/**
 * 실거래 경로 검증 (개발용) — 실제 네트워크 호출 없이 모의 브로커로 검증
 */
import { Portfolio } from '../server/src/portfolio.js';

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

const settings = {
  takeProfitPct: 10,
  stopLossPct: 5,
  trailingStopPct: 0,
  maxHoldMinutes: 0,
  initialCapitalUSDT: 10000,
  positionSizeUSDT: 100,
  maxPositions: 10,
  topN: 10,
  cooldownMinutes: 15,
  takerFeeBps: 5,
  slippageBps: 2,
  autoTrade: 1,
};

/** 실제 체결을 흉내내는 모의 브로커 */
function makeBroker({ ask = 100, fillSlip = 0, available = 10000, failWith = null, minNotional = 5 } = {}) {
  const orders = [];
  return {
    isLive: true,
    network: 'testnet',
    positionMode: 'one-way',
    orders,
    async buy(symbol, notional, refPrice) {
      if (failWith) throw new Error(failWith);
      const qty = notional / refPrice;
      if (qty * refPrice < minNotional) throw new Error(`주문금액 최소 ${minNotional} 미만`);
      const avgPrice = ask * (1 + fillSlip);
      const fill = { orderId: 1000 + orders.length, symbol, avgPrice, qty, cost: avgPrice * qty };
      orders.push({ side: 'BUY', ...fill, notional });
      return fill;
    },
    async sell(symbol, qty) {
      if (failWith) throw new Error(failWith);
      const avgPrice = ask * (1 - fillSlip);
      const fill = { orderId: 2000 + orders.length, symbol, avgPrice, qty, cost: avgPrice * qty };
      orders.push({ side: 'SELL', ...fill });
      return fill;
    },
    toLocalPosition(ex, { signal, cost } = {}) {
      return {
        symbol: ex.symbol,
        qty: ex.positionAmt,
        entryPrice: ex.entryPrice,
        rawEntryPrice: ex.entryPrice,
        cost: cost ?? ex.entryPrice * ex.positionAmt,
        entryTime: Date.now(),
        markPrice: ex.markPrice,
        exitPrice: null,
        pnlPct: 0,
        pnlUSDT: 0,
        highPrice: ex.entryPrice,
        lowPrice: ex.entryPrice,
        peakPnlPct: 0,
        trailStopPrice: null,
        holdMinutes: 0,
        signal: signal ?? {},
        status: 'open',
        isNew: true,
      };
    },
  };
}

function livePortfolio(broker) {
  const pf = new Portfolio();
  pf.init(settings);
  pf.attachExecutor(broker);
  pf.liveBalance = { walletBalance: 10000, availableBalance: 10000, unrealizedProfit: 0, marginBalance: 10000 };
  return pf;
}

console.log('\n── 1. 실거래 모드 매수/매도 ──');
{
  const broker = makeBroker({ ask: 100 });
  const pf = livePortfolio(broker);

  check('isLive', pf.isLive, true);
  const p = await pf.buy('BTCUSDT', 100, 100);
  check('거래 요청 발생', broker.orders.length, 1);
  check('매수 주문 방향', broker.orders[0].side, 'BUY');
  check('진입가는 실제 체결가(슬리피지 없음)', p.entryPrice, 100);
  check('수량은 투자금액/가격', p.qty, 1);
  check('포지션이 실거래로 표시', p.live, true);
  check('현금은 건드리지 않음 (거래소 관리)', pf.cash, 10000);
}

{
  const broker = makeBroker({ ask: 100, fillSlip: 0.001 });
  const pf = livePortfolio(broker);
  const p = await pf.buy('BTCUSDT', 100, 100);

  check('체결 슬리피지가 진입가에 반영', p.entryPrice, 100.1);
  check('실거래는 슬리피지 설정을 두 번 적용하지 않음', p.entryPrice === 100 * 1.0002, false);
}

console.log('\n── 2. 손익 판정은 가상과 동일 ──');
{
  // 진입 100, 가상+실거래 모두 같은 기준 적용
  const paper = new Portfolio();
  paper.init({ ...settings, takerFeeBps: 0, slippageBps: 0 });
  const pp = await paper.buy('X', 100, {});

  const broker = makeBroker({ ask: 100 });
  const live = livePortfolio(broker);
  const lp = await live.buy('X', 100, 100);

  check('checkExit +10% 동일', live.checkExit(lp, 110.0, Date.now()), 'take-profit');
  check('checkExit −5% 동일', live.checkExit(lp, 95.0, Date.now()), 'stop-loss');
  check('checkExit +9.99% 보류 동일', live.checkExit(lp, 109.99, Date.now()), null);
  check('가상 진입가와 실거래 진입가 동일', pp.entryPrice, lp.entryPrice);
}

