import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.COIN_SURFER_DATA_DIR || path.join(__dirname, '..', 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');

// ── 정책 ─────────────────────────────────────────────────────
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7일
const MIN_PASSWORD_LEN = 8;
const MAX_NAME_LEN = 32;
const LOGIN_MAX_FAILS = 5;
const LOGIN_WINDOW_MS = 60_000;

/** 로그인 시도 제한 (메모리, 프로세스 재시작 시 초기화) */
const loginAttempts = new Map(); // key: `${ip}:${name}` → { count, firstAt }

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
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
  ensureDir();
  fs.writeFileSync(file, JSON.stringify(data, null, 2), { encoding: 'utf8', mode });
  try {
    fs.chmodSync(file, mode);
  } catch {
    /* 파일시스템이 권한 변경을 지원하지 않을 수 있음 */
  }
}

// ── 비밀번호 해시 (scrypt, 솔트 포함) ─────────────────────────
export function hashPassword(password, saltHex = null) {
  const salt = saltHex ?? crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), Buffer.from(salt, 'hex'), 64).toString('hex');
  return { salt, hash };
}

export function verifyPassword(password, saltHex, hashHex) {
  try {
    const { hash } = hashPassword(password, saltHex);
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(String(hashHex), 'hex'));
  } catch {
    return false;
  }
}

// ── 사용자 저장소 ────────────────────────────────────────────
export function loadUsers() {
  const rows = readJson(USERS_FILE, []);
  return Array.isArray(rows) ? rows : [];
}

function saveUsers(rows) {
  writeJson(USERS_FILE, rows, 0o600);
}

export function hasAnyUser() {
  return loadUsers().length > 0;
}

export function findUserByName(name) {
  const norm = String(name ?? '').trim();
  return loadUsers().find((u) => u.name === norm && !u.disabled) ?? null;
}

export function findUserById(id) {
  return loadUsers().find((u) => u.id === id) ?? null;
}

/** 외부 노출용 (해시 제외) */
export function publicUser(u) {
  if (!u) return null;
  return { id: u.id, name: u.name, role: u.role, disabled: Boolean(u.disabled), createdAt: u.createdAt };
}

function validateName(name) {
  const norm = String(name ?? '').trim();
  if (!norm) return '이름을 입력하세요.';
  if (norm.length > MAX_NAME_LEN) return `이름은 ${MAX_NAME_LEN}자 이내여야 합니다.`;
  if (!/^[A-Za-z0-9가-힣_\-]+$/.test(norm)) return '이름은 영문·숫자·한글·밑줄·하이픈만 사용할 수 있습니다.';
  return null;
}

function validatePassword(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LEN) {
    return `비밀번호는 ${MIN_PASSWORD_LEN}자 이상이어야 합니다.`;
  }
  if (password.length > 128) return '비밀번호는 128자 이내여야 합니다.';
  return null;
}

/** 최초 마스터 생성 — 사용자가 한 명도 없을 때만 허용 */
export function createMaster({ name = 'master', password }) {
  if (hasAnyUser()) throw new Error('이미 사용자가 존재합니다.');
  const nameErr = validateName(name);
  if (nameErr) throw new Error(nameErr);
  const pwErr = validatePassword(password);
  if (pwErr) throw new Error(pwErr);

  const { salt, hash } = hashPassword(password);
  const user = {
    id: `u_${crypto.randomBytes(8).toString('hex')}`,
    name: String(name).trim(),
    role: 'master',
    passSalt: salt,
    passHash: hash,
    disabled: false,
    createdAt: Date.now(),
  };
  saveUsers([user]);
  return publicUser(user);
}

/** 마스터가 일반 사용자 생성 */
export function createUser({ name, password, role = 'user' }) {
  const nameErr = validateName(name);
  if (nameErr) throw new Error(nameErr);
  const pwErr = validatePassword(password);
  if (pwErr) throw new Error(pwErr);
  if (role !== 'user' && role !== 'master') throw new Error('role 은 user 또는 master 여야 합니다.');

  const users = loadUsers();
  const norm = String(name).trim();
  if (users.some((u) => u.name === norm)) throw new Error('이미 존재하는 이름입니다.');

  const { salt, hash } = hashPassword(password);
  const user = {
    id: `u_${crypto.randomBytes(8).toString('hex')}`,
    name: norm,
    role,
    passSalt: salt,
    passHash: hash,
    disabled: false,
    createdAt: Date.now(),
  };
  users.push(user);
  saveUsers(users);
  return publicUser(user);
}

export function setUserDisabled(id, disabled) {
  const users = loadUsers();
  const u = users.find((x) => x.id === id);
  if (!u) throw new Error('사용자를 찾을 수 없습니다.');
  if (u.role === 'master' && disabled) {
    const activeMasters = users.filter((x) => x.role === 'master' && !x.disabled && x.id !== id);
    if (!activeMasters.length) throw new Error('마지막 마스터는 비활성화할 수 없습니다.');
  }
  u.disabled = Boolean(disabled);
  saveUsers(users);
  if (disabled) revokeSessionsForUser(id);
  return publicUser(u);
}

export function resetUserPassword(id, password) {
  const pwErr = validatePassword(password);
  if (pwErr) throw new Error(pwErr);
  const users = loadUsers();
  const u = users.find((x) => x.id === id);
  if (!u) throw new Error('사용자를 찾을 수 없습니다.');
  const { salt, hash } = hashPassword(password);
  u.passSalt = salt;
  u.passHash = hash;
  saveUsers(users);
  revokeSessionsForUser(id);
  return publicUser(u);
}

