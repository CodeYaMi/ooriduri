import { EventEmitter } from 'node:events';
import { Portfolio } from './portfolio.js';
import { LiveBroker } from './broker.js';
import { loadSettingsFrom, saveSettingsTo, loadPortfolioFrom, savePortfolioTo } from './config.js';
import { saveCredentials, loadCredentials, deleteCredentials, describeCredentials, armLive, disarmLive } from './credentials.js';
import { appendEvent, accountPaths } from './accounts.js';

const MINUTE = 60_000;

/**
 * 계정별 트레이더 (거래 계정 1개 = 인스턴스 1개)
 *
 * 시세·분봉·스캐너 히스토리는 MarketHub(공유)에서 읽기만 하고,
 * 설정·포트폴리오·브로커·주문·이벤트는 이 계정 것만 다룬다.
 */
export class Trader extends EventEmitter {
  constructor(accountId, meta, hub) {
    super();
    this.accountId = accountId;
    this.meta = meta;
    this.hub = hub;
    this.paths = accountPaths(accountId);

    this.settings = loadSettingsFrom(this.paths.settings);
    this.portfolio = new Portfolio();
    this.portfolio.init(this.settings, loadPortfolioFrom(this.paths.portfolio));
    this.broker = new LiveBroker();
    this.broker.setSettings(this.settings);
    /** 주문 처리 중 재진입 방지 플래그 */
    this.trading = false;

    this.candidates = [];
    this.nearMiss = [];
    this.entryRejects = { by24h: 0, byRsi: 0 };
    this.cooldowns = new Map();
    /** 청산 실패 백오프: symbol → { count, nextRetryAt, lastError } */
    this.closeFail = new Map();
    this.tracked = new Set();

    this.status = {
      lastScanAt: null,
      nextScanAt: null,
      lastScanMs: null,
      scanCount: 0,
      lastError: null,
      account: { connected: false, network: null, mode: 'paper', balance: null },
      marketWarning: null,
    };

    this.running = false;
    this.scanTimer = null;
    this.persistTimer = null;
    this.liveTimer = null;

    const saved = loadPortfolioFrom(this.paths.portfolio);
    if (saved) {
      console.log(`[trader:${this.meta.name}] 이전 상태 복원 — 포지션 ${saved.positions?.length ?? 0}개, 거래 ${saved.trades?.length ?? 0}건`);
    }
  }

  get name() {
    return this.meta.name;
  }

  // ── 이벤트 로그 ────────────────────────────────────────────
  log(type, msg, actor = null) {
    appendEvent(this.accountId, type, msg, actor);
  }

  // ── 라이프사이클 ─────────────────────────────────────────────

  start() {
    if (this.running || this.meta.disabled) return;
    this.running = true;
    this.#startScanTimer();
    this.#startPersistTimer();
    this.#startLiveTimer();
    this.registerPicks();
    this.scan().catch((err) => console.error(`[trader:${this.name}] 첫 스캔 실패:`, err.message));
    console.log(`[trader:${this.name}] 시작`);
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    clearTimeout(this.scanTimer);
    clearInterval(this.persistTimer);
    clearInterval(this.liveTimer);
    this.scanTimer = this.persistTimer = this.liveTimer = null;
    console.log(`[trader:${this.name}] 정지`);
  }

