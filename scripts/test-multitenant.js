/**
 * 멀티 계정 격리 검증 (개발용)
 * 실행: COIN_SURFER_DATA_DIR=$(mktemp -d)/data node scripts/test-multitenant.js
 *
 * 네트워크를 쓰지 않는다 (MarketHub 생성만 하고 start 하지 않음).
 */
import fs from 'node:fs';
import path from 'node:path';
import { MarketHub } from '../server/src/market.js';
import { Trader } from '../server/src/trader.js';
import { DEFAULT_SETTINGS, savePortfolioTo } from '../server/src/config.js';
import {
  createMaster,
  createUser,
  setUserDisabled,
  deleteUser,
} from '../server/src/auth.js';
import {
  createTradingAccount,
  ensureDefaultAccount,
  setAccountDisabled,
  renameTradingAccount,
  deleteTradingAccount,
  disableAccountsOfUser,
  visibleAccounts,
  canAccessAccount,
  getAccountMeta,
  appendEvent,
  readEvents,
  readAllEvents,
  accountPaths,
  hasLegacyData,
  migrateLegacyToAccount,
} from '../server/src/accounts.js';
import { saveCredentials, loadCredentials, describeCredentials, resetLiveOnBoot } from '../server/src/credentials.js';

const DATA_DIR = process.env.COIN_SURFER_DATA_DIR;
if (!DATA_DIR) {
  console.error('COIN_SURFER_DATA_DIR 을 지정하세요 (실제 데이터를 보호하기 위함).');
  process.exit(2);
}

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
const throws = (name, fn, substr) => {
  try {
    fn();
    fail += 1;
    console.log(`  ❌ ${name}\n     기대: 에러 (${substr})\n     실제: 통과함`);
  } catch (err) {
    if (!substr || String(err.message).includes(substr)) {
      pass += 1;
      console.log(`  ✅ ${name}`);
    } else {
      fail += 1;
      console.log(`  ❌ ${name}\n     기대 포함: ${substr}\n     실제: ${err.message}`);
    }
  }
};

const master = createMaster({ name: 'master', password: 'masterpass123' });
const alice = createUser({ name: 'alice', password: 'alicepass1' });
const bob = createUser({ name: 'bob', password: 'bobpass12' });

console.log('\n── 1. 기본 거래 계정 ──');
{
  const a = ensureDefaultAccount(alice.id);
  const b = ensureDefaultAccount(bob.id);
  check('alice 기본 계정 소유자', a.ownerUserId, alice.id);
  check('계정 id 다름', a.id === b.id, false);
  check('멱등 (두 번 호출해도 하나)', ensureDefaultAccount(alice.id).id, a.id);
}

console.log('\n── 2. 가시성 규칙 ──');
{
  const accA = ensureDefaultAccount(alice.id);
  const accB = ensureDefaultAccount(bob.id);
  const masterView = visibleAccounts({ id: master.id, role: 'master' });
  check('마스터는 전부 (3개: master 기본 없음 → 2개)', masterView.length, 2);
  check('alice 는 본인 것만', visibleAccounts({ id: alice.id, role: 'user' }).map((m) => m.id), [accA.id]);
  check('마스터 접근 허용', Boolean(canAccessAccount({ id: master.id, role: 'master' }, accA.id)), true);
  check('본인 접근 허용', Boolean(canAccessAccount({ id: alice.id, role: 'user' }, accA.id)), true);
  check('타인 접근 차단', canAccessAccount({ id: alice.id, role: 'user' }, accB.id), null);
  check('없는 계정 null', canAccessAccount({ id: alice.id, role: 'user' }, 'a_nope'), null);

  setAccountDisabled(accB.id, true);
  check('정지 계정은 소유자에게 숨음', visibleAccounts({ id: bob.id, role: 'user' }).length, 0);
  check('정지 계정도 마스터는 봄', visibleAccounts({ id: master.id, role: 'master' }).length, 2);
  check('정지 계정 접근 차단 (일반)', canAccessAccount({ id: bob.id, role: 'user' }, accB.id), null);
  setAccountDisabled(accB.id, false);
}

console.log('\n── 3. 설정 격리 ──');
const hub = new MarketHub();
{
  const accA = ensureDefaultAccount(alice.id);
  const accB = ensureDefaultAccount(bob.id);
  const tA = new Trader(accA.id, getAccountMeta(accA.id), hub);
  const tB = new Trader(accB.id, getAccountMeta(accB.id), hub);

  check('초기 설정은 기본값', tA.settings.takeProfitPct, DEFAULT_SETTINGS.takeProfitPct);
  tA.applySettings({ ...tA.settings, takeProfitPct: 25 }, 'alice');
  check('A 익절 25', tB.settings.takeProfitPct === 25 ? 'leak' : tA.settings.takeProfitPct, 25);
  check('B 영향 없음', tB.settings.takeProfitPct, DEFAULT_SETTINGS.takeProfitPct);
  // 파일로도 분리 저장됐는지
  const fileA = JSON.parse(fs.readFileSync(accountPaths(accA.id).settings, 'utf8'));
  check('A 설정 파일 분리', fileA.takeProfitPct, 25);
  check('B 설정 파일 없음 (기본값 사용)', fs.existsSync(accountPaths(accB.id).settings), false);
  tA.stop();
  tB.stop();
}

