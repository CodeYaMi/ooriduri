import { fetchUniverse, fetchAllTickers, fetchLatestKline, fetchKlines } from './binance/rest.js';
import { ResilientStream } from './binance/stream.js';
import { VolumeScanner } from './scanner.js';

const FSTREAM = process.env.BINANCE_FSTREAM_BASE || 'wss://fstream.binance.com/stream';
const TRACK_LIMIT = 60; // 실시간 가격 구독 종목 수 상한 (연결당 1024 스트림 제한 대비 안전)

const streamsPath = (symbols, kind) =>
  symbols.length ? `${FSTREAM}?streams=${symbols.map((s) => `${s.toLowerCase()}@${kind}`).join('/')}` : null;

/**
 * 공유 시장 계층 (전 계정 공용, 인스턴스 1개)
 *
 * 비싼 작업(REST 폴링, WS 스트림, 분봉 히스토리)은 여기서 한 번만 수행하고,
 * 각 Trader 는 이 데이터를 읽기만 해서 자기 설정으로 진입을 판단한다.
 * 계정이 늘어나도 바이낸스 API 호출 부하는 그대로다.
 */
export class MarketHub {
  constructor() {
    this.universe = [];
    this.universeMap = new Map();
    /** @type {Map<string, {lastPrice:number, quoteVolume:number, priceChangePercent:number, high:number, low:number}>} */
    this.market = new Map();
    /** @type {Map<string, number>} 실시간 가격 */
    this.prices = new Map();
    /** @type {Map<string, {bid:number, ask:number}>} 실시간 호가 */
    this.orderBook = new Map();

    this.scanner = new VolumeScanner();
    // 스캐너 설정은 전 Trader 의 요구 합집합으로 맞춘다 (히스토리 깊이 등)
    this.scanner.configure({ recentWindowMinutes: 3, lookbackMinutes: 30, rsiPeriod: 14 });

    /** traderId → seed 대상 심볼 목록 (합집합 유지용) */
    this.seedPicks = new Map();
    /** 구독 중인 전체 심볼 합집합 */
    this.tracked = new Set();

    this.status = {
      market: 'idle', // REST 24h 폴링 상태
      priceFeed: 'pending', // 실시간 가격 소스 (bookTicker | trade | rest)
      priceStreamState: null,
      lastPollAt: null,
      lastBarPollAt: null,
      lastBarPollMs: null,
      apiOk: false,
      lastError: null,
    };

    // 폴링 주기는 전 Trader 중 가장 짧은 값을 사용한다
    this.marketPollSec = 10;
    this.barPollSec = 20;

    this.running = false;
    this.marketTimer = null;
    this.barTimer = null;
    this.barPolling = false;
    this.priceStream = null;
  }

  // ── 라이프사이클 ─────────────────────────────────────────────

  async start() {
    if (this.running) return;
    this.running = true;
    console.log('[market] 시작');

    this.#startPriceStream();
    this.#startMarketPoller();
    this.#startBarPoller();

    try {
      await this.#loadUniverse();
    } catch (err) {
      this.status.lastError = `유니버스 로드 실패: ${err.message}`;
      console.error('[market]', err);
    }
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    clearInterval(this.marketTimer);
    clearInterval(this.barTimer);
    this.marketTimer = this.barTimer = null;
    this.priceStream?.close();
    this.priceStream = null;
    console.log('[market] 정지');
  }

  // ── 유니버스 ─────────────────────────────────────────────────

  async #loadUniverse() {
    this.status.market = 'loading';
    const [universe, tickers] = await Promise.allSettled([fetchUniverse(), fetchAllTickers()]);

    if (universe.status === 'rejected') throw universe.reason;
    this.universe = universe.value;
    this.universeMap = new Map(this.universe.map((u) => [u.symbol, u]));

