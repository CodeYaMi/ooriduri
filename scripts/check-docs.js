/**
 * 문서 일치 검증 (개발용)
 * DEVELOPMENT.md / README.md 에 적힌 사실이 코드와 맞는지 확인한다.
 * 문서가 낡아지는 것을 막기 위한 장치.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_SETTINGS, SCHEMA, GROUPS } from '../server/src/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const dev = read('DEVELOPMENT.md');
const readme = read('README.md');
const portfolio = read('server/src/portfolio.js');
const scanner = read('server/src/scanner.js');
const market = read('server/src/market.js');
const trader = read('server/src/trader.js');
const privateJs = read('server/src/binance/private.js');
const creds = read('server/src/credentials.js');

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
/** 문자열 포함 검사 — 결과를 반환해야 || 로 조합할 수 있다 */
const has = (name, haystack, needle) => {
  const found = String(haystack).includes(needle);
  check(name, found, true);
  return found;
};

/** README 에 명령이 적혀 있는가 (`npm run x` 또는 `npm x` 허용) */
const hasCmd = (name, doc, cmd) => {
  const found = new RegExp(`npm (run )?${cmd}\\b`).test(doc);
  check(name, found, true);
  return found;
};

console.log('\n── 설정 스키마와 문서 일치 ──');
check('설정 항목 수', Object.keys(SCHEMA).length, 29);
check('그룹 수', GROUPS.length, 7);
check('DEVELOPMENT.md 가 29개 항목 명시', dev.includes('29개 항목'), true);
check('DEVELOPMENT.md 가 7개 그룹 명시', dev.includes('7개 그룹'), true);

console.log('\n── 그룹 id 일치 ──');
for (const g of GROUPS) {
  // DEVELOPMENT.md 는 "#### <id> — <이름>" 형식으로 기록한다
  has(`그룹 ${g.id} 문서화`, dev, `#### ${g.id} — ${g.name}`);
  check(`그룹 ${g.id} 표에 항목 존재`, Object.values(SCHEMA).some((d) => d.group === g.id), true);
}

console.log('\n── 기본값 문서 일치 ──');
const defaults = [
  ['takeProfitPct', '10'],
  ['stopLossPct', '5'],
  ['trailingStopPct', '0'],
  ['maxHoldMinutes', '0'],
  ['rsiPeriod', '14'],
  ['rsiMin', '45'],
  ['rsiMax', '75'],
  ['positionSizeUSDT', '100'],
  ['maxPositions', '10'],
  ['topN', '10'],
  ['cooldownMinutes', '15'],
  ['scanIntervalSec', '60'],
  ['recentWindowMinutes', '3'],
  ['lookbackMinutes', '30'],
  ['zScoreThreshold', '2'],
  ['surgeRatioThreshold', '2'],
  ['minMinuteQuoteVolumeUSDT', '300000'],
  ['min24hQuoteVolumeUSDT', '20000000'],
  ['maxSymbols', '200'],
  ['minOnboardDays', '7'],
  ['use24hChangeFilter', '1'],
  ['minChange24hPct', '0'],
  ['marketPollSec', '10'],
  ['barPollSec', '20'],
  ['takerFeeBps', '5'],
  ['slippageBps', '2'],
  ['autoTrade', '1'],
];
for (const [key, expected] of defaults) {
  const actual = String(DEFAULT_SETTINGS[key]);
  check(`기본값 ${key} = ${expected}`, actual, expected);
}

console.log('\n── 핵심 공식이 코드와 일치 ──');
has('z-score 20% 바닥선', scanner, 'baseAvg * 0.2');
has('RSI Wilder 평활 (period-1)', scanner, '(period - 1)');
has('점수 가중치 z×1.0', scanner, 'metrics.z * 1.0');
has('점수 가중치 ratio 0.35', scanner, '0.35');
has('점수 모멘텀 0.05', scanner, '0.05');
has('진입 관문 존재', portfolio, 'checkEntryGate');
has('청산 판정 존재', portfolio, 'checkExit');
has('진입/청산 분리 (entryGate 는 buy 에서만)', portfolio, 'const gate = this.checkEntryGate(signal)');
// 청산(checkExit) 본문에 진입 조건 필터가 섞이지 않았는지 확인
{
  const exitBody = portfolio.slice(portfolio.indexOf('checkExit(position'));
  const hasEntryFilter = exitBody.includes('use24hChangeFilter') || exitBody.includes('checkEntryGate');
  check('청산 로직에 진입 조건이 없음', hasEntryFilter, false);
}
has('hasBody 판별 (GET 은 바디 금지)', privateJs, "const withBody = verb === 'POST'");
has('시크릿 권한 600', creds, '0o600');
has('재시작 시 자동 해제', creds, 'resetLiveOnBoot');

console.log('\n── 타이머 주기 문서 일치 ──');
has('market 10초 폴링', market, 'marketPollSec');
has('bar 20초 폴링', market, 'barPollSec');
has('실거래 20초 동기화', trader, '20_000');
has('계정별 스냅샷에 accountId 포함', trader, 'accountId');
has('상태 1초', read('server/src/index.js'), '1000');
has('live 250ms', read('server/src/index.js'), '250');

console.log('\n── 테스트 개수 일치 ──');
const testFiles = fs.readdirSync(path.join(ROOT, 'scripts')).filter((f) => f.startsWith('test-'));
check('테스트 스크립트 수', testFiles.length, 12);
has('check-syntax 가 test 에 포함', read('package.json'), 'check-syntax.js');
has('test-24h-filter 가 test 에 포함', read('package.json'), 'test-24h-filter.js');
has('test-live 가 test 에 포함', read('package.json'), 'test-live.js');

console.log('\n── npm 스크립트 문서 일치 ──');
const pkg = JSON.parse(read('package.json'));
for (const cmd of ['up', 'down', 'restart', 'status', 'logs', 'dev', 'start', 'test']) {
  check(`npm run ${cmd} 존재`, typeof pkg.scripts[cmd] === 'string', true);
  // README 는 `npm start` / `npm test` 처럼 run 을 생략하는 형태도 허용한다
  hasCmd(`README 에 ${cmd} 명령 기재`, readme, cmd);
}

console.log('\n── API 엔드포인트 문서 일치 ──');
const idx = read('server/src/index.js');
const endpoints = [...idx.matchAll(/app\.(?:get|post|put|delete)\('([^']+)'/g)].map((m) => m[1]);
for (const ep of endpoints) {
  if (ep === '*') continue;
  // 경로 파라미터를 일반 경로 형태로 바꿔 문서에서 찾는다
  const clean = ep.split('/:symbol')[0].split('/:action')[0];
  has(`엔드포인트 ${ep} 문서화`, dev, clean);
}

console.log('\n── 알려진 제약 문서화 ──');
for (const note of ['롱 전용', '시장가', 'USDT 선물만', '재시작 시 자동 해제', '테스트넷']) {
  has(`제약/특성 "${note}" 문서화`, dev + readme, note);
}

console.log(`\n${'═'.repeat(46)}\n통과 ${pass} / 실패 ${fail}\n`);
process.exit(fail === 0 ? 0 : 1);
