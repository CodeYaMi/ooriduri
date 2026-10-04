/**
 * 24시간 변동률 진입 필터 검증 (개발용)
 *
 * 핵심 원칙: 진입만 막고 청산은 열어둔다.
 * 하강 추세에서 손절까지 막히면 포지션이 갇힌다.
 */
import { Portfolio } from '../server/src/portfolio.js';
import { VolumeScanner } from '../server/src/scanner.js';

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

const base = {
  takeProfitPct: 10,
  stopLossPct: 5,
  trailingStopPct: 0,
  maxHoldMinutes: 0,
  initialCapitalUSDT: 10_000,
  positionSizeUSDT: 100,
  maxPositions: 10,
  topN: 10,
  cooldownMinutes: 15,
  zScoreThreshold: 2,
  surgeRatioThreshold: 2,
  minMinuteQuoteVolumeUSDT: 300_000,
  min24hQuoteVolumeUSDT: 20_000_000,
  recentWindowMinutes: 3,
  lookbackMinutes: 30,
  useRsiFilter: 0,
  rsiPeriod: 14,
  rsiMin: 45,
  rsiMax: 75,
  use24hChangeFilter: 1,
  minChange24hPct: 0,
  takerFeeBps: 0,
  slippageBps: 0,
  autoTrade: 1,
};

const fresh = (over = {}) => {
  const pf = new Portfolio();
  pf.init({ ...base, ...over });
  return pf;
};

console.log('\n── 1. 마이너스 변동 종목 진입 차단 ──');
{
  const pf = fresh();
  const r = await pf.buy('DOWNUSDT', 100, { change24hPct: -0.42, z: 3, ratio: 3 });
  check('24h −0.42% → 차단', typeof r.error === 'string' && r.error.includes('24시간 변동'), true);
  check('포지션 생성 안 됨', pf.positions.size, 0);
  check('차단 사유에 수치가 보임', r.error, '24시간 변동 -0.42% < 0% (진입 금지 설정)');
}

console.log('\n── 2. 플러스 변동 종목은 진입 허용 ──');
{
  const pf = fresh();
  const r = await pf.buy('UPUSDT', 100, { change24hPct: 1.5, z: 3, ratio: 3 });
  check('24h +1.5% → 진입', typeof r.error, 'undefined');
  check('포지션 생성됨', pf.positions.size, 1);
}
{
  const pf = fresh();
  const r = await pf.buy('FLATUSDT', 100, { change24hPct: 0, z: 3, ratio: 3 });
  check('24h 정확히 0% → 진입 허용 (0 미만만 차단)', typeof r.error, 'undefined');
}

console.log('\n── 3. 필터 OFF 이면 제한 없음 ──');
{
  const pf = fresh({ use24hChangeFilter: 0 });
  const r = await pf.buy('DOWNUSDT', 100, { change24hPct: -5, z: 3, ratio: 3 });
  check('필터 OFF → 마이너스도 진입', typeof r.error, 'undefined');
}

console.log('\n── 4. 임계값 조정 ──');
{
  const pf = fresh({ minChange24hPct: -3 });
  const r = await pf.buy('DOWNUSDT', 100, { change24hPct: -2, z: 3, ratio: 3 });
  check('하한 −3% → −2% 는 허용', typeof r.error, 'undefined');
}
{
  const pf = fresh({ minChange24hPct: 3 });
  const r = await pf.buy('UPUSDT', 100, { change24hPct: 1.5, z: 3, ratio: 3 });
  check('하한 +3% → +1.5% 는 차단', typeof r.error === 'string' && r.error.includes('24시간 변동'), true);
}
{
  const pf = fresh({ minChange24hPct: -100 });
  const r = await pf.buy('DOWNUSDT', 100, { change24hPct: -99, z: 3, ratio: 3 });
  check('하한 −100% → 사실상 제한 없음', typeof r.error, 'undefined');
}

console.log('\n── 5. 데이터 없으면 차단하지 않음 ──');
{
  const pf = fresh();
  const r = await pf.buy('NOSIGNAL', 100, {});
  check('change24hPct 없음 → 통과 (과잉 차단 방지)', typeof r.error, 'undefined');
}

