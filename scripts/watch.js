/**
 * 분봉 폴러가 실제로 히스토리를 적재하는지 검증 (개발용)
 * 2분간 지켜보며 확정봉 개수 증가와 z-score 변화를 확인한다.
 */
import WebSocket from 'ws';

const DURATION_MS = Number(process.argv[2] ?? 150_000);
const START = Date.now();
const BASE = process.env.WS_URL || 'ws://localhost:8787/ws';
const token = process.env.CS_TOKEN ?? '';
const wantAccount = process.argv[3] ?? null;
if (!token) {
  console.error('CS_TOKEN 이 필요합니다 (로그인 후 세션 토큰).');
  process.exit(2);
}

const ws = new WebSocket(`${BASE}?token=${encodeURIComponent(token)}`);
let last = null;

ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.type !== 'state') return;
  if (wantAccount && msg.accountId !== wantAccount) return;
  last = msg.data;
});

const line = (s) => console.log(s);

setInterval(() => {
  if (!last) return;
  const el = Math.round((Date.now() - START) / 1000);
  const cand = last.candidates;
  line(`\n[${el}s] 스캔#${last.status.scanCount} | 1분봉폴링 ${last.status.lastBarPollMs}ms 전 ${Math.round((Date.now() - last.status.lastBarPollAt) / 1000)}초 | 가격 ${last.status.priceFeed}`);
  if (cand.length) {
    for (const c of cand.slice(0, 5)) {
      line(
        `   ${c.symbol.padEnd(14)} ${String(c.price).padStart(11)}  z=${String(c.z).padStart(6)}  ${String(c.ratio).padStart(5)}배  ` +
          `평균/분=${Math.round(c.recentAvg).toLocaleString().padStart(12)}  pace=${c.livePace ? Math.round(c.livePace).toLocaleString() : '—'}`,
      );
    }
  } else {
    line('   (후보 없음 — 임계값 미달)');
  }
  const p = last.positions;
  if (p.length) {
    for (const pos of p) line(`   보유 ${pos.symbol.padEnd(14)} ${pos.pnlPct.toFixed(2)}% (${pos.pnlUSDT})`);
  }
  if (last.trades.length) {
    const t = last.trades[0];
    line(`   최근 청산 ${t.symbol} ${t.reason} ${t.pnlPct.toFixed(2)}%`);
  }
}, 15_000);

setTimeout(() => {
  console.log('\n── 종료 ──');
  ws.close();
  process.exit(0);
}, DURATION_MS);