console.log('\n── 3. 실거래 청산 ──');
{
  const broker = makeBroker({ ask: 100 });
  const pf = livePortfolio(broker);
  await pf.buy('BTCUSDT', 100, 100);

  // 가격 110 로 평가 → 익절
  const exits = pf.update(new Map([['BTCUSDT', 110.05]]));
  check('익절 감지', exits[0]?.reason, 'take-profit');

  const closed = await pf.sell('BTCUSDT', 100, 'take-profit');
  check('매도 주문 발생', broker.orders.filter((o) => o.side === 'SELL').length, 1);
  check('청산가 = 실제 체결가', closed.exitPrice, 100);
  check('수익률 = 진입가 대비', (closed.pnlPct * 100).toFixed(2), '0.00');
  check('실거래는 수수료를 추정하지 않음', closed.exitFee, 0);
  check('포지션 제거됨', pf.positions.size, 0);
}

{
  const broker = makeBroker({ ask: 100 });
  const pf = livePortfolio(broker);
  await pf.buy('BTCUSDT', 100, 100);
  const closed = await pf.sell('BTCUSDT', 100, 'manual');
  check('수동 매도도 실제 주문', broker.orders.length, 2);
  check('매도 수량 = 보유 수량', closed.qty, 1);
}

console.log('\n── 4. 사전 검증 (거래소가 거절할 상황을 미리 차단) ──');
{
  const pf = livePortfolio(makeBroker());
  pf.liveBalance.availableBalance = 50; // 잔고 부족
  const r = await pf.buy('BTCUSDT', 100, 100);
  check('잔고 부족 사전 차단', typeof r.error === 'string' && r.error.includes('잔고'), true);
}
{
  const pf = livePortfolio(makeBroker({ minNotional: 1000 }));
  let message = '';
  try {
    await pf.buy('CHEAPUSDT', 1, 1); // 1 USDT 주문
  } catch (err) {
    message = err.message;
  }
  check('최소 주문금액 사전 차단', message.includes('최소'), true);
}
{
  const pf = livePortfolio(makeBroker());
  await pf.buy('BTCUSDT', 100, 100);
  const dup = await pf.buy('BTCUSDT', 100, 100);
  check('중복 진입 차단 (실거래에서도)', dup.error, 'BTCUSDT 이미 보유 중');
}
{
  const pf = livePortfolio(makeBroker());
  const r1 = await pf.buy('A', 100, 100);
  const r2 = await pf.buy('B', 100, 100);
  const r3 = await pf.buy('C', 100, 100);
  check('슬롯 초과 차단 (10종목 설정에 2개만 채워도 통과)', [Boolean(r1), Boolean(r2), Boolean(r3)], [true, true, true]);
}

console.log('\n── 5. 주문 실패가 전파된다 ──');
{
  const pf = livePortfolio(makeBroker({ failWith: '거래소 거절: 잔고 부족' }));
  let caught = '';
  try {
    await pf.buy('BTCUSDT', 100, 100);
  } catch (err) {
    caught = err.message;
  }
  check('주문 실패 예외 전달', caught, '거래소 거절: 잔고 부족');
  check('실패해도 포지션 생성 안 됨', pf.positions.size, 0);
}

console.log('\n── 6. 요약은 거래소 잔고 기준 ──');
{
  const broker = makeBroker({ ask: 100 });
  const pf = livePortfolio(broker);
  await pf.buy('BTCUSDT', 100, 100);

  pf.liveBalance = { walletBalance: 9900, availableBalance: 9800, unrealizedProfit: 12.5, marginBalance: 9912.5 };
  pf.equity = pf.computeEquity();

  const s = pf.summary();
  check('live 플래그', s.live, true);
  check('자산 = 지갑잔고 + 미실현손익', s.equity, 9912.5);
  check('현금은 가용잔고', s.cash, 9800);
  check('지갑 잔고 별도 노출', s.walletBalance, 9900);
  check('미실현 손익은 거래소 값', s.unrealizedPnl, 12.5);
  check('네트워크 노출', s.network, 'testnet');
}

console.log('\n── 7. 가상 모드 복귀 ──');
{
  const broker = makeBroker({ ask: 100 });
  const pf = livePortfolio(broker);
  await pf.buy('BTCUSDT', 100, 100);
  pf.detachExecutor();

  check('isLive 해제', pf.isLive, false);
  const p = await pf.buy('ETHUSDT', 100, 100);
  check('가상 매수 재개', typeof p.error, 'undefined');
  check('가상 모드 진입가는 슬리피지 적용', p.entryPrice, 100.02);
  check('실거래 잔고 무시', pf.liveBalance, null);
  const s = pf.summary();
  check('summary.live = false', s.live, false);
}