export function deleteUser(id) {
  const users = loadUsers();
  const u = users.find((x) => x.id === id);
  if (!u) throw new Error('사용자를 찾을 수 없습니다.');
  if (u.role === 'master') {
    const otherMasters = users.filter((x) => x.role === 'master' && x.id !== id);
    if (!otherMasters.length) throw new Error('마지막 마스터는 삭제할 수 없습니다.');
  }
  saveUsers(users.filter((x) => x.id !== id));
  revokeSessionsForUser(id);
  return publicUser(u);
}

// ── 세션 (토큰) ──────────────────────────────────────────────
function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function loadSessions() {
  const rows = readJson(SESSIONS_FILE, []);
  if (!Array.isArray(rows)) return [];
  const now = Date.now();
  const alive = rows.filter((s) => s.expiresAt > now);
  if (alive.length !== rows.length) writeJson(SESSIONS_FILE, alive, 0o600);
  return alive;
}

function saveSessions(rows) {
  writeJson(SESSIONS_FILE, rows, 0o600);
}

export function issueSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  const sessions = loadSessions();
  sessions.push({ tokenHash: tokenHash(token), userId, createdAt: now, expiresAt: now + SESSION_TTL_MS });
  // 사용자당 세션上限 (오래된 것부터 정리)
  const mine = sessions.filter((s) => s.userId === userId);
  if (mine.length > 10) {
    const drop = new Set(mine.slice(0, mine.length - 10).map((s) => s.tokenHash));
    saveSessions(sessions.filter((s) => !drop.has(s.tokenHash)));
  } else {
    saveSessions(sessions);
  }
  return { token, expiresAt: now + SESSION_TTL_MS };
}

export function resolveSession(token) {
  if (!token) return null;
  const sessions = loadSessions();
  const s = sessions.find((x) => {
    try {
      return crypto.timingSafeEqual(Buffer.from(x.tokenHash, 'hex'), Buffer.from(tokenHash(token), 'hex'));
    } catch {
      return false;
    }
  });
  if (!s) return null;
  const user = findUserById(s.userId);
  if (!user || user.disabled) return null;
  // 원본(해시 포함)이 아니라 공개 형태로 반환 — 세션 해석 결과가
  // 그대로 응답에 실려도 해시가 노출되지 않는다
  return { user: publicUser(user), expiresAt: s.expiresAt };
}

export function revokeSession(token) {
  if (!token) return;
  const h = tokenHash(token);
  saveSessions(loadSessions().filter((s) => s.tokenHash !== h));
}

export function revokeSessionsForUser(userId) {
  saveSessions(loadSessions().filter((s) => s.userId !== userId));
}

// ── 로그인 (시도 제한 포함) ──────────────────────────────────
function attemptKey(ip, name) {
  return `${ip ?? '?'}:${String(name ?? '').trim().toLowerCase()}`;
}

function checkRateLimit(ip, name) {
  const key = attemptKey(ip, name);
  const now = Date.now();
  const rec = loginAttempts.get(key);
  if (rec && now - rec.firstAt > LOGIN_WINDOW_MS) loginAttempts.delete(key);
  const cur = loginAttempts.get(key);
  if (cur && cur.count >= LOGIN_MAX_FAILS) {
    const waitSec = Math.ceil((LOGIN_WINDOW_MS - (now - cur.firstAt)) / 1000);
    const err = new Error(`로그인 시도가 너무 많습니다. ${waitSec}초 후 다시 시도하세요.`);
    err.status = 429;
    throw err;
  }
}

function recordFail(ip, name) {
  const key = attemptKey(ip, name);
  const now = Date.now();
  const rec = loginAttempts.get(key);
  if (!rec || now - rec.firstAt > LOGIN_WINDOW_MS) loginAttempts.set(key, { count: 1, firstAt: now });
  else rec.count += 1;
}

export function login({ name, password, ip }) {
  checkRateLimit(ip, name);
  const user = findUserByName(name);
  const ok = user && verifyPassword(password, user.passSalt, user.passHash);
  if (!ok) {
    recordFail(ip, name);
    const err = new Error('이름 또는 비밀번호가 올바르지 않습니다.');
    err.status = 401;
    throw err;
  }
  loginAttempts.delete(attemptKey(ip, name));
  const { token, expiresAt } = issueSession(user.id);
  return { token, expiresAt, user: publicUser(user) };
}

// ── Express 미들웨어 ─────────────────────────────────────────
export function bearerToken(req) {
  const h = req.headers?.authorization ?? '';
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  if (m) return m[1].trim();
  // WebSocket 핸드셰이크는 헤더를 못 붙이므로 쿼리 허용
  if (req.query?.token) return String(req.query.token);
  return null;
}

/** 로그인 필수. req.user = { id, name, role } */
export function requireAuth(req, res, next) {
  const session = resolveSession(bearerToken(req));
  if (!session) return res.status(401).json({ ok: false, error: '로그인이 필요합니다.', code: 'UNAUTHORIZED' });
  req.user = { id: session.user.id, name: session.user.name, role: session.user.role };
  req.sessionExpiresAt = session.expiresAt;
  next();
}

/** 마스터 전용 */
export function requireMaster(req, res, next) {
  if (req.user?.role !== 'master') {
    return res.status(403).json({ ok: false, error: '마스터 권한이 필요합니다.', code: 'FORBIDDEN' });
  }
  next();
}

export { SESSION_TTL_MS, USERS_FILE };
