/**
 * 청산 내역 CSV 생성 (순수 함수 — 테스트 가능).
 * 한글 엑셀 호환을 위해 UTF-8 BOM을 앞에 붙인다.
 */

const REASON_KO = {
  'take-profit': '익절',
  'stop-loss': '손절',
  'trailing-stop': '트레일링스탑',
  'time-stop': '시간청산',
  manual: '수동',
};

const HEADERS = ['청산시각', '종목', '청산사유', '진입가', '청산가', '수익률(%)', '손익(USDT)', '보유시간(분)', '부분체결'];

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** 로컬 시간대 기준 엑셀 친화 형식 */
export function formatLocal(ts) {
  if (ts === null || ts === undefined) return '';
  const d = new Date(ts);
  if (!Number.isFinite(d.getTime())) return '';
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function esc(value) {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function num(value, digits) {
  return Number.isFinite(value) ? Number(value).toFixed(digits) : '';
}

/**
 * @param {Array} trades 포트폴리오 청산 기록 (exitTime 내림차순 무관)
 * @returns {string} BOM 포함 CSV
 */
export function tradesToCsv(trades) {
  const lines = [HEADERS.join(',')];
  const sorted = [...(trades ?? [])].sort((a, b) => (b.exitTime ?? 0) - (a.exitTime ?? 0));
  for (const t of sorted) {
    lines.push(
      [
        esc(formatLocal(t.exitTime)),
        esc(t.symbol ?? ''),
        esc(REASON_KO[t.exitReason] ?? t.exitReason ?? ''),
        esc(num(t.entryPrice, 8)),
        esc(num(t.exitPrice, 8)),
        esc(t.pnlPct === undefined || t.pnlPct === null ? '' : (Number(t.pnlPct) * 100).toFixed(3)),
        esc(num(t.pnlUSDT, 4)),
        esc(t.holdMinutes === undefined || t.holdMinutes === null ? '' : Number(t.holdMinutes).toFixed(1)),
        esc(t.partial ? 'Y' : ''),
      ].join(','),
    );
  }
  return `﻿${lines.join('\n')}\n`;
}

/** 다운로드 파일명 (윈도우 금지문자 제거) */
export function csvFilename(accountName) {
  const safe = String(accountName ?? 'account').replace(/[\\/:*?"<>|]/g, '_').slice(0, 40) || 'account';
  const d = new Date();
  const stamp = `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}`;
  return `coin-surfer-trades_${safe}_${stamp}.csv`;
}
