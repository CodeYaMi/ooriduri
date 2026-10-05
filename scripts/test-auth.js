/**
 * 인증/사용자 관리 검증 (개발용)
 * 실행: COIN_SURFER_DATA_DIR=$(mktemp -d)/data node scripts/test-auth.js
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  hashPassword,
  verifyPassword,
  hasAnyUser,
  createMaster,
  createUser,
  setUserDisabled,
  resetUserPassword,
  deleteUser,
  findUserByName,
  login,
  resolveSession,
  revokeSession,
  issueSession,
  publicUser,
} from '../server/src/auth.js';

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

console.log('\n── 1. 비밀번호 해시 ──');
{
  const { salt, hash } = hashPassword('correct horse 123');
  check('올바른 비밀번호 검증', verifyPassword('correct horse 123', salt, hash), true);
  check('틀린 비밀번호 거부', verifyPassword('wrong password', salt, hash), false);
  check('솔트가 다르면 해시 다름', hashPassword('same', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa').hash === hashPassword('same', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb').hash, false);
  check('깨진 입력에도 false (예외 없음)', verifyPassword('x', 'zz', 'zz'), false);
}

console.log('\n── 2. 최초 마스터 생성 ──');
{
  check('초기에는 사용자 없음', hasAnyUser(), false);
  const m = createMaster({ name: 'master', password: 'masterpass123' });
  check('마스터 role', m.role, 'master');
  check('해시 미노출', 'passHash' in m, false);
  check('사용자 존재', hasAnyUser(), true);
  throws('두 번째 마스터 생성 차단', () => createMaster({ name: 'm2', password: 'masterpass123' }), '이미 사용자가 존재');
  throws('짧은 비밀번호 거부', () => createUser({ name: 'short', password: '123' }), '8자');
  throws('이상한 이름 거부', () => createUser({ name: 'a b!', password: 'longpassword1' }), '이름은');
}

console.log('\n── 3. 사용자 CRUD ──');
{
  const alice = createUser({ name: 'alice', password: 'alicepass1' });
  check('기본 role=user', alice.role, 'user');
  throws('중복 이름 거부', () => createUser({ name: 'alice', password: 'otherpass1' }), '이미 존재');
  throws('잘못된 role 거부', () => createUser({ name: 'x', password: 'longpassword1', role: 'admin' }), 'role');
  const bob = createUser({ name: 'bob', password: 'bobpass12', role: 'master' });
  check('마스터 추가 가능', bob.role, 'master');

  const rp = resetUserPassword(alice.id, 'newalicepass');
  check('비밀번호 재설정', rp.id, alice.id);
  const { token } = login({ name: 'alice', password: 'newalicepass', ip: '1.2.3.4' });
  check('새 비밀번호로 로그인', typeof token, 'string');
  throws('이전 비밀번호 무효', () => login({ name: 'alice', password: 'alicepass1', ip: '1.2.3.4' }), '올바르지 않습니다');

  // bob(마스터) 삭제 → master 1명 남음
  const masterId = findUserByName('master').id;
  deleteUser(bob.id);
  check('bob 삭제 후 조회 불가', findUserByName('bob'), null);
  throws('마지막 마스터 삭제 차단', () => deleteUser(masterId), '마지막 마스터');
  throws('마지막 마스터 비활성화 차단', () => setUserDisabled(masterId, true), '마지막 마스터');
}

console.log('\n── 4. 로그인/세션 ──');
{
  const { token, user } = login({ name: 'alice', password: 'newalicepass', ip: '9.9.9.9' });
  check('로그인 사용자명', user.name, 'alice');
  const s = resolveSession(token);
  check('세션 해석', s?.user.name, 'alice');
  check('publicUser 에 해시 없음', s && 'passHash' in s.user, false);
  revokeSession(token);
  check('로그아웃 후 무효', resolveSession(token), null);
  check('가짜 토큰 무효', resolveSession('0'.repeat(64)), null);
  check('빈 토큰 무효', resolveSession(''), null);

  // 만료 세션 정리 — 토큰 해시로 정확히 해당 행만 만료시킨다
  const { createHash } = await import('node:crypto');
  const { token: t2 } = issueSession(findUserByName('alice').id);
  const h2 = createHash('sha256').update(t2).digest('hex');
  const sessFile = path.join(DATA_DIR, 'sessions.json');
  const rows = JSON.parse(fs.readFileSync(sessFile, 'utf8'));
  rows.find((r) => r.tokenHash === h2).expiresAt = Date.now() - 1000;
  fs.writeFileSync(sessFile, JSON.stringify(rows), 'utf8');
  check('만료 세션 무효', resolveSession(t2), null);

  // 비활성화 사용자는 로그인 불가 + 기존 세션 무효
  const { token: t3 } = login({ name: 'alice', password: 'newalicepass', ip: '9.9.9.9' });
  const aliceId = findUserByName('alice').id; // 비활성화 전 id 확보 (findUserByName 은 활성 사용자만 반환)
  setUserDisabled(aliceId, true);
  throws('비활성화 사용자 로그인 차단', () => login({ name: 'alice', password: 'newalicepass', ip: '9.9.9.9' }), '올바르지 않습니다');
  check('기존 세션도 무효', resolveSession(t3), null);
  setUserDisabled(aliceId, false);
}

console.log('\n── 5. 로그인 시도 제한 ──');
{
  const ip = '7.7.7.7';
  for (let i = 0; i < 5; i += 1) {
    try {
      login({ name: 'alice', password: 'wrong', ip });
    } catch {
      /* 실패 카운트 */
    }
  }
  let blocked = '';
  try {
    login({ name: 'alice', password: 'wrong', ip });
  } catch (err) {
    blocked = `${err.status}:${err.message}`;
  }
  check('6회 연속 실패 → 429', blocked.startsWith('429:'), true);
  // 다른 IP 는 영향 없음
  const { token } = login({ name: 'alice', password: 'newalicepass', ip: '8.8.8.8' });
  check('다른 IP 정상 로그인', typeof token, 'string');
}

console.log('\n── 6. 파일 권한 ──');
{
  const st = fs.statSync(path.join(DATA_DIR, 'users.json'));
  check('users.json 600', (st.mode & 0o777).toString(8), '600');
}

console.log(`\n${'═'.repeat(46)}\n통과 ${pass} / 실패 ${fail}\n`);
process.exit(fail === 0 ? 0 : 1);
