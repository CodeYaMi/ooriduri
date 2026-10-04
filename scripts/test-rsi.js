/**
 * RSI 계산기 (Wilder 방식) — 개발용 검증
 *
 * New Concepts in Technical Trading Systems (J. Welles Wilder) 의
 * 14-period 예시 데이터로 정확도를 확인한다.
 */

const closes = [
  44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.1, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28,
];

/** Wilder 평활 RSI */
export function computeRSI(closes, period = 14) {
  if (!Array.isArray(closes) || closes.length < period + 1) return null;

  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= period; i += 1) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gainSum += diff;
    else lossSum -= diff;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;

  const toRsi = () => (avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));

  // Wilder 평활: avg = (avg × (period-1) + 현재값) / period
  for (let i = period + 1; i < closes.length; i += 1) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  return toRsi();
}

// ── 검증 ──
let pass = 0;
let fail = 0;
const check = (name, actual, expected, tol = 0.02) => {
  const ok = typeof actual === 'number' ? Math.abs(actual - expected) <= tol : actual === expected;
  if (ok) {
    pass += 1;
    const shown = typeof actual === 'number' ? actual.toFixed(2) : String(actual);
    console.log(`  ✅ ${name}  (${shown}${typeof expected === 'number' ? ` ≈ ${expected}` : ''})`);
  } else {
    fail += 1;
    console.log(`  ❌ ${name}\n     기대: ${expected}\n     실제: ${actual}`);
  }
};

console.log('\n── Wilder 14-period 예시 데이터 ──');
// 첫 15개 종가로 만든 RSI = 70.46 (교과서 기준값)
check('15개 종가 → RSI', computeRSI(closes, 14), 70.46, 0.05);

// 16번째 종가 46.00 추가 → 66.25 (교과서 기준값)
check('16번째 봉 추가 → RSI', computeRSI([...closes, 46.0], 14), 66.25, 0.05);

console.log('\n── 경계값 ──');
check('데이터 부족 (period+1 미만) → null', computeRSI([1, 2, 3], 14), null);
check('period+1 개면 계산 가능', computeRSI([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], 14) !== null, true);
check('단일 상승 → 100', computeRSI([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16], 14), 100);
check('단일 하락 → 0', computeRSI([16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1], 14), 0);
check('완전 보합 → 100 (손실 0)', computeRSI(Array(16).fill(50), 14), 100);
check('빈 배열 → null', computeRSI([], 14), null);

console.log('\n── 실전 시나리오 ──');
{
  // 완만한 상승 + 노이즈 → 강세(50 이상). 노이즈가 기울기보다 크면 RSI는 내려간다.
  const mild = Array.from({ length: 24 }, (_, i) => 100 + i * 0.2 + (i % 2 ? 0.6 : -0.5));
  const r = computeRSI(mild, 14);
  check('완만한 상승 → 50 이상 (강세)', r > 50, true);
  console.log(`     (RSI ${r.toFixed(2)})`);

  const strong = Array.from({ length: 24 }, (_, i) => 100 + i * 0.5 + (i % 2 ? 0.4 : -0.3));
  const r2 = computeRSI(strong, 14);
  check('강한 상승 → 80 이상 (과매수권)', r2 > 80, true);
  console.log(`     (RSI ${r2.toFixed(2)})`);
}
{
  // 완전 단조 상승은 손실이 0이므로 RSI 100 (수학적으로 정답)
  check('완전 단조 상승 → 100', computeRSI(Array.from({ length: 20 }, (_, i) => 100 + i), 14), 100);
}
{
  // 급등 후 반락 → 과매수 영역을 지나 RSI 급락
  const spike = [...Array(16).fill(100), 130, 140, 130, 110, 95];
  const r = computeRSI(spike, 14);
  check('급등 후 반전 → 70 이하로 하락', r < 70, true);
  console.log(`     (RSI ${r.toFixed(2)})`);
}
{
  // 횡보 → 중립권
  const flat = [100, 100.5, 99.8, 100.3, 99.9, 100.4, 99.7, 100.2, 99.9, 100.1, 99.8, 100.3, 99.9, 100.2, 100.0, 100.1];
  const r = computeRSI(flat, 14);
  check('횡보 → 30~70 중립권', r > 30 && r < 70, true);
  console.log(`     (RSI ${r.toFixed(2)})`);
}

console.log(`\n${'═'.repeat(46)}\n통과 ${pass} / 실패 ${fail}\n`);
process.exit(fail === 0 ? 0 : 1);
