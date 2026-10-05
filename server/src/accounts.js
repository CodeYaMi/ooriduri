import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_SETTINGS } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.COIN_SURFER_DATA_DIR || path.join(__dirname, '..', 'data');
const ACCOUNTS_DIR = path.join(DATA_DIR, 'accounts');
const META_FILE = path.join(ACCOUNTS_DIR, 'meta.json');

// 레거시 단일 파일 (마이그레이션 전용)
const LEGACY = {
  settings: path.join(DATA_DIR, 'settings.json'),
  portfolio: path.join(DATA_DIR, 'portfolio.json'),
  credentials: path.join(DATA_DIR, 'credentials.json'),
  liveArmed: path.join(DATA_DIR, 'live-armed.json'),
};

const MAX_EVENT_LINES = 10_000;
const EVENT_ROTATE_KEEP = 5_000;

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data, mode = 0o600) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(data, null, 2), { encoding: 'utf8', mode });
  try {
    fs.chmodSync(file, mode);
  } catch {
    /* 파일시스템이 권한 변경을 지원하지 않을 수 있음 */
  }
}

// ── 거래 계정 메타 ───────────────────────────────────────────
// meta.json: [{ id, name, ownerUserId, createdAt, disabled }]
export function loadAccountMetas() {
  const rows = readJson(META_FILE, []);
  return Array.isArray(rows) ? rows : [];
}

function saveAccountMetas(rows) {
  writeJson(META_FILE, rows, 0o600);
}

export function accountDir(id) {
  return path.join(ACCOUNTS_DIR, id);
}

export function accountPaths(id) {
  const dir = accountDir(id);
  return {
    dir,
    settings: path.join(dir, 'settings.json'),
    portfolio: path.join(dir, 'portfolio.json'),
    credentials: path.join(dir, 'credentials.json'),
    liveArmed: path.join(dir, 'live-armed.json'),
    events: path.join(dir, 'events.jsonl'),
  };
}

export function publicAccountMeta(m) {
  if (!m) return null;
  return { id: m.id, name: m.name, ownerUserId: m.ownerUserId, disabled: Boolean(m.disabled), createdAt: m.createdAt };
}

/** 사용자가 볼 수 있는 계정 (마스터는 전부, 일반은 본인 소유의 활성 계정) */
export function visibleAccounts(user) {
  const all = loadAccountMetas();
  if (user.role === 'master') return all.map(publicAccountMeta);
  return all.filter((m) => m.ownerUserId === user.id && !m.disabled).map(publicAccountMeta);
}

export function getAccountMeta(id) {
  return loadAccountMetas().find((m) => m.id === id) ?? null;
}

/** 접근 권한 확인. 마스터는 전부, 일반은 본인 소유 활성 계정만 */
export function canAccessAccount(user, accountId) {
  const m = getAccountMeta(accountId);
  if (!m) return null;
  if (user.role === 'master') return m;
  if (m.ownerUserId === user.id && !m.disabled) return m;
  return null;
}

export function createTradingAccount({ name, ownerUserId }) {
  const norm = String(name ?? '').trim() || '기본';
  if (norm.length > 32) throw new Error('계정 이름은 32자 이내여야 합니다.');
  const id = `a_${crypto.randomBytes(8).toString('hex')}`;
  const meta = { id, name: norm, ownerUserId, disabled: false, createdAt: Date.now() };
  const metas = loadAccountMetas();
  metas.push(meta);
  saveAccountMetas(metas);
  ensureDir(accountDir(id));
  // 설정 파일이 없으면 첫 로드 시 기본값으로 동작하므로 미리 만들지 않는다
  return publicAccountMeta(meta);
}

/** 사용자의 기본 거래 계정 (없으면 생성) */
export function ensureDefaultAccount(ownerUserId, name = '기본') {
  const existing = loadAccountMetas().find((m) => m.ownerUserId === ownerUserId && !m.disabled);
  if (existing) return publicAccountMeta(existing);
  return createTradingAccount({ name, ownerUserId });
}

export function setAccountDisabled(id, disabled) {
  const metas = loadAccountMetas();
  const m = metas.find((x) => x.id === id);
  if (!m) throw new Error('거래 계정을 찾을 수 없습니다.');
  m.disabled = Boolean(disabled);
  saveAccountMetas(metas);
  return publicAccountMeta(m);
}

export function renameTradingAccount(id, name) {
  const norm = String(name ?? '').trim();
  if (!norm || norm.length > 32) throw new Error('계정 이름은 1~32자여야 합니다.');
  const metas = loadAccountMetas();
  const m = metas.find((x) => x.id === id);
  if (!m) throw new Error('거래 계정을 찾을 수 없습니다.');
  m.name = norm;
  saveAccountMetas(metas);
  return publicAccountMeta(m);
}

