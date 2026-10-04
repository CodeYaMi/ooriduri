/**
 * 앱 아이콘 생성 (개발용) — 외부 이미지 의존성 없이 .icns 를 만든다.
 *   node scripts/make-icon.js <출력경로.icns>
 *
 * 코어 그래픽만으로 그려서 어느 환경에서도 동작한다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const OUT = process.argv[2] ?? path.join(ROOT, 'app-icon.icns');

const SIZES = [16, 32, 64, 128, 256, 512, 1024];
const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'cs-icon-'));

/** 라운드 렉트 그라데이션 배지 + 물결 표시 (거래량 급등 상징) */
function drawSvg(size) {
  const s = size;
  const r = s * 0.22; // 코너 라운드
  const waveY = s * 0.62;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 ${s} ${s}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#1e293b"/>
      <stop offset="55%" stop-color="#0f172a"/>
      <stop offset="100%" stop-color="#020617"/>
    </linearGradient>
    <linearGradient id="wave" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#38bdf8"/>
      <stop offset="100%" stop-color="#818cf8"/>
    </linearGradient>
  </defs>

  <rect x="0" y="0" width="${s}" height="${s}" rx="${r}" fill="url(#bg)"/>

  <!-- 추세 상승선 -->
  <polyline
    points="${s * 0.16},${waveY} ${s * 0.36},${waveY - s * 0.06} ${s * 0.52},${waveY - s * 0.02} ${s * 0.66},${s * 0.4} ${s * 0.84},${s * 0.3}"
    fill="none" stroke="url(#wave)" stroke-width="${s * 0.062}"
    stroke-linecap="round" stroke-linejoin="round"/>

  <!-- 거래량 막대 3개 (급등 표현) -->
  <g fill="url(#wave)" opacity="0.9">
    <rect x="${s * 0.16}" y="${s * 0.74}" width="${s * 0.075}" height="${s * 0.1}" rx="${s * 0.02}"/>
    <rect x="${s * 0.29}" y="${s * 0.68}" width="${s * 0.075}" height="${s * 0.16}" rx="${s * 0.02}"/>
    <rect x="${s * 0.42}" y="${s * 0.56}" width="${s * 0.075}" height="${s * 0.28}" rx="${s * 0.02}"/>
    <rect x="${s * 0.55}" y="${s * 0.46}" width="${s * 0.075}" height="${s * 0.38}" rx="${s * 0.02}"/>
    <rect x="${s * 0.68}" y="${s * 0.34}" width="${s * 0.075}" height="${s * 0.5}" rx="${s * 0.02}"/>
    <rect x="${s * 0.81}" y="${s * 0.22}" width="${s * 0.075}" height="${s * 0.62}" rx="${s * 0.02}"/>
  </g>
</svg>`;
}

// PNG 렌더링에 rsvg-convert / qlmanage / sips 중 하나를 사용한다
function renderPng(svgPath, pngPath, size) {
  // 1순위: rsvg-convert (고품질)
  const rsvg = spawnSync('rsvg-convert', ['-w', String(size), '-h', String(size), '-o', pngPath, svgPath], { stdio: 'ignore' });
  if (rsvg.status === 0) return true;

  // 2순위: sips (SVG 지원 여부 확인)
  const sips = spawnSync('sips', ['-s', 'format', 'png', '-z', String(size), String(size), svgPath, '--out', pngPath], { stdio: 'ignore' });
  if (sips.status === 0 && fs.existsSync(pngPath) && fs.statSync(pngPath).size > 0) return true;

  return false;
}

let rendered = 0;
const made = [];

for (const size of SIZES) {
  const svgPath = path.join(tmp, `icon-${size}.svg`);
  const pngPath = path.join(tmp, `icon-${size}.png`);
  fs.writeFileSync(svgPath, drawSvg(size), 'utf8');
  if (renderPng(svgPath, pngPath, size)) {
    made.push({ size, png: pngPath });
    rendered += 1;
  }
}

if (!rendered) {
  console.log('  (아이콘 생성 도구 없음 — 기본 아이콘을 사용합니다)');
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(0);
}

// iconset 생성 → iconutil 로 .icns
const iconset = path.join(tmp, 'AppIcon.iconset');
fs.mkdirSync(iconset, { recursive: true });
for (const { size, png } of made) {
  const copy = (px) => fs.copyFileSync(png, path.join(iconset, `icon_${px}x${px}.png`));
  copy(size);
  if (size <= 512) copy(size * 2); // @2x
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
const util = spawnSync('iconutil', ['-c', 'icns', iconset, '-o', OUT], { stdio: 'ignore' });
fs.rmSync(tmp, { recursive: true, force: true });

if (util.status === 0 && fs.existsSync(OUT)) {
  console.log(`  아이콘 생성: ${OUT} (${(fs.statSync(OUT).size / 1024).toFixed(0)} KB)`);
} else {
  console.log('  (iconutil 실패 — 기본 아이콘을 사용합니다)');
}