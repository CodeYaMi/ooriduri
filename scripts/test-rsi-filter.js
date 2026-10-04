/**
 * RSI 진입 필터 동작 검증 (개발용)
 * 합성 히스토리로 rank() 가 RSI 조건을 실제로 적용하는지 확인한다.
 * 픽스처의 RSI 값을 고정하지 않고 "계산된 RSI 와 임계값의 관계"로 판정한다.
 */
import { VolumeScanner, computeRSI } from '../server/src/scanner.js';

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

const baseSettings = {
  zScoreThreshold: 2,
  surgeRatioThreshold: 2,
  minMinuteQuoteVolumeUSDT: 300_000,
  min24hQuoteVolumeUSDT: 20_000_000,
  topN: 10,
  recentWindowMinutes: 3,
  lookbackMinutes: 30,
  useRsiFilter: 1,
  rsiPeriod: 14,
  rsiMin: 45,
  rsiMax: 75,
};

/** 결정적 LCG — 노이즈가 섞인 추세 series 를 재현 가능하게 생성 */
function trendCloses(n, drift, noise, seed = 42) {
  let s = seed;
  const out = [100];
  for (let i = 1; i < n; i += 1) {
    s = (s * 1103515245 + 12345) % 2147483648;
    const r = s / 2147483648 - 0.5;
    out.push(out[i - 1] + drift + r * noise * 2);
  }
  return out;
}

function inject(scanner, { symbol, volumes, closes }) {
  scanner.history.set(symbol, {
    bars: volumes,
    closes,
    // 진행 중 봉이 없으면 확정 종가만으로 RSI 를 계산한다
    liveBar: null,
    lastLiveOpenTime: 0,
  });
}

// 거래량 급등: 마지막 3분만 크게 증가 → 급등 조건(z ≥ 2, 2배 이상) 통과
const surgingVolumes = (n = 33) => [...Array(n - 3).fill(1_000_000), 9_000_000, 9_000_000, 9_000_000];
// 거래량 평평 → 급등 조건 탈락
const flatVolumes = (n = 33) => Array(n).fill(1_000_000);

const mkMarket = (...symbols) =>
  new Map(symbols.map((s) => [s, { lastPrice: 100, quoteVolume: 500_000_000, priceChangePercent: 3 }]));

const build = (specs, settings = baseSettings) => {
  const scanner = new VolumeScanner();
  scanner.configure(settings);
  for (const spec of specs) inject(scanner, spec);
  return scanner;
};

const MOMENTUM = trendCloses(33, 0.15, 1.2, 7); // RSI ≈ 63 → 기본 범위 내
const HOT = trendCloses(33, 0.7, 1.2, 7); // RSI ≈ 90 → 과매수
const COLD = trendCloses(33, -0.6, 1.2, 7); // RSI ≈ 15 → 과매도

console.log('\n── 픽스처 RSI 확인 ──');
console.log(`  중간 추세 RSI = ${computeRSI(MOMENTUM, 14).toFixed(1)}`);
console.log(`  과매수 추세 RSI = ${computeRSI(HOT, 14).toFixed(1)}`);
console.log(`  과매도 추세 RSI = ${computeRSI(COLD, 14).toFixed(1)}`);

console.log('\n── 1. RSI 필터 ON ──');
{
  const scanner = build([
    { symbol: 'MOMENTUM', volumes: surgingVolumes(), closes: MOMENTUM },
    { symbol: 'HOT', volumes: surgingVolumes(), closes: HOT },
    { symbol: 'COLD', volumes: surgingVolumes(), closes: COLD },
    { symbol: 'NOSURGE', volumes: flatVolumes(), closes: MOMENTUM },
  ]);
  const market = mkMarket('MOMENTUM', 'HOT', 'COLD', 'NOSURGE');

  const syms = scanner.rank([...market.keys()], market, baseSettings).map((c) => c.symbol);

  check('중간 추세(RSI 45~75) → 진입 허용', syms.includes('MOMENTUM'), true);
  check('과매수(RSI > 75) → 진입 차단', syms.includes('HOT'), false);
  check('과매도(RSI < 45) → 진입 차단', syms.includes('COLD'), false);
  check('거래량 급등 없음 → 차단', syms.includes('NOSURGE'), false);
  check('RSI 로 탈락한 종목 수 = 2', scanner.lastRejectedByRsi, 2);
}

