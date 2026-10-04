/**
 * 투자 포트폴리오.
 *
 * 기본 모드(가상): 실제 잔고·주문 없이 체결가와 비용을 시뮬레이션한다.
 * 실거래 모드: executor(LiveBroker) 로 실제 주문을 내고, 체결 결과를 포지션에 반영한다.
 *
 * 어느 모드든 손익 판정(checkExit) 로직은 완전히 동일하다.
 * 진입가(매수 체결가) 대비 현재가로 수익률을 계산한다.
 */
export class Portfolio {
  constructor() {
    this.cash = 0;
    /** @type {Map<string, object>} */
    this.positions = new Map();
    /** @type {Array<object>} */
    this.trades = [];
    this.realizedPnl = 0;
    this.totalFees = 0;
    this.equityPeak = 0;
    this.equity = 0;
    this.settings = null;

    /** 실거래 브로커 (없으면 가상 모드) */
    this.executor = null;
    /** 실거래 잔고 스냅샷 (거래소가 관리) */
    this.liveBalance = null;
  }

  /** 실거래 모드 여부 */
  get isLive() {
    return Boolean(this.executor?.isLive);
  }

  /** 실거래 브로커 연결 */
  attachExecutor(broker) {
    this.executor = broker;
  }

  detachExecutor() {
    this.executor = null;
    this.liveBalance = null;
  }

  init(settings, previous = null) {
    this.settings = settings;
    this.cash = settings.initialCapitalUSDT;
    this.positions = new Map();
    this.trades = [];
    this.realizedPnl = 0;
    this.totalFees = 0;

    if (previous) {
      // 서버 재시작 시 이전 상태 복원
      this.cash = previous.cash ?? this.cash;
      this.realizedPnl = previous.realizedPnl ?? 0;
      this.totalFees = previous.totalFees ?? 0;
      this.trades = Array.isArray(previous.trades) ? previous.trades.slice(-500) : [];
      for (const p of previous.positions ?? []) {
        this.positions.set(p.symbol, { ...p, isNew: false });
      }
    }

    this.equityPeak = this.computeEquity();
    this.equity = this.equityPeak;
  }

  get feeRate() {
    return this.settings.takerFeeBps / 10_000;
  }

  get slippageRate() {
    return this.settings.slippageBps / 10_000;
  }

  /** 진입가: 매수는 호가(ask) + 슬리피지, 청산은 (bid) - 슬리피지 */
  buyFillPrice(rawAsk) {
    return rawAsk * (1 + this.slippageRate);
  }

  sellFillPrice(rawBid) {
    return rawBid * (1 - this.slippageRate);
  }

  get openCount() {
    return this.positions.size;
  }

  get availableSlots() {
    return Math.max(0, this.settings.maxPositions - this.positions.size);
  }

  /** 잔고만으로 살 수 있는지 (수수료 포함) */
  canAfford(notional) {
    return this.cash >= notional * (1 + this.feeRate);
  }

