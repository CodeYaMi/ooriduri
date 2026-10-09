/**
 * 시드 재선정 검증 (개발용)
 * - 합집합 시드 + 탈락 정리 + 보유 종목 유지
 * - 네트워크 미사용 (스캐너 스텁)
 * 실행: node scripts/test-reseed.js (파일시스템 미사용)
 */
import { MarketHub } from '../server/src/market.js';

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

/** 히스토리 집합만 흉내 내는 스캐너 스텁 */
function stubScanner() {
  const history = new Set();
  return {
    history,
    has: (s) => history.has(s),
    seedMany: async (symbols) => {
      for (const s of symbols) history.add(s);
      return symbols.length;
    },
    prune: (keep) => {
      for (const s of [...history]) if (!keep.has(s)) history.delete(s);
    },
    getTrackedSymbols: () => [...history],
    stats: () => ({ tracked: history.size }),
  };
}

console.log('\n── 1. 합집합 시드 ──');
{
  const hub = new MarketHub();
  hub.scanner = stubScanner();
  hub.registerSeedPicks('t1', ['A', 'B', 'C']);
  hub.registerSeedPicks('t2', ['C', 'D']);
  const n = await hub.refreshSeedTargets();
  check('합집합 4종목', n, 4);
  check('전부 시드됨', hub.scanner.getTrackedSymbols().sort(), ['A', 'B', 'C', 'D']);
}

console.log('\n── 2. 탈락 정리 + 보유 유지 ──');
{
  const hub = new MarketHub();
  hub.scanner = stubScanner();
  hub.registerSeedPicks('t1', ['A', 'B']);
  await hub.refreshSeedTargets();
  check('초기 2종목', hub.scanner.getTrackedSymbols().sort(), ['A', 'B']);

  // 다음 주기: B 탈락, C 신규 진입. A는 보유 중이라 유지돼야 함
  hub.registerSeedPicks('t1', ['A', 'C']);
  await hub.refreshSeedTargets(new Set(['A']));
  check('C 시드 + B 정리 + A 유지', hub.scanner.getTrackedSymbols().sort(), ['A', 'C']);
}

console.log('\n── 3. 보유 종목은 탈락해도 유지 ──');
{
  const hub = new MarketHub();
  hub.scanner = stubScanner();
  hub.registerSeedPicks('t1', ['X', 'Y']);
  await hub.refreshSeedTargets();
  hub.registerSeedPicks('t1', []); // 전멸 (설정 변경 등)
  await hub.refreshSeedTargets(new Set(['X']));
  check('보유 X만 남음', hub.scanner.getTrackedSymbols(), ['X']);
}

console.log('\n── 4. 이미 있는 종목은 재조회 안 함 ──');
{
  const hub = new MarketHub();
  const stub = stubScanner();
  let seedCalls = 0;
  const orig = stub.seedMany.bind(stub);
  stub.seedMany = async (symbols) => {
    seedCalls += 1;
    return orig(symbols);
  };
  hub.scanner = stub;
  hub.registerSeedPicks('t1', ['A', 'B']);
  await hub.refreshSeedTargets();
  await hub.refreshSeedTargets(); // 변동 없음
  check('추가 조회 없음', seedCalls, 1);
}

console.log(`\n${'═'.repeat(46)}\n통과 ${pass} / 실패 ${fail}\n`);
process.exit(fail === 0 ? 0 : 1);