export function deleteTradingAccount(id) {
  const m = getAccountMeta(id);
  if (!m) throw new Error('거래 계정을 찾을 수 없습니다.');
  const paths = accountPaths(id);
  if (fs.existsSync(paths.portfolio)) {
    try {
      const pf = JSON.parse(fs.readFileSync(paths.portfolio, 'utf8'));
      if (Array.isArray(pf.positions) && pf.positions.length) {
        throw new Error('보유 포지션이 있는 계정은 삭제할 수 없습니다. 먼저 전량 청산하세요.');
      }
    } catch (err) {
      if (err.message.includes('보유 포지션')) throw err;
      // 파싱 실패는 삭제 진행 (깨진 파일)
    }
  }
  fs.rmSync(paths.dir, { recursive: true, force: true });
  saveAccountMetas(loadAccountMetas().filter((x) => x.id !== id));
  return true;
}

/** 사용자의 모든 거래 계정 비활성화 (사용자 삭제/정지 시) */
export function disableAccountsOfUser(ownerUserId) {
  const metas = loadAccountMetas();
  let changed = 0;
  for (const m of metas) {
    if (m.ownerUserId === ownerUserId && !m.disabled) {
      m.disabled = true;
      changed += 1;
    }
  }
  if (changed) saveAccountMetas(metas);
  return changed;
}

// ── 레거시 마이그레이션 ─────────────────────────────────────
/** 구 단일 파일이 있고 아직 계정이 하나도 없으면 true */
export function hasLegacyData() {
  return fs.existsSync(LEGACY.settings) || fs.existsSync(LEGACY.portfolio) || fs.existsSync(LEGACY.credentials);
}

/**
 * 레거시 파일을 새 계정 디렉터리로 이동.
 * @returns 이동한 파일명 목록
 */
export function migrateLegacyToAccount(accountId) {
  const paths = accountPaths(accountId);
  ensureDir(paths.dir);
  const moved = [];
  for (const [key, src] of Object.entries(LEGACY)) {
    if (!fs.existsSync(src)) continue;
    const dest = paths[key];
    if (fs.existsSync(dest)) continue; // 이미 있으면 덮지 않음
    fs.renameSync(src, dest);
    try {
      fs.chmodSync(dest, 0o600);
    } catch {
      /* noop */
    }
    moved.push(key);
  }
  return moved;
}

// ── 이벤트 로그 (계정별 append-only) ─────────────────────────
// events.jsonl 한 줄 = { ts, type, actor, msg }
export const EVENT_TYPES = ['buy', 'sell', 'error', 'settings', 'account', 'system'];

export function appendEvent(accountId, type, msg, actor = null) {
  if (!EVENT_TYPES.includes(type)) type = 'system';
  const line = JSON.stringify({ ts: Date.now(), type, actor: actor ?? null, msg: String(msg).slice(0, 500) });
  const { events } = accountPaths(accountId);
  try {
    ensureDir(path.dirname(events));
    fs.appendFileSync(events, line + '\n', 'utf8');
    rotateEventsIfNeeded(events);
  } catch (err) {
    console.error(`[events] ${accountId} 기록 실패:`, err.message);
  }
}

/** 파일이 너무 커지면 뒤쪽 절반만 남긴다 */
function rotateEventsIfNeeded(file) {
  try {
    const st = fs.statSync(file);
    if (st.size < 2 * 1024 * 1024) return;
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    if (lines.length <= MAX_EVENT_LINES) return;
    fs.writeFileSync(file, lines.slice(-EVENT_ROTATE_KEEP).join('\n') + '\n', 'utf8');
  } catch {
    /* noop */
  }
}

/**
 * @param {{type?:string, limit?:number, before?:number, after?:number, q?:string}} opts
 */
export function readEvents(accountId, { type = null, limit = 200, before = 0, after = 0, q = '' } = {}) {
  const { events } = accountPaths(accountId);
  const safeLimit = Math.min(Math.max(Number(limit) || 200, 1), 1000);
  let lines = [];
  try {
    if (!fs.existsSync(events)) return [];
    const raw = fs.readFileSync(events, 'utf8').trim();
    if (!raw) return [];
    lines = raw.split('\n');
  } catch {
    return [];
  }
  const out = [];
  for (let i = lines.length - 1; i >= 0 && out.length < safeLimit; i -= 1) {
    let e;
    try {
      e = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (before && !(e.ts < before)) continue;
    if (after && !(e.ts > after)) continue;
    if (type && e.type !== type) continue;
    if (q && !String(e.msg).includes(q)) continue;
    out.push(e);
  }
  return out;
}

/** 마스터용: 모든 계정의 이벤트를 시간순으로 합친다 */
export function readAllEvents(metas, { type = null, limit = 200, before = 0, q = '' } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 200, 1), 1000);
  const per = Math.max(20, Math.ceil(safeLimit / Math.max(metas.length, 1)));
  let merged = [];
  for (const m of metas) {
    const rows = readEvents(m.id, { type, limit: per, before, q });
    for (const r of rows) merged.push({ ...r, accountId: m.id, accountName: m.name, ownerUserId: m.ownerUserId });
  }
  merged.sort((a, b) => b.ts - a.ts);
  return merged.slice(0, safeLimit);
}

export { ACCOUNTS_DIR, DEFAULT_SETTINGS };