console.log('\n── 6. [핵심] 청산은 24h 조건과 무관 ──');
{
  // 하강 추세 진입을 우회해 포지션을 만든 뒤, 조건이 켜져 있어도 손절되어야 한다
  const pf = fresh({ use24hChangeFilter: 0 });
  await pf.buy('TRAPPED', 100, { change24hPct: -8 }); // 필터 off 로 생성
  check('포지션 존재', pf.positions.size, 1);

  // 이제 필터를 켠다 (실거래 중 설정 변경 시나리오)
  pf.settings = { ...pf.settings, use24hChangeFilter: 1, minChange24hPct: 0 };

  const exits = pf.update(new Map([['TRAPPED', 94.5]]));
  check('손절이 정상 동작', exits[0]?.reason, 'stop-loss');

  const closed = await pf.sell('TRAPPED', 94.5, 'stop-loss');
  check('청산 완료', typeof closed, 'object');
  check('24h 조건이 청산을 막지 않음', pf.positions.size, 0);
}
{
  // 익절도 동일하게 동작해야 한다
  const pf = fresh({ use24hChangeFilter: 0 });
  await pf.buy('WINNER', 100, { change24hPct: -9 });
  pf.settings = { ...pf.settings, use24hChangeFilter: 1 };
  const exits = pf.update(new Map([['WINNER', 110.5]]));
  check('익절이 정상 동작', exits[0]?.reason, 'take-profit');
}
{
  // 시간 청산도 동일
  const pf = fresh({ use24hChangeFilter: 0, maxHoldMinutes: 30 });
  await pf.buy('TIMED', 100, { change24hPct: -9 });
  pf.settings = { ...pf.settings, use24hChangeFilter: 1 };
  const exits = pf.update(new Map([['TIMED', 99.5]]), Date.now() + 31 * 60_000);
  check('시간 청산이 정상 동작', exits[0]?.reason, 'time-stop');
}

console.log('\n── 7. 스캐너 rank() 필터링 ──');
{
  const s = new VolumeScanner();
  s.configure(base);
  const surge = [...Array(30).fill(1_000_000), 9_000_000, 9_000_000, 9_000_000];
  const mk = (sym, chg) => {
    s.history.set(sym, {
      bars: [...surge],
      closes: Array.from({ length: 33 }, (_, i) => 100 + i * 0.15),
      liveBar: null,
      lastLiveOpenTime: 0,
    });
  };
  mk('RISING', 2.5);
  mk('FALLING', -2.5);
  mk('FLAT24H', 0.1);

  const market = new Map(
    ['RISING', 'FALLING', 'FLAT24H'].map((sym) => [
      sym,
      { lastPrice: 100, quoteVolume: 500_000_000, priceChangePercent: sym === 'RISING' ? 2.5 : sym === 'FALLING' ? -2.5 : 0.1 },
    ]),
  );
  const all = [...market.keys()];

  const filtered = s.rank(all, market, base).map((c) => c.symbol);
  check('상승 종목 통과', filtered.includes('RISING'), true);
  check('하락 종목 탈락', filtered.includes('FALLING'), false);
  check('24h 탈락 카운트', s.lastRejectedBy24h, 1);

  const off = s.rank(all, market, { ...base, use24hChangeFilter: 0 }).map((c) => c.symbol);
  check('필터 OFF → 하락 종목도 통과', off.includes('FALLING'), true);
  check('필터 OFF → 탈락 카운트 0', s.lastRejectedBy24h, 0);
}

console.log('\n── 8. 근접 탈락 진단에 사유 포함 ──');
{
  const s = new VolumeScanner();
  s.configure(base);
  const surge = [...Array(30).fill(1_000_000), 9_000_000, 9_000_000, 9_000_000];
  s.history.set('FALLING', {
    bars: [...surge],
    closes: Array.from({ length: 33 }, (_, i) => 100 + i * 0.15),
    liveBar: null,
    lastLiveOpenTime: 0,
  });
  const market = new Map([['FALLING', { lastPrice: 100, quoteVolume: 500_000_000, priceChangePercent: -2.5 }]]);

  // z/배수/RSI 는 통과시키고 24h 만 위반 → 24h 조건만으로 막힌 케이스
  const near = s.nearMisses(['FALLING'], market, base, 5);
  check('진단에 잡힘', near.length, 1);
  check('사유에 24h 변동 표시', near[0].reasons.some((r) => r.includes('24h 변동')), true);
  check('24h 단독 차단으로 표시', near[0].blockedOnlyBy24h, true);
  check('변동률 값 노출', near[0].change24hPct, -2.5);
}

console.log(`\n${'═'.repeat(46)}\n통과 ${pass} / 실패 ${fail}\n`);
process.exit(fail === 0 ? 0 : 1);
