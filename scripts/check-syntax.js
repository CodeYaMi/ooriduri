/**
 * 서버 구문 검사 (개발용)
 *
 * 프론트엔드 빌드(Vite)는 server/ 코드를 다루지 않으므로
 * 서버 쪽 구문 오류는 실제 실행 전까지 드러나지 않는다.
 * `node --check` 로 파일을 파싱만 하고 실행하지 않는다 (부작용 없음).
 *
 * .jsx 는 `node --check` 가 파싱하지 못하므로 제외한다.
 * 프론트 코드는 `npm run build` (Vite/esbuild) 가 별도로 검증한다.
 */
import { readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry.endsWith('.js')) out.push(full);
  }
  return out;
}

const targets = [
  ...walk(path.join(ROOT, 'server', 'src')),
  ...walk(path.join(ROOT, 'scripts')),
  ...walk(path.join(ROOT, 'web', 'src')),
];

let pass = 0;
let fail = 0;

console.log('\n── 구문 검사 (실행 없이 파싱만) ──\n');

for (const file of targets) {
  const rel = path.relative(ROOT, file);
  const res = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (res.status === 0) {
    pass += 1;
    console.log(`  ✅ ${rel}`);
  } else {
    fail += 1;
    const msg = (res.stderr ?? '').split('\n').filter((l) => l.trim() && !l.includes('^')).slice(0, 2).join(' ');
    console.log(`  ❌ ${rel}\n     ${msg.trim()}`);
  }
}

console.log(`\n${'═'.repeat(46)}\n통과 ${pass} / 실패 ${fail}\n`);
process.exit(fail === 0 ? 0 : 1);
