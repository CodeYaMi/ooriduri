import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import express from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';

import { loadSettings, saveSettings, normalizeSettings, SCHEMA, GROUPS, DEFAULT_SETTINGS, loadPortfolioState } from './config.js';
import { Engine } from './engine.js';
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8787;

const settings = loadSettings();
const engine = new Engine(settings);

// 보안: 재시작하면 실거래 모드가 자동으로 해제된다
resetLiveOnBoot();

// 이전 세션의 포트폴리오 복원
const saved = loadPortfolioState();
if (saved) {
  engine.portfolio.init(settings, saved);
  console.log(`[server] 이전 상태 복원 — 포지션 ${saved.positions?.length ?? 0}개, 거래 ${saved.trades?.length ?? 0}건`);
}

const app = express();
app.use(cors());
app.use(express.json());

// ── 상태 브로드캐스트용 ────────────────────────────────────────
const clients = new Set();
const send = (ws, msg) => {
  if (ws.readyState === 1) {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      /* 전송 실패는 close 핸들러에서 정리 */
    }
  }
};
const broadcast = (msg) => {
  for (const ws of clients) send(ws, msg);
};

engine.on('toast', (toast) => broadcast({ type: 'toast', data: { ...toast, id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}` } }));
engine.on('status', (status) => broadcast({ type: 'status', data: status }));
engine.on('settings', (s) => broadcast({ type: 'settings', data: s }));
engine.on('reset', () => broadcast(engine.snapshot()));
engine.on('scan', () => broadcast(engine.snapshot()));

// ── REST API ──────────────────────────────────────────────────
app.get('/api/health', async (_req, res) => {
  let binance = 'unknown';
  try {
    await ping();
    binance = 'ok';
  } catch (err) {
    binance = `error: ${err.message}`;
  }
  res.json({ ok: true, binance, engine: engine.status, uptimeSec: Math.round(process.uptime()) });
});

/** 설정 스키마 + 현재값 + 기본값 (설정 다이얼로그 구성용) */
app.get('/api/settings', (_req, res) => {
  res.json({ settings: engine.settings, schema: SCHEMA, groups: GROUPS, defaults: DEFAULT_SETTINGS });
});

app.put('/api/settings', (req, res) => {
  const { settings: next, warnings } = normalizeSettings(req.body ?? {}, engine.settings);
  engine.applySettings(next);
  saveSettings(next);
  broadcast({ type: 'settings', data: next });
  broadcast(engine.snapshot());
  res.json({ ok: true, settings: next, warnings });
});

app.post('/api/settings/reset', (_req, res) => {
  engine.applySettings({ ...DEFAULT_SETTINGS });
  saveSettings(engine.settings);
  broadcast({ type: 'settings', data: engine.settings });
  broadcast(engine.snapshot());
  res.json({ ok: true, settings: engine.settings });
});

app.post('/api/engine/:action', (req, res) => {
  const { action } = req.params;
  if (action === 'start') {
    engine.start();
  } else if (action === 'stop') {
    engine.stop();
  } else if (action === 'scan') {
    engine.scan().catch((err) => res.status(500).json({ ok: false, error: err.message }));
  } else {
    return res.status(400).json({ ok: false, error: `알 수 없는 action: ${action}` });
  }
  if (action !== 'scan') res.json({ ok: true, running: engine.running });
});

app.post('/api/portfolio/reset', (_req, res) => {
  engine.resetPortfolio();
  broadcast(engine.snapshot());
  res.json({ ok: true });
});

app.post('/api/portfolio/close-all', async (_req, res) => {
  res.json(await engine.closeAll());
});

app.post('/api/positions/:symbol/buy', async (req, res) => {
  const result = await engine.manualBuy(req.params.symbol.toUpperCase());
  res.status(result.ok ? 200 : 400).json(result);
  broadcast(engine.snapshot());
});

app.post('/api/positions/:symbol/sell', async (req, res) => {
  const result = await engine.manualSell(req.params.symbol.toUpperCase());
  res.status(result.ok ? 200 : 400).json(result);
  broadcast(engine.snapshot());
});

app.get('/api/klines', async (req, res) => {
  const symbol = String(req.query.symbol ?? '').toUpperCase();
  if (!/^[A-Z0-9]{5,25}$/.test(symbol)) return res.status(400).json({ error: '잘못된 심볼' });
  try {
    const klines = await engine.getKlines(symbol, String(req.query.interval ?? '1m'), Math.min(500, Number(req.query.limit) || 120));
    res.json({ symbol, klines });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/universe', (_req, res) => {
  res.json({
    symbols: engine.universe
      .map((u) => ({ ...u, price: engine.prices.get(u.symbol) ?? null, held: engine.portfolio.positions.has(u.symbol) }))
      .filter((u) => u.price)
      .sort((a, b) => b.price - a.price),
  });
});

app.get('/api/trades', (_req, res) => {
  res.json({ trades: engine.portfolio.trades.slice(0, 200) });
});

// ── 계정 / 실거래 ─────────────────────────────────────────────

/** 저장된 자격증명 상태 (시크릿 절대 포함하지 않음) */
app.get('/api/account', async (_req, res) => {
  const described = describeCredentials();
  res.json({
    ...described,
    mode: engine.portfolio.isLive ? 'live' : 'paper',
    // 서버가 이미 연결돼 있는 경우 (프로세스 재사용)
    connected: described.connected || engine.broker.isLive,
    liveActive: engine.portfolio.isLive,
    dryRun: engine.portfolio.isLive ? engine.broker.dryRun : null,
    executesOrders: engine.broker.executesOrders,
    broker: engine.broker.describe(),
    balance: engine.portfolio.liveBalance,
    testnetUrl: 'https://testnet.binancefuture.com',
  });
});

/** 자격증명 저장 (연결 전 형식 검사) */
app.post('/api/account/credentials', (req, res) => {
  const { apiKey, apiSecret, network } = req.body ?? {};
  const shape = validateCredentialShape({ apiKey, apiSecret });
  if (!shape.ok) return res.status(400).json({ ok: false, errors: shape.errors });

  const creds = saveCredentials({ apiKey, apiSecret, network });
  res.json({ ok: true, apiKeyMasked: describeCredentials().apiKeyMasked, network: creds.network });
});

app.delete('/api/account/credentials', (_req, res) => {
  deleteCredentials();
  const info = engine.disconnectAccount();
  disarmLive();
  res.json({ ok: true, ...info });
});

/** 자격증명 검증만 (저장하지 않고 통신 테스트) */
app.post('/api/account/verify', async (req, res) => {
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
app.post('/api/account/connect', async (req, res) => {
  const { mode = 'paper', confirm, dryRun = false } = req.body ?? {};
  const liveRequested = mode === 'live';
  const simulated = Boolean(dryRun);

  // 실제 주문을 전송하는 경우에만 확인 절차가 필요하다.
  // (주문 시뮬레이션은 안전하게 점검이 목적이므로 확인 없이 진입 가능)
  if (requiresConfirmation({ mode, dryRun: simulated }) && !confirm) {
    return res.status(400).json({ ok: false, error: '실거래 모드는 확인 절차가 필요합니다.' });
  }

  const creds = loadCredentials();
  if (!creds) return res.status(400).json({ ok: false, error: '저장된 API 키가 없습니다.' });

  try {
    if (liveRequested) armLive(creds.network);
    const info = await engine.connectAccount({ ...creds, mode: liveRequested ? 'live' : 'paper', dryRun: simulated });
    res.json({ ok: true, ...info });
  } catch (err) {
    if (liveRequested) disarmLive(); // 실패하면 무장 해제
    res.status(400).json({ ok: false, error: err.friendly ?? err.message, code: err.code });
  } finally {
    broadcast(engine.snapshot());
  }
});

/** 주문 시뮬레이션 토글 (실거래 모드에서) */
app.post('/api/account/dry-run', async (req, res) => {
  const { enabled } = req.body ?? {};
  try {
    const info = engine.setDryRun(Boolean(enabled));
    res.json({ ok: true, ...info });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.friendly ?? err.message });
  } finally {
    broadcast(engine.snapshot());
  }
});

/** 실거래 모드 해제 (가상 모드로 복귀) */
app.post('/api/account/disconnect', (_req, res) => {
  disarmLive();
  const info = engine.disconnectAccount();
  res.json({ ok: true, ...info });
  broadcast(engine.snapshot());
});

/** 잔고 새로고침 */
app.post('/api/account/balance', async (_req, res) => {
  try {
    const balance = await engine.refreshBalance();
    res.json({ ok: true, balance });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.friendly ?? err.message });
  } finally {
    broadcast(engine.snapshot());
  }
});

/** 거래소 포지션과 동기화 */
app.post('/api/account/sync', async (_req, res) => {
  try {
    const info = await engine.syncPositions();
    res.json({ ok: true, ...info });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.friendly ?? err.message });
  } finally {
    broadcast(engine.snapshot());
  }
});

/** 현재 보유 종목의 거래 규격 (최소 주문금액 확인용) */
app.get('/api/account/filters', async (req, res) => {
  if (!engine.broker.isLive) return res.status(400).json({ error: '계정이 연결되어 있지 않습니다.' });
  const symbol = String(req.query.symbol ?? '').toUpperCase();
  if (!engine.broker.client.filters.size) await engine.broker.client.loadFilters();
  res.json({ filters: engine.broker.client.filterFor(symbol) });
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

wss.on('connection', (ws) => {
  clients.add(ws);
  console.log(`[ws] 클라이언트 연결 (${clients.size}개)`);
  send(ws, engine.snapshot());

  ws.on('close', () => {
    clients.delete(ws);
    console.log(`[ws] 클라이언트 해제 (${clients.size}개)`);
  });
  ws.on('error', () => clients.delete(ws));
});

// 1Hz: 전체 스냅샷
const stateTimer = setInterval(() => {
  // 먼저 가격 반영 + 청산 검사
  engine.processPriceUpdates();
  broadcast(engine.snapshot());
}, 1000);

// 250ms: 실시간 가격만 (부드러운 UI 갱신용)
let lastLiveSent = 0;
const liveTimer = setInterval(() => {
  if (!clients.size) return;
  const now = Date.now();
  if (now - lastLiveSent < 250) return;
  lastLiveSent = now;
  const msg = engine.livePrices();
  for (const ws of clients) send(ws, msg);
}, 250);

server.listen(PORT, () => {
  console.log(`\n  ▲ Coin Surfer 서버`);
  console.log(`  ├─ API/WS : http://localhost:${PORT}`);
  console.log(`  ├─ 설정   : 익절 ${settings.takeProfitPct}% / 손절 ${settings.stopLossPct}% / 최대 ${settings.maxPositions}종목`);
  console.log(`  └─ 마켓   : Binance USDⓈ-M Futures\n`);
  engine.start();
});

function shutdown(signal) {
  console.log(`\n[server] ${signal} 수신, 종료합니다...`);
  clearInterval(stateTimer);
  clearInterval(liveTimer);
  engine.stop();
  for (const ws of clients) ws.close();
  wss.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => console.error('[server] 처리되지 않은 rejection:', err));
