/**
 * 매도 실패 수정 검증 (개발용)
 * 1) 포지션 모드 감지가 dual 엔드포인트를 쓰는지
 * 2) 청산 실패 백오프가 동작하는지
 * 실행: COIN_SURFER_DATA_DIR=$(mktemp -d)/data node scripts/test-sellfix.js
 */
import { PrivateClient, BinancePrivateError } from '../server/src/binance/private.js';
import { LiveBroker } from '../server/src/broker.js';
import { Trader } from '../server/src/trader.js';
import { createMaster } from '../server/src/auth.js';
import { ensureDefaultAccount, getAccountMeta } from '../server/src/accounts.js';

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

/** signedRequest 를 스텁으로 교체한 클라이언트 */
function stubClient(responses) {
  const c = new PrivateClient({ apiKey: 'A'.repeat(40), apiSecret: 'B'.repeat(40), network: 'testnet' });
  c.calls = [];
  c.signedRequest = async (method, pathname, params) => {
    c.calls.push({ method, pathname });
    const r = responses[pathname];
    if (r instanceof Error) throw r;
    return r;
  };
  return c;
}

console.log('\n── 1. -4061 한국어 안내 ──');
{
  const err = new BinancePrivateError("Order's position side does not match user's setting.", { code: -4061 });
  check('원인 지목 (one-way/LONG)', err.friendly.includes('맞지 않습니다'), true);
}

console.log('\n── 2. 포지션 모드는 dual 엔드포인트로 ──');
{
  const accountRes = { canTrade: true, totalWalletBalance: 100, availableBalance: 100, assets: [] };
  const oneWay = stubClient({ '/fapi/v2/account': accountRes, '/fapi/v1/positionSide/dual': { dualSidePosition: false } });
  check('dual=false → one-way (verify)', (await oneWay.verify()).positionMode, 'one-way');
  check('dual=false → one-way (balance)', (await oneWay.fetchBalance()).positionMode, 'one-way');
  check('dual 엔드포인트 호출됨', oneWay.calls.some((c) => c.pathname === '/fapi/v1/positionSide/dual'), true);

  const hedge = stubClient({ '/fapi/v2/account': accountRes, '/fapi/v1/positionSide/dual': { dualSidePosition: true } });
  check('dual=true → hedge', (await hedge.verify()).positionMode, 'hedge');
}

console.log('\n── 3. 브로커 모드 자가 복구 ──');
{
  const b = new LiveBroker();
  b.client = stubClient({ '/fapi/v1/positionSide/dual': { dualSidePosition: false } });
  b.connected = true;
  b.positionMode = 'hedge'; // 잘못 캐시된 상태
  const r = await b.refreshPositionMode();
  check('변경 감지', [r.changed, r.from, r.to], [true, 'hedge', 'one-way']);
  check('모드 갱신됨', b.positionMode, 'one-way');
  const r2 = await b.refreshPositionMode();
  check('동일하면 changed=false', r2.changed, false);
}

console.log('\n── 4. 청산 실패 백오프 ──');
{
  const master = createMaster({ name: 'master', password: 'masterpass123' });
  const acc = ensureDefaultAccount(master.id);
  const hub = {
    quoteFor: () => ({ ask: 100, bid: 89 }), // -11% → 손절 트리거
    scanner: { rank: () => [], nearMisses: () => [], lastRejectedBy24h: 0, lastRejectedByRsi: 0 },
    market: new Map(),
    universeMap: new Map(),
    registerSeedPicks: () => {},
  };
  const t = new Trader(acc.id, getAccountMeta(acc.id), hub);
  t.settings = { ...t.settings, takeProfitPct: 10, stopLossPct: 5, cooldownMinutes: 0 };

  let sellCalls = 0;
  const boom = () => {
    sellCalls += 1;
    throw new BinancePrivateError("Order's position side does not match user's setting.", { code: -4061 });
  };
  const mockExec = {
    isLive: true,
    dryRun: false,
    sell: boom,
    buy: async () => ({ qty: 1, avgPrice: 100, cost: 100 }),
    toLocalPosition: (ex, { signal } = {}) => ({
      symbol: ex.symbol,
      qty: ex.positionAmt,
      entryPrice: ex.entryPrice,
      markPrice: ex.markPrice,
      pnlPct: 0,
      pnlUSDT: 0,
      highPrice: ex.entryPrice,
      lowPrice: ex.entryPrice,
      entryTime: Date.now(),
      holdMinutes: 0,
      signal: signal ?? {},
    }),
  };
  t.portfolio.attachExecutor(mockExec);
  await t.portfolio.buy('TESTUSDT', 100, { change24hPct: 1 });

  // 첫 틱: 청산 시도 → 실패 → 백오프 등록
  const first = t.processPriceUpdates();
  await new Promise((r) => setTimeout(r, 50)); // #closePositions 비동기 완료 대기
  check('첫 실패 시도됨', sellCalls, 1);
  check('백오프 등록', t.closeFail.has('TESTUSDT'), true);
  const rec = t.closeFail.get('TESTUSDT');
  check('재시도 시각이 미래', rec.nextRetryAt > Date.now(), true);
  check('로그에 재시도 안내', rec.count, 1);

  // 즉시 다음 틱: 건너뜀 (가격 반영만)
  sellCalls = 0;
  const second = t.processPriceUpdates();
  await new Promise((r) => setTimeout(r, 50));
  check('백오프 중 재시도 안 함', sellCalls, 0);
  check('건너뛴 exits 미반환', second.length, 0);
  check('포지션은 유지 (손실 감시 계속)', t.portfolio.positions.has('TESTUSDT'), true);

  // 쿨다운 만료 후: 다시 시도
  rec.nextRetryAt = Date.now() - 1;
  t.processPriceUpdates();
  await new Promise((r) => setTimeout(r, 50));
  check('만료 후 재시도', sellCalls, 1);
  check('연속 실패 카운트 증가', t.closeFail.get('TESTUSDT').count, 2);

  // 수동 매도는 백오프를 우회 (사용자가 명시 요청)
  sellCalls = 0;
  await t.manualSell('TESTUSDT');
  check('수동 매도는 즉시 시도', sellCalls, 1);

  // 성공 시 백오프 해제
  t.portfolio.executor.sell = async () => ({ avgPrice: 89, qty: 1 });
  rec.nextRetryAt = Date.now() - 1;
  t.processPriceUpdates();
  await new Promise((r) => setTimeout(r, 100));
  check('성공 후 백오프 해제', t.closeFail.has('TESTUSDT'), false);
  check('포지션 정리됨', t.portfolio.positions.has('TESTUSDT'), false);
  t.stop();
}

console.log(`\n${'═'.repeat(46)}\n통과 ${pass} / 실패 ${fail}\n`);
process.exit(fail === 0 ? 0 : 1);
