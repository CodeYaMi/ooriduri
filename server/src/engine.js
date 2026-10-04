import { EventEmitter } from 'node:events';
import { fetchUniverse, fetchAllTickers, fetchLatestKline, fetchKlines, ping } from './binance/rest.js';
import { ResilientStream } from './binance/stream.js';
import { VolumeScanner } from './scanner.js';
import { Portfolio } from './portfolio.js';
import { savePortfolioState } from './config.js';
import { LiveBroker } from './broker.js';

const FSTREAM = process.env.BINANCE_FSTREAM_BASE || 'wss://fstream.binance.com/stream';
const MINUTE = 60_000;
const TRACK_LIMIT = 60; // 실시간 가격 구독 종목 수 상한 (연결당 1024 스트림 제한 대비 안전)

const streamsPath = (symbols, kind) =>
  symbols.length ? `${FSTREAM}?streams=${symbols.map((s) => `${s.toLowerCase()}@${kind}`).join('/')}` : null;

/**
 * 전체 오케스트레이션
 *
 * 데이터 피드 (네트워크 환경에 따라 자동 대체됨)
 *   1) 24시간 통계  : REST /fapi/v1/ticker/24hr 폴링
 *      → 전 종목 24h 거래대금 / 변동률 / 최근가
 *   2) 분봉 거래량  : REST /fapi/v1/klines 폴링 (1m)
 *      → 확정봉을 히스토리에 적재. 급등 판정의 유일한 근거
 *   3) 실시간 가격  : WS @bookTicker → (무응답 시) WS @trade → (무응답 시) REST
 *      → 추적 종목의 실시간 체결가·호가
 *
 * 참고: fstream 의 !ticker@arr / @aggTrade / @kline_1m 은 일부 환경에서
 *       handshake 만 성공하고 데이터를 보내지 않으므로 사용하지 않는다.
 */
export class Engine extends EventEmitter {
  constructor(settings) {
    super();
    this.settings = settings;
    this.scanner = new VolumeScanner();
    this.portfolio = new Portfolio();
    this.portfolio.init(settings);
    this.broker = new LiveBroker();
    /** 주문 처리 중 재진입 방지 플래그 */
    this.trading = false;

    this.universe = [];
    this.universeMap = new Map();
    /** @type {Map<string, {lastPrice:number, quoteVolume:number, priceChangePercent:number, high:number, low:number}>} */
    this.market = new Map();
    /** @type {Map<string, number>} 실시간 가격 */
    this.prices = new Map();
    /** @type {Map<string, {bid:number, ask:number}>} 실시간 호가 */
    this.orderBook = new Map();

    this.candidates = [];
    this.cooldowns = new Map();
    this.tracked = new Set();
    this.seedTargets = [];

    this.status = {
      market: 'idle',        // REST 24h 폴링 상태
      priceFeed: 'pending',  // 실시간 가격 소스 (bookTicker | trade | rest)
      lastScanAt: null,
      nextScanAt: null,
      lastPollAt: null,
      lastBarPollAt: null,
      lastBarPollMs: null,
      scanCount: 0,
      lastError: null,
      apiOk: false,
      account: { connected: false, network: null, mode: 'paper', balance: null },
    };

    this.running = false;
    this.scanTimer = null;
    this.marketTimer = null;
    this.barTimer = null;
    this.persistTimer = null;
    this.liveTimer = null;
    this.barPolling = false;

    this.scanner.configure(settings);
  }

  // ── 라이프사이클 ─────────────────────────────────────────────

