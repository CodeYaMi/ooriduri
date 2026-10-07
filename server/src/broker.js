import { PrivateClient, BinancePrivateError } from './binance/private.js';

/** 시뮬레이션 체결가 정리 (부동소수점 노이즈 제거) */
const round8 = (n) => Number(Number(n).toFixed(8));

/**
 * 실거래 체결 브로커.
 *
 * 전략 판단(익절/손절/시간 청산)은 기존 Portfolio.checkExit 를 그대로 쓰고,
 * 이 클래스는 "주문만 실제로 내는" 역할만 맡는다.
 * → 전략 로직을 갈아끼우지 않으므로 검증된 판정 기준이 그대로 적용된다.
 *
 * 세 가지 실행 모드
 *   paper      : 브로커 미사용 (완전 시뮬레이션)
 *   dryRun     : 실제 계정·잔고·규격을 쓰되 주문은 넣지 않음 (파이프라인 검증)
 *   live       : 실제 주문
 */
export class LiveBroker {
  constructor() {
    /** @type {PrivateClient|null} */
    this.client = null;
    this.network = null;
    this.positionMode = 'one-way';
    this.connected = false;
    this.lastError = null;
    this.orderCount = 0;
    this.simulatedCount = 0;
    this.totalFee = 0;
    /** true 면 실제 주문을 넣지 않는다 */
    this.dryRun = false;
  }

  get isLive() {
    return Boolean(this.client && this.connected);
  }

  /** 계정이 연결돼 있는지 (주문 가능 여부와 무관) */
  get isConnected() {
    return this.isLive;
  }

  get isTestnet() {
    return this.network === 'testnet';
  }

  /** 실제 주문을 넣는 모드인가 */
  get executesOrders() {
    return this.isLive && !this.dryRun;
  }

  /**
   * 연결 + 자격증명 검증
   * @param {{apiKey:string, apiSecret:string, network:string}} creds
   * @param {{dryRun?:boolean}} opts
   */
  async connect(creds, { dryRun = false } = {}) {
    const client = new PrivateClient(creds);
    const account = await client.verify();

    if (!account.canTrade) {
      throw new BinancePrivateError('이 API 키에는 거래 권한이 없습니다. 바이낸스에서 "Enable Futures" 권한을 켜주세요.');
    }

    this.client = client;
    this.network = creds.network === 'production' ? 'production' : 'testnet';
    this.positionMode = account.positionMode;
    this.connected = true;
    this.dryRun = Boolean(dryRun);
    this.lastError = null;

    // 거래 규격(수량 단위 등) 사전 로드 — 주문 거절을 미리 막기 위함
    await client.loadFilters();

    return {
      network: this.network,
      positionMode: this.positionMode,
      canTrade: account.canTrade,
      walletBalance: account.totalWalletBalance,
      availableBalance: account.availableBalance,
    };
  }

  disconnect() {
    this.client = null;
    this.connected = false;
    this.network = null;
    this.orderCount = 0;
    this.simulatedCount = 0;
    this.totalFee = 0;
    this.dryRun = false;
  }

  setDryRun(value) {
    this.dryRun = Boolean(value);
    return this.dryRun;
  }

  /**
   * 포지션 모드 재확인 — 재연결 없이 갱신한다.
   * 사용자가 바이낸스에서 모드를 바꾸면 다음 잔고 갱신 때 자동 반영된다.
   * @returns 변경됐으면 { changed:true, from, to }
   */
  async refreshPositionMode() {
    const client = this.#require();
    const mode = await client.fetchPositionMode();
    if (mode !== this.positionMode) {
      const from = this.positionMode;
      this.positionMode = mode;
      console.log(`[broker] 포지션 모드 변경 감지: ${from} → ${mode}`);
      return { changed: true, from, to: mode };
    }
    return { changed: false, mode };
  }

