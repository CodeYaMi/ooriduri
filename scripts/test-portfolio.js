/** 가상 포트폴리오 익절/손절 로직 검증 (개발용) */
import { Portfolio } from '../server/src/portfolio.js';

let pass = 0;
let fail = 0;

function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    pass += 1;
    console.log(`  ✅ ${name}`);
  } else {
    fail += 1;
    console.log(`  ❌ ${name}\n     기대: ${JSON.stringify(expected)}\n     실제: ${JSON.stringify(actual)}`);
  }
}

const baseSettings = {
  takeProfitPct: 10,
  stopLossPct: 5,
  trailingStopPct: 0,
  maxHoldMinutes: 0,
  initialCapitalUSDT: 10_000,
  positionSizeUSDT: 100,
  maxPositions: 10,
  topN: 10,
  cooldownMinutes: 15,
  scanIntervalSec: 60,
  recentWindowMinutes: 3,
  lookbackMinutes: 30,
  zScoreThreshold: 2,
  surgeRatioThreshold: 2,
  minMinuteQuoteVolumeUSDT: 300_000,
  min24hQuoteVolumeUSDT: 20_000_000,
  maxSymbols: 200,
  minOnboardDays: 7,
  takerFeeBps: 5,
  slippageBps: 2,
  autoTrade: 1,
};

const zeroCost = { ...baseSettings, takerFeeBps: 0, slippageBps: 0 };
const withCost = baseSettings;

console.log('\n── 1. 진입가 기준 익절 +10% ──');
{
  const pf = new Portfolio();
  pf.init({ ...zeroCost, takeProfitPct: 10, stopLossPct: 5 });
  await pf.buy('TESTUSDT', 100, {});

  check('진입 직후 +9.99% → 청산 안 함', pf.checkExit(pf.positions.get('TESTUSDT'), 109.99, Date.now()), null);
  check('정확히 +10.0% → 익절', pf.checkExit(pf.positions.get('TESTUSDT'), 110.0, Date.now()), 'take-profit');
  check('+15% → 익절', pf.checkExit(pf.positions.get('TESTUSDT'), 115, Date.now()), 'take-profit');
}

console.log('\n── 2. 진입가 기준 손절 −5% ──');
{
  const pf = new Portfolio();
  pf.init({ ...zeroCost, takeProfitPct: 10, stopLossPct: 5 });
  await pf.buy('TESTUSDT', 100, {});

  check('−4.99% → 청산 안 함', pf.checkExit(pf.positions.get('TESTUSDT'), 95.01, Date.now()), null);
  check('정확히 −5.0% → 손절', pf.checkExit(pf.positions.get('TESTUSDT'), 95.0, Date.now()), 'stop-loss');
  check('−30% → 손절', pf.checkExit(pf.positions.get('TESTUSDT'), 70, Date.now()), 'stop-loss');
}

console.log('\n── 3. 기준값이 다르면 판정도 달라진다 ──');
{
  const pf = new Portfolio();
  pf.init({ ...zeroCost, takeProfitPct: 3, stopLossPct: 1 });
  await pf.buy('TESTUSDT', 200, {});
  check('TP +3% 설정 → +3.01% 익절', pf.checkExit(pf.positions.get('TESTUSDT'), 206.02, Date.now()), 'take-profit');
  check('TP +3% 설정 → +5% 익절', pf.checkExit(pf.positions.get('TESTUSDT'), 210, Date.now()), 'take-profit');

  const pf2 = new Portfolio();
  pf2.init({ ...zeroCost, takeProfitPct: 50, stopLossPct: 20 });
  pf2.buy('TESTUSDT', 200, {});
  check('TP +50%/SL −20% → −10% 는 보류', pf2.checkExit(pf2.positions.get('TESTUSDT'), 180, Date.now()), null);
  check('TP +50%/SL −20% → −20.1% 손절', pf2.checkExit(pf2.positions.get('TESTUSDT'), 159.9, Date.now()), 'stop-loss');
}

/** 엔진(processPriceUpdates)과 동일하게 "감지 → 체결"을 수행하는 헬퍼 */
async function tickAndSettle(pf, prices) {
  const exits = pf.update(prices);
  const closed = [];
  for (const e of exits) closed.push(await pf.sell(e.symbol, e.price, e.reason));
  return { exits, closed };
}