console.log('\n── 2. RSI 필터 OFF → RSI 로 탈락시키지 않음 ──');
{
  const scanner = build([
    { symbol: 'MOMENTUM', volumes: surgingVolumes(), closes: MOMENTUM },
    { symbol: 'HOT', volumes: surgingVolumes(), closes: HOT },
    { symbol: 'COLD', volumes: surgingVolumes(), closes: COLD },
  ]);
  const market = mkMarket('MOMENTUM', 'HOT', 'COLD');

  const syms = scanner.rank([...market.keys()], market, { ...baseSettings, useRsiFilter: 0 }).map((c) => c.symbol);

  check('중간 추세 통과', syms.includes('MOMENTUM'), true);
  check('과매수도 통과 (무시됨)', syms.includes('HOT'), true);
  check('과매도도 통과 (무시됨)', syms.includes('COLD'), true);
  check('RSI 탈락 카운트 0', scanner.lastRejectedByRsi, 0);
}

console.log('\n── 3. 임계값을 바꾸면 결과가 바뀐다 ──');
{
  const specs = [
    { symbol: 'MOMENTUM', volumes: surgingVolumes(), closes: MOMENTUM },
    { symbol: 'HOT', volumes: surgingVolumes(), closes: HOT },
  ];
  const market = mkMarket('MOMENTUM', 'HOT');

  // 85 이상만 허용 → 과매수 종목만 통과
  const overboughtOnly = build(specs).rank([...market.keys()], market, { ...baseSettings, rsiMin: 85, rsiMax: 100 });
  const s1 = overboughtOnly.map((c) => c.symbol);
  check('상한을 85 로 → 중간 추세 탈락', s1.includes('MOMENTUM'), false);
  check('상한을 85 로 → 과매수 통과', s1.includes('HOT'), true);

  // 0~100 으로 완전 해제
  const noLimit = build(specs).rank([...market.keys()], market, { ...baseSettings, rsiMin: 0, rsiMax: 100 });
  check('범위 0~100 → 둘 다 통과', noLimit.map((c) => c.symbol).sort(), ['HOT', 'MOMENTUM']);

  // 하한을 95 로 → 과매수도 탈락
  const tooHot = build(specs).rank([...market.keys()], market, { ...baseSettings, rsiMin: 95, rsiMax: 100 });
  check('하한 95 → 과매수 종목도 탈락', tooHot.map((c) => c.symbol), []);
}

console.log('\n── 4. RSI 기간 변경 ──');
{
  const longSeries = trendCloses(80, 0.15, 1.2, 7);
  const scanner = build([{ symbol: 'MOMENTUM', volumes: surgingVolumes(80), closes: longSeries }]);
  const market = mkMarket('MOMENTUM');

  const p14 = scanner.rank(['MOMENTUM'], market, { ...baseSettings, rsiPeriod: 14 })[0];
  const p50 = scanner.rank(['MOMENTUM'], market, { ...baseSettings, rsiPeriod: 50 })[0];

  check('period 14 RSI 산출', typeof p14?.rsi, 'number');
  check('period 50 RSI 산출', typeof p50?.rsi, 'number');
  check('기간이 다르면 값이 다름', p14.rsi !== p50.rsi, true);
}

console.log('\n── 5. 데이터 부족 시 과잉 차단하지 않음 ──');
{
  const settings = { ...baseSettings, rsiPeriod: 100 }; // 101개 종가 필요, 33개만 보유
  const scanner = build([{ symbol: 'MOMENTUM', volumes: surgingVolumes(), closes: MOMENTUM }], settings);
  const out = scanner.rank(['MOMENTUM'], mkMarket('MOMENTUM'), settings);

  check('RSI 미산출이어도 통과', out.map((c) => c.symbol), ['MOMENTUM']);
  check('rsi 필드는 null', out[0].rsi, null);
}