console.log('\n── 4. 포트폴리오 격리 ──');
{
  const accA = ensureDefaultAccount(alice.id);
  const accB = ensureDefaultAccount(bob.id);
  const tA = new Trader(accA.id, getAccountMeta(accA.id), hub);
  const tB = new Trader(accB.id, getAccountMeta(accB.id), hub);
  // A 익절 25 유지됨 (파일에서 로드)
  check('A 설정 복원', tA.settings.takeProfitPct, 25);

  const r = await tA.portfolio.buy('BTCUSDT', 50000, { change24hPct: 1 });
  check('A 매수 성공', Boolean(r && !r.error), true);
  check('B 포지션 없음', tB.portfolio.positions.size, 0);
  // A 쿨다운/포지션이 B 스캔에 영향 없음 — B 는 빈 후보에서도 동작
  await tB.scan();
  check('B 스캔 동작 (후보 배열)', Array.isArray(tB.candidates), true);
  tA.stop();
  tB.stop();
}

console.log('\n── 5. 이벤트 로그 분리 ──');
{
  const accA = ensureDefaultAccount(alice.id);
  const accB = ensureDefaultAccount(bob.id);
  appendEvent(accA.id, 'buy', 'BTCUSDT 매수 테스트', 'alice');
  appendEvent(accA.id, 'error', '에러 테스트', null);
  appendEvent(accB.id, 'sell', 'ETHUSDT 매도 테스트', 'bob');

  const ea = readEvents(accA.id, {});
  // 섹션 3의 설정 변경(settings) + 여기서 추가한 buy/error = 3건
  check('A 이벤트 3건', ea.length, 3);
  check('최신이 먼저 (error)', ea[0].type, 'error');
  check('actor 기록', ea[1].actor, 'alice');
  check('설정 변경도 기록됨', ea.some((e) => e.type === 'settings'), true);
  check('B 이벤트 1건', readEvents(accB.id, {}).length, 1);
  check('타입 필터', readEvents(accA.id, { type: 'buy' }).length, 1);
  check('검색어 필터', readEvents(accA.id, { q: 'BTCUSDT' }).length, 1);

  const all = readAllEvents([getAccountMeta(accA.id), getAccountMeta(accB.id)], {});
  check('마스터 합산 4건', all.length, 4);
  check('합산에 계정 표식', all.every((e) => e.accountId && e.accountName), true);
  check('시간 역순', all[0].ts >= all[1].ts && all[1].ts >= all[2].ts, true);
}

console.log('\n── 6. 계정별 자격증명 ──');
{
  const accA = ensureDefaultAccount(alice.id);
  const paths = accountPaths(accA.id);
  saveCredentials(paths.dir, { apiKey: 'A'.repeat(40), apiSecret: 'S'.repeat(40), network: 'testnet' });
  const desc = describeCredentials(paths.dir);
  check('연결됨', desc.connected, true);
  check('마스킹만 노출', desc.apiKeyMasked.startsWith('AAAA') && desc.apiKeyMasked.includes('•'), true);
  check('시크릿 미노출', JSON.stringify(desc).includes('S'.repeat(40)), false);
  check('원문은 로드 가능 (서버 내부용)', loadCredentials(paths.dir)?.apiKey, 'A'.repeat(40));

  const accB = ensureDefaultAccount(bob.id);
  check('B 에는 키 없음', describeCredentials(accountPaths(accB.id).dir).connected, false);

  const st = fs.statSync(path.join(paths.dir, 'credentials.json'));
  check('권한 600', (st.mode & 0o777).toString(8), '600');
}

console.log('\n── 7. 실거래 무장 해제 (재시작 시) ──');
{
  const accA = ensureDefaultAccount(alice.id);
  const { armLive, readLiveFlag } = await import('../server/src/credentials.js');
  const paths = accountPaths(accA.id);
  armLive(paths.dir, 'testnet');
  check('무장됨', readLiveFlag(paths.dir).armed, true);
  resetLiveOnBoot([paths.dir]);
  check('재시작 시 해제', readLiveFlag(paths.dir).armed, false);
}

