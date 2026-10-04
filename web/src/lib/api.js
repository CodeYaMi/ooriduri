const BASE = '';

async function request(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const text = await res.text();
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { error: text };
  }
  if (!res.ok) throw new Error(body.error || `요청 실패 (HTTP ${res.status})`);
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
