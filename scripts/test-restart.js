/**
 * 서버 자체 재시작 검증 (개발용)
 * 실제 프로세스를 띄우지 않고 spawn/exit 을 주입해 검증한다.
 * 실행: node scripts/test-restart.js (파일시스템 미사용 — tmp만)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scheduleRestart } from '../server/src/restart.js';

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
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('\n── 1. 후속 프로세스 실행 + PID 교체 + 종료 ──');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-restart-'));
  const calls = [];
  let shutdownCalled = false;
  const fakeSpawn = (bin, args, opts) => {
    calls.push({ bin, args, opts });
    return { pid: 424242, unref: () => calls.push({ unref: true }) };
  };

  const ret = scheduleRestart({
    entryFile: '/app/server/src/index.js',
    pidFile: path.join(dir, 'server.pid'),
    logFile: path.join(dir, 'logs', 'server.log'),
    delayMs: 20,
    spawnFn: fakeSpawn,
    shutdownFn: () => {
      shutdownCalled = true;
    },
  });
  check('예약 반환', ret.scheduled, true);

  await wait(120);
  check('spawn 1회', calls.filter((c) => c.bin).length, 1);
  const sc = calls[0];
  check('node 로 entry 실행', sc.args, ['/app/server/src/index.js']);
  check('detached', sc.opts.detached, true);
  check('PID 기록 env', sc.opts.env.COIN_SURFER_WRITE_PID, '1');
  check('unref 호출', calls.some((c) => c.unref), true);
  check('PID 파일 교체', fs.readFileSync(path.join(dir, 'server.pid'), 'utf8'), '424242');
  check('기존 종료(shutdown) 호출', shutdownCalled, true);
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('\n── 2. 필수 인자 검증 ──');
{
  let msg = '';
  try {
    scheduleRestart({ pidFile: '/tmp/x.pid' });
  } catch (err) {
    msg = err.message;
  }
  check('entryFile 없으면 즉시 에러', msg.includes('entryFile'), true);
}

console.log('\n── 3. shutdownFn 없으면 exitFn ──');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-restart-'));
  let exited = null;
  scheduleRestart({
    entryFile: '/app/server/src/index.js',
    pidFile: path.join(dir, 'server.pid'),
    logFile: path.join(dir, 'server.log'),
    delayMs: 20,
    spawnFn: () => ({ pid: 1, unref: () => {} }),
    exitFn: (code) => {
      exited = code;
    },
  });
  await wait(120);
  check('exit(0) 호출', exited, 0);
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${'═'.repeat(46)}\n통과 ${pass} / 실패 ${fail}\n`);
process.exit(fail === 0 ? 0 : 1);