console.log('\n── 8. 레거시 마이그레이션 ──');
{
  // 레거시 파일 작성 (실제 DATA_DIR 하위)
  fs.writeFileSync(path.join(DATA_DIR, 'settings.json'), JSON.stringify({ ...DEFAULT_SETTINGS, takeProfitPct: 33 }), 'utf8');
  fs.writeFileSync(path.join(DATA_DIR, 'portfolio.json'), JSON.stringify({ cash: 1234, positions: [], trades: [] }), 'utf8');
  fs.writeFileSync(path.join(DATA_DIR, 'credentials.json'), JSON.stringify({ apiKey: 'L'.repeat(40), apiSecret: 'M'.repeat(40), network: 'testnet', savedAt: 1 }), 'utf8');
  check('레거시 감지', hasLegacyData(), true);

  const carol = createUser({ name: 'carol', password: 'carolpass1' });
  const accC = ensureDefaultAccount(carol.id);
  const moved = migrateLegacyToAccount(accC.id);
  check('3개 파일 이동', moved.sort(), ['credentials', 'portfolio', 'settings']);
  check('레거시 settings 삭제됨', fs.existsSync(path.join(DATA_DIR, 'settings.json')), false);
  check('새 위치에 설정 존재', JSON.parse(fs.readFileSync(accountPaths(accC.id).settings, 'utf8')).takeProfitPct, 33);
  check('레거시 없음으로 전환', hasLegacyData(), false);

  const tC = new Trader(accC.id, getAccountMeta(accC.id), hub);
  check('마이그레이션 설정 로드', tC.settings.takeProfitPct, 33);
  check('마이그레이션 잔고 로드', tC.portfolio.cash, 1234);
  tC.stop();
}

console.log('\n── 9. 사용자 정지/삭제 연동 ──');
{
  const accB = ensureDefaultAccount(bob.id);
  setUserDisabled(bob.id, true);
  const n = disableAccountsOfUser(bob.id);
  check('bob 계정 정지됨', n >= 1, true);
  check('정지 후 본인에게 숨음', visibleAccounts({ id: bob.id, role: 'user' }).length, 0);

  const dave = createUser({ name: 'dave', password: 'davepass12' });
  const accD = ensureDefaultAccount(dave.id);
  deleteUser(dave.id);
  disableAccountsOfUser(dave.id);
  check('삭제된 사용자 계정도 정지', getAccountMeta(accD.id).disabled, true);
}

console.log('\n── 10. 삭제 가드 ──');
{
  const accA = ensureDefaultAccount(alice.id);
  const tA = new Trader(accA.id, getAccountMeta(accA.id), hub);
  await tA.portfolio.buy('BTCUSDT', 50000, { change24hPct: 1 });
  // persist 타이머 없이 파일에 직접 저장 (삭제 가드 검증용)
  savePortfolioTo(tA.portfolio.toJSON(), accountPaths(accA.id).portfolio);
  let msg = '';
  try {
    deleteTradingAccount(accA.id);
  } catch (err) {
    msg = err.message;
  }
  check('포지션 보유 시 삭제 차단', msg.includes('전량 청산'), true);
  tA.stop();

  // 빈 계정은 삭제 가능
  const tmp = createTradingAccount({ name: 'tmp', ownerUserId: alice.id });
  deleteTradingAccount(tmp.id);
  check('빈 계정 삭제', getAccountMeta(tmp.id), null);

  // 파일 가드는 보수적이다: 오래된 파일에 포지션이 남아 있으면 차단한다.
  // API 라우트는 삭제 전 메모리 상태를 파일에 확정하므로 실제 운용에서는
  // 이 가드가 오탐하지 않는다 (메모리 우선 → 파일 확정 → 삭제).
  const stale = createTradingAccount({ name: 'stale', ownerUserId: alice.id });
  savePortfolioTo({ cash: 100, positions: [{ symbol: 'X', qty: 1 }], trades: [] }, accountPaths(stale.id).portfolio);
  let staleMsg = '';
  try {
    deleteTradingAccount(stale.id);
  } catch (err) {
    staleMsg = err.message;
  }
  check('파일 가드는 포지션 잔존 시 차단', staleMsg.includes('전량 청산'), true);
  // 뒷정리: 파일+메타 모두 제거
  savePortfolioTo({ cash: 100, positions: [], trades: [] }, accountPaths(stale.id).portfolio);
  deleteTradingAccount(stale.id);
  check('정리 후 삭제 가능', getAccountMeta(stale.id), null);

  let rmsg = '';
  try {
    renameTradingAccount(accA.id, '');
  } catch (err) {
    rmsg = err.message;
  }
  check('빈 이름 변경 거부', rmsg.includes('1~32자'), true);
  check('이름 변경', renameTradingAccount(accA.id, '알파').name, '알파');
}

console.log(`\n${'═'.repeat(46)}\n통과 ${pass} / 실패 ${fail}\n`);
process.exit(fail === 0 ? 0 : 1);
