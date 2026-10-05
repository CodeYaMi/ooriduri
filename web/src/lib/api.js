const BASE = '';

/** 세션 토큰 + 활성 거래 계정 (모듈 전역 — 모든 요청에 자동 적용) */
let authToken = localStorage.getItem('cs_token') || '';
let activeAccountId = localStorage.getItem('cs_account') || '';
let onUnauthorized = null;

export function setAuthToken(token) {
  authToken = token || '';
  if (token) localStorage.setItem('cs_token', token);
  else localStorage.removeItem('cs_token');
}
export function getAuthToken() {
  return authToken;
}
export function setActiveAccount(id) {
  activeAccountId = id || '';
  if (id) localStorage.setItem('cs_account', id);
  else localStorage.removeItem('cs_account');
}
export function getActiveAccount() {
  return activeAccountId;
}
export function onAuthExpired(fn) {
  onUnauthorized = fn;
}

/** 거래 계정 스코프가 필요한 경로 */
const SCOPED = ['/api/settings', '/api/engine', '/api/portfolio', '/api/positions', '/api/trades', '/api/events', '/api/account'];

function scopedPath(path) {
  if (!activeAccountId) return path;
  if (!SCOPED.some((p) => path === p || path.startsWith(`${p}/`) || path.startsWith(`${p}?`))) return path;
  const sep = path.includes('?') ? '&' : '?';
  if (/(^|[?&])account=/.test(path)) return path;
  return `${path}${sep}account=${encodeURIComponent(activeAccountId)}`;
}

async function request(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers ?? {}) };
  if (authToken) headers.Authorization = `Bearer ${authToken}`;
  const res = await fetch(`${BASE}${scopedPath(path)}`, { ...options, headers });
  const text = await res.text();
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { error: text };
  }
  if (res.status === 401) {
    setAuthToken('');
    if (onUnauthorized) onUnauthorized(body);
    const err = new Error(body.error || '로그인이 필요합니다.');
    err.code = body.code ?? 'UNAUTHORIZED';
    throw err;
  }
  if (!res.ok) {
    const err = new Error(body.error || `요청 실패 (HTTP ${res.status})`);
    err.code = body.code;
    throw err;
  }
  return body;
}

export const api = {
  health: () => request('/api/health'),
  getSettings: () => request('/api/settings'),
  saveSettings: (settings) => request('/api/settings', { method: 'PUT', body: JSON.stringify(settings) }),
  resetSettings: () => request('/api/settings/reset', { method: 'POST' }),
  engine: (action) => request(`/api/engine/${action}`, { method: 'POST' }),
  resetPortfolio: () => request('/api/portfolio/reset', { method: 'POST' }),
  closeAll: () => request('/api/portfolio/close-all', { method: 'POST' }),
  buy: (symbol) => request(`/api/positions/${symbol}/buy`, { method: 'POST' }),
  sell: (symbol) => request(`/api/positions/${symbol}/sell`, { method: 'POST' }),
  klines: (symbol, interval = '1m', limit = 120) =>
    request(`/api/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`),
  trades: () => request('/api/trades'),
  universe: () => request('/api/universe'),

  // ── 인증 / 사용자 ──
  authStatus: () => request('/api/auth/status'),
  authSetup: (payload) => request('/api/auth/setup', { method: 'POST', body: JSON.stringify(payload) }),
  login: (payload) => request('/api/auth/login', { method: 'POST', body: JSON.stringify(payload) }),
  logout: () => request('/api/auth/logout', { method: 'POST' }),
  me: () => request('/api/auth/me'),
  listUsers: () => request('/api/users'),
  createUser: (payload) => request('/api/users', { method: 'POST', body: JSON.stringify(payload) }),
  resetUserPassword: (id, password) =>
    request(`/api/users/${id}/password`, { method: 'POST', body: JSON.stringify({ password }) }),
  setUserDisabled: (id, disabled) =>
    request(`/api/users/${id}/disabled`, { method: 'POST', body: JSON.stringify({ disabled }) }),
  deleteUser: (id) => request(`/api/users/${id}`, { method: 'DELETE' }),

  // ── 거래 계정 ──
  listTradingAccounts: () => request('/api/trading-accounts'),
  createTradingAccount: (payload) => request('/api/trading-accounts', { method: 'POST', body: JSON.stringify(payload) }),
  renameTradingAccount: (id, name) =>
    request(`/api/trading-accounts/${id}`, { method: 'PATCH', body: JSON.stringify({ name }) }),
  setTradingAccountDisabled: (id, disabled) =>
    request(`/api/trading-accounts/${id}/disabled`, { method: 'POST', body: JSON.stringify({ disabled }) }),
  deleteTradingAccount: (id) => request(`/api/trading-accounts/${id}`, { method: 'DELETE' }),

  // ── 마스터 ──
  adminOverview: () => request('/api/admin/overview'),
  adminEvents: (params = {}) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') q.set(k, v);
    }
    const qs = q.toString();
    return request(`/api/admin/events${qs ? `?${qs}` : ''}`);
  },
  myEvents: (params = {}) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') q.set(k, v);
    }
    const qs = q.toString();
    return request(`/api/events${qs ? `?${qs}` : ''}`);
  },

  // ── 계정 / 실거래 ──
  getAccount: () => request('/api/account'),
  saveCredentials: (payload) => request('/api/account/credentials', { method: 'POST', body: JSON.stringify(payload) }),
  deleteCredentials: () => request('/api/account/credentials', { method: 'DELETE' }),
  verifyCredentials: (payload) => request('/api/account/verify', { method: 'POST', body: JSON.stringify(payload) }),
  connect: (mode, confirm = false, dryRun = false) =>
    request('/api/account/connect', { method: 'POST', body: JSON.stringify({ mode, confirm, dryRun }) }),
  setDryRun: (enabled) => request('/api/account/dry-run', { method: 'POST', body: JSON.stringify({ enabled }) }),
  disconnect: () => request('/api/account/disconnect', { method: 'POST' }),
  refreshBalance: () => request('/api/account/balance', { method: 'POST' }),
  syncPositions: () => request('/api/account/sync', { method: 'POST' }),
  filters: (symbol) => request(`/api/account/filters?symbol=${symbol}`),
};
