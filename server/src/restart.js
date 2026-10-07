import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

/**
 * 서버 자체 재시작 (마스터 전용 API에서 사용).
 *
 * 동작 순서 (포트 경합 회피):
 *  1. 응답을 먼저 보낸 뒤 delay 후 실행 (클라이언트가 결과를 받도록)
 *  2. 후속 프로세스를 detached 로 실행 — 리슨 실패 시 1초 간격 재시도 (index.js)
 *  3. server.pid 를 후속 PID 로 교체 (데몬 상태 명령과 호환)
 *  4. 기존 프로세스 graceful 종료 → 포트 해제 → 후속이 바인드
 *
 * spawnFn/exitFn 을 주입받으므로 단위 테스트에서 실제 프로세스를 띄우지 않는다.
 */
export function scheduleRestart({
  entryFile,
  pidFile,
  logFile,
  delayMs = 800,
  spawnFn = spawn,
  exitFn = (code) => process.exit(code),
  shutdownFn = null,
  logger = console,
}) {
  if (!entryFile || !pidFile) throw new Error('entryFile 과 pidFile 이 필요합니다.');
  setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
    } catch {
      /* noop */
    }
    let out = 'ignore';
    try {
      out = fs.openSync(logFile, 'a');
    } catch (err) {
      logger.error?.(`[restart] 로그 파일 열기 실패: ${err.message}`);
    }
    const child = spawnFn(process.execPath, [entryFile], {
      detached: true,
      stdio: ['ignore', out, out],
      env: { ...process.env, COIN_SURFER_WRITE_PID: '1' },
    });
    try {
      child.unref?.();
    } catch {
      /* noop */
    }
    try {
      fs.writeFileSync(pidFile, String(child.pid), 'utf8');
    } catch (err) {
      logger.error?.(`[restart] PID 파일 쓰기 실패: ${err.message}`);
    }
    logger.log?.(`[restart] 후속 프로세스 시작 (PID ${child.pid}), 기존 프로세스 종료 중...`);
    if (shutdownFn) {
      shutdownFn();
    } else {
      exitFn(0);
    }
  }, delayMs);
  return { scheduled: true, delayMs };
}