console.log('\n── 4. tick 시퀀스로 실제 청산 검증 ──');
{
  const pf = new Portfolio();
  pf.init({ ...zeroCost, takeProfitPct: 10, stopLossPct: 5 });
  await pf.buy('WINUSDT', 100, {});
  await pf.buy('LOSEUSDT', 100, {});

  const prices = new Map([
    ['WINUSDT', 100.5],
    ['LOSEUSDT', 99.8],
  ]);
  check('첫 tick: 청산 없음', pf.update(prices).length, 0);

  // 승리 종목은 +10% 돌파, 패배 종목은 −5% 돌파
  const { exits } = await tickAndSettle(
    pf,
    new Map([
      ['WINUSDT', 110.05],
      ['LOSEUSDT', 94.9],
    ]),
  );
  check('두 종목 동시 청산', exits.length, 2);
  check('익절 종목 사유', exits.find((e) => e.symbol === 'WINUSDT')?.reason, 'take-profit');
  check('손절 종목 사유', exits.find((e) => e.symbol === 'LOSEUSDT')?.reason, 'stop-loss');

  const win = pf.trades.find((t) => t.symbol === 'WINUSDT');
  const lose = pf.trades.find((t) => t.symbol === 'LOSEUSDT');
  check('익절 수익률 ≈ +10%', (win.pnlPct * 100).toFixed(2), '10.05');
  check('손절 손실률 ≈ −5%', (lose.pnlPct * 100).toFixed(2), '-5.10');
  check('보유 중인 포지션 0개', pf.positions.size, 0);
  check('현금 복원 (200 + 10.05 - 5.10)', pf.cash.toFixed(2), '10004.95');
  check('실현 손익 = +4.95', pf.realizedPnl.toFixed(2), '4.95');
  check('요약 승률 50%', pf.summary().winRate, 50);
}

console.log('\n── 5. 중복 진입 / 슬롯 / 잔고 제한 ──');
{
  const pf = new Portfolio();
  pf.init({ ...zeroCost, maxPositions: 2, positionSizeUSDT: 100, initialCapitalUSDT: 250 });
  check('첫 진입 성공', Boolean(await pf.buy('A', 10, {})), true);
  check('같은 종목 재진입 차단', (await pf.buy('A', 10, {})).error, 'A 이미 보유 중');
  check('두 번째 진입 성공', Boolean(await pf.buy('B', 10, {})), true);
  check('슬롯 초과 차단', (await pf.buy('C', 10, {})).error, '최대 보유 종목 수 도달');
  check('잔고 부족 차단', (await pf.buy('D', 10, {})).error, '최대 보유 종목 수 도달');
}

console.log('\n── 6. 수수료 · 슬리피지 반영 ──');
{
  const pf = new Portfolio();
  pf.init(withCost);
  const pos = await pf.buy('FEEUSDT', 100, {});
  // 매수: 100 * (1 + 0.0002) = 100.02
  check('매수 체결가 = ask + 슬리피지', pos.entryPrice.toFixed(4), '100.0200');
  check('수수료 0.05 차감', pf.totalFees.toFixed(4), '0.0500');
  check('현금 = 10000 - 100 - 0.05', pf.cash.toFixed(4), '9899.9500');

  const closed = await pf.sell('FEEUSDT', 100, 'manual');
  // 매도: 100 * (1 - 0.0002) = 99.98
  check('매도 체결가 = bid - 슬리피지', closed.exitPrice.toFixed(4), '99.9800');
  check('왕복 비용 반영 손익 < 0', closed.pnlUSDT < 0, true);
  check('누적 수수료 0.10', pf.totalFees.toFixed(4), '0.1000');
}

console.log('\n── 7. 트레일링 스탑 ──');
{
  const pf = new Portfolio();
  pf.init({ ...zeroCost, takeProfitPct: 100, stopLossPct: 90, trailingStopPct: 3 });
  const pos = await pf.buy('TRAILUSDT', 100, {});
  pf.mark('TRAILUSDT', 100);

  check('상승 중에는 보류', pf.checkExit(pos, 130, Date.now()), null);
  pos.highPrice = Math.max(pos.highPrice, 130);
  pf.mark('TRAILUSDT', 128);
  check('130 고점 후 3% = 126.1 아래로 하락 → 트레일링', pf.checkExit(pos, 126.0, Date.now()), 'trailing-stop');
  check('아직 유지 중', pf.checkExit(pos, 127, Date.now()), null);
}

console.log('\n── 8. 시간 기반 청산 ──');
{
  const pf = new Portfolio();
  pf.init({ ...zeroCost, takeProfitPct: 90, stopLossPct: 90, maxHoldMinutes: 30 });
  const pos = await pf.buy('TIMEUSDT', 100, {});
  check('29분은 보류', pf.checkExit(pos, 100, Date.now() + 29 * 60_000), null);
  check('31분은 시간 만료', pf.checkExit(pos, 100, Date.now() + 31 * 60_000), 'time-stop');
}

console.log(`\n${'═'.repeat(46)}\n통과 ${pass} / 실패 ${fail}\n`);
process.exit(fail === 0 ? 0 : 1);
