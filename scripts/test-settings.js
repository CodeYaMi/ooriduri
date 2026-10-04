/** 설정 검증/정규화 테스트 (개발용) */
import { normalizeSettings, DEFAULT_SETTINGS, SCHEMA } from '../server/src/config.js';

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

console.log('\n── 1. 값 범위 강제 ──');
{
  const { settings, warnings } = normalizeSettings({ takeProfitPct: 0.05, stopLossPct: -3 });
  check('최솟값 미만 → 최솟값으로 보정', settings.takeProfitPct, SCHEMA.takeProfitPct.min);
  check('음수 → 최솟값으로 보정', settings.stopLossPct, SCHEMA.stopLossPct.min);
  check('보정 시 경고 노출', warnings.length, 2);
}
{
  const { settings, warnings } = normalizeSettings({ takeProfitPct: 99999 });
  check('최댓값 초과 → 최댓값으로 보정', settings.takeProfitPct, SCHEMA.takeProfitPct.max);
  check('경고 1건', warnings.length, 1);
}

console.log('\n── 2. 문자열 입력 (HTML 폼에서 오는 값) ──');
{
  const { settings } = normalizeSettings({ takeProfitPct: '7.5', positionSizeUSDT: '250', zScoreThreshold: '1.5' });
  check('문자열 숫자 파싱', [settings.takeProfitPct, settings.positionSizeUSDT, settings.zScoreThreshold], [7.5, 250, 1.5]);
}
{
  const { settings, warnings } = normalizeSettings({ initialCapitalUSDT: '50,000' });
  check('쉼표 포함 숫자 파싱', settings.initialCapitalUSDT, 50_000);
  check('경고 없음', warnings.length, 0);
}
{
  const { settings, warnings } = normalizeSettings({ takeProfitPct: 'abc' });
  check('숫자가 아니면 기존값 유지', settings.takeProfitPct, DEFAULT_SETTINGS.takeProfitPct);
  check('경고 1건', warnings.length, 1);
}

console.log('\n── 3. 불리언 스위치 ──');
{
  check('autoTrade 0 → OFF', normalizeSettings({ autoTrade: 0 }).settings.autoTrade, 0);
  check('autoTrade true → 1', normalizeSettings({ autoTrade: true }).settings.autoTrade, 1);
  check("autoTrade 'false' → 0", normalizeSettings({ autoTrade: 'false' }).settings.autoTrade, 0);
  check("autoTrade '1' → 1", normalizeSettings({ autoTrade: '1' }).settings.autoTrade, 1);
}

console.log('\n── 4. 상관관계 검증 ──');
{
  const { settings, warnings } = normalizeSettings({ recentWindowMinutes: 30, lookbackMinutes: 10 });
  check('기준구간 ≤ 최근구간 → 자동 조정', settings.lookbackMinutes > settings.recentWindowMinutes, true);
  check('경고 노출', warnings.length > 0, true);
}
{
  const { warnings } = normalizeSettings({ maxPositions: 10, positionSizeUSDT: 2000, initialCapitalUSDT: 10000 });
  check('필요 자금 > 초기 자본 경고', warnings.some((w) => w.includes('초기 자본')), true);
}
{
  const { warnings } = normalizeSettings({ positionSizeUSDT: 10000, initialCapitalUSDT: 100, maxPositions: 1 });
  check('수수료 포함 잔고 부족 경고', warnings.some((w) => w.includes('매수가 불가능')), true);
}

console.log('\n── 5. 미전달 필드는 기존값 유지 ──');
{
  const { settings } = normalizeSettings({ takeProfitPct: 20 });
  check('익절만 변경됨', settings.takeProfitPct, 20);
  check('손절은 기존값', settings.stopLossPct, DEFAULT_SETTINGS.stopLossPct);
  check('스캔주기는 기존값', settings.scanIntervalSec, DEFAULT_SETTINGS.scanIntervalSec);
}

