/**
 * 배포용 실행 파일 빌드 (개발용)
 *
 *   node scripts/build-app.js [대상폴더]
 *
 * 생성물
 *   Coin_Surfer.app/            더블클릭 실행 (.app 번들)
 *     └─ Contents/
 *        ├─ Info.plist
 *        ├─ MacOS/Coin_Surfer  실행 스크립트
 *        └─ Resources/         번들 서버 + node 런타임 + 웹 자산
 *   Coin_Surfer.command        터미널용 실행 파일
 *   README.txt                 설치·실행 안내
 *
 * 배포 산출물은 Node 런타임 포함이라 별도 설치 없이 동작한다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// esbuild 의 lib/main.js 는 라이브러리라 CLI 로 실행되지 않는다.
// CLI 를 부르면 exit 0 인데 산출물이 없는 상태가 되므로 JS API 를 직접 쓴다.
const esbuild = require('esbuild');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const TARGET = process.argv[2] ?? path.join(process.env.HOME, 'Kimui-MacBookPro-3', 'Coin_Surfer');
const APP_NAME = 'Coin_Surfer';
const BUNDLE_ID = 'com.coinsurfer.app';
const VERSION = '1.0.0';
const PORT = 8787;

const log = (msg) => console.log(msg);
const step = (n, total, msg) => log(`  [${String(n).padStart(2)}/${total}] ${msg}`);

// ── 정리 ──────────────────────────────────────────────────
function rimraf(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function dirSize(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    total += entry.isDirectory() ? dirSize(p) : fs.statSync(p).size;
  }
  return total;
}

const total = 8;
log('\n▶ 배포용 실행 파일 빌드\n');

// ── 1. 대상 폴더 준비 ──────────────────────────────────────
step(1, total, `대상 폴더 준비: ${TARGET}`);
fs.mkdirSync(TARGET, { recursive: true });

// ── 2. 웹 자산 빌드 ────────────────────────────────────────
step(2, total, '프론트엔드 빌드');
execFileSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit' });
const distDir = path.join(ROOT, 'web', 'dist');
if (!fs.existsSync(path.join(distDir, 'index.html'))) {
  console.error('  ✗ 프론트 빌드 실패 (index.html 없음)');
  process.exit(1);
}

// ── 3. 앱 번들 구조 ────────────────────────────────────────
const APP = path.join(TARGET, `${APP_NAME}.app`);
step(3, total, '앱 번들 구조 생성');
rimraf(APP);
const Contents = path.join(APP, 'Contents');
const MacOS = path.join(Contents, 'MacOS');
const Resources = path.join(Contents, 'Resources');
fs.mkdirSync(MacOS, { recursive: true });
fs.mkdirSync(Resources, { recursive: true });

// ── 4. 서버 번들 (esbuild) ──────────────────────────────────
step(4, total, '서버 번들 (의존성 포함 단일 파일)');
const bundleOut = path.join(Resources, 'server.mjs');
const bundleResult = await esbuild.build({
  entryPoints: [path.join(ROOT, 'server', 'src', 'index.js')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: bundleOut,
  external: ['node:*'],
  banner: {
    // 번들은 esbuild가 만든 파일이므로 import.meta.url 이 원본 경로를 가리킨다.
    // 데이터/인증 파일은 배포 위치가 아니라 사용자 홈 아래에 두어야 하므로
    // 번들 안에서 쓰는 파일 경로는 아래 헬퍼가 항상 사용자 홈 기준으로 해석한다.
    js: [
      'import { fileURLToPath as __csFileURLToPath } from "node:url";',
      'import { dirname as __csDirname } from "node:path";',
    ].join('\n'),
  },
  logLevel: 'warning',
  metafile: true,
});

if (!fs.existsSync(bundleOut) || fs.statSync(bundleOut).size === 0) {
  console.error('  ✗ 서버 번들 실패 (산출물 없음)');
  console.error('  esbuild 결과:', JSON.stringify(bundleResult.errors ?? [], null, 2).slice(0, 800));
  process.exit(1);
}
log(`        ${(fs.statSync(bundleOut).size / 1024).toFixed(0)} KB`);

// ── 5. 웹 자산 + 런타임 ────────────────────────────────────
step(5, total, '웹 자산 및 Node 런타임 포함');
copyDir(distDir, path.join(Resources, 'dist'));

// 번들 내부 import.meta.url 기반 경로 탐색이 깨지지 않도록 표시
fs.writeFileSync(
  path.join(Resources, 'package.json'),
  JSON.stringify({ name: 'coin-surfer-runtime', type: 'module', private: true }, null, 2),
  'utf8',
);

const nodeBin = process.execPath;
const nodeDest = path.join(Resources, 'node');
log(`        Node 런타임 복사 (${nodeBin})`);
fs.copyFileSync(nodeBin, nodeDest);
fs.chmodSync(nodeDest, 0o755);

// ── 6. 실행 스크립트 ────────────────────────────────────────
step(6, total, '실행 스크립트 생성');
const launcher = `#!/bin/bash
# ${APP_NAME} 실행 스크립트 (자동 생성됨 — 수정하지 마세요)
set -euo pipefail

HERE="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
RESOURCES="$(cd "$HERE/../Resources" && pwd)"
NODE="$RESOURCES/node"
PORT=${PORT}

if [ ! -x "$NODE" ]; then
  echo "내장 Node 런타임을 찾을 수 없습니다: $NODE"
  echo "앱이 손상된 것 같습니다. 다시 설치해 주세요."
  read -r -p "엔터를 누르면 종료합니다..."
  exit 1
fi

mkdir -p "$HOME/Library/Logs/${APP_NAME}"
LOG="$HOME/Library/Logs/${APP_NAME}/server.log"

# 이미 실행 중이면 브라우저만 연다
if curl -sf "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
  open "http://127.0.0.1:$PORT"
  exit 0
fi

echo "${APP_NAME} 를 시작합니다...  (로그: $LOG)"
"$NODE" "$RESOURCES/server.mjs" >>"$LOG" 2>&1 &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null || true' EXIT INT TERM

# 준비될 때까지 대기 (최대 60초)
for i in \$(seq 1 60); do
  if curl -sf "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
    echo "준비 완료 — 브라우저를 엽니다."
    open "http://127.0.0.1:$PORT"
    wait $SERVER_PID
    exit 0
  fi
  if ! kill -0 $SERVER_PID 2>/dev/null; then
    echo "서버가 시작되지 못했습니다. 로그를 확인하세요:"
    echo "  $LOG"
    tail -20 "$LOG" 2>/dev/null || true
    read -r -p "엔터를 누르면 종료합니다..."
    exit 1
  fi
  sleep 1
done

echo "대기 시간이 초과되었습니다. 로그: $LOG"
kill $SERVER_PID 2>/dev/null || true
exit 1
`;

const launcherPath = path.join(MacOS, APP_NAME);
fs.writeFileSync(launcherPath, launcher, 'utf8');
fs.chmodSync(launcherPath, 0o755);

// 터미널용 .command
const command = `#!/bin/bash
# ${APP_NAME} — 터미널에서 실행
cd "$(dirname "$0")"
exec "./${APP_NAME}.app/Contents/MacOS/${APP_NAME}"
`;
const commandPath = path.join(TARGET, `${APP_NAME}.command`);
fs.writeFileSync(commandPath, command, 'utf8');
fs.chmodSync(commandPath, 0o755);

// ── 7. Info.plist ───────────────────────────────────────────
step(7, total, 'Info.plist 작성');
const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>${APP_NAME}</string>
  <key>CFBundleDisplayName</key><string>Coin Surfer</string>
  <key>CFBundleIdentifier</key><string>${BUNDLE_ID}</string>
  <key>CFBundleVersion</key><string>${VERSION}</string>
  <key>CFBundleShortVersionString</key><string>${VERSION}</string>
  <key>CFBundleExecutable</key><string>${APP_NAME}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSSupportsAutomaticGraphicsSwitching</key><true/>
  <key>CFBundleIconFile</key><string>AppIcon</string>
</dict>
</plist>
`;
fs.writeFileSync(path.join(Contents, 'Info.plist'), plist, 'utf8');

// 앱 아이콘 (단순 마크 앱 programmatically 생성은 어려워 기본 아이콘 사용)
const iconSrc = path.join(ROOT, 'scripts', 'make-icon.js');
if (fs.existsSync(iconSrc)) {
  spawnSync(process.execPath, [iconSrc, path.join(Resources, 'AppIcon.icns')], { stdio: 'inherit' });
}

// ── 8. 코드 서명 (ad-hoc) ───────────────────────────────────
step(8, total, '코드 서명 (ad-hoc)');
const codesign = spawnSync('codesign', ['--force', '--deep', '--sign', '-', APP], { stdio: 'ignore' });
if (codesign.status !== 0) {
  log('        (codesign 실패 — 실행에는 영향 없음)');
} else {
  log('        완료');
}

// ── 결과 ───────────────────────────────────────────────────
log('');
const size = dirSize(APP);
log('  ✓ 빌드 완료\n');
log(`    앱          ${APP}`);
log(`    터미널 실행  ${commandPath}`);
log(`    크기        ${(size / 1024 / 1024).toFixed(0)} MB`);
log(`    로그        ~/Library/Logs/${APP_NAME}/server.log`);
log(`    설정/키     ~/Documents/기본 프로젝트/coin-surfer/server/data/`);
log('');

// 사용 가능한 런타임 확인 (경고만)
const arch = spawnSync('uname', ['-m'], { encoding: 'utf8' }).stdout.trim();
log(`    대상 아키텍처: ${arch} (arm64)`);
if (arch !== 'arm64') log('    ⚠ 이 빌드는 Apple Silicon 전용입니다.');
log('');