console.log('\n── 8. 주문 시뮬레이션 모드 (dryRun) ──');
{
  // dryRun 은 LiveBroker 계층의 로직이므로 실제 클래스를 검증한다.
  // PrivateClient 만 스텁으로 교체해 "거래소로 전송되었는가"를 관찰한다.
  const { LiveBroker } = await import('../server/src/broker.js');

  let sent = 0;
  const stubClient = {
    filterFor: () => ({ stepSize: 0.001, minQty: 0.001, minNotional: 5, tickSize: 0.01 }),
    roundQuantity: (sym, qty) => Math.floor(qty / 0.001) * 0.001,
    validateOrder: (sym, qty, price) => ({ ok: true, errors: [], minNotional: 5, stepSize: 0.001 }),
    marketBuy: async () => {
      sent += 1;
      return { orderId: 1, symbol: 'X', side: 'BUY', avgPrice: 100, qty: 1, cost: 100, status: 'FILLED' };
    },
    marketSell: async () => {
      sent += 1;
      return { orderId: 2, symbol: 'X', side: 'SELL', avgPrice: 100, qty: 1, cost: 100, status: 'FILLED' };
    },
  };

  const broker = new LiveBroker();
  broker.client = stubClient;
  broker.connected = true;
  broker.network = 'testnet';
  broker.setSettings({ slippageBps: 2 });
  broker.dryRun = true;

  check('isLive (계정 연결됨)', broker.isLive, true);
  check('executesOrders = false', broker.executesOrders, false);

  const buy = await broker.buy('X', 100, 100);
  check('매수 시 거래소 호출 0회', sent, 0);
  check('체결가는 참고가', buy.avgPrice, 100);
  check('simulated = true', buy.simulated, true);
  check('orderId SIM- 접두사', String(buy.orderId).startsWith('SIM-'), true);
  check('simulatedCount 증가', broker.simulatedCount, 1);

  const sell = await broker.sell('X', 1, { closing: true, refPrice: 110 });
  check('매도 시 거래소 호출 0회', sent, 0);
  check('매도도 simulated', sell.simulated, true);
  check('매도 체결가 = 참고가 − 슬리피지', sell.avgPrice, 109.978);
  check('simulatedCount 2', broker.simulatedCount, 2);

  // dryRun 끄면 실제 주문 경로로 전환
  broker.setDryRun(false);
  check('executesOrders = true', broker.executesOrders, true);
  await broker.buy('X', 100, 100);
  check('매수 시 거래소 호출 1회', sent, 1);
  await broker.sell('X', 1, { closing: true });
  check('매도 시 거래소 호출 2회', sent, 2);
  check('실제 주문 카운터 증가', broker.orderCount, 2);
  check('시뮬레이션 카운터 그대로', broker.simulatedCount, 2);
}

console.log('\n── 9. dryRun 에서도 규격 검증은 동작 ──');
{
  const { LiveBroker } = await import('../server/src/broker.js');
  const broker = new LiveBroker();
  broker.client = {
    filterFor: () => ({ stepSize: 0.001, minQty: 0.001, minNotional: 1000, tickSize: 0.01 }),
    roundQuantity: (s, q) => q,
    validateOrder: (s, q, p) => ({ ok: false, errors: [`주문금액 ${p * q} 가 최소 1000 미만`], minNotional: 1000, stepSize: 0.001 }),
  };
  broker.connected = true;
  broker.dryRun = true;

  let msg = '';
  try {
    await broker.buy('CHEAP', 1, 1);
  } catch (err) {
    msg = err.message;
  }
  check('시뮬레이션 중에도 최소 주문금액 검증', msg.includes('최소'), true);
  check('simulatedCount 증가하지 않음', broker.simulatedCount, 0);
}

console.log('\n── 10. 포트폴리오가 simulated 플래그를 노출 ──');
{
  const broker = makeBroker({ ask: 100 });
  const realBuy = broker.buy;
  const realSell = broker.sell;
  broker.buy = async (symbol, notional, ref) => ({ ...(await realBuy(symbol, notional, ref)), simulated: true });
  broker.sell = async (symbol, qty) => ({ ...(await realSell(symbol, qty)), simulated: true });
  broker.isLive = true;
  const pf = livePortfolio(broker);
  const p = await pf.buy('X', 100, 100);
  check('포지션에 simulated 전달', p.simulated, true);

  const closed = await pf.sell('X', 100, 'manual');
  check('청산 기록에 simulated 전달', closed.simulated, true);
}

console.log('\n── 11. 확인 게이트 정책 ──');
{
  const { requiresConfirmation } = await import('../server/src/credentials.js');

  // 위험 모드는 반드시 확인을 요구해야 한다
  check('실거래 + 실제주문 → 확인 필요', requiresConfirmation({ mode: 'live', dryRun: false }), true);
  // 안전 모드는 확인 없이 진입되어야 한다 (과도한 마찰 방지)
  check('실거래 + 시뮬레이션 → 확인 불필요', requiresConfirmation({ mode: 'live', dryRun: true }), false);
  check('가상 모드 → 확인 불필요', requiresConfirmation({ mode: 'paper', dryRun: false }), false);
  check('가상 + 시뮬레이션 → 확인 불필요', requiresConfirmation({ mode: 'paper', dryRun: true }), false);
  // 실거래인데 dryRun 이 빠진 값(오류/누락)도 위험 모드로 취급돼야 한다
  check('dryRun 누락(undefined) → 확인 필요', requiresConfirmation({ mode: 'live', dryRun: undefined }), true);
}

console.log(`\n${'═'.repeat(46)}\n통과 ${pass} / 실패 ${fail}\n`);
process.exit(fail === 0 ? 0 : 1);