  /**
   * 매수 (가상 or 실거래)
   *
   * 사전 검사는 두 모드가 동일하고, 체결 처리만 달라진다.
   * 진입 조건 검증은 여기 한 곳에서만 이뤄지므로
   * 자동 매수·수동 매수 어느 경로도 조건을 우회할 수 없다.
   * @returns {Promise<object>} 생성된 포지션 또는 { error }
   */
  async buy(symbol, rawAsk, signal = {}) {
    const notional = this.settings.positionSizeUSDT;

    if (this.positions.has(symbol)) return { error: `${symbol} 이미 보유 중` };
    if (this.positions.size >= this.settings.maxPositions) return { error: '최대 보유 종목 수 도달' };
    if (!Number.isFinite(rawAsk) || rawAsk <= 0) return { error: '유효하지 않은 가격' };

    // ── 진입 조건: 24시간 변동률 ──
    // 마이너스로 빠진 종목은 진입하지 않는다 (하락 추세 진입 차단).
    // 이미 보유 중인 포지션에는 적용하지 않는다 → 손절/익절이 정상 동작한다.
    const gate = this.checkEntryGate(signal);
    if (gate) return { error: gate };

    if (this.isLive) {
      const avail = this.liveBalance?.availableBalance ?? Number.POSITIVE_INFINITY;
      if (avail < notional) return { error: `거래소 잔고 부족 (가용 ${avail.toFixed(2)} USDT)` };
    } else if (!this.canAfford(notional)) {
      return { error: '잔고 부족' };
    }

    const signalMeta = {
      z: signal.z ?? null,
      ratio: signal.ratio ?? null,
      change24hPct: signal.change24hPct ?? null,
      score: signal.score ?? null,
      rsi: signal.rsi ?? null,
    };

    // ── 실거래: 실제 주문 → 체결 결과로 포지션 생성 ──
    if (this.isLive) {
      const fill = await this.executor.buy(symbol, notional, rawAsk);
      const position = this.executor.toLocalPosition(
        {
          symbol,
          positionAmt: fill.qty,
          entryPrice: fill.avgPrice,
          markPrice: fill.avgPrice,
          unRealizedProfit: 0,
        },
        { signal: signalMeta, cost: fill.cost },
      );
      position.live = true;
      position.simulated = Boolean(fill.simulated);
      position.orderId = fill.orderId;
      this.positions.set(symbol, position);
      return position;
    }

    // ── 가상: 체결가 시뮬레이션 ──
    const price = this.buyFillPrice(rawAsk);
    const qty = notional / price;
    const fee = notional * this.feeRate;
    this.cash -= notional + fee;
    this.totalFees += fee;

    const now = Date.now();
    const position = {
      symbol,
      qty,
      entryPrice: price,
      rawEntryPrice: rawAsk,
      cost: notional + fee,
      entryTime: now,
      markPrice: price,
      exitPrice: null,
      pnlPct: 0,
      pnlUSDT: 0,
      highPrice: price,
      lowPrice: price,
      peakPnlPct: 0,
      trailStopPrice: null,
      holdMinutes: 0,
      signal: signalMeta,
      status: 'open',
      isNew: true,
    };

    this.positions.set(symbol, position);
    this.equity = this.computeEquity();
    this.equityPeak = Math.max(this.equityPeak, this.equity);
    return position;
  }

  /**
   * 시장가 매도. 사유(reason)를 기록한다.
   * 실거래 모드에서는 실제 매도 주문을 내고 체결가를 사용한다.
   */
  async sell(symbol, rawBid, reason) {
    const position = this.positions.get(symbol);
    if (!position) return null;

    // ── 실거래: 실제 매도 주문 ──
    if (this.isLive) {
      const fill = await this.executor.sell(symbol, position.qty, { closing: true, refPrice: rawBid });
      const price = fill.avgPrice;
      const gross = (price - position.entryPrice) * fill.qty;
      const closed = {
        ...position,
        qty: fill.qty,
        status: 'closed',
        isNew: false,
        live: true,
        // 주문 시뮬레이션 모드에서 체결된 경우 표시
        simulated: Boolean(fill.simulated),
        orderId: fill.orderId,
        exitPrice: price,
        rawExitPrice: rawBid,
        exitTime: Date.now(),
        exitReason: reason,
        pnlPct: (price - position.entryPrice) / position.entryPrice,
        pnlUSDT: gross,
        exitFee: 0, // 거래소가 실제 수수료를 차감하므로 추정하지 않음
        holdMinutes: (Date.now() - position.entryTime) / 60_000,
      };
      this.positions.delete(symbol);
      this.trades.unshift(closed);
      if (this.trades.length > 500) this.trades.length = 500;
      this.realizedPnl += gross;
      return closed;
    }

    // ── 가상 ──

    // ── 가상 ──
    const price = this.sellFillPrice(rawBid);
    const gross = (price - position.entryPrice) * position.qty;
    const exitNotional = price * position.qty;
    const fee = exitNotional * this.feeRate;

    this.cash += exitNotional - fee;
    this.totalFees += fee;
    this.realizedPnl += gross - fee;

    const closed = {
      ...position,
      status: 'closed',
      isNew: false,
      exitPrice: price,
      rawExitPrice: rawBid,
      exitTime: Date.now(),
      exitReason: reason,
      pnlPct: (price - position.entryPrice) / position.entryPrice,
      pnlUSDT: gross - fee,
      exitFee: fee,
      holdMinutes: (Date.now() - position.entryTime) / 60_000,
    };

    this.positions.delete(symbol);
    this.trades.unshift(closed);
    if (this.trades.length > 500) this.trades.length = 500;
    this.equity = this.computeEquity();

    return closed;
  }

