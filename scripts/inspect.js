/**
 * 엔진 상태 점검 스크립트 (개발용)
 *   node scripts/inspect.js
 * WebSocket 으로 스냅샷을 받아 후보/포지션/설정을 출력한다.
 */
import WebSocket from 'ws';

const url = process.env.WS_URL || 'ws://localhost:8787/ws';

const ws = new WebSocket(url);

const timer = setTimeout(() => {
  console.error('응답 타임아웃');
  process.exit(1);
}, 15_000);

ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.type !== 'state') return;

  const d = msg.data;
  console.log('═══════════════════════════════════════════════════');
  console.log('실행 상태  :', d.running, '| 24h폴링:', d.status.market, '| 실시간가격:', d.status.priceFeed);
  console.log('스캔       :', d.status.scanCount, '회 |', d.status.lastScanMs, 'ms | 시장', d.marketCount, '종목 | 분봉', d.trackedHistory, '종목');
  console.log('추적 구독  :', d.tracked.length, '종목 →', d.tracked.join(', '));
  console.log('1분봉 폴링 :', d.status.lastBarPollMs ?? '-', 'ms |', d.status.lastBarPollAt ? Math.round((Date.now() - d.status.lastBarPollAt) / 1000) + '초 전' : '-');
  console.log('───────────────────────────────────────────────────');
  console.log('요약       :', JSON.stringify(d.summary, null, 1));
  console.log('───────────────────────────────────────────────────');
  console.log('후보', d.candidates.length, '종목');
  for (const c of d.candidates) {
    console.log(
      `  ${c.symbol.padEnd(14)} ${String(c.price).padStart(11)}  z=${String(c.z).padStart(5)}  ${String(c.ratio).padStart(5)}배  ` +
        `평균/분=${Math.round(c.recentAvg).toLocaleString().padStart(12)}  pace=${c.livePace ? Math.round(c.livePace).toLocaleString() : '—'}  24h=${c.change24hPct.toFixed(2)}%`,
    );
  }
  console.log('───────────────────────────────────────────────────');
  console.log('보유 포지션', d.positions.length, '종목');
  for (const p of d.positions) {
    console.log(
      `  ${p.symbol.padEnd(14)} 진입=${p.entryPrice} 현재=${p.markPrice} 손익=${p.pnlPct.toFixed(2)}% (${p.pnlUSDT})`,
    );
  }
  console.log('청산 내역', d.trades.length, '건');
  for (const t of d.trades.slice(0, 8)) {
    console.log(`  ${new Date(t.exitTime).toISOString().slice(11, 19)} ${t.symbol.padEnd(14)} ${t.reason.padEnd(14)} ${t.pnlPct.toFixed(2)}% ${t.pnlUSDT}`);
  }
  console.log('═══════════════════════════════════════════════════');

  clearTimeout(timer);
  ws.close();
  process.exit(0);
});

ws.on('error', (err) => {
  console.error('WebSocket 오류:', err.message);
  process.exit(1);
});
