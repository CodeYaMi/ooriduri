/**
 * 청산 내역 CSV 검증 (개발용)
 * 실행: node scripts/test-csv.js (파일시스템 미사용)
 */
import { tradesToCsv, csvFilename, formatLocal } from '../server/src/csv.js';

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

const T1 = new Date(2026, 9, 6, 12, 30, 45).getTime();
const T2 = new Date(2026, 9, 7, 9, 5, 3).getTime();

console.log('\n── 1. 헤더 + BOM ──');
{
  const out = tradesToCsv([]);
  check('BOM', out.charCodeAt(0).toString(16), 'feff');
  check(
    '헤더',
    out.slice(1).split('\n')[0],
    '청산시각,종목,청산사유,진입가,청산가,수익률(%),손익(USDT),보유시간(분),부분체결',
  );
  check('빈 기록도 헤더만', out.trim().split('\n').length, 1);
}

console.log('\n── 2. 행 변환 ──');
{
  const out = tradesToCsv([
    {
      symbol: 'BTCUSDT',
      exitReason: 'take-profit',
      entryPrice: 50000.123456789,
      exitPrice: 55000,
      pnlPct: 0.1,
      pnlUSDT: 500.56789,
      holdMinutes: 12.345,
      exitTime: T1,
      partial: false,
    },
  ]);
  const row = out.trim().split('\n')[1];
  check(
    '행 전체',
    row,
    '2026-10-06 12:30:45,BTCUSDT,익절,50000.12345679,55000.00000000,10.000,500.5679,12.3,',
  );
}

console.log('\n── 3. 정렬 (최신 먼저) ──');
{
  const out = tradesToCsv([
    { symbol: 'OLD', exitTime: T1, pnlUSDT: 1 },
    { symbol: 'NEW', exitTime: T2, pnlUSDT: 2 },
  ]);
  const rows = out.trim().split('\n').slice(1);
  check('최신이 먼저', [rows[0].includes('NEW'), rows[1].includes('OLD')], [true, true]);
}

console.log('\n── 4. 이스케이프 + 결측 ──');
{
  const out = tradesToCsv([
    { symbol: 'WEIRD,COIN', exitReason: 'custom "reason"', entryPrice: NaN, pnlUSDT: null, holdMinutes: undefined, exitTime: T1, partial: true },
  ]);
  const row = out.trim().split('\n')[1];
  check('콤마·따옴표 이스케이프', row.includes('"WEIRD,COIN"') && row.includes('"custom ""reason"""'), true);
  check('NaN/null은 빈칸', row.includes(',,,,'), true);
  check('부분체결 Y', row.endsWith(',Y'), true);
  check('알 수 없는 사유는 원문', row.includes('custom'), true);
}

console.log('\n── 5. 파일명 ──');
{
  const name = csvFilename('기본');
  check('접두사', name.startsWith('coin-surfer-trades_'), true);
  check('확장자', name.endsWith('.csv'), true);
  check('금지문자 제거', csvFilename('a/b:c*d?e"f<g>h|i\\j').includes('/'), false);
  check('빈 이름 폴백', csvFilename('').startsWith('coin-surfer-trades_account_'), true);
}

console.log('\n── 6. 시각 형식 ──');
{
  check('정상', formatLocal(T2), '2026-10-07 09:05:03');
  check('무효', formatLocal(null), '');
}

console.log(`\n${'═'.repeat(46)}\n통과 ${pass} / 실패 ${fail}\n`);
process.exit(fail === 0 ? 0 : 1);
