/** 스캐너 단독 점검 (개발용) */
import { VolumeScanner } from '../server/src/scanner.js';

const scanner = new VolumeScanner();
scanner.configure({ recentWindowMinutes: 3, lookbackMinutes: 30 });

const symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'DOGEUSDT', 'XRPUSDT', 'BNBUSDT', 'ADAUSDT', 'LINKUSDT'];
const ok = await scanner.seedMany(symbols, 4);
console.log('시드 성공:', ok, '/', symbols.length);

let evaluated = 0;
for (const symbol of symbols) {
  const m = scanner.evaluate(symbol);
  if (!m) {
    console.log(`${symbol.padEnd(11)} evaluate → null (히스토리 부족)`);
    continue;
  }
  evaluated += 1;
  console.log(
    `${symbol.padEnd(11)} bars=${String(m.sampleBars).padStart(3)} recentAvg=${Math.round(m.recentAvg).toLocaleString().padStart(12)} ` +
      `baseAvg=${Math.round(m.baseAvg).toLocaleString().padStart(12)} z=${m.z.toFixed(3).padStart(8)} ratio=${m.ratio.toFixed(3).padStart(6)}`,
  );
}
console.log('\nevaluate 성공:', evaluated, '/', symbols.length);
