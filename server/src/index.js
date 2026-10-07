import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import express from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';

import { normalizeSettings, SCHEMA, GROUPS, DEFAULT_SETTINGS, savePortfolioTo } from './config.js';
import { MarketHub } from './market.js';
import { Trader } from './trader.js';
import { scheduleRestart } from './restart.js';
import { ping } from './binance/rest.js';
import { validateCredentialShape } from './binance/private.js';
import {
  saveCredentials,
  loadCredentials,
  deleteCredentials,
  describeCredentials,
  armLive,
  disarmLive,
  resetLiveOnBoot,
  requiresConfirmation,
} from './credentials.js';
import {
  bearerToken,
  requireAuth,
  requireMaster,
  hasAnyUser,
  createMaster,
  createUser,
  setUserDisabled,
  resetUserPassword,
  deleteUser,
  loadUsers,
  publicUser,
  findUserById,
  login,
  resolveSession,
  revokeSession,
} from './auth.js';
import {
  loadAccountMetas,
  publicAccountMeta,
  getAccountMeta,
  visibleAccounts,
  canAccessAccount,
  createTradingAccount,
  ensureDefaultAccount,
  setAccountDisabled,
  renameTradingAccount,
  deleteTradingAccount,
  disableAccountsOfUser,
  hasLegacyData,
  migrateLegacyToAccount,
  readEvents,
  readAllEvents,
  accountPaths,
} from './accounts.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const PORT = Number(process.env.PORT) || 8787;

const hub = new MarketHub();
/** accountId → Trader */
const traders = new Map();

const allAccountDirs = () => [...new Set([...loadAccountMetas().map((m) => accountPaths(m.id).dir), DATA_DIR])];

// 보안: 재시작하면 모든 계정의 실거래 모드가 자동으로 해제된다
resetLiveOnBoot(allAccountDirs());