  /** 허브에 시드 요구 등록 */
  registerPicks() {
    this.hub.registerSeedPicks(this.accountId, this.#pickSeedTargets());
  }

  applySettings(next, actor = null) {
    const prev = this.settings;
    this.settings = next;
    this.portfolio.settings = next;
    this.broker.setSettings(next);

    // 자본·투자금액 등 자금 설정이 바뀌면 포트폴리오를 재계산해야 하므로 초기화
    if (prev.initialCapitalUSDT !== next.initialCapitalUSDT || prev.positionSizeUSDT !== next.positionSizeUSDT) {
      this.portfolio.init(next);
      this.cooldowns.clear();
      this.emit('reset');
    }
    if (prev.scanIntervalSec !== next.scanIntervalSec) this.#startScanTimer();
    saveSettingsTo(next, this.paths.settings);
    this.log('settings', `설정 변경${actor ? ` (by ${actor})` : ''}: 익절 ${next.takeProfitPct}% / 손절 ${next.stopLossPct}% / 최대 ${next.maxPositions}종목`, actor);
    this.registerPicks();
    this.hub.refreshSeedTargets().catch(() => {});
    this.emit('settings', next);
  }

  resetPortfolio(actor = null) {
    this.portfolio.init(this.settings);
    this.cooldowns.clear();
    this.candidates = [];
    savePortfolioTo(null, this.paths.portfolio);
    this.log('account', `포트폴리오 초기화${actor ? ` (by ${actor})` : ''}`, actor);
    this.emit('reset');
    this.emit('toast', { level: 'info', text: '가상 자산을 초기화했습니다.' });
  }

  // ── 시드 대상 (own settings 기준) ────────────────────────────

  /** 거래대금 + 상장기간 기준으로 시드 대상 선정 (평가 대상과 동일한 조건) */
  #pickSeedTargets() {
    const { min24hQuoteVolumeUSDT, minOnboardDays, maxSymbols } = this.settings;
    return [...this.hub.universe]
      .filter((u) => u.ageDays >= minOnboardDays)
      .map((u) => ({ ...u, qv: this.hub.market.get(u.symbol)?.quoteVolume ?? 0 }))
      .filter((u) => u.qv >= min24hQuoteVolumeUSDT)
      .sort((a, b) => b.qv - a.qv)
      .slice(0, maxSymbols)
      .map((u) => u.symbol);
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
        console.error(`[trader:${this.name}] 스캔 실패:`, err.message);
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
        savePortfolioTo(this.portfolio.toJSON(), this.paths.portfolio);
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
          const live = new Map(ex.filter((p) => p.positionAmt > 0).map((p) => [p.symbol, p]));
          if (live.size !== this.portfolio.positions.size) await this.#reconcilePositions();
        }
      } catch (err) {
        console.warn(`[trader:${this.name}] 실거래 동기화 실패:`, err.message);
      }
    }, 20_000);
  }

  // ── 스캔 + 자동 매수 ─────────────────────────────────────────

  async scan() {
    const t0 = Date.now();
    this.status.scanCount += 1;
    this.status.lastScanAt = Date.now();
    this.status.lastError = null;

    const universeKeys = [...this.hub.universeMap.keys()];
    const ranked = this.hub.scanner.rank(universeKeys, this.hub.market, this.settings);

    this.candidates = ranked.map((c) => ({
      ...c,
      cooldownLeftMin: this.#cooldownLeft(c.symbol),
      held: this.portfolio.positions.has(c.symbol),
    }));
    // 후보가 없을 때 "무엇을 낮춰야 하는가" 를 보여줄 진단 정보
    this.nearMiss = this.candidates.length ? [] : this.hub.scanner.nearMisses(universeKeys, this.hub.market, this.settings, 5);
    // 진입 조건으로 차단된 종목 수 (후보가 있을 때도 참고용으로 노출)
    this.entryRejects = {
      by24h: this.hub.scanner.lastRejectedBy24h ?? 0,
      byRsi: this.hub.scanner.lastRejectedByRsi ?? 0,
    };
    this.status.lastScanMs = Date.now() - t0;

    this.emit('scan', { candidates: this.candidates, ms: this.status.lastScanMs });

    if (this.settings.autoTrade) this.autoBuy();
  }

  /**
   * 전체 평가 리스트 (전체 리스트 창용).
   * 통과 여부·탈락 사유·보유/쿨다운 상태를 함께 담는다.
   */
  fullRanking() {
    const universeKeys = [...this.hub.universeMap.keys()];
    const { rows } = this.hub.scanner.rankAll(universeKeys, this.hub.market, this.settings);
    return rows.map((r) => ({
      ...r,
      cooldownLeftMin: this.#cooldownLeft(r.symbol),
      held: this.portfolio.positions.has(r.symbol),
    }));
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
  async autoBuy(actor = null) {
    if (this.trading) return 0; // 주문 처리 중 중복 진입 방지
    let bought = 0;
    try {
      this.trading = true;
      for (const candidate of this.candidates) {
        if (this.portfolio.availableSlots <= 0) break;
        if (this.portfolio.positions.has(candidate.symbol)) continue;
        if (this.#cooldownLeft(candidate.symbol) > 0) continue;

        const price = this.hub.quoteFor(candidate.symbol).ask;
        if (!price) continue;

        let result;
        try {
          result = await this.portfolio.buy(candidate.symbol, price, candidate);
        } catch (err) {
          // 주문 실패는 이 종목만 건너뛰고 계속
          this.log('error', `${candidate.symbol} 매수 실패: ${err.message}`, actor);
          this.emit('toast', { level: 'warn', text: `${candidate.symbol} 매수 실패: ${err.message}` });
          continue;
        }

        if (result?.error) {
          if (result.error.includes('잔고') || result.error.includes('최대 보유')) break;
          continue;
        }
        bought += 1;
        const kind = result.simulated ? '시뮬레이션 매수' : result.live ? '실거래 매수' : '매수';
        const msg = `${kind} ${candidate.symbol} ${result.qty.toPrecision(6)} @ ${result.entryPrice.toPrecision(8)} (z ${candidate.z}, ${candidate.ratio}배)`;
        this.log('buy', msg, actor);
        this.emit('toast', { level: 'buy', text: msg });
        if (this.portfolio.isLive) await this.#refreshLiveBalance();
      }
    } finally {
      this.trading = false;
    }

    return bought;
  }

  // ── 가격 반영 + 청산 ─────────────────────────────────────────

  /** 1초마다 호출. 보유 포지션의 현재가를 갱신하고 청산 조건을 검사한다. */
  processPriceUpdates() {
    // 실거래 주문이 처리 중이면 가격 반영만 하고 청산 판단은 다음 틱으로 미룬다
    const map = new Map();
    for (const symbol of this.portfolio.positions.keys()) {
      const { bid } = this.hub.quoteFor(symbol);
      if (bid > 0) map.set(symbol, bid);
    }
    if (this.trading) return [];

    const now = Date.now();
    const exits = this.portfolio.update(map, now);
    // 청산 실패 백오프 중인 종목은 건너뛴다 (가격 반영·손익 표시는 계속됨)
    const ready = exits.filter((e) => {
      const rec = this.closeFail.get(e.symbol);
      return !rec || rec.nextRetryAt <= now;
    });
    if (ready.length) this.#closePositions(ready);
    return ready;
  }

  /** 청산 실행 (비동기 — 실거래는 실제 주문이므로 await) */
  async #closePositions(exits, actor = null) {
    if (this.trading) return;
    this.trading = true;
    try {
      for (const exit of exits) {
        await this.#closePosition(exit.symbol, exit.reason, exit.price, actor);
      }
      if (this.portfolio.isLive) await this.#refreshLiveBalance();
    } finally {
      this.trading = false;
    }
  }

  async #closePosition(symbol, reason, forcedPrice = null, actor = null) {
    const price = forcedPrice ?? this.hub.quoteFor(symbol).bid;
    let closed;
    try {
      closed = await this.portfolio.sell(symbol, price, reason);
    } catch (err) {
      // 같은 실패를 매초 반복하지 않는다 — 지수 백오프 (30초 → 5분 상한)
      const rec = this.closeFail.get(symbol) ?? { count: 0 };
      rec.count += 1;
      rec.lastError = err.message;
      const delayMs = Math.min(30_000 * 2 ** (rec.count - 1), 300_000);
      rec.nextRetryAt = Date.now() + delayMs;
      this.closeFail.set(symbol, rec);
      const friendly = err.friendly ?? err.message;
      this.log('error', `${symbol} 매도 실패 (${rec.count}회 연속): ${friendly} — ${Math.round(delayMs / 1000)}초 후 재시도`, actor);
      this.emit('toast', { level: 'warn', text: `${symbol} 매도 실패: ${friendly}` });
      return null;
    }
    if (!closed) return null;
    this.closeFail.delete(symbol);

    if (this.settings.cooldownMinutes > 0) {
      this.cooldowns.set(symbol, Date.now() + this.settings.cooldownMinutes * MINUTE);
    }

    const label =
      {
        'take-profit': '익절',
        'stop-loss': '손절',
        'trailing-stop': '트레일링 스탑',
        'time-stop': '시간 만료',
        manual: '수동 매도',
      }[reason] ?? reason;

    const msg = `${symbol} ${label} 매도 @ ${closed.exitPrice.toPrecision(8)} · ${closed.pnlPct >= 0 ? '+' : ''}${(closed.pnlPct * 100).toFixed(2)}% (${closed.pnlUSDT >= 0 ? '+' : ''}${closed.pnlUSDT.toFixed(2)} USDT)${closed.partial ? ' (부분 체결 — 잔량 유지)' : ''}`;
    this.log(reason === 'manual' ? 'sell' : 'sell', msg, actor);
    this.emit('toast', { level: closed.pnlUSDT >= 0 ? 'profit' : 'loss', text: msg });

    this.candidates = this.candidates.map((c) =>
      c.symbol === symbol ? { ...c, held: false, cooldownLeftMin: this.#cooldownLeft(symbol) } : c,
    );
    this.emit('trade-closed', closed);
    return closed;
  }

  // ── 수동 조작 ────────────────────────────────────────────────

  async manualBuy(symbol, actor = null) {
    const price = this.hub.quoteFor(symbol).ask;
    const stat = this.hub.market.get(symbol) ?? {};
    const candidate = this.candidates.find((c) => c.symbol === symbol);

    let result;
    try {
      result = await this.portfolio.buy(symbol, price, candidate ?? { change24hPct: stat.priceChangePercent });
    } catch (err) {
      this.log('error', `${symbol} 수동 매수 실패: ${err.message}`, actor);
      return { ok: false, error: err.message };
    }
    if (result?.error) return { ok: false, error: result.error };

    if (this.portfolio.isLive) await this.#refreshLiveBalance();
    const kind = result.simulated ? '시뮬레이션' : result.live ? '실거래' : '';
    const msg = `${symbol} ${kind} 수동 매수 @ ${result.entryPrice.toPrecision(8)}`;
    this.log('buy', msg, actor);
    this.emit('toast', { level: 'buy', text: msg });
    return { ok: true, position: result };
  }

  async manualSell(symbol, actor = null) {
    const closed = await this.#closePosition(symbol, 'manual', null, actor);
    if (!closed) return { ok: false, error: '보유 중인 종목이 아닙니다.' };
    if (this.portfolio.isLive) await this.#refreshLiveBalance();
    return { ok: true, trade: closed };
  }

  async closeAll(actor = null) {
    if (this.trading) return { ok: false, error: '주문 처리 중입니다. 잠시 후 다시 시도하세요.' };
    let count = 0;
    this.trading = true;
    try {
      for (const symbol of [...this.portfolio.positions.keys()]) {
        const closed = await this.#closePosition(symbol, 'manual', null, actor);
        if (closed) count += 1;
      }
      if (this.portfolio.isLive) await this.#refreshLiveBalance();
    } finally {
      this.trading = false;
    }
    this.log('sell', `전량 청산 (${count}종목)${actor ? ` by ${actor}` : ''}`, actor);
    return { ok: true, count };
  }

  // ── 실거래 연결 / 동기화 (계정별 자격증명) ────────────────────

  /**
   * 실거래 모드 진입.
   * @param {{apiKey:string, apiSecret:string, network:string, mode:'live'|'paper', dryRun?:boolean, actor?:string}} opts
   */
  async connectAccount({ apiKey, apiSecret, network, mode = 'live', dryRun = false, actor = null }) {
    this.broker.setSettings(this.settings);
    const result = await this.broker.connect({ apiKey, apiSecret, network }, { dryRun });
    this.status.account = { ...this.broker.describe(), balance: null };

    if (mode !== 'live') {
      this.status.account.mode = 'paper';
      const msg = `${result.network === 'testnet' ? '테스트넷' : '실거래'} 계정에 연결했습니다. 현재는 가상 모드입니다.`;
      this.log('account', msg, actor);
      this.emit('toast', { level: 'info', text: msg });
      return this.accountInfo();
    }

    // ── 실거래 모드 (주문 시뮬레이션 여부에 따라 동작이 나뉜다) ──
    this.portfolio.attachExecutor(this.broker);
    // 실거래와 가상 포지션이 섞이지 않도록 로컬 포지션을 비우고 거래소에서 복구
    this.portfolio.positions = new Map();
    this.portfolio.equityPeak = 0;

    await this.#reconcilePositions();
    await this.#refreshLiveBalance();

    this.status.account.mode = 'live';
    const isProd = result.network === 'production';

    if (dryRun) {
      this.status.marketWarning = null;
      const msg = `주문 시뮬레이션 모드 (${isProd ? '실계정' : '테스트넷'}) · 잔고 ${result.walletBalance.toFixed(2)} USDT · 주문은 넣지 않습니다.`;
      this.log('account', msg, actor);
      this.emit('toast', { level: 'info', text: msg });
    } else {
      this.status.marketWarning = isProd ? '실거래 모드입니다 — 실제 자금이 움직입니다.' : null;
      const msg = `실거래 모드 시작 (${isProd ? '실계정' : '테스트넷'}) · 지갑 ${result.walletBalance.toFixed(2)} USDT`;
      this.log('account', msg, actor);
      this.emit('toast', { level: isProd ? 'warn' : 'info', text: msg });
    }
    return this.accountInfo();
  }

  /**
   * 주문 시뮬레이션 토글 — 연결을 유지한 채 실제 주문 여부만 바꾼다.
   */
  setDryRun(enabled, actor = null) {
    if (!this.portfolio.isLive) throw new Error('실거래 모드에서만 주문 시뮬레이션을 켤 수 있습니다.');
    const on = this.broker.setDryRun(enabled);
    this.status.account = { ...this.broker.describe(), balance: null };
    this.status.marketWarning =
      !on && this.broker.network === 'production' ? '실거래 모드입니다 — 실제 자금이 움직입니다.' : null;
    const msg = on ? '주문 시뮬레이션 ON — 주문을 넣지 않고 시나리오만 확인합니다.' : '실제 주문 ON — 시장가 주문이 전송됩니다.';
    this.log('account', msg, actor);
    this.emit('toast', { level: on ? 'info' : 'warn', text: msg });
    return this.accountInfo();
  }

  disconnectAccount(actor = null) {
    this.broker.disconnect();
    this.portfolio.detachExecutor();
    this.status.account = { ...this.broker.describe(), balance: null };
    this.status.marketWarning = null;
    this.log('account', `계정 연결 해제 → 가상 모드${actor ? ` (by ${actor})` : ''}`, actor);
    this.emit('toast', { level: 'info', text: '계정 연결을 해제했습니다. 가상 모드로 전환됩니다.' });
    return this.accountInfo();
  }

  /** 거래소 잔고 갱신 (+ 포지션 모드 자가 복구) */
  async #refreshLiveBalance() {
    if (!this.portfolio.isLive) return null;
    try {
      const balance = await this.broker.balance();
      this.portfolio.liveBalance = {
        ...balance,
        startBalance: this.portfolio.liveBalance?.startBalance ?? balance.walletBalance,
      };
      this.portfolio.equity = this.portfolio.computeEquity();
      this.portfolio.equityPeak = Math.max(this.portfolio.equityPeak, this.portfolio.equity);
      this.status.account.balance = balance;
      // 포지션 모드가 바뀌었으면(사용자가 바이낸스에서 변경) 자동 반영
      try {
        const mode = await this.broker.refreshPositionMode();
        if (mode.changed) {
          this.log('account', `포지션 모드 변경 감지: ${mode.from} → ${mode.to} (자동 반영)`, null);
          this.emit('toast', { level: 'info', text: `포지션 모드가 ${mode.to} 로 바뀌어 자동 반영했습니다.` });
        }
      } catch {
        /* 모드 조회 실패는 잔고 갱신을 막지 않는다 */
      }
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

  // ── 자격증명 (계정별 파일) ───────────────────────────────────

  saveCreds({ apiKey, apiSecret, network }, actor = null) {
    const creds = saveCredentials(this.paths.dir, { apiKey, apiSecret, network });
    this.log('account', `API 키 저장 (네트워크: ${creds.network})`, actor);
    return creds;
  }

  deleteCreds(actor = null) {
    deleteCredentials(this.paths.dir);
    const info = this.disconnectAccount(actor);
    disarmLive(this.paths.dir);
    this.log('account', 'API 키 삭제', actor);
    return info;
  }

  describeCreds() {
    return describeCredentials(this.paths.dir);
  }

  armLiveMode() {
    const creds = loadCredentials(this.paths.dir);
    if (!creds) throw new Error('저장된 API 키가 없습니다.');
    return armLive(this.paths.dir, creds.network);
  }

  disarmLiveMode() {
    return disarmLive(this.paths.dir);
  }

  loadCreds() {
    return loadCredentials(this.paths.dir);
  }

  /** 추적 심볼 집합 (허브 구독 합집합용) */
  ownTracked() {
    const next = new Set();
    for (const c of this.candidates) next.add(c.symbol);
    for (const s of this.portfolio.positions.keys()) next.add(s);
    return next;
  }

  // ── 스냅샷 ───────────────────────────────────────────────────

  snapshot() {
    const market = this.hub.marketStatus();
    return {
      type: 'state',
      accountId: this.accountId,
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
        status: {
          ...this.status,
          market: market.market,
          priceFeed: market.priceFeed,
          priceStreamState: market.priceStreamState,
          lastPollAt: market.lastPollAt,
          lastBarPollAt: market.lastBarPollAt,
          lastBarPollMs: market.lastBarPollMs,
          apiOk: market.apiOk,
          lastError: this.status.lastError ?? market.lastError,
          marketWarning: this.status.marketWarning,
          account: this.status.account,
        },
        tracked: [...this.tracked],
        marketCount: market.marketCount,
        trackedHistory: market.trackedHistory,
        account: this.accountInfo(),
      },
    };
  }
}