    if (tickers.status === 'fulfilled') this.#applyTickers(tickers.value);
    this.status.apiOk = true;
    console.log(`[market] 유니버스 ${this.universe.length}종목 / 시장 ${this.market.size}종목 로드 완료`);
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
        console.warn('[market]', this.status.lastError);
      }
    };
    run();
    this.marketTimer = setInterval(run, Math.max(3, this.marketPollSec) * 1000);
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
            } catch {
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
    this.barTimer = setInterval(run, Math.max(5, this.barPollSec) * 1000);
  }

  // ── 실시간 가격 스트림 (bookTicker → trade 자동 전환) ────────

  #startPriceStream() {
    this.priceStream = new ResilientStream({
      name: 'price',
      probeMs: 12_000,
      onStatus: (s) => {
        if (s.specId) this.status.priceFeed = s.specId;
        this.status.priceStreamState = s.state;
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

  // ── Trader 연동 ────────────────────────────────────────────

  /**
   * 스캐너 히스토리 깊이 조정 — 전 Trader 요구의 최댓값을 커버한다.
   * 평가는 계정별 윈도우로 하므로, 히스토리만 충분히 깊으면 된다.
   */
  retuneScanner(settingsList) {
    const max = (fn, fallback) =>
      settingsList.length ? Math.max(...settingsList.map(fn)) : fallback;
    this.scanner.configure({
      recentWindowMinutes: max((s) => s.recentWindowMinutes ?? 3, 3),
      lookbackMinutes: max((s) => s.lookbackMinutes ?? 30, 30),
      rsiPeriod: max((s) => s.rsiPeriod ?? 14, 14),
    });
  }

  /**
   * Trader 의 시드 요구 등록. 전 Trader 요구의 합집합을 유지한다.
   * @returns {string[]} 합집합 심볼
   */
  registerSeedPicks(traderId, picks) {
    this.seedPicks.set(traderId, picks);
    const union = new Set();
    for (const list of this.seedPicks.values()) for (const s of list) union.add(s);
    return [...union];
  }

  unregisterSeedPicks(traderId) {
    this.seedPicks.delete(traderId);
  }

  /** 합집합 기준으로 히스토리 시드 + 불필요분 정리 */
  async refreshSeedTargets() {
    const union = new Set();
    for (const list of this.seedPicks.values()) for (const s of list) union.add(s);
    const targets = [...union];
    const missing = targets.filter((s) => !this.scanner.has(s));
    if (missing.length) {
      console.log(`[market] 분봉 히스토리 시드 ${missing.length}종목 조회 중...`);
      await this.scanner.seedMany(missing, 8);
    }
    this.scanner.prune(new Set(targets));
    console.log(`[market] 히스토리 ${this.scanner.getTrackedSymbols().length}/${targets.length}종목 준비 완료`);
    return targets.length;
  }

  /**
   * 폴링 주기 조정 — 전 Trader 중 가장 짧은 값을 쓴다.
   * 짧은 쪽이 시드를 다 커버하므로 긴 쪽도 문제없다.
   */
  retunePollers(marketPollSec, barPollSec) {
    let changed = false;
    if (Number.isFinite(marketPollSec) && marketPollSec !== this.marketPollSec) {
      this.marketPollSec = marketPollSec;
      changed = true;
    }
    if (Number.isFinite(barPollSec) && barPollSec !== this.barPollSec) {
      this.barPollSec = barPollSec;
      changed = true;
    }
    if (changed && this.running) {
      this.#startMarketPoller();
      this.#startBarPoller();
    }
  }

  /** 전 Trader 의 추적 집합 합집합으로 WS 구독을 맞춘다 (정렬로 경로 안정화) */
  rebuildTracked(sets) {
    const next = new Set();
    for (const set of sets) {
      for (const s of set) {
        if (next.size >= TRACK_LIMIT) break;
        next.add(s);
      }
      if (next.size >= TRACK_LIMIT) break;
    }
    this.tracked = next;
    this.priceStream?.open([...next].sort());
  }

  /** 호가 스냅샷. 호가가 없으면 최근가 + 가정 스프레드로 근사 */
  quoteFor(symbol) {
    const book = this.orderBook.get(symbol);
    if (book?.ask > 0 && book?.bid > 0) return book;
    const price = this.prices.get(symbol) ?? this.market.get(symbol)?.lastPrice ?? 0;
    const halfSpread = price * 0.0002; // 스프레드 미수신 시 2bp 가정
    return { ask: price + halfSpread, bid: price - halfSpread };
  }

  /** 스냅샷에 실을 시장 상태 (비밀정보 없음) */
  marketStatus() {
    return {
      market: this.status.market,
      priceFeed: this.status.priceFeed,
      priceStreamState: this.status.priceStreamState,
      lastPollAt: this.status.lastPollAt,
      lastBarPollAt: this.status.lastBarPollAt,
      lastBarPollMs: this.status.lastBarPollMs,
      apiOk: this.status.apiOk,
      lastError: this.status.lastError,
      marketCount: this.market.size,
      trackedHistory: this.scanner.stats().tracked,
    };
  }

  /** 실시간 가격만 빠르게 전송 (고빈도, 비밀정보 없음) */
  livePrices() {
    const prices = {};
    for (const symbol of this.tracked) {
      const price = this.prices.get(symbol);
      if (price) prices[symbol] = price;
    }
    return { type: 'live', data: { ts: Date.now(), prices } };
  }

  getKlines(symbol, interval = '1m', limit = 120) {
    return fetchKlines(symbol, interval, limit);
  }
}