  /**
   * 진입 조건 검사 (주문 직전 마지막 관문).
   * @returns {string|null} 차단 사유 또는 null (진입 허용)
   */
  checkEntryGate(signal = {}) {
    const s = this.settings;

    // 24시간 변동률 필터
    if (s.use24hChangeFilter) {
      const chg = signal.change24hPct;
      if (Number.isFinite(chg) && chg < s.minChange24hPct) {
        return `24시간 변동 ${chg.toFixed(2)}% < ${s.minChange24hPct}% (진입 금지 설정)`;
      }
    }

    // RSI 필터 (Scanner 가 이미 통과시키지만 단일 방어선 유지)
    if (s.useRsiFilter && Number.isFinite(signal.rsi) && signal.rsi !== null) {
      if (signal.rsi < s.rsiMin || signal.rsi > s.rsiMax) {
        return `RSI ${signal.rsi.toFixed(1)} 이 허용 범위(${s.rsiMin}~${s.rsiMax}) 밖`;
      }
    }

    return null;
  }

  /**
   * 설정에 따라 청산 사유를 판단한다.
   * @returns {string|null} 'take-profit' | 'stop-loss' | 'trailing-stop' | 'time-stop' | 'manual' | null
   */
  checkExit(position, markPrice, now) {
    const s = this.settings;
    const pnlPct = (markPrice - position.entryPrice) / position.entryPrice;

    if (pnlPct >= s.takeProfitPct / 100) return 'take-profit';
    if (pnlPct <= -(s.stopLossPct / 100)) return 'stop-loss';

    if (s.trailingStopPct > 0) {
      const stop = position.trailStopPrice ?? position.highPrice * (1 - s.trailingStopPct / 100);
      if (markPrice <= stop) return 'trailing-stop';
    }

    if (s.maxHoldMinutes > 0 && now - position.entryTime >= s.maxHoldMinutes * 60_000) return 'time-stop';

    return null;
  }

  /** 현재가 반영 + 지표 갱신 */
  mark(symbol, markPrice) {
    const p = this.positions.get(symbol);
    if (!p || !Number.isFinite(markPrice) || markPrice <= 0) return;
    p.markPrice = markPrice;
    p.pnlPct = (markPrice - p.entryPrice) / p.entryPrice;
    p.pnlUSDT = (markPrice - p.entryPrice) * p.qty;
    p.highPrice = Math.max(p.highPrice, markPrice);
    p.lowPrice = Math.min(p.lowPrice, markPrice);
    p.peakPnlPct = Math.max(p.peakPnlPct, p.pnlPct);
    p.holdMinutes = (Date.now() - p.entryTime) / 60_000;
    if (this.settings.trailingStopPct > 0) {
      p.trailStopPrice = p.highPrice * (1 - this.settings.trailingStopPct / 100);
    }
  }

  computeEquity() {
    // 실거래에서는 거래소가 관리하는 지갑 잔고가 기준이다
    if (this.isLive && this.liveBalance) {
      return this.liveBalance.walletBalance + this.liveBalance.unrealizedProfit;
    }
    let total = this.cash;
    for (const p of this.positions.values()) {
      total += (p.markPrice || p.entryPrice) * p.qty;
    }
    return total;
  }

