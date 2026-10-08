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

const baseSettings = {
  takeProfitPct: 10,
  stopLossPct: 5,
  trailingStopPct: 0,
  maxHoldMinutes: 0,
  initialCapitalUSDT: 10_000,
  positionSizeUSDT: 100,
  maxPositions: 10,
  topN: 10,
  cooldownMinutes: 0,
  takerFeeBps: 0,
  slippageBps: 0,
  autoTrade: 0,
};

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

console.log('\n── 5. 체결 응답 파싱 (FULL 우선) ──');
{
  // fills VWAP 우선
  const c = stubClient({
    '/fapi/v1/order': {
      status: 'FILLED', orderId: 1, symbol: 'X', side: 'BUY', avgPrice: '0.00000000', executedQty: '1',
      fills: [
        { price: '100', qty: '0.6', commission: '0.03', commissionAsset: 'USDT' },
        { price: '102', qty: '0.4', commission: '0.02', commissionAsset: 'USDT' },
      ],
    },
  });
  const fill = await c.marketBuy('X', 1, {});
  check('fills VWAP 체결가', fill.avgPrice, 100.8);
  check('체결 수량', fill.qty, 1);
  check('전량 체결은 partial 아님', fill.isPartial, false);
  check('수수료 USDT 합산', [fill.fee, fill.feeAsset], [0.05, 'USDT']);
}
{
  // avgPrice 필드 폴백 (fills 없음)
  const c = stubClient({
    '/fapi/v1/order': { status: 'FILLED', orderId: 2, symbol: 'X', side: 'BUY', avgPrice: '99.5', executedQty: '2', fills: [] },
  });
  const fill = await c.marketBuy('X', 2, {});
  check('avgPrice 필드 폴백', fill.avgPrice, 99.5);
}
{
  // 응답 누락 → GET 재조회로 복구
  let orderCalls = 0;
  const c = stubClient({});
  c.signedRequest = async (method, pathname) => {
    if (pathname === '/fapi/v1/order' && method === 'POST') {
      orderCalls += 1;
      return { status: 'FILLED', orderId: 3, symbol: 'X', side: 'BUY', avgPrice: '0', executedQty: '0', fills: [] };
    }
    return {
      status: 'FILLED', orderId: 3, symbol: 'X', side: 'BUY', avgPrice: '101.25', executedQty: '1.5',
      fills: [{ price: '101.25', qty: '1.5', commission: '0.05', commissionAsset: 'USDT' }],
    };
  };
  const fill = await c.marketBuy('X', 1.5, {});
  check('재조회로 체결가 복구', fill.avgPrice, 101.25);
  check('POST 1회 + GET 1회', orderCalls, 1);
}
{
  // 전부 실패 → 동기화 안내와 함께 throw
  const c = stubClient({
    '/fapi/v1/order': { status: 'FILLED', orderId: 4, symbol: 'X', side: 'BUY', avgPrice: '0', executedQty: '0', fills: [] },
  });
  // GET 재조회도 빈 응답
  const orig = c.signedRequest;
  c.signedRequest = async (method, pathname, params) => {
    if (method === 'GET') return { status: 'FILLED', orderId: 4, avgPrice: '0', executedQty: '0', fills: [] };
    return orig(method, pathname, params);
  };
  let msg = '';
  try {
    await c.marketBuy('X', 1, {});
  } catch (err) {
    msg = err.message;
  }
  check('동기화 안내 포함', msg.includes('동기화'), true);
  check('주문번호 포함', msg.includes('#4'), true);
}
{
  // 부분 체결 플래그
  const c = stubClient({
    '/fapi/v1/order': {
      status: 'PARTIALLY_FILLED', orderId: 5, symbol: 'X', side: 'SELL', avgPrice: '0', executedQty: '0.7',
      fills: [{ price: '50', qty: '0.7', commission: '0.01', commissionAsset: 'BNB' }],
    },
  });
  const fill = await c.marketSell('X', 1, {});
  check('부분 체결 감지', fill.isPartial, true);
  check('요청 수량 기록', fill.requestedQty, 1);
  check('체결 수량', fill.qty, 0.7);
  check('수수료 자산 유지', fill.feeAsset, 'BNB');
}

console.log('\n── 6. 부분 체결 잔량 유지 ──');
{
  const { Portfolio } = await import('../server/src/portfolio.js');
  const pf = new Portfolio();
  pf.init({ ...baseSettings, takerFeeBps: 0, slippageBps: 0 });
  const exec = {
    isLive: true,
    dryRun: false,
    buy: async () => ({ qty: 10, avgPrice: 100, cost: 1000 }),
    sell: async () => ({ avgPrice: 110, qty: 6, requestedQty: 10, isPartial: true }),
    toLocalPosition: (ex) => ({ symbol: ex.symbol, qty: ex.positionAmt, entryPrice: ex.entryPrice, markPrice: ex.markPrice, pnlPct: 0, pnlUSDT: 0, highPrice: ex.entryPrice, lowPrice: ex.entryPrice, entryTime: Date.now(), holdMinutes: 0, signal: {} }),
  };
  pf.attachExecutor(exec);
  await pf.buy('X', 1000, 100);
  const closed = await pf.sell('X', 110, 'take-profit');
  check('체결분만 실현', closed.pnlUSDT, 60);
  check('부분 표시', closed.partial, true);
  check('잔량 4 유지', pf.positions.get('X')?.qty, 4);
  check('포지션 삭제 안 됨', pf.positions.has('X'), true);
}