  #require() {
    if (!this.isLive) throw new BinancePrivateError('계정이 연결되어 있지 않습니다. API 키를 먼저 입력하세요.');
    return this.client;
  }

  /**
   * 진입 매수
   * @param {string} symbol
   * @param {number} notionalUsdt 투자 금액
   * @param {number} refPrice 수량 계산용 참고가
   */
  async buy(symbol, notionalUsdt, refPrice) {
    const client = this.#require();
    const rawQty = notionalUsdt / refPrice;
    const qty = client.roundQuantity(symbol, rawQty);

    const check = client.validateOrder(symbol, qty, refPrice);
    if (!check.ok) {
      throw new BinancePrivateError(
        `주문을 넣을 수 없습니다 (${symbol}): ${check.errors.join(', ')}. 설정에서 종목당 투자 금액을 ${Math.ceil(check.minNotional / refPrice * 10000) / 10000} USDT 이상으로 올리세요.`,
        { code: -4164 },
      );
    }

    // 주문 시뮬레이션: 규격·수량은 검증하되 실제 주문은 넣지 않는다
    if (this.dryRun) {
      this.simulatedCount += 1;
      return {
        orderId: `SIM-${Date.now()}-${this.simulatedCount}`,
        symbol,
        side: 'BUY',
        avgPrice: round8(refPrice),
        qty,
        cost: refPrice * qty,
        reduceOnly: false,
        status: 'SIMULATED',
        simulated: true,
        fee: 0,
        feeAsset: 'USDT',
        time: Date.now(),
      };
    }

    const fill = await client.marketBuy(symbol, qty);
    this.#recordFee(fill);
    return fill;
  }

  /**
   * 청산 매도
   * @param {string} symbol
   * @param {number} qty 보유 수량
   * @param {{closing?:boolean, refPrice?:number}} opts refPrice 는 주문 시뮬레이션 체결가 계산용
   */
  async sell(symbol, qty, { closing = true, refPrice = 0 } = {}) {
    const client = this.#require();
    const rounded = client.roundQuantity(symbol, qty);

    // 수량이 최소 단위에 못 미쳐 dust 가 남는 경우 → 전량 청산 시도
    const f = client.filterFor(symbol);
    const useQty = rounded < f.minQty ? client.roundQuantity(symbol, qty + f.stepSize) : rounded;
    if (!(useQty > 0)) throw new BinancePrivateError(`청산 수량이 0입니다 (${symbol}). 지워진 수량을 정리하세요.`, { code: -1013 });

    // 주문 시뮬레이션
    if (this.dryRun) {
      this.simulatedCount += 1;
      // 부동소수점 노이즈가 체결가에 섞이지 않도록 정리한다
      const price = refPrice > 0 ? round8(refPrice * (1 - this.slippageRate)) : round8(useQty);
      return {
        orderId: `SIM-${Date.now()}-${this.simulatedCount}`,
        symbol,
        side: 'SELL',
        avgPrice: price,
        qty: useQty,
        cost: price * useQty,
        reduceOnly: closing,
        status: 'SIMULATED',
        simulated: true,
        fee: 0,
        feeAsset: 'USDT',
        time: Date.now(),
      };
    }

    const hedge = this.positionMode === 'hedge';
    const fill = await client.marketSell(symbol, useQty, {
      reduceOnly: closing && !hedge,
      positionSide: hedge ? 'LONG' : null,
    });
    this.#recordFee(fill);
    return fill;
  }

  get slippageRate() {
    return (this.settings?.slippageBps ?? 2) / 10_000;
  }

  /** 전략 설정 참조 (슬리피지 등 시뮬레이션에 사용) */
  setSettings(settings) {
    this.settings = settings;
  }

  #recordFee(fill) {
    this.orderCount += 1;
    // 수수료 자산이 USDT 가 아닐 수 있으므로 대략 환산하지 않고 주문 수만 집계한다
    if (fill.feeAsset === 'USDT' && Number.isFinite(fill.fee)) this.totalFee += fill.fee;
  }

  /** 잔고 */
  async balance() {
    return this.#require().fetchBalance();
  }

  /** 거래소 기준 열린 포지션 */
  async exchangePositions() {
    return this.#require().fetchPositions();
  }

  /**
   * 로컬 포지션 ↔ 거래소 포지션 동기화.
   * 거래소에만 있는 포지션 → 로컬에 편입 (재시작 후 복구)
   * 로컬에만 있는 포지션 → 제거 (거래소에서 이미 청산됨)
   * 수량/진입가 불일치 → 거래소 값을 채택 (거래소가 진실)
   * @returns {{adopted:string[], removed:string[], corrected:string[]}}
   */
  async reconcile(localPositions) {
    const client = this.#require();
    const rows = await client.fetchPositions();
    const exchange = new Map(rows.filter((r) => r.positionAmt > 0).map((r) => [r.symbol, r]));

    const adopted = [];
    const removed = [];
    const corrected = [];

    for (const symbol of exchange.keys()) {
      if (localPositions.has(symbol)) {
        const local = localPositions.get(symbol);
        const ex = exchange.get(symbol);
        if (Math.abs(local.qty - ex.positionAmt) > 1e-12 || Math.abs(local.entryPrice - ex.entryPrice) > 1e-8) {
          local.qty = ex.positionAmt;
          local.entryPrice = ex.entryPrice;
          local.reconciledAt = Date.now();
          corrected.push(symbol);
        }
      } else {
        adopted.push(symbol);
      }
    }

    for (const symbol of localPositions.keys()) {
      if (!exchange.has(symbol)) removed.push(symbol);
    }

    return { exchange: rows, adopted, removed, corrected };
  }

  /**
   * 거래소 포지션을 로컬 포지션 객체로 변환 (재시작 후 복구용)
   */
  toLocalPosition(ex, { signal = {}, entryTime = Date.now(), cost = null } = {}) {
    return {
      symbol: ex.symbol,
      qty: ex.positionAmt,
      entryPrice: ex.entryPrice,
      rawEntryPrice: ex.entryPrice,
      // cost 는 실제 체결 금액. 알 수 없으면 진입가 × 수량으로 근사
      cost: cost ?? ex.entryPrice * ex.positionAmt,
      entryTime,
      markPrice: ex.markPrice || ex.entryPrice,
      exitPrice: null,
      pnlPct: ex.entryPrice > 0 ? (ex.markPrice - ex.entryPrice) / ex.entryPrice : 0,
      pnlUSDT: ex.unRealizedProfit,
      highPrice: Math.max(ex.markPrice, ex.entryPrice),
      lowPrice: Math.min(ex.markPrice, ex.entryPrice),
      peakPnlPct: 0,
      trailStopPrice: null,
      holdMinutes: (Date.now() - entryTime) / 60_000,
      signal,
      status: 'open',
      isNew: true,
      live: true,
    };
  }

  describe() {
    return {
      connected: this.connected,
      network: this.network,
      positionMode: this.positionMode,
      dryRun: this.dryRun,
      // 실제로 주문을 넣는 모드인지
      executesOrders: this.executesOrders,
      orderCount: this.orderCount,
      simulatedCount: this.simulatedCount,
      lastError: this.lastError,
    };
  }
}

export { BinancePrivateError };