  async start() {
    if (this.running) return;
    this.running = true;
    console.log('[engine] 시작');

    this.#startPriceStream();
    this.#startMarketPoller();
    this.#startBarPoller();
    this.#startScanTimer();
    this.#startPersistTimer();
    this.#startLiveTimer();

    try {
      await this.#loadUniverse();
    } catch (err) {
      this.status.lastError = `유니버스 로드 실패: ${err.message}`;
      console.error('[engine]', err);
      return;
    }

    this.#refreshSeedTargets().then(() => {
      this.scan().catch((err) => console.error('[engine] 첫 스캔 실패:', err.message));
    });
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    clearTimeout(this.scanTimer);
    clearInterval(this.marketTimer);
    clearInterval(this.barTimer);
    clearInterval(this.persistTimer);
    this.scanTimer = this.marketTimer = this.barTimer = this.persistTimer = this.liveTimer = null;
    this.priceStream?.close();
    console.log('[engine] 정지');
  }

  applySettings(next) {
    const prev = this.settings;
    this.settings = next;
    this.portfolio.settings = next;
    this.scanner.configure(next);

    // 자본·투자금액 등 자금 설정이 바뀌면 포트폴리오를 재계산해야 하므로 초기화
    if (prev.initialCapitalUSDT !== next.initialCapitalUSDT || prev.positionSizeUSDT !== next.positionSizeUSDT) {
      this.portfolio.init(next);
      this.cooldowns.clear();
      this.emit('reset');
    }
    if (prev.scanIntervalSec !== next.scanIntervalSec) this.#startScanTimer();
    if (prev.marketPollSec !== next.marketPollSec) this.#startMarketPoller();
    if (prev.barPollSec !== next.barPollSec) this.#startBarPoller();
    if (prev.min24hQuoteVolumeUSDT !== next.min24hQuoteVolumeUSDT || prev.maxSymbols !== next.maxSymbols) {
      this.#refreshSeedTargets();
    }
    this.emit('settings', next);
  }

  resetPortfolio() {
    this.portfolio.init(this.settings);
    this.cooldowns.clear();
    this.candidates = [];
    savePortfolioState(null);
    this.emit('reset');
    this.emit('toast', { level: 'info', text: '가상 자산을 초기화했습니다.' });
  }

  // ── 유니버스 / 시드 ──────────────────────────────────────────

  async #loadUniverse() {
    this.status.market = 'loading';
    const [universe, tickers] = await Promise.allSettled([fetchUniverse(), fetchAllTickers()]);

    if (universe.status === 'rejected') throw universe.reason;
    this.universe = universe.value;
    this.universeMap = new Map(this.universe.map((u) => [u.symbol, u]));

    if (tickers.status === 'fulfilled') this.#applyTickers(tickers.value);
    this.status.apiOk = true;
    console.log(`[engine] 유니버스 ${this.universe.length}종목 / 시장 ${this.market.size}종목 로드 완료`);
  }

  /** 거래대금 + 상장기간 기준으로 시드 대상 선정 (평가 대상과 동일한 조건) */
  #pickSeedTargets() {
    const { min24hQuoteVolumeUSDT, minOnboardDays, maxSymbols } = this.settings;
    return [...this.universe]
      .filter((u) => u.ageDays >= minOnboardDays)
      .map((u) => ({ ...u, qv: this.market.get(u.symbol)?.quoteVolume ?? 0 }))
      .filter((u) => u.qv >= min24hQuoteVolumeUSDT)
      .sort((a, b) => b.qv - a.qv)
      .slice(0, maxSymbols)
      .map((u) => u.symbol);
  }

  async #refreshSeedTargets() {
    const targets = this.#pickSeedTargets();
    this.seedTargets = targets;
    const missing = targets.filter((s) => !this.scanner.has(s));
    if (missing.length) {
      console.log(`[engine] 분봉 히스토리 시드 ${missing.length}종목 조회 중...`);
      this.emit('status', { ...this.status, phase: 'seeding', seeded: this.scanner.getTrackedSymbols().length, total: targets.length });
      await this.scanner.seedMany(missing, 8);
    }
    this.scanner.prune(new Set(targets));
    this.emit('status', { ...this.status, phase: 'ready', seeded: this.scanner.getTrackedSymbols().length, total: targets.length });
    console.log(`[engine] 히스토리 ${this.scanner.getTrackedSymbols().length}/${targets.length}종목 준비 완료`);
    this.#syncTracked();
  }

  // ── REST 폴링: 24시간 통계 ──────────────────────────────────

  #startMarketPoller() {
    clearInterval(this.marketTimer);
    const run = async () => {
      try {
        const tickers = await fetchAllTickers();
        this.#applyTickers(tickers);
        this.status.market = 'polling';
        this.status.lastPollAt = Date.now();
        this.status.apiOk = true;
      } catch (err) {
        this.status.market = 'error';
        this.status.lastError = `24h 시세 폴링 실패: ${err.message}`;
        console.warn('[engine]', this.status.lastError);
      }
      this.emit('status', this.status);
    };
    run();
    this.marketTimer = setInterval(run, Math.max(3, this.settings.marketPollSec) * 1000);
  }

  /** 24시간 티커 반영 (증분값이 아니라 절대값으로 덮어씀) */
  #applyTickers(tickers) {
    for (const t of tickers) {
      if (!Number.isFinite(t.lastPrice) || t.lastPrice <= 0) continue;
      this.market.set(t.symbol, {
        lastPrice: t.lastPrice,
        quoteVolume: Number.isFinite(t.quoteVolume) ? t.quoteVolume : 0,
        priceChangePercent: Number.isFinite(t.priceChangePercent) ? t.priceChangePercent : 0,
        high: t.highPrice,
        low: t.lowPrice,
      });
      // 실시간 가격 피드가 아직 값을 주지 않았을 때만 폴링 값으로 채운다
      if (!this.prices.has(t.symbol)) this.prices.set(t.symbol, t.lastPrice);
    }
  }

  // ── REST 폴링: 1분봉 (급등 판정의 근거) ─────────────────────

  #startBarPoller() {
    clearInterval(this.barTimer);
    const run = async () => {
      if (this.barPolling) return; // 이전 라운드 아직 진행 중이면 건너뛴다
      const symbols = this.scanner.getTrackedSymbols();
      if (!symbols.length) return;

      this.barPolling = true;
      const t0 = Date.now();
      try {
        await Promise.all(
          symbols.map(async (symbol) => {
            try {
              const bar = await fetchLatestKline(symbol, '1m');
              if (!bar) return;
              this.scanner.syncBar(symbol, bar);
              // 실시간 가격 피드가 약하면 분봉 종가로 보강
              if (!this.prices.has(symbol) || this.status.priceFeed === 'rest') this.prices.set(symbol, bar.close);
            } catch (err) {
              /* 개별 종목 실패는 무시 (다음 라운드에서 재시도) */
            }
          }),
        );
        this.status.lastBarPollAt = Date.now();
        this.status.lastBarPollMs = Date.now() - t0;
      } finally {
        this.barPolling = false;
      }
    };
    this.barTimer = setInterval(run, Math.max(5, this.settings.barPollSec) * 1000);
  }

  // ── 실시간 가격 스트림 (bookTicker → trade 자동 전환) ────────

  #startPriceStream() {
    this.priceStream = new ResilientStream({
      name: 'price',
      probeMs: 12_000,
      onStatus: (s) => {
        if (s.specId) this.status.priceFeed = s.specId;
        this.status.priceStreamState = s.state;
        this.emit('status', this.status);
      },
      specs: [
        {
          id: 'bookTicker',
          build: (symbols) => streamsPath(symbols, 'bookTicker'),
          handle: (data) => {
            // { e:'bookTicker', s, b, a, B, A }
            const symbol = data?.s;
            if (!symbol) return;
            const bid = parseFloat(data.b);
            const ask = parseFloat(data.a);
            if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0) return;
            this.orderBook.set(symbol, { bid, ask });
            this.prices.set(symbol, (bid + ask) / 2);
            this.#touchSymbol(symbol);
          },
        },
        {
          id: 'trade',
          build: (symbols) => streamsPath(symbols, 'trade'),
          handle: (data) => {
            // { e:'trade', s, p, q, m }
            const symbol = data?.s;
            if (!symbol) return;
            const price = parseFloat(data.p);
            if (!Number.isFinite(price) || price <= 0) return;
            this.prices.set(symbol, price);
            this.#touchSymbol(symbol);
          },
        },
      ],
    });
    this.priceStream.open([]);
  }

  #touchSymbol(symbol) {
    const stat = this.market.get(symbol);
    const price = this.prices.get(symbol);
    if (stat && Number.isFinite(price)) stat.lastPrice = price;
  }

  /** 후보 + 보유 종목에 실시간 가격 구독을 맞춘다 */
  #syncTracked() {
    const next = new Set();
    for (const c of this.candidates) next.add(c.symbol);
    for (const s of this.portfolio.positions.keys()) next.add(s);
    while (next.size > TRACK_LIMIT) next.delete([...next][0]); // 후보부터 잘라낸다

    this.tracked = next;
    this.priceStream?.open([...next]);
  }

  // ── 타이머 ───────────────────────────────────────────────────

  #startScanTimer() {
    clearTimeout(this.scanTimer);
    this.#scheduleScan();
  }

  #scheduleScan() {
    const interval = Math.max(10, this.settings.scanIntervalSec) * 1000;
    this.status.nextScanAt = Date.now() + interval;
    this.scanTimer = setTimeout(async () => {
      try {
        await this.scan();
      } catch (err) {
        console.error('[engine] 스캔 실패:', err.message);
        this.status.lastError = err.message;
        this.emit('status', this.status);
      } finally {
        if (this.running) this.#scheduleScan();
      }
    }, interval);
  }

  #startPersistTimer() {
    clearInterval(this.persistTimer);
    this.persistTimer = setInterval(() => {
      if (this.portfolio.positions.size || this.portfolio.trades.length) {
        savePortfolioState(this.portfolio.toJSON());
      }
    }, 30_000);
  }

  /**
   * 실거래 유지보수 — 잔고 갱신 + 포지션 동기화.
   * 거래소에서 직접 청산/수동 변경된 내용을 로컬에 반영한다.
   */
  #startLiveTimer() {
    clearInterval(this.liveTimer);
    this.liveTimer = setInterval(async () => {
      if (!this.portfolio.isLive || this.trading) return;
      try {
        await this.#refreshLiveBalance();
        // 포지션 집합이 어긋나면 동기화 (rate limit 를 위해 조건부 실행)
        if (this.portfolio.positions.size) {
          const ex = await this.broker.exchangePositions();
          const live = new Map(
            ex.filter((p) => p.positionAmt > 0).map((p) => [p.symbol, p]),
          );
          if (live.size !== this.portfolio.positions.size) await this.#reconcilePositions();
        }
      } catch (err) {
        console.warn('[engine] 실거래 동기화 실패:', err.message);
      }
    }, 20_000);
  }

  // ── 스캔 + 자동 매수 ─────────────────────────────────────────

  async scan() {
    const t0 = Date.now();
    this.status.scanCount += 1;
    this.status.lastScanAt = Date.now();
    this.status.lastError = null;

    // 평가 대상 중 히스토리가 없는 종목 보강 (신규 상장분)
    const expected = this.seedTargets.length ? this.seedTargets : this.#pickSeedTargets();
    const missing = expected.filter((s) => !this.scanner.has(s));
    if (missing.length) await this.#refreshSeedTargets();

    const universeKeys = [...this.universeMap.keys()];
    const ranked = this.scanner.rank(universeKeys, this.market, this.settings);

    this.candidates = ranked.map((c) => ({
      ...c,
      cooldownLeftMin: this.#cooldownLeft(c.symbol),
      held: this.portfolio.positions.has(c.symbol),
    }));
    // 후보가 없을 때 "무엇을 낮춰야 하는가" 를 보여줄 진단 정보
    this.nearMiss = this.candidates.length
      ? []
      : this.scanner.nearMisses(universeKeys, this.market, this.settings, 5);
    // 진입 조건으로 차단된 종목 수 (후보가 있을 때도 참고용으로 노출)
    this.entryRejects = {
      by24h: this.scanner.lastRejectedBy24h ?? 0,
      byRsi: this.scanner.lastRejectedByRsi ?? 0,
    };
    this.status.lastScanMs = Date.now() - t0;

    this.#syncTracked();
    this.emit('scan', { candidates: this.candidates, ms: this.status.lastScanMs });
    console.log(
      `[engine] 스캔 #${this.status.scanCount} — 후보 ${this.candidates.length}종목 ` +
        `(${this.status.lastScanMs}ms, 히스토리 ${this.scanner.stats().tracked}종목, 가격 ${this.status.priceFeed})`,
    );

    if (this.settings.autoTrade) this.autoBuy();
  }

  #cooldownLeft(symbol) {
    const until = this.cooldowns.get(symbol);
    if (!until) return 0;
    if (Date.now() >= until) {
      this.cooldowns.delete(symbol);
      return 0;
    }
    return Math.ceil((until - Date.now()) / MINUTE);
  }

  /** 빈 슬롯만큼 상위 후보부터 매수 (가상/실거래 공통) */
  async autoBuy() {
    if (this.trading) return 0; // 주문 처리 중 중복 진입 방지
    let bought = 0;
    try {
      this.trading = true;
      for (const candidate of this.candidates) {
        if (this.portfolio.availableSlots <= 0) break;
        if (this.portfolio.positions.has(candidate.symbol)) continue;
        if (this.#cooldownLeft(candidate.symbol) > 0) continue;

        const price = this.#quoteFor(candidate.symbol).ask;
        if (!price) continue;

        let result;
        try {
          result = await this.portfolio.buy(candidate.symbol, price, candidate);
        } catch (err) {
          // 주문 실패는 이 종목만 건너뛰고 계속
          this.emit('toast', { level: 'warn', text: `${candidate.symbol} 매수 실패: ${err.message}` });
          continue;
        }

        if (result?.error) {
          if (result.error.includes('잔고') || result.error.includes('최대 보유')) break;
          continue;
        }
        bought += 1;
        this.emit('toast', {
          level: 'buy',
          text: `${result.live ? '실거래 매수' : '매수'} ${candidate.symbol} ${result.qty.toPrecision(6)} @ ${result.entryPrice.toPrecision(8)} (z ${candidate.z}, ${candidate.ratio}배)`,
        });
        if (this.portfolio.isLive) await this.#refreshLiveBalance();
      }
    } finally {
      this.trading = false;
    }

    if (bought) this.#syncTracked();
    return bought;
  }

  /** 호가 스냅샷. 호가가 없으면 최근가 + 가정 스프레드로 근사 */
  #quoteFor(symbol) {
    const book = this.orderBook.get(symbol);
    if (book?.ask > 0 && book?.bid > 0) return book;
    const price = this.prices.get(symbol) ?? this.market.get(symbol)?.lastPrice ?? 0;
    const halfSpread = price * 0.0002; // 스프레드 미수신 시 2bp 가정
    return { ask: price + halfSpread, bid: price - halfSpread };
  }

  // ── 가격 반영 + 청산 ─────────────────────────────────────────

  /** 1초마다 호출. 보유 포지션의 현재가를 갱신하고 청산 조건을 검사한다. */
  processPriceUpdates() {
    // 실거래 주문이 처리 중이면 가격 반영만 하고 청산 판단은 다음 틱으로 미룬다
    const map = new Map();
    for (const symbol of this.portfolio.positions.keys()) {
      const { bid } = this.#quoteFor(symbol);
      if (bid > 0) map.set(symbol, bid);
    }
    if (this.trading) return [];

    const exits = this.portfolio.update(map, Date.now());
    if (exits.length) this.#closePositions(exits);
    return exits;
  }

  /** 청산 실행 (비동기 — 실거래는 실제 주문이므로 await) */
  async #closePositions(exits) {
    if (this.trading) return;
    this.trading = true;
    try {
      for (const exit of exits) {
        await this.#closePosition(exit.symbol, exit.reason, exit.price);
      }
      if (this.portfolio.isLive) await this.#refreshLiveBalance();
    } finally {
      this.trading = false;
    }
  }

  async #closePosition(symbol, reason, forcedPrice = null) {
    const price = forcedPrice ?? this.#quoteFor(symbol).bid;
    let closed;
    try {
      closed = await this.portfolio.sell(symbol, price, reason);
    } catch (err) {
      this.emit('toast', { level: 'warn', text: `${symbol} 매도 실패: ${err.message}` });
      return null;
    }
    if (!closed) return null;

    if (this.settings.cooldownMinutes > 0) {
      this.cooldowns.set(symbol, Date.now() + this.settings.cooldownMinutes * MINUTE);
    }

    const label = {
      'take-profit': '익절',
      'stop-loss': '손절',
      'trailing-stop': '트레일링 스탑',
      'time-stop': '시간 만료',
      manual: '수동 매도',
    }[reason] ?? reason;

    this.emit('toast', {
      level: closed.pnlUSDT >= 0 ? 'profit' : 'loss',
      text: `${symbol} ${label} 매도 @ ${closed.exitPrice.toPrecision(8)} · ${closed.pnlPct >= 0 ? '+' : ''}${(closed.pnlPct * 100).toFixed(2)}% (${closed.pnlUSDT >= 0 ? '+' : ''}${closed.pnlUSDT.toFixed(2)} USDT)`,
    });

    this.candidates = this.candidates.map((c) =>
      c.symbol === symbol ? { ...c, held: false, cooldownLeftMin: this.#cooldownLeft(symbol) } : c,
    );
    this.#syncTracked();
    this.emit('trade-closed', closed);
    return closed;
  }

  // ── 수동 조작 ────────────────────────────────────────────────

  async manualBuy(symbol) {
    const price = this.#quoteFor(symbol).ask;
    const stat = this.market.get(symbol) ?? {};
    const candidate = this.candidates.find((c) => c.symbol === symbol);

    let result;
    try {
      result = await this.portfolio.buy(symbol, price, candidate ?? { change24hPct: stat.priceChangePercent });
    } catch (err) {
      return { ok: false, error: err.message };
    }
    if (result?.error) return { ok: false, error: result.error };

    if (this.portfolio.isLive) await this.#refreshLiveBalance();
    this.#syncTracked();
    this.emit('toast', {
      level: 'buy',
      text: `${symbol} ${result.live ? '실거래' : ''} 수동 매수 @ ${result.entryPrice.toPrecision(8)}`,
    });
    return { ok: true, position: result };
  }

  async manualSell(symbol) {
    const closed = await this.#closePosition(symbol, 'manual');
    if (!closed) return { ok: false, error: '보유 중인 종목이 아닙니다.' };
    if (this.portfolio.isLive) await this.#refreshLiveBalance();
    return { ok: true, trade: closed };
  }

  async closeAll() {
    if (this.trading) return { ok: false, error: '주문 처리 중입니다. 잠시 후 다시 시도하세요.' };
    let count = 0;
    this.trading = true;
    try {
      for (const symbol of [...this.portfolio.positions.keys()]) {
        const closed = await this.#closePosition(symbol, 'manual');
        if (closed) count += 1;
      }
      if (this.portfolio.isLive) await this.#refreshLiveBalance();
    } finally {
      this.trading = false;
    }
    return { ok: true, count };
  }

  // ── 실거래 연결 / 동기화 ────────────────────────────────────

  /**
   * 실거래 모드 진입.
   * @param {{apiKey:string, apiSecret:string, network:string, mode:'live'|'paper', dryRun?:boolean}} opts
   */
  async connectAccount({ apiKey, apiSecret, network, mode = 'live', dryRun = false }) {
    this.broker.setSettings(this.settings);
    const result = await this.broker.connect({ apiKey, apiSecret, network }, { dryRun });
    this.status.account = { ...this.broker.describe(), balance: null };

    if (mode !== 'live') {
      // 자격증명만 저장하고 로컬 지갑은 그대로 사용
      this.status.account.mode = 'paper';
      this.emit('toast', {
        level: 'info',
        text: `${result.network === 'testnet' ? '테스트넷' : '실거래'} 계정에 연결했습니다. 현재는 가상 모드입니다.`,
      });
      return this.accountInfo();
    }

    // ── 실거래 모드 (주문 시뮬레이션 여부에 따라 동작이 나뉜다) ──
    this.portfolio.attachExecutor(this.broker);
    // 실거래와 가상 포지션이 섞이지 않도록 로컬 포지션을 비우고 거래소에서 복구
    this.portfolio.positions = new Map();
    this.portfolio.equityPeak = 0;

    await this.#reconcilePositions();
    await this.#refreshLiveBalance();
    this.#syncTracked();

    this.status.account.mode = 'live';
    const isProd = result.network === 'production';

    if (dryRun) {
      // 실제 잔고·규격으로 시나리오만 확인 (주문은 넣지 않음)
      this.status.marketWarning = null;
      this.emit('toast', {
        level: 'info',
        text: `주문 시뮬레이션 모드 (${isProd ? '실계정' : '테스트넷'}) · 잔고 ${result.walletBalance.toFixed(2)} USDT · 주문은 넣지 않습니다.`,
      });
    } else {
      this.status.marketWarning = isProd ? '실거래 모드입니다 — 실제 자금이 움직입니다.' : null;
      this.emit('toast', {
        level: isProd ? 'warn' : 'info',
        text: `실거래 모드 시작 (${isProd ? '실계정' : '테스트넷'}) · 지갑 ${result.walletBalance.toFixed(2)} USDT`,
      });
    }
    return this.accountInfo();
  }

  /**
   * 주문 시뮬레이션 토글 — 연결을 유지한 채 실제 주문 여부만 바꾼다.
   */
  setDryRun(enabled) {
    if (!this.portfolio.isLive) throw new Error('실거래 모드에서만 주문 시뮬레이션을 켤 수 있습니다.');
    const on = this.broker.setDryRun(enabled);
    this.status.account = { ...this.broker.describe(), balance: null };
    this.status.marketWarning = !on && this.broker.network === 'production' ? '실거래 모드입니다 — 실제 자금이 움직입니다.' : null;
    this.emit('toast', {
      level: on ? 'info' : 'warn',
      text: on ? '주문 시뮬레이션 ON — 주문을 넣지 않고 시나리오만 확인합니다.' : '실제 주문 ON — 시장가 주문이 전송됩니다.',
    });
    return this.accountInfo();
  }

  disconnectAccount() {
    this.broker.disconnect();
    this.portfolio.detachExecutor();
    this.status.account = { ...this.broker.describe(), balance: null };
    this.status.marketWarning = null;
    this.emit('toast', { level: 'info', text: '계정 연결을 해제했습니다. 가상 모드로 전환됩니다.' });
    return this.accountInfo();
  }

  /** 거래소 잔고 갱신 */
  async #refreshLiveBalance() {
    if (!this.portfolio.isLive) return null;
    try {
      const balance = await this.broker.balance();
      this.portfolio.liveBalance = { ...balance, startBalance: this.portfolio.liveBalance?.startBalance ?? balance.walletBalance };
      this.portfolio.equity = this.portfolio.computeEquity();
      this.portfolio.equityPeak = Math.max(this.portfolio.equityPeak, this.portfolio.equity);
      this.status.account.balance = balance;
      return balance;
    } catch (err) {
      this.status.account.balanceError = err.message;
      return null;
    }
  }

  /** 거래소 포지션 ↔ 로컬 포지션 동기화 */
  async #reconcilePositions() {
    if (!this.portfolio.isLive) return null;
    const result = await this.broker.reconcile(this.portfolio.positions);

    for (const symbol of result.adopted) {
      const ex = result.exchange.find((r) => r.symbol === symbol);
      this.portfolio.positions.set(symbol, this.broker.toLocalPosition(ex, { entryTime: Date.now() }));
    }
    for (const symbol of result.removed) this.portfolio.positions.delete(symbol);

    if (result.adopted.length || result.removed.length || result.corrected.length) {
      this.emit('toast', {
        level: 'info',
        text: `거래소와 동기화 — 편입 ${result.adopted.length}, 제거 ${result.removed.length}, 보정 ${result.corrected.length}`,
      });
    }
    this.status.account.reconcile = {
      adopted: result.adopted,
      removed: result.removed,
      corrected: result.corrected,
      at: Date.now(),
    };
    return result;
  }

  /** 잔고만 조회 (조회 버튼) */
  async refreshBalance() {
    const balance = await this.#refreshLiveBalance();
    if (!balance) throw new Error(this.status.account.balanceError ?? '잔고를 가져오지 못했습니다.');
    return balance;
  }

  /** 수동 동기화 (포지션 재적재) */
  async syncPositions() {
    if (!this.portfolio.isLive) throw new Error('실거래 모드가 아닙니다.');
    await this.#reconcilePositions();
    await this.#refreshLiveBalance();
    this.#syncTracked();
    return this.accountInfo();
  }

  accountInfo() {
    return {
      broker: this.broker.describe(),
      mode: this.portfolio.isLive ? 'live' : 'paper',
      // 주문 시뮬레이션이면 실제 주문을 넣지 않는다
      dryRun: this.portfolio.isLive ? this.broker.dryRun : null,
      network: this.broker.network,
      balance: this.portfolio.liveBalance,
      localPositions: this.portfolio.positions.size,
    };
  }

  // ── 시세 조회 ────────────────────────────────────────────────

  getKlines(symbol, interval = '1m', limit = 120) {
    return fetchKlines(symbol, interval, limit);
  }

  // ── 스냅샷 ───────────────────────────────────────────────────

  snapshot() {
    return {
      type: 'state',
      data: {
        ts: Date.now(),
        running: this.running,
        settings: this.settings,
        summary: this.portfolio.summary(),
        positions: this.portfolio.serializePositions(),
        candidates: this.candidates,
        nearMiss: this.nearMiss ?? [],
        entryRejects: this.entryRejects ?? { by24h: 0, byRsi: 0 },
        trades: this.portfolio.trades.slice(0, 60).map((t) => ({
          symbol: t.symbol,
          entryPrice: Number(t.entryPrice.toFixed(8)),
          exitPrice: Number(t.exitPrice.toFixed(8)),
          pnlPct: Number((t.pnlPct * 100).toFixed(3)),
          pnlUSDT: Number(t.pnlUSDT.toFixed(4)),
          reason: t.exitReason,
          holdMinutes: Number(t.holdMinutes.toFixed(1)),
          exitTime: t.exitTime,
        })),
        status: this.status,
        tracked: [...this.tracked],
        marketCount: this.market.size,
        trackedHistory: this.scanner.stats().tracked,
        account: this.accountInfo(),
      },
    };
  }

  /** 실시간 가격만 빠르게 전송 (고빈도) */
  livePrices() {
    const prices = {};
    for (const symbol of this.tracked) {
      const price = this.prices.get(symbol);
      if (price) prices[symbol] = price;
    }
    return { type: 'live', data: { ts: Date.now(), prices } };
  }
}

export { ping };