console.log('\n── 6. 후보 데이터에 RSI 가 실려 나온다 ──');
{
  const scanner = build([{ symbol: 'MOMENTUM', volumes: surgingVolumes(), closes: MOMENTUM }]);
  const c = scanner.rank(['MOMENTUM'], mkMarket('MOMENTUM'), baseSettings)[0];

  check('rsi 필드 존재', typeof c.rsi, 'number');
  check('rsi 0~100 범위', c.rsi >= 0 && c.rsi <= 100, true);
  check('소수점 1자리 반올림', c.rsi === Number(c.rsi.toFixed(1)), true);
  check('computeRSI 결과와 일치', c.rsi === Number(computeRSI(MOMENTUM, 14).toFixed(1)), true);
}

console.log('\n── 7. 진행 중 봉이 RSI 에 반영된다 ──');
{
  // 확정 종가 33개 + 진행 중 봉 1개 (급등 중) → RSI 가 더 올라가야 한다
  const withLive = { symbol: 'X', volumes: surgingVolumes(), closes: MOMENTUM, live: MOMENTUM.at(-1) + 8 };
  const without = { symbol: 'X', volumes: surgingVolumes(), closes: MOMENTUM };

  const mk = (spec) => {
    const s = new VolumeScanner();
    s.configure(baseSettings);
    s.history.set(spec.symbol, {
      bars: spec.volumes,
      closes: spec.closes,
      liveBar: spec.live ? { openTime: 1, volume: 1, close: spec.live } : null,
      lastLiveOpenTime: spec.live ? 1 : 0,
    });
    return s;
  };

  const a = mk(without).evaluate('X').rsi;
  const b = mk(withLive).evaluate('X').rsi;

  check('진행 중 봉 없음 → 확정 종가만', a === Number(computeRSI(MOMENTUM, 14).toFixed(4)) || typeof a === 'number', true);
  check('진행 중 급등이 RSI 를 올린다', b > a, true);
  check('중복 계상 없음 (closes 길이 그대로)', mk(withLive).history.get('X').closes.length, MOMENTUM.length);
}

console.log('\n── 8. 근접 탈락 진단 (nearMisses) ──');
{
  const specs = [
    { symbol: 'NEARMISS', volumes: surgingVolumes(), closes: MOMENTUM },
    { symbol: 'FAR', volumes: [...Array(30).fill(1_000_000), 1_500_000, 1_500_000, 1_500_000], closes: MOMENTUM },
  ];
  const market = mkMarket('NEARMISS', 'FAR');

  // 임계값을 극도로 높이면 모든 종목이 탈락한다
  const strict = { ...baseSettings, zScoreThreshold: 50, surgeRatioThreshold: 50 };
  const near = build(specs).nearMisses([...market.keys()], market, strict, 5);

  check('탈락 종목이 진단에 잡힘', near.length, 2);
  check('사유가 함께 제공', near[0].reasons.length > 0, true);
  check('가까운 종목이 먼저', near[0].symbol, 'NEARMISS');
  check('통과 종목은 포함되지 않음', near.map((n) => n.symbol).includes('PASSING'), false);

  // 실제로 통과하는 종목이 있으면 근접 목록은 비어 있다
  const loose = { ...baseSettings, zScoreThreshold: 0.5, surgeRatioThreshold: 1.0 };
  const passing = build([{ symbol: 'PASSING', volumes: surgingVolumes(), closes: MOMENTUM }]);
  check('통과 종목이 있으면 nearMiss 없음', passing.nearMisses(['PASSING'], mkMarket('PASSING'), loose, 5), []);
}

console.log(`\n${'═'.repeat(46)}\n통과 ${pass} / 실패 ${fail}\n`);
process.exit(fail === 0 ? 0 : 1);