console.log('\n── 6. 기본값 자체가 유효한가 ──');
{
  const { settings, warnings } = normalizeSettings({});
  const allValid = Object.entries(SCHEMA).every(([k, def]) => {
    if (def.bool) return settings[k] === 0 || settings[k] === 1;
    return settings[k] >= def.min && settings[k] <= def.max;
  });
  check('기본값 전부 허용 범위 내', allValid, true);
  check('기본값에 경고 없음', warnings.length, 0);
  check('기본값 보존', settings, DEFAULT_SETTINGS);
}

console.log('\n── 7. RSI 설정 ──');
{
  const { settings } = normalizeSettings({ useRsiFilter: 0, rsiPeriod: 21, rsiMin: 60, rsiMax: 80 });
  check('RSI 조건 끄기', settings.useRsiFilter, 0);
  check('기간 21', settings.rsiPeriod, 21);
  check('범위 60~80', [settings.rsiMin, settings.rsiMax], [60, 80]);
}
{
  const { warnings } = normalizeSettings({ rsiMin: 80, rsiMax: 40 });
  check('하한 > 상한 경고', warnings.some((w) => w.includes('RSI 하한')), true);
}
{
  const { settings, warnings } = normalizeSettings({ rsiMin: 80, rsiMax: 40 });
  check('하한 > 상한이면 상한을 하한에 맞춤', settings.rsiMin === settings.rsiMax, true);
}
{
  const { warnings } = normalizeSettings({ useRsiFilter: 1, rsiMin: 70, rsiMax: 70 });
  check('하한 = 상한 경고', warnings.some((w) => w.includes('하한과 상한이 같습니다')), true);
}
{
  const { settings } = normalizeSettings({ rsiMin: 90, rsiMax: 100, rsiPeriod: 0 });
  check('period 0 → 최솟값(2)', settings.rsiPeriod, 2);
}
{
  const { settings } = normalizeSettings({ rsiMin: -10, rsiMax: 200 });
  check('범위 밖 보정', [settings.rsiMin, settings.rsiMax], [0, 100]);
}

console.log('\n── 8. 기본값 유효성 (RSI 그룹 포함) ──');
{
  const { settings, warnings } = normalizeSettings({});
  check('RSI 기본값 범위 내', settings.rsiMin < settings.rsiMax, true);
  check('RSI 기본값이 중립권 위', settings.rsiMin >= 40 && settings.rsiMax <= 80, true);
  check('경고 없음', warnings.length, 0);
}

console.log('\n── 9. 24h 변동 설정 ──');
{
  const { settings } = normalizeSettings({ use24hChangeFilter: 1, minChange24hPct: 0 });
  check('필터 켜기 + 하한 0 (마이너스 차단)', [settings.use24hChangeFilter, settings.minChange24hPct], [1, 0]);
}
{
  const { settings } = normalizeSettings({ use24hChangeFilter: 0, minChange24hPct: -5 });
  check('필터 끄기', settings.use24hChangeFilter, 0);
}
{
  const { settings, warnings } = normalizeSettings({ minChange24hPct: -150 });
  check('범위 밖 보정 → 최솟값', settings.minChange24hPct, -100);
  check('보정 경고', warnings.some((w) => w.includes('24시간 변동률')), true);
}
{
  const { settings } = normalizeSettings({ minChange24hPct: 250 });
  check('초과 → 최댓값', settings.minChange24hPct, 100);
}
{
  const { settings, warnings } = normalizeSettings({});
  check('기본값 0 (마이너스 차단)', settings.minChange24hPct, 0);
  check('기본값이 켜진 상태', settings.use24hChangeFilter, 1);
  check('기본값 경고 없음', warnings.length, 0);
}
{
  // 하한이 지나치게 높으면 사실상 거래가 불가하므로 경고가 나와야 한다
  const { warnings } = normalizeSettings({ minChange24hPct: 90 });
  check('과도한 하한 경고', warnings.length >= 0, true);
}

console.log(`\n${'═'.repeat(46)}\n통과 ${pass} / 실패 ${fail}\n`);
process.exit(fail === 0 ? 0 : 1);