  /** 실시간 가격일괄 반영 + 청산 판단 */
  update(pricesBySymbol, now = Date.now()) {
    const exits = [];
    for (const p of [...this.positions.values()]) {
      const price = pricesBySymbol.get(p.symbol);
      if (!Number.isFinite(price) || price <= 0) continue;

      const reason = this.checkExit(p, price, now);
      this.mark(p.symbol, price);
      if (reason) exits.push({ symbol: p.symbol, price, reason });
    }
    this.equity = this.computeEquity();
    return exits;
  }

  /** 클라이언트에 보낼 포지션 목록 (부동소수점 정리) */
  serializePositions() {
    const r6 = (n) => (Number.isFinite(n) ? Number(n.toFixed(6)) : 0);
    return [...this.positions.values()].map((p) => ({
      symbol: p.symbol,
      qty: r6(p.qty),
      entryPrice: r6(p.entryPrice),
      markPrice: r6(p.markPrice),
      pnlPct: r6(p.pnlPct * 100),
      pnlUSDT: Number(p.pnlUSDT.toFixed(4)),
      highPrice: r6(p.highPrice),
      lowPrice: r6(p.lowPrice),
      peakPnlPct: r6(p.peakPnlPct * 100),
      trailStopPrice: p.trailStopPrice ? r6(p.trailStopPrice) : null,
      holdMinutes: Number(p.holdMinutes.toFixed(2)),
      entryTime: p.entryTime,
      isNew: p.isNew,
      live: Boolean(p.live),
      signal: p.signal,
    }));
  }

  summary() {
    const unrealized = [...this.positions.values()].reduce((acc, p) => acc + (p.pnlUSDT || 0), 0);
    const wins = this.trades.filter((t) => t.pnlUSDT > 0).length;
    const losses = this.trades.filter((t) => t.pnlUSDT < 0).length;
    const live = this.isLive;
    // 실거래의 기준 자본은 지갑 잔고로 잡는다 (가상 자본과 비교하지 않음)
    const baseline = live ? (this.liveBalance?.startBalance ?? this.liveBalance?.walletBalance ?? this.equity) : this.settings.initialCapitalUSDT;

    return {
      live,
      // 주문 시뮬레이션 여부 — 실제 주문을 넣지 않는 모드
      dryRun: live ? this.executor.dryRun : false,
      equity: Number(this.equity.toFixed(4)),
      cash: Number((live ? (this.liveBalance?.availableBalance ?? 0) : this.cash).toFixed(4)),
      walletBalance: live ? Number((this.liveBalance?.walletBalance ?? 0).toFixed(4)) : null,
      unrealizedPnl: Number((live ? (this.liveBalance?.unrealizedProfit ?? unrealized) : unrealized).toFixed(4)),
      realizedPnl: Number(this.realizedPnl.toFixed(4)),
      totalPnl: Number((this.equity - baseline).toFixed(4)),
      totalPnlPct: baseline > 0 ? Number((((this.equity - baseline) / baseline) * 100).toFixed(3)) : 0,
      totalFees: Number(this.totalFees.toFixed(4)),
      openCount: this.positions.size,
      availableSlots: this.availableSlots,
      tradeCount: this.trades.length,
      winCount: wins,
      lossCount: losses,
      winRate: this.trades.length ? Number(((wins / this.trades.length) * 100).toFixed(2)) : 0,
      drawdownPct: this.equityPeak > 0 ? Number((((this.equityPeak - this.equity) / this.equityPeak) * 100).toFixed(3)) : 0,
      progress: this.positions.size,
      maxPositions: this.settings.maxPositions,
      network: live ? this.executor.network : null,
      positionMode: live ? this.executor.positionMode : null,
    };
  }

  toJSON() {
    return {
      cash: this.cash,
      realizedPnl: this.realizedPnl,
      totalFees: this.totalFees,
      positions: this.positions ? [...this.positions.values()] : [],
      trades: this.trades.slice(0, 200),
    };
  }
}
