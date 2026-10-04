/**
 * 데몬 관리 스크립트 — 터미널을 닫아도 서버가 계속 돌도록 합니다.
 *
 *   node scripts/daemon.js start|stop|restart|status
 *
 * 왜 필요한가
 *   그냥 `node src/index.js &` 로 띄우면 셸 세션이 정리될 때 함께 종료됩니다.
 *   nohup + unref 로 실행하면 부모(1)로 재부모되어 세션과 무관하게 생존합니다.
 */
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const LOG_DIR = path.join(ROOT, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'server.log');
const PID_FILE = path.join(ROOT, 'server.pid');
const ENTRY = path.join(ROOT, 'server', 'src', 'index.js');
const PORT = Number(process.env.PORT) || 8787;

const isAlive = (pid) => {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const readPid = () => {
  try {
    return Number(fs.readFileSync(PID_FILE, 'utf8').trim()) || null;
  } catch {
    return null;
  }
};

function portInUse(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: '127.0.0.1' });
    const done = (v) => {
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(700);
    sock.on('connect', () => done(true));
    sock.on('timeout', () => done(false));
    sock.on('error', () => done(false));
  });
}

function start() {
  fs.mkdirSync(LOG_DIR, { recursive: true });

  const existing = readPid();
  if (isAlive(existing)) {
    console.log(`이미 실행 중입니다 (PID ${existing}) → http://localhost:${PORT}`);
    return;
  }
  if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE);

  const out = fs.openSync(LOG_FILE, 'a');
  const child = spawn(process.execPath, [ENTRY], {
    cwd: ROOT,
    detached: true, // 새 프로세스 그룹
    stdio: ['ignore', out, out],
    env: process.env,
  });
  child.unref(); // 부모(셸) 종료와 무관하게 유지

  fs.writeFileSync(PID_FILE, String(child.pid), 'utf8');
  console.log(`서버를 백그라운드로 시작했습니다 (PID ${child.pid})`);
  console.log(`  주소 : http://localhost:${PORT}`);
  console.log(`  로그 : logs/server.log`);
  console.log(`  중지 : npm run down`);
}

function stop() {
  const pid = readPid();
  if (!isAlive(pid)) {
    console.log('실행 중인 서버가 없습니다.');
    if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE);
    return;
  }
  // Graceful shutdown 후 강제 종료
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    /* 이미 종료됨 */
  }
  console.log(`종료 신호를 보냈습니다 (PID ${pid}). 정리 중...`);

  const deadline = Date.now() + 6000;
  const timer = setInterval(() => {
    if (!isAlive(pid) || Date.now() > deadline) {
      clearInterval(timer);
      if (isAlive(pid)) {
        try {
          process.kill(pid, 'SIGKILL');
          console.log('  강제 종료했습니다 (SIGKILL).');
        } catch {
          /* noop */
        }
      } else {
        console.log('  정상 종료했습니다.');
      }
      if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE);
      process.exit(0);
    }
  }, 200);
}

async function status() {
  const pid = readPid();
  const alive = isAlive(pid);
  const inUse = await portInUse(PORT);

  console.log(`  PID 파일 : ${pid ?? '없음'}`);
  console.log(`  프로세스 : ${alive ? `실행 중 (PID ${pid})` : '중지'}`);
  console.log(`  포트 ${PORT} : ${inUse ? '사용 중' : '사용 안 함'}`);

  if (fs.existsSync(LOG_FILE)) {
    const lines = fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n');
    console.log(`  로그     : logs/server.log (${lines.length}줄)`);
  }
  console.log(`  상태     : ${alive && inUse ? '✅ 정상' : '⚠️  중지'}`);
}

const cmd = process.argv[2] ?? 'status';

if (cmd === 'start') start();
else if (cmd === 'stop') stop();
else if (cmd === 'restart') {
  try {
    execSync('node scripts/daemon.js stop', { cwd: ROOT, stdio: 'ignore' });
  } catch {
    /* 실행 중이 아니면 무시 */
  }
  setTimeout(start, 400);
} else if (cmd === 'status') {
  await status();
} else {
  console.log('사용법: node scripts/daemon.js start|stop|restart|status');
  process.exit(1);
}
