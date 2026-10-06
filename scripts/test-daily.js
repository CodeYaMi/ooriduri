/**
 * 일별 실현 손익 집계 검증 (개발용)
 * 실행: node scripts/test-daily.js (파일시스템 미사용)
 */
import { Portfolio } from '../server/src/portfolio.js';

const base = {
  takeProfitPct: 10,
  stopLossPct: 5,
  trailingStopPct: 0,
  maxHoldMinutes: 0,
  initialCapitalUSDT: 10_000,
  positionSizeUSDT: 100,
  maxPositions: 10,
  topN: 10,
  cooldownMinutes: 0,
  takerFeeBps: 0,
  slippageBps: 0,
  autoTrade: 0,
};

let pass = 0;
let fail = 0;
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    pass += 1;
    console.log(`  ✅ ${name}`);
  } else {
    fail += 1;
    console.log(`  ❌ ${name}\n     기대: ${JSON.stringify(expected)}\n     실제: ${JSON.stringify(actual)}`);
  }
};

const DAY = 86_400_000;
// 고정 기준일 (로컬 날짜 경계와 무관하게 결정적)
const T0 = new Date(2026, 9, 6, 12, 0, 0).getTime(); // 10-06 12:00 로컬
const at = (dayOffset, hour = 12) => new Date(2026, 9, 6 + dayOffset, hour, 0, 0).getTime();

function trade(symbol, pnl, exitTime) {
  const entry = 100;
  const qty = 1;
  const exit = entry + pnl; // pnl>0 이면 익절가
  return {
    symbol,
    entryPrice: entry,
    exitPrice: exit,
    pnlPct: (exit - entry) / entry,
    pnlUSDT: pnl,
    exitReason: pnl >= 0 ? 'take-profit' : 'stop-loss',
    holdMinutes: 5,
    exitTime,
  };
}

console.log('\n── 1. 빈 기록 ──');
{
  const pf = new Portfolio();
  pf.init(base);
  const r = pf.dailyStats(30);
  check('days 비어 있음', r.days, []);
  check('합계 0', [r.total.pnl, r.total.trades, r.total.days], [0, 0, 0]);
  check('best/worst null', [r.total.bestDay, r.total.worstDay], [null, null]);
}

console.log('\n── 2. 날짜별 집계 ──');
{
  const pf = new Portfolio();
  pf.init(base);
  pf.trades = [
    trade('AUSDT', 10, at(0, 10)),
    trade('BUSD', -4, at(0, 15)),
    trade('CUSDT', 6, at(-1, 20)),
    trade('DUSDT', -2, at(-2, 9)),
    trade('EUSDT', 0, at(-2, 10)), // 본전
  ];
  const r = pf.dailyStats(30);
  check('거래일 3일', r.days.length, 3);
  check('오름차순', r.days.map((d) => d.date), ['2026-10-04', '2026-10-05', '2026-10-06']);

  const today = r.days[2];
  check('오늘 2건', today.trades, 2);
  check('오늘 손익 +6', today.pnl, 6);
  check('오늘 1승 1패', [today.wins, today.losses], [1, 1]);
  check('오늘 승률 50', today.winRate, 50);
  check('오늘 최고 +10', today.best, 10);
  check('오늘 최악 -4', today.worst, -4);
  check('오늘 대표 종목', [today.topSymbol, today.topSymbolPnl], ['AUSDT', 10]);

  const flat = r.days[0];
  check('본전일은 승도 패도 아님', [flat.wins, flat.losses], [0, 1]);
  check('본전일 손익 -2', flat.pnl, -2);

  check('합계 손익 +10', r.total.pnl, 10);
  check('합계 5건 2승 2패', [r.total.trades, r.total.wins, r.total.losses], [5, 2, 2]);
  check('합계 승률 40', r.total.winRate, 40);
  check('수익일 2 / 손실일 1', [r.total.upDays, r.total.downDays], [2, 1]);
  check('일평균', r.total.avgPerDay, Number((10 / 3).toFixed(4)));
  check('최고일', r.total.bestDay.date, '2026-10-06');
  check('최악일', r.total.worstDay.date, '2026-10-04');
}

console.log('\n── 3. 기간 필터 ──');
{
  const pf = new Portfolio();
  pf.init(base);
  pf.trades = [trade('AUSDT', 10, at(0)), trade('BUSD', 5, at(-10)), trade('CUSDT', 7, at(-40))];
  check('30일 → 2일', pf.dailyStats(30).days.length, 2);
  check('7일 → 1일', pf.dailyStats(7).days.length, 1);
  check('1일 → 오늘만', pf.dailyStats(1).days.map((d) => d.date), ['2026-10-06']);
  check('days 상한 365', pf.dailyStats(9999).total.trades, 3);
  check('days 하한 1', pf.dailyStats(0).days.length, 1);
  check('문자열 입력', pf.dailyStats('7').days.length, 1);
}

console.log('\n── 4. 자정 경계 ──');
{
  const pf = new Portfolio();
  pf.init(base);
  const justBefore = new Date(2026, 9, 5, 23, 59, 59).getTime();
  const justAfter = new Date(2026, 9, 6, 0, 0, 1).getTime();
  pf.trades = [trade('AUSDT', 1, justBefore), trade('BUSD', 2, justAfter)];
  const r = pf.dailyStats(30);
  check('자정 전후 분리', r.days.map((d) => d.date), ['2026-10-05', '2026-10-06']);
}

console.log('\n── 5. 비정상 데이터 내성 ──');
{
  const pf = new Portfolio();
  pf.init(base);
  pf.trades = [
    { symbol: 'X', pnlUSDT: NaN, exitTime: at(0) },
    { symbol: 'Y', exitTime: at(0) }, // pnl 없음
    { symbol: 'Z', pnlUSDT: 5, exitTime: null }, // 시각 없음 → 제외
    { symbol: 'W', pnlUSDT: 5, exitTime: 'bad' }, // 시각 무효 → 제외
  ];
  const r = pf.dailyStats(30);
  check('NaN/누락은 0으로', r.total.pnl, 0);
  check('유효 시각만 집계', r.total.trades, 2);
}

console.log(`\n${'═'.repeat(46)}\n통과 ${pass} / 실패 ${fail}\n`);
process.exit(fail === 0 ? 0 : 1);