// ── Trader 생명주기 ──────────────────────────────────────────
function wireTrader(trader) {
  const id = trader.accountId;
  trader.on('toast', (toast) =>
    sendToAccount(id, { type: 'toast', accountId: id, data: { ...toast, id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}` } }),
  );
  trader.on('status', () => sendSnapshot(trader));
  trader.on('settings', () => sendSnapshot(trader));
  trader.on('reset', () => sendSnapshot(trader));
  trader.on('scan', () => sendSnapshot(trader));
  trader.on('trade-closed', () => sendSnapshot(trader));
}

function mountTrader(meta) {
  if (traders.has(meta.id)) return traders.get(meta.id);
  const trader = new Trader(meta.id, meta, hub);
  wireTrader(trader);
  traders.set(meta.id, trader);
  if (!meta.disabled) trader.start();
  retuneHub();
  return trader;
}

function unmountTrader(id) {
  const trader = traders.get(id);
  if (!trader) return;
  trader.stop();
  trader.removeAllListeners();
  traders.delete(id);
  hub.unregisterSeedPicks(id);
  retuneHub();
}

/** 허브를 전 Trader 설정에 맞춰 조정 */
function retuneHub() {
  const list = [...traders.values()].filter((t) => !t.meta.disabled).map((t) => t.settings);
  if (!list.length) return;
  hub.retuneScanner(list);
  hub.retunePollers(
    Math.min(...list.map((s) => s.marketPollSec ?? 10)),
    Math.min(...list.map((s) => s.barPollSec ?? 20)),
  );
  for (const t of traders.values()) t.registerPicks();
  hub.refreshSeedTargets().catch((err) => console.error('[market] 시드 갱신 실패:', err.message));
}

function defaultAccountFor(user) {
  const list = visibleAccounts(user);
  return list[0] ?? null;
}

const app = express();
app.use(cors());
app.use(express.json());

// ── WebSocket 클라이언트 (사용자별 가시 계정) ─────────────────
// ws → { user, accountIds:Set }
const clients = new Map();
const send = (ws, msg) => {
  if (ws.readyState === 1) {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      /* 전송 실패는 close 핸들러에서 정리 */
    }
  }
};

function sendToAccount(accountId, msg) {
  for (const [ws, ctx] of clients) {
    if (ctx.accountIds.has(accountId)) send(ws, msg);
  }
}

function sendSnapshot(trader) {
  sendToAccount(trader.accountId, trader.snapshot());
}

function visibleAccountIds(user) {
  return new Set(visibleAccounts(user).map((m) => m.id));
}

// ── 계정 스코프 해결 ─────────────────────────────────────────
/**
 * ?account= 또는 body.account 로 대상 계정을 정한다.
 * 없으면 사용자의 기본 계정. 마스터는 전부, 일반은 본인 소유만.
 */
function resolveTrader(req, res) {
  const requested = req.query.account ?? req.body?.account ?? null;
  const meta = requested
    ? canAccessAccount(req.user, String(requested))
    : (() => {
        const d = defaultAccountFor(req.user);
        return d ? canAccessAccount(req.user, d.id) : null;
      })();
  if (!meta) {
    res.status(requested ? 403 : 404).json({
      ok: false,
      error: requested ? '이 계정에 접근할 수 없습니다.' : '사용 가능한 거래 계정이 없습니다.',
    });
    return null;
  }
  let trader = traders.get(meta.id);
  if (!trader) {
    // 마운트되지 않은 계정 (서버 기동 후 생성분 등) → 즉시 마운트
    trader = mountTrader(meta);
  } else {
    trader.meta = meta; // 이름/정지 상태 동기화
  }
  if (meta.disabled && req.user.role !== 'master') {
    res.status(403).json({ ok: false, error: '정지된 계정입니다.' });
    return null;
  }
  req.accountMeta = meta;
  req.trader = trader;
  return trader;
}

const actorOf = (req) => req.user?.name ?? null;

// ── REST API ──────────────────────────────────────────────────
app.get('/api/health', async (_req, res) => {
  let binance = 'unknown';
  try {
    await ping();
    binance = 'ok';
  } catch (err) {
    binance = `error: ${err.message}`;
  }
  const market = hub.marketStatus();
  res.json({ ok: true, binance, market, accounts: traders.size, uptimeSec: Math.round(process.uptime()) });
});

// ── 인증 ─────────────────────────────────────────────────────
app.get('/api/auth/status', (_req, res) => {
  res.json({ setupRequired: !hasAnyUser() });
});

app.post('/api/auth/setup', (req, res) => {
  try {
    const { name = 'master', password } = req.body ?? {};
    const user = createMaster({ name, password });
    // 마스터의 기본 거래 계정 + 레거시 데이터 승계
    const account = ensureDefaultAccount(user.id, '기본');
    let migrated = [];
    if (hasLegacyData()) migrated = migrateLegacyToAccount(account.id);
    const trader = mountTrader({ ...account, disabled: false });
    const { token, expiresAt } = login({ name: user.name, password, ip: req.ip });
    trader.log('system', `마스터 계정 생성${migrated.length ? ` · 기존 데이터 승계 (${migrated.join(', ')})` : ''}`, user.name);
    res.json({ ok: true, user, token, expiresAt, account, migrated });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.post('/api/auth/login', (req, res) => {
  try {
    const { name, password } = req.body ?? {};
    const { token, expiresAt, user } = login({ name, password, ip: req.ip });
    const accounts = visibleAccounts(user);
    res.json({ ok: true, token, expiresAt, user, accounts, defaultAccountId: accounts[0]?.id ?? null });
  } catch (err) {
    res.status(err.status ?? 401).json({ ok: false, error: err.message });
  }
});

app.post('/api/auth/logout', requireAuth, (req, res) => {
  revokeSession(bearerToken(req));
  res.json({ ok: true });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  const accounts = visibleAccounts(req.user);
  res.json({ ok: true, user: publicUser(findUserById(req.user.id)), accounts, defaultAccountId: accounts[0]?.id ?? null, sessionExpiresAt: req.sessionExpiresAt });
});

// ── 사용자 관리 (마스터) ─────────────────────────────────────
app.get('/api/users', requireAuth, requireMaster, (_req, res) => {
  const counts = {};
  for (const m of loadAccountMetas()) counts[m.ownerUserId] = (counts[m.ownerUserId] ?? 0) + 1;
  res.json({
    users: loadUsers().map((u) => ({ ...publicUser(u), accountCount: counts[u.id] ?? 0 })),
  });
});

app.post('/api/users', requireAuth, requireMaster, (req, res) => {
  try {
    const { name, password, role = 'user' } = req.body ?? {};
    const user = createUser({ name, password, role });
    const account = ensureDefaultAccount(user.id, '기본');
    mountTrader({ ...account, disabled: false });
    res.json({ ok: true, user, account });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.post('/api/users/:id/password', requireAuth, requireMaster, (req, res) => {
  try {
    const user = resetUserPassword(req.params.id, req.body?.password);
    res.json({ ok: true, user });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.post('/api/users/:id/disabled', requireAuth, requireMaster, (req, res) => {
  try {
    const disabled = Boolean(req.body?.disabled);
    const user = setUserDisabled(req.params.id, disabled);
    const n = disableAccountsOfUser(req.params.id);
    if (disabled) {
      for (const [id, t] of traders) {
        if (t.meta.ownerUserId === req.params.id) {
          t.stop();
          t.meta = { ...t.meta, disabled: true };
        }
      }
    }
    res.json({ ok: true, user, disabledAccounts: disabled ? n : 0 });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.delete('/api/users/:id', requireAuth, requireMaster, (req, res) => {
  try {
    if (req.params.id === req.user.id) return res.status(400).json({ ok: false, error: '자기 자신은 삭제할 수 없습니다.' });
    const user = deleteUser(req.params.id);
    disableAccountsOfUser(req.params.id);
    for (const [id, t] of traders) {
      if (t.meta.ownerUserId === req.params.id) {
        t.stop();
        t.meta = { ...t.meta, disabled: true };
      }
    }
    res.json({ ok: true, user });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// ── 거래 계정 관리 ───────────────────────────────────────────
app.get('/api/trading-accounts', requireAuth, (req, res) => {
  const list = visibleAccounts(req.user).map((m) => {
    const t = traders.get(m.id);
    return {
      ...m,
      ownerName: req.user.role === 'master' ? (findUserById(m.ownerUserId)?.name ?? '(삭제됨)') : undefined,
      running: t?.running ?? false,
      mode: t ? (t.portfolio.isLive ? 'live' : 'paper') : 'paper',
      openCount: t?.portfolio.positions.size ?? 0,
    };
  });
  res.json({ accounts: list });
});

app.post('/api/trading-accounts', requireAuth, (req, res) => {
  try {
    const { name = '기본', ownerUserId = null } = req.body ?? {};
    let owner = req.user.id;
    if (ownerUserId && ownerUserId !== req.user.id) {
      if (req.user.role !== 'master') return res.status(403).json({ ok: false, error: '마스터만 다른 사용자의 계정을 만들 수 있습니다.' });
      if (!findUserById(ownerUserId)) return res.status(400).json({ ok: false, error: '대상 사용자를 찾을 수 없습니다.' });
      owner = ownerUserId;
    }
    const account = createTradingAccount({ name, ownerUserId: owner });
    mountTrader({ ...account, disabled: false });
    res.json({ ok: true, account });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.patch('/api/trading-accounts/:id', requireAuth, (req, res) => {
  const meta = canAccessAccount(req.user, req.params.id);
  if (!meta) return res.status(403).json({ ok: false, error: '이 계정에 접근할 수 없습니다.' });
  try {
    const renamed = renameTradingAccount(req.params.id, req.body?.name);
    const t = traders.get(req.params.id);
    if (t) {
      t.meta = { ...t.meta, name: renamed.name };
      t.log('account', `계정 이름 변경 → ${renamed.name}`, actorOf(req));
    }
    res.json({ ok: true, account: renamed });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.post('/api/trading-accounts/:id/disabled', requireAuth, requireMaster, (req, res) => {
  try {
    if (!getAccountMeta(req.params.id)) return res.status(404).json({ ok: false, error: '거래 계정을 찾을 수 없습니다.' });
    const renamed = setAccountDisabled(req.params.id, Boolean(req.body?.disabled));
    const t = traders.get(req.params.id);
    if (t) {
      t.meta = { ...t.meta, disabled: renamed.disabled };
      if (renamed.disabled) t.stop();
      else t.start();
      t.log('account', renamed.disabled ? '계정 정지' : '계정 재개', actorOf(req));
    }
    retuneHub();
    res.json({ ok: true, account: renamed });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.delete('/api/trading-accounts/:id', requireAuth, (req, res) => {
  const meta = canAccessAccount(req.user, req.params.id);
  if (!meta) return res.status(403).json({ ok: false, error: '이 계정에 접근할 수 없습니다.' });
  // 메모리 포지션을 먼저 검사한다. 파일 검사는 persist 타이머(30초) 때문에
  // 오래된 상태일 수 있어, 메모리가 진실이다. 검증 전 언마운트 금지 —
  // 실패 시 재마운트하면 오래된 파일에서 포지션이 부활한다.
  const live = traders.get(req.params.id);
  if (live && live.portfolio.positions.size > 0) {
    return res.status(400).json({ ok: false, error: '보유 포지션이 있는 계정은 삭제할 수 없습니다. 먼저 전량 청산하세요.' });
  }
  try {
    // 메모리 상태를 파일에 확정 — persist 타이머 주기와 무관하게 파일 검사를 정확히 한다
    if (live) savePortfolioTo(live.portfolio.toJSON(), accountPaths(req.params.id).portfolio);
    unmountTrader(req.params.id);
    deleteTradingAccount(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    // 검증 후 실패는 파일 문제이므로 마운트 복구 (메모리에는 포지션 없음 확인됨)
    if (!traders.has(req.params.id)) mountTrader(meta);
    res.status(400).json({ ok: false, error: err.message });
  }
});

// ── 마스터: 전체 현황 + 전체 로그 ────────────────────────────
app.get('/api/admin/overview', requireAuth, requireMaster, (_req, res) => {
  const rows = loadAccountMetas().map((m) => {
    const t = traders.get(m.id);
    const s = t?.portfolio.summary() ?? null;
    return {
      ...publicAccountMeta(m),
      ownerName: findUserById(m.ownerUserId)?.name ?? '(삭제됨)',
      running: t?.running ?? false,
      mode: t ? (t.portfolio.isLive ? 'live' : 'paper') : 'paper',
      dryRun: t?.portfolio.isLive ? t.broker.dryRun : null,
      network: t?.broker.network ?? null,
      equity: s?.equity ?? null,
      totalPnl: s?.totalPnl ?? null,
      totalPnlPct: s?.totalPnlPct ?? null,
      openCount: s?.openCount ?? 0,
      tradeCount: s?.tradeCount ?? 0,
      winRate: s?.winRate ?? 0,
      lastScanAt: t?.status.lastScanAt ?? null,
      candidates: t?.candidates.length ?? 0,
    };
  });
  res.json({ accounts: rows });
});

app.get('/api/admin/events', requireAuth, requireMaster, (req, res) => {
  const { accountId = null, type = null, limit = 200, before = 0, q = '' } = req.query;
  const metas = accountId ? loadAccountMetas().filter((m) => m.id === String(accountId)) : loadAccountMetas();
  res.json({ events: readAllEvents(metas, { type: type || null, limit, before: Number(before) || 0, q: String(q ?? '') }) });
});

/**
 * 서버 재시작 (마스터 전용).
 * 응답을 먼저 보낸 뒤 후속 프로세스를 띄우고 자신을 종료한다.
 * 재시작하면 실거래 모드가 자동 해제되고 WS가 일시 끊긴다 (클라이언트 자동 재접속).
 */
app.post('/api/admin/restart', requireAuth, requireMaster, (req, res) => {
  res.json({ ok: true, message: '서버를 재시작합니다. 약 30~60초 후 자동으로 복구됩니다.' });
  setTimeout(() => {
    try {
      scheduleRestart({
        entryFile: path.join(__dirname, 'index.js'),
        pidFile: PID_FILE,
        logFile: LOG_FILE,
        shutdownFn: () => shutdown('RESTART'),
        logger: console,
      });
    } catch (err) {
      console.error('[restart] 예약 실패:', err.message);
    }
  }, 800);
});

// ── 설정 (계정별) ────────────────────────────────────────────
/** 설정 스키마 + 현재값 + 기본값 (설정 다이얼로그 구성용) */
app.get('/api/settings', requireAuth, (req, res) => {
  const trader = resolveTrader(req, res);
  if (!trader) return;
  res.json({ settings: trader.settings, schema: SCHEMA, groups: GROUPS, defaults: DEFAULT_SETTINGS, accountId: trader.accountId });
});

app.put('/api/settings', requireAuth, (req, res) => {
  const trader = resolveTrader(req, res);
  if (!trader) return;
  const { settings: next, warnings } = normalizeSettings(req.body ?? {}, trader.settings);
  trader.applySettings(next, actorOf(req));
  retuneHub();
  sendSnapshot(trader);
  res.json({ ok: true, settings: next, warnings, accountId: trader.accountId });
});

app.post('/api/settings/reset', requireAuth, (req, res) => {
  const trader = resolveTrader(req, res);
  if (!trader) return;
  trader.applySettings({ ...DEFAULT_SETTINGS }, actorOf(req));
  retuneHub();
  sendSnapshot(trader);
  res.json({ ok: true, settings: trader.settings, accountId: trader.accountId });
});

app.post('/api/engine/:action', requireAuth, (req, res) => {
  const trader = resolveTrader(req, res);
  if (!trader) return;
  const { action } = req.params;
  if (action === 'start') {
    trader.start();
  } else if (action === 'stop') {
    trader.stop();
  } else if (action === 'scan') {
    trader.scan().catch((err) => res.status(500).json({ ok: false, error: err.message }));
  } else {
    return res.status(400).json({ ok: false, error: `알 수 없는 action: ${action}` });
  }
  if (action !== 'scan') res.json({ ok: true, running: trader.running, accountId: trader.accountId });
  sendSnapshot(trader);
});

app.post('/api/portfolio/reset', requireAuth, (req, res) => {
  const trader = resolveTrader(req, res);
  if (!trader) return;
  if (trader.portfolio.isLive) {
    return res.status(400).json({ ok: false, error: '실거래 모드에서는 초기화할 수 없습니다.' });
  }
  trader.resetPortfolio(actorOf(req));
  sendSnapshot(trader);
  res.json({ ok: true, accountId: trader.accountId });
});

app.post('/api/portfolio/close-all', requireAuth, async (req, res) => {
  const trader = resolveTrader(req, res);
  if (!trader) return;
  res.json({ ...(await trader.closeAll(actorOf(req))), accountId: trader.accountId });
  sendSnapshot(trader);
});

app.post('/api/positions/:symbol/buy', requireAuth, async (req, res) => {
  const trader = resolveTrader(req, res);
  if (!trader) return;
  const result = await trader.manualBuy(req.params.symbol.toUpperCase(), actorOf(req));
  res.status(result.ok ? 200 : 400).json({ ...result, accountId: trader.accountId });
  retuneTracked();
  sendSnapshot(trader);
});

app.post('/api/positions/:symbol/sell', requireAuth, async (req, res) => {
  const trader = resolveTrader(req, res);
  if (!trader) return;
  const result = await trader.manualSell(req.params.symbol.toUpperCase(), actorOf(req));
  res.status(result.ok ? 200 : 400).json({ ...result, accountId: trader.accountId });
  retuneTracked();
  sendSnapshot(trader);
});

app.get('/api/trades', requireAuth, (req, res) => {
  const trader = resolveTrader(req, res);
  if (!trader) return;
  res.json({ trades: trader.portfolio.trades.slice(0, 200), accountId: trader.accountId });
});

/** 일별 실현 손익 집계 (청산 기준, 서버 로컬 날짜) */
app.get('/api/trades/daily', requireAuth, (req, res) => {
  const trader = resolveTrader(req, res);
  if (!trader) return;
  const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);
  const stats = trader.portfolio.dailyStats(days);
  res.json({ daily: stats.days, total: stats.total, accountId: trader.accountId, periodDays: days });
});

/** 본인 계정의 이벤트 로그 */
app.get('/api/events', requireAuth, (req, res) => {
  const trader = resolveTrader(req, res);
  if (!trader) return;
  const { type = null, limit = 200, before = 0, q = '' } = req.query;
  res.json({
    events: readEvents(trader.accountId, { type: type || null, limit, before: Number(before) || 0, q: String(q ?? '') }),
    accountId: trader.accountId,
  });
});

app.get('/api/klines', requireAuth, async (req, res) => {
  const symbol = String(req.query.symbol ?? '').toUpperCase();
  if (!/^[A-Z0-9]{5,25}$/.test(symbol)) return res.status(400).json({ error: '잘못된 심볼' });
  try {
    const klines = await hub.getKlines(symbol, String(req.query.interval ?? '1m'), Math.min(500, Number(req.query.limit) || 120));
    res.json({ symbol, klines });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/universe', requireAuth, (req, res) => {
  const trader = resolveTrader(req, res);
  const held = trader ? new Set(trader.portfolio.positions.keys()) : new Set();
  res.json({
    symbols: hub.universe
      .map((u) => ({ ...u, price: hub.prices.get(u.symbol) ?? null, held: held.has(u.symbol) }))
      .filter((u) => u.price)
      .sort((a, b) => b.price - a.price),
  });
});

// ── 계정 / 실거래 (거래 계정별 자격증명) ──────────────────────

/** 저장된 자격증명 상태 (시크릿 절대 포함하지 않음) */
app.get('/api/account', requireAuth, async (req, res) => {
  const trader = resolveTrader(req, res);
  if (!trader) return;
  const described = trader.describeCreds();
  res.json({
    ...described,
    accountId: trader.accountId,
    mode: trader.portfolio.isLive ? 'live' : 'paper',
    connected: described.connected || trader.broker.isLive,
    liveActive: trader.portfolio.isLive,
    dryRun: trader.portfolio.isLive ? trader.broker.dryRun : null,
    executesOrders: trader.broker.executesOrders,
    broker: trader.broker.describe(),
    balance: trader.portfolio.liveBalance,
    testnetUrl: 'https://testnet.binancefuture.com',
  });
});

/** 자격증명 저장 (연결 전 형식 검사) */
app.post('/api/account/credentials', requireAuth, (req, res) => {
  const trader = resolveTrader(req, res);
  if (!trader) return;
  const { apiKey, apiSecret, network } = req.body ?? {};
  const shape = validateCredentialShape({ apiKey, apiSecret });
  if (!shape.ok) return res.status(400).json({ ok: false, errors: shape.errors });

  const creds = trader.saveCreds({ apiKey, apiSecret, network }, actorOf(req));
  res.json({ ok: true, apiKeyMasked: trader.describeCreds().apiKeyMasked, network: creds.network, accountId: trader.accountId });
});

app.delete('/api/account/credentials', requireAuth, (_req, res) => {
  const trader = resolveTrader(_req, res);
  if (!trader) return;
  const info = trader.deleteCreds(actorOf(_req));
  res.json({ ok: true, ...info, accountId: trader.accountId });
  sendSnapshot(trader);
});

/** 자격증명 검증만 (저장하지 않고 통신 테스트) */
app.post('/api/account/verify', requireAuth, async (req, res) => {
  const { apiKey, apiSecret, network } = req.body ?? {};
  const shape = validateCredentialShape({ apiKey, apiSecret });
  if (!shape.ok) return res.status(400).json({ ok: false, errors: shape.errors });

  try {
    const { PrivateClient } = await import('./binance/private.js');
    const client = new PrivateClient({ apiKey, apiSecret, network });
    const result = await client.verify();
    res.json({ ok: true, ...result, network: network === 'production' ? 'production' : 'testnet' });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.friendly ?? err.message, code: err.code });
  }
});

/** 계정 연결 + 모드 전환 (mode: 'live' | 'paper', dryRun: 주문 시뮬레이션) */
app.post('/api/account/connect', requireAuth, async (req, res) => {
  const trader = resolveTrader(req, res);
  if (!trader) return;
  const { mode = 'paper', confirm, dryRun = false } = req.body ?? {};
  const liveRequested = mode === 'live';
  const simulated = Boolean(dryRun);

  // 실제 주문을 전송하는 경우에만 확인 절차가 필요하다.
  if (requiresConfirmation({ mode, dryRun: simulated }) && !confirm) {
    return res.status(400).json({ ok: false, error: '실거래 모드는 확인 절차가 필요합니다.' });
  }

  const creds = trader.loadCreds();
  if (!creds) return res.status(400).json({ ok: false, error: '저장된 API 키가 없습니다.' });

  try {
    if (liveRequested) trader.armLiveMode();
    const info = await trader.connectAccount({ ...creds, mode: liveRequested ? 'live' : 'paper', dryRun: simulated, actor: actorOf(req) });
    res.json({ ok: true, ...info, accountId: trader.accountId });
  } catch (err) {
    if (liveRequested) trader.disarmLiveMode(); // 실패하면 무장 해제
    res.status(400).json({ ok: false, error: err.friendly ?? err.message, code: err.code });
  } finally {
    retuneTracked();
    sendSnapshot(trader);
  }
});

/** 주문 시뮬레이션 토글 (실거래 모드에서) */
app.post('/api/account/dry-run', requireAuth, async (req, res) => {
  const trader = resolveTrader(req, res);
  if (!trader) return;
  const { enabled } = req.body ?? {};
  try {
    const info = trader.setDryRun(Boolean(enabled), actorOf(req));
    res.json({ ok: true, ...info, accountId: trader.accountId });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.friendly ?? err.message });
  } finally {
    sendSnapshot(trader);
  }
});

/** 실거래 모드 해제 (가상 모드로 복귀) */
app.post('/api/account/disconnect', requireAuth, (_req, res) => {
  const trader = resolveTrader(_req, res);
  if (!trader) return;
  trader.disarmLiveMode();
  const info = trader.disconnectAccount(actorOf(_req));
  res.json({ ok: true, ...info, accountId: trader.accountId });
  sendSnapshot(trader);
});

/** 잔고 새로고침 */
app.post('/api/account/balance', requireAuth, async (req, res) => {
  const trader = resolveTrader(req, res);
  if (!trader) return;
  try {
    const balance = await trader.refreshBalance();
    res.json({ ok: true, balance, accountId: trader.accountId });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.friendly ?? err.message });
  } finally {
    sendSnapshot(trader);
  }
});

/** 거래소 포지션과 동기화 */
app.post('/api/account/sync', requireAuth, async (req, res) => {
  const trader = resolveTrader(req, res);
  if (!trader) return;
  try {
    const info = await trader.syncPositions();
    res.json({ ok: true, ...info, accountId: trader.accountId });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.friendly ?? err.message });
  } finally {
    sendSnapshot(trader);
  }
});

/** 현재 보유 종목의 거래 규격 (최소 주문금액 확인용) */
app.get('/api/account/filters', requireAuth, async (req, res) => {
  const trader = resolveTrader(req, res);
  if (!trader) return;
  if (!trader.broker.isLive) return res.status(400).json({ error: '계정이 연결되어 있지 않습니다.' });
  const symbol = String(req.query.symbol ?? '').toUpperCase();
  if (!trader.broker.client.filters.size) await trader.broker.client.loadFilters();
  res.json({ filters: trader.broker.client.filterFor(symbol), accountId: trader.accountId });
});

// ── 정적 파일 (프로덕션 빌드) ─────────────────────────────────
const dist = path.join(__dirname, '..', '..', 'web', 'dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(path.join(dist, 'index.html'));
  });
  console.log('[server] 정적 파일 서빙:', dist);
}

const server = http.createServer(app);

// ── 클라이언트 WebSocket ──────────────────────────────────────
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url ?? '/ws', 'http://localhost');
  const session = resolveSession(url.searchParams.get('token'));
  if (!session) {
    ws.close(4401, 'unauthorized');
    return;
  }
  const user = { id: session.user.id, name: session.user.name, role: session.user.role };
  const ctx = { user, accountIds: visibleAccountIds(user) };
  clients.set(ws, ctx);
  console.log(`[ws] ${user.name} 연결 (가시 계정 ${ctx.accountIds.size}개, 전체 ${clients.size}개)`);
  for (const id of ctx.accountIds) {
    const t = traders.get(id);
    if (t) send(ws, t.snapshot());
  }

  ws.on('close', () => {
    clients.delete(ws);
    console.log(`[ws] ${user.name} 해제 (${clients.size}개)`);
  });
  ws.on('error', () => clients.delete(ws));
});

/** 전 Trader 추적 합집합으로 허브 구독 갱신 */
function retuneTracked() {
  hub.rebuildTracked([...traders.values()].filter((t) => t.running).map((t) => t.ownTracked()));
}

// 1Hz: 전 Trader 가격 반영 + 청산 검사 + 스냅샷
const stateTimer = setInterval(() => {
  for (const trader of traders.values()) {
    if (!trader.running) continue;
    trader.processPriceUpdates();
  }
  retuneTracked();
  for (const trader of traders.values()) {
    if (!trader.running) continue;
    sendSnapshot(trader);
  }
}, 1000);

// 250ms: 실시간 가격만 (부드러운 UI 갱신용, 비밀정보 없음 — 전체 공유)
let lastLiveSent = 0;
const liveTimer = setInterval(() => {
  if (!clients.size) return;
  const now = Date.now();
  if (now - lastLiveSent < 250) return;
  lastLiveSent = now;
  const msg = hub.livePrices();
  for (const ws of clients.keys()) send(ws, msg);
}, 250);

const PID_FILE = path.join(__dirname, '..', '..', 'server.pid');
const LOG_FILE = path.join(__dirname, '..', '..', 'logs', 'server.log');

function writePidFile() {
  try {
    fs.writeFileSync(PID_FILE, String(process.pid), 'utf8');
  } catch (err) {
    console.error('[server] PID 파일 쓰기 실패:', err.message);
  }
}

async function boot() {
  // 데몬/재시작 경로로 실행됐을 때만 PID 파일 갱신 (dev 모드 간섭 방지)
  if (process.env.COIN_SURFER_WRITE_PID === '1') writePidFile();

  console.log(`\n  ▲ Coin Surfer 서버 (멀티 계정)`);
  console.log(`  ├─ API/WS : http://localhost:${PORT}`);

  await hub.start();

  const metas = loadAccountMetas().filter((m) => !m.disabled);
  for (const meta of loadAccountMetas()) mountTrader(meta);
  retuneHub();
  await hub.refreshSeedTargets();
  for (const meta of metas) {
    const t = traders.get(meta.id);
    if (t) t.scan().catch((err) => console.error(`[trader:${meta.name}] 첫 스캔 실패:`, err.message));
  }

  const n = loadAccountMetas().length;
  console.log(`  ├─ 거래 계정: ${n}개`);
  console.log(`  ├─ 설정 필요: ${hasAnyUser() ? '아니오 (로그인 화면으로)' : '예 — 최초 마스터 생성 (/api/auth/setup)'}`);
  console.log(`  └─ 마켓   : Binance USDⓈ-M Futures\n`);
}

// 재시작 직후 기존 프로세스가 포트를 잡고 있으면 1초 간격으로 재시도
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    const left = Number(server.__retryLeft ?? 20);
    if (left > 0) {
      server.__retryLeft = left - 1;
      console.log(`[server] 포트 ${PORT} 사용 중 — 1초 후 재시도 (${server.__retryLeft})`);
      setTimeout(() => server.listen(PORT, boot), 1000);
      return;
    }
  }
  console.error('[server] 리슨 실패:', err.message);
  process.exit(1);
});

server.listen(PORT, boot);

function shutdown(signal) {
  console.log(`\n[server] ${signal} 수신, 종료합니다...`);
  clearInterval(stateTimer);
  clearInterval(liveTimer);
  for (const trader of traders.values()) trader.stop();
  hub.stop();
  for (const ws of clients.keys()) ws.close();
  wss.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => console.error('[server] 처리되지 않은 rejection:', err));