console.log('\n── 7. NEW 상태 폴링 ──');
{
  // NEW → 폴링 후 FILLED
  const c = stubClient({});
  let gets = 0;
  c.signedRequest = async (method, pathname) => {
    if (method === 'POST') return { status: 'NEW', orderId: 10, symbol: 'X', side: 'BUY' };
    gets += 1;
    if (gets < 3) return { status: 'NEW', orderId: 10, symbol: 'X', side: 'BUY' };
    return {
      status: 'FILLED', orderId: 10, symbol: 'X', side: 'BUY', avgPrice: '0', executedQty: '2',
      fills: [{ price: '200', qty: '2', commission: '0.1', commissionAsset: 'USDT' }],
    };
  };
  const fill = await c.marketBuy('X', 2, {});
  check('NEW 후 체결가 확정', fill.avgPrice, 200);
  check('GET 폴링 발생', gets >= 3, true);
}
{
  // NEW 지속 → 타임아웃 후 동기화 안내 (10초 대기)
  const c = stubClient({});
  c.signedRequest = async (method) => {
    if (method === 'POST') return { status: 'NEW', orderId: 11, symbol: 'X', side: 'BUY' };
    return { status: 'NEW', orderId: 11, symbol: 'X', side: 'BUY' };
  };
  const t0 = Date.now();
  let msg = '';
  try {
    await c.marketBuy('X', 1, {});
  } catch (err) {
    msg = err.message;
  }
  check('타임아웃 시 throw', msg.includes('예상과 다릅니다: NEW'), true);
  check('약 10초 대기', Date.now() - t0 >= 9000, true);
}

console.log('\n── 8. -4047 복구 (거래소 수량 기준 재시도) ──');
{
  const { LiveBroker } = await import('../server/src/broker.js');
  const mkBroker = (marketSellImpl, exchangeAmt) => {
    const b = new LiveBroker();
    b.connected = true;
    b.positionMode = 'one-way';
    const sent = [];
    b.client = {
      roundQuantity: (s, q) => Math.floor(q / 0.001) * 0.001,
      filterFor: () => ({ stepSize: 0.001, minQty: 0.001, minNotional: 5, tickSize: 0.01 }),
      marketSell: async (symbol, qty, opts) => {
        sent.push({ symbol, qty, opts });
        return marketSellImpl(symbol, qty, opts);
      },
    };
    b.exchangePositions = async () =>
      exchangeAmt > 0 ? [{ symbol: 'X', positionAmt: exchangeAmt }] : [];
    return { b, sent };
  };
  const err4047 = new BinancePrivateError('ReduceOnly Order is rejected.', { code: -4047 });

  // (a) 로컬 10 vs 거래소 6 → 6으로 재시도 1회 후 성공
  {
    let n = 0;
    const { b, sent } = mkBroker(async () => {
      n += 1;
      if (n === 1) throw err4047;
      return { avgPrice: 50, qty: 6, orderId: 21 };
    }, 6);
    const fill = await b.sell('X', 10, {});
    check('재시도 성공', fill.qty, 6);
    check('첫 시도는 로컬 수량', sent[0].qty, 10);
    check('재시도는 거래소 수량', sent[1].qty, 6);
    check('총 2회 호출', sent.length, 2);
  }
  // (b) 거래소에 없음 → 확정 안내
  {
    const { b } = mkBroker(async () => {
      throw err4047;
    }, 0);
    let msg = '';
    try {
      await b.sell('X', 10, {});
    } catch (err) {
      msg = err.message;
    }
    check('이미 청산됨 안내', msg.includes('이미 없습니다'), true);
  }
  // (c) 다른 에러는 재시도 안 함
  {
    let n = 0;
    const { b } = mkBroker(async () => {
      n += 1;
      throw new BinancePrivateError('boom', { code: -1003 });
    }, 6);
    try {
      await b.sell('X', 10, {});
    } catch { /* noop */ }
    check('-4047 외에는 1회만', n, 1);
  }
  // (d) 보유 초과 금지: dust 분기 삭제 확인
  {
    const { b, sent } = mkBroker(async (s, q) => ({ avgPrice: 50, qty: q, orderId: 22 }), 100);
    await b.sell('X', 5.0009, {});
    check('보유 초과 주문 없음', sent[0].qty <= 5.0009, true);
  }
  // (e) 최소 수량 미달은 사전 안내
  {
    const { b } = mkBroker(async () => ({ avgPrice: 1, qty: 1, orderId: 23 }), 100);
    b.client.filterFor = () => ({ stepSize: 0.001, minQty: 100, minNotional: 5, tickSize: 0.01 });
    let msg = '';
    try {
      await b.sell('X', 5, {});
    } catch (err) {
      msg = err.message;
    }
    check('dust 사전 안내', msg.includes('최소 주문수량'), true);
  }
}

console.log(`\n${'═'.repeat(46)}\n통과 ${pass} / 실패 ${fail}\n`);
process.exit(fail === 0 ? 0 : 1);
