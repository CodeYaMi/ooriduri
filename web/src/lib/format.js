export const fmtUsd = (n, digits = 2) =>
  Number.isFinite(n)
    ? n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })
    : '—';

export const fmtPct = (n, digits = 2) => (Number.isFinite(n) ? `${n >= 0 ? '+' : ''}${n.toFixed(digits)}%` : '—');

export const fmtSignedUsd = (n, digits = 2) =>
  Number.isFinite(n) ? `${n >= 0 ? '+' : ''}${fmtUsd(n, digits)}` : '—';

/** 가격: 값대별 자릿수를 달리해 실시간 변동이 보이도록 표시 */
export function fmtPrice(n) {
  if (!Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 1000) return n.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  if (abs >= 1) return n.toFixed(4);
  if (abs >= 0.1) return n.toFixed(5);
  if (abs >= 0.01) return n.toFixed(6); // 저가 코인: 틱스텝이 보일 정도까지
  if (abs >= 0.0001) return n.toFixed(7);
  return n.toPrecision(4);
}

export function fmtQty(n) {
  if (!Number.isFinite(n)) return '—';
  if (n >= 1000) return n.toFixed(2);
  if (n >= 1) return n.toFixed(4);
  return n.toPrecision(4);
}

/** 66,543,210 → 66.5M */
export function fmtCompact(n) {
  if (!Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 1e12) return `${(n / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toFixed(0);
}

export function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export const pnlClass = (n) => (n > 0 ? 'up' : n < 0 ? 'down' : 'flat');

export const REASON_LABEL = {
  'take-profit': '익절',
  'stop-loss': '손절',
  'trailing-stop': '트레일링',
  'time-stop': '시간만료',
  manual: '수동',
};
