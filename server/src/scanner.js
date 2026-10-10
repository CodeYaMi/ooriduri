import { fetchKlines, mapLimit } from './binance/rest.js';

const mean = (arr) => arr.reduce((a, b) => a + b, 0) / (arr.length || 1);

function stddev(arr, m) {
  if (arr.length < 2) return 0;
  const variance = arr.reduce((acc, v) => acc + (v - m) ** 2, 0) / arr.length;
  return Math.sqrt(variance);
}

const round = (n, d = 2) => (Number.isFinite(n) ? Number(n.toFixed(d)) : 0);

/**
 * RSI (Wilder 평활법)
 *
 *   1. 처음 period 개의 변화량으로 단순 평균 gain/loss 를 구한다
 *   2. 이후에는 平활 avg = (avg × (period-1) + 현재) / period 로 갱신한다
 *   3. RSI = 100 − 100 / (1 + avgGain / avgLoss), avgLoss = 0 이면 100
 *
 * 종가가 period+1 개 이상 필요하며, 정확히 period+1 개일 때 초기값(가장 민감한 값)이 나온다.
 * @param {number[]} closes 시간 순 종가 배열 (오래된 순)
 * @param {number} period
 * @returns {number|null} 0~100, 데이터 부족 시 null
 */
export function computeRSI(closes, period = 14) {
  if (!Array.isArray(closes) || closes.length < period + 1) return null;
  // 최근 period+1 개만 사용 (계산량은 고정, 오래된 값의 영향 제거)
  const window = closes.slice(-(period + 1));

  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= period; i += 1) {
    const diff = window[i] - window[i - 1];
    if (diff >= 0) gainSum += diff;
    else lossSum -= diff;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;

  // Wilder 평활 (필요한 만큼만 반복 — window 길이가 period+1 이면 0회)
  for (let i = period + 1; i < window.length; i += 1) {
    const diff = window[i] - window[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(0, diff)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(0, -diff)) / period;
  }

  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

/**
 * 1분봉 거래량 히스토리를 관리하고, "거래량 급등"을 z-score + 배수로 판정한다.
 *
 * 판정식
 *   recentAvg = 최근 R분의 평균 거래대금 (확정봉만)
 *   baseAvg   = 그 이전 L분의 평균 거래대금
 *   z         = (recentAvg - baseAvg) / std(baseAvg)
 *   ratio     = recentAvg / baseAvg
 *
 * 데이터 소스
 *   - 히스토리 시드: REST /fapi/v1/klines (교환소가 계산한 확정 수치)
 *   - 진행 중 봉:   매 N초 REST klines 폴링 (1m 봉의 running total)
 *   ※ 24시간 누적 거래대금의 차분은 윈도우 롤오버로 음수가 될 수 있어
 *     분당 거래량 계산에 사용할 수 없다. 반드시 분봉을 직접 읽는다.
 *
 * 단일 1분봉의 스파이크는 노이즈가 커서, 최근 R분을 평균내어 안정적으로 판정한다.
 */
export class VolumeScanner {
  constructor() {
    /**
     * symbol -> {
     *   bars: number[]          확정된 1분봉 거래대금 (오래된 순)
     *   closes: number[]        확정된 1분봉 종가 (RSI 계산용, 오래된 순)
     *   liveBar: {openTime, volume, close}  진행 중 1분봉 (closes 와 중복 없음)
     *   lastLiveOpenTime: number
     * }
     */
    this.history = new Map();
    this.pending = new Set();
    this.maxBars = 200;
    this.recentWindowMinutes = 3;
    this.lookbackMinutes = 30;
    this.rsiPeriod = 14;
  }

  /** 히스토리 크기를 설정에 맞춰 조정 */
  configure({ recentWindowMinutes, lookbackMinutes, rsiPeriod }) {
    this.recentWindowMinutes = recentWindowMinutes;
    this.lookbackMinutes = lookbackMinutes;
    if (Number.isFinite(rsiPeriod) && rsiPeriod > 1) this.rsiPeriod = rsiPeriod;
    // RSI 는 period+1 개 종가가 필요하므로 최소 period+5 개까지는 확보
    this.maxBars = Math.min(1000, Math.max(30, recentWindowMinutes + lookbackMinutes + 5, this.rsiPeriod + 5));
  }

  has(symbol) {
    return this.history.has(symbol);
  }

  getTrackedSymbols() {
    return [...this.history.keys()];
  }

  /**
   * REST 분봉으로 히스토리를 시드한다. 마지막 봉(진행 중)은 liveBar 로 분리.
   */
  async seed(symbol) {
    if (this.pending.has(symbol)) return false;
    this.pending.add(symbol);
    try {
      const limit = Math.min(1000, this.maxBars + 2);
      const klines = await fetchKlines(symbol, '1m', limit);
      if (!klines.length) return false;

      const live = klines.filter((k) => !k.isClosed);
      const closed = klines.filter((k) => k.isClosed);
      const lastLive = live.at(-1) ?? null;

      this.history.set(symbol, {
        bars: closed.map((k) => k.quoteVolume),
        closes: closed.map((k) => k.close),
        liveBar: lastLive ? { openTime: lastLive.openTime, volume: lastLive.quoteVolume, close: lastLive.close } : null,
        lastLiveOpenTime: lastLive?.openTime ?? 0,
      });
      return true;
    } catch (err) {
      console.warn(`[scanner] ${symbol} 분봉 조회 실패:`, err.message);
      return false;
    } finally {
      this.pending.delete(symbol);
    }
  }

  /** 여러 종목 시드 (동시 요청 제한) */
  async seedMany(symbols, concurrency = 6) {
    const results = await mapLimit(symbols, concurrency, (symbol) => this.seed(symbol));
    const ok = results.filter((r) => r?.ok && r.value).length;
    const failed = results.filter((r) => r && !r.ok).map((r, i) => symbols[i]);
    if (failed.length) console.warn(`[scanner] ${failed.length}종목 시드 실패:`, failed.slice(0, 8).join(', '));
    return ok;
  }

  /**
   * 진행 중인 1분봉을 갱신한다 (같은 봉이 다시 조회되면 값 교체, 다른 봉이면 확정).
   * @param {object} bar {openTime, quoteVolume}
   */
  syncBar(symbol, bar) {
    let entry = this.history.get(symbol);
    if (!entry) return;
    if (!entry.closes) entry.closes = [];

    const nextLive = { openTime: bar.openTime, volume: bar.quoteVolume, close: bar.close };

    // 다른 봉으로 넘어갔으면 직전 봉을 히스토리에 확정
    if (entry.lastLiveOpenTime && bar.openTime > entry.lastLiveOpenTime) {
      const prev = entry.liveBar;
      if (prev && prev.openTime === entry.lastLiveOpenTime && prev.volume > 0) {
        entry.bars.push(prev.volume);
        entry.closes.push(prev.close);
        if (entry.bars.length > this.maxBars) {
          entry.bars.splice(0, entry.bars.length - this.maxBars);
          entry.closes.splice(0, entry.closes.length - this.maxBars);
        }
      }
      entry.liveBar = nextLive;
      entry.lastLiveOpenTime = bar.openTime;
      return;
    }

    // 같은 봉 → running total 교체
    if (bar.openTime === entry.lastLiveOpenTime) {
      entry.liveBar = nextLive;
    } else if (bar.openTime > (entry.lastLiveOpenTime ?? 0)) {
      // 진행 중 봉이 아직 없는 상태에서 새로 시작
      entry.liveBar = nextLive;
      entry.lastLiveOpenTime = bar.openTime;
    }
  }

  /** 진행 중 봉의 초당 pace → 분당 환산 (UI 실시간 힌트용) */
  livePace(symbol) {
    const entry = this.history.get(symbol);
    if (!entry?.liveBar?.volume) return null;
    const elapsed = (Date.now() - entry.liveBar.openTime) / 60_000;
    // 15초 미만이면 표본이 너무 작아 환산이 크게 흔들린다
    if (elapsed < 0.25 || elapsed >= 1) return null;
    return entry.liveBar.volume / elapsed;
  }

  /**
   * 특정 종목의 z-score / 배수 / RSI 계산.
   * @param {object|number} [opts] 윈도우 지정. 숫자면 rsiPeriod 로 간주 (하위 호환).
   *   공유 히스토리 위에서 계정별 설정으로 평가할 때 사용한다.
   */
  evaluate(symbol, opts = {}) {
    const entry = this.history.get(symbol);
    if (!entry) return null;

    const o = typeof opts === 'number' ? { rsiPeriod: opts } : opts;
    const rsiPeriod = o.rsiPeriod ?? this.rsiPeriod;
    const R = o.recentWindowMinutes ?? this.recentWindowMinutes;
    const L = o.lookbackMinutes ?? this.lookbackMinutes;
    const bars = entry.bars;

    if (bars.length < R + 5) return null; // 최소 표본 부족

    const recent = bars.slice(-R);
    const base = bars.slice(-(R + L), -R);
    if (base.length < 5) return null;

    const recentAvg = mean(recent);
    const baseAvg = mean(base);
    if (!(baseAvg > 0)) return null;

    // 표준편차가 지나치게 작으면(거래량이 매우 고르다면) 분모 폭주를 막기 위해 20% 바닥선 적용
    const std = Math.max(stddev(base, baseAvg), baseAvg * 0.2);
    const z = (recentAvg - baseAvg) / std;
    const ratio = recentAvg / baseAvg;

    // RSI: 확정 종가 + 진행 중 봉의 현재 종가.
    // closes 에는 아직 확정되지 않은 봉이 없으므로 liveBar 를 이어 붙여도
    // 마지막 종가가 중복 계상되지 않는다 (syncBar 가 불변식을 유지한다).
    const closes = [...(entry.closes ?? [])];
    const liveClose = entry.liveBar?.close;
    if (Number.isFinite(liveClose) && liveClose > 0) closes.push(liveClose);
    const rsi = computeRSI(closes, rsiPeriod);

    return {
      recentAvg,
      baseAvg,
      z,
      ratio,
      rsi,
      livePace: this.livePace(symbol),
      recentQuoteVolume: recent.reduce((a, b) => a + b, 0),
      sampleBars: bars.length,
      bars: bars.slice(-Math.max(L + R, 40)), // 프론트 차트용
    };
  }

  /**
   * 전체 종목 평가 → 통과 여부·탈락 사유까지 담은 전체 리스트를 점수순으로 반환.
   * rank()와 동일한 판정 로직을 공유한다 (전체 리스트 창용).
   * @returns {{ rows: Array, rejectedByRsi: number, rejectedBy24h: number }}
   *   row = 후보 row + { passed: bool, reasons: string[] } (bars 제외로 경량화)
   */
  rankAll(symbols, marketStats, settings) {
    const {
      zScoreThreshold,
      surgeRatioThreshold,
      minMinuteQuoteVolumeUSDT,
      min24hQuoteVolumeUSDT,
      useRsiFilter,
      rsiMin,
      rsiMax,
      use24hChangeFilter,
      minChange24hPct,
    } = settings;

    const rsiEnabled = Boolean(useRsiFilter);
    const chgEnabled = Boolean(use24hChangeFilter);
    const rows = [];
    let rejectedByRsi = 0;
    let rejectedBy24h = 0;

    for (const symbol of symbols) {
      const stat = marketStats.get(symbol);
      if (!stat) continue;
      if (stat.quoteVolume < min24hQuoteVolumeUSDT) continue;

      const metrics = this.evaluate(symbol, {
        rsiPeriod: settings.rsiPeriod ?? this.rsiPeriod,
        recentWindowMinutes: settings.recentWindowMinutes ?? this.recentWindowMinutes,
        lookbackMinutes: settings.lookbackMinutes ?? this.lookbackMinutes,
      });
      if (!metrics) continue;
      if (metrics.recentAvg < minMinuteQuoteVolumeUSDT) continue;

      // 탈락 사유 수집 (통과 종목은 빈 배열)
      const reasons = [];
      const volumePass =
        metrics.ratio >= surgeRatioThreshold &&
        metrics.z >= zScoreThreshold;
      if (metrics.ratio < surgeRatioThreshold) reasons.push(`급등 ${metrics.ratio.toFixed(2)}배 < ${surgeRatioThreshold}배`);
      if (metrics.z < zScoreThreshold) reasons.push(`z ${metrics.z.toFixed(2)} < ${zScoreThreshold}`);

      let rsiBlocked = false;
      let chgBlocked = false;
      if (chgEnabled && stat.priceChangePercent < minChange24hPct) {
        reasons.push(`24h 변동 ${stat.priceChangePercent.toFixed(2)}% < ${minChange24hPct}%`);
        chgBlocked = true;
      }
      if (rsiEnabled && metrics.rsi !== null && (metrics.rsi < rsiMin || metrics.rsi > rsiMax)) {
        reasons.push(`RSI ${metrics.rsi.toFixed(1)} 범위 밖 (${rsiMin}~${rsiMax})`);
        rsiBlocked = true;
      }
      // 기존 rank()와 동일: 거래량 게이트를 통과한 종목에 한해 집계
      if (volumePass && rsiBlocked) rejectedByRsi += 1;
      if (volumePass && chgBlocked) rejectedBy24h += 1;

      rows.push({
        symbol,
        price: stat.lastPrice,
        change24hPct: stat.priceChangePercent,
        quoteVolume24h: stat.quoteVolume,
        z: round(metrics.z, 2),
        ratio: round(metrics.ratio, 2),
        rsi: metrics.rsi === null ? null : round(metrics.rsi, 1),
        recentAvg: round(metrics.recentAvg, 0),
        baseAvg: round(metrics.baseAvg, 0),
        recentQuoteVolume: round(metrics.recentQuoteVolume, 0),
        livePace: metrics.livePace ? round(metrics.livePace, 0) : null,
        bars: metrics.bars.map((v) => round(v, 0)),
        // 종합 점수: z-score와 배수의 결합 + 모멘텀 보정
        // RSI 가 범위 중앙에 가까울수록(강하지만 과매수 아님) 가산점
        score: round(
          metrics.z * 1.0 +
            (metrics.ratio - 1) * 0.35 +
            Math.abs(stat.priceChangePercent) * 0.05 +
            (metrics.rsi === null ? 0 : Math.max(0, 1 - Math.abs(metrics.rsi - (rsiMin + rsiMax) / 2) / 50) * 0.5),
          3,
        ),
        passed: reasons.length === 0,
        reasons,
      });
    }

    rows.sort((a, b) => b.score - a.score);
    return { rows, rejectedByRsi, rejectedBy24h };
  }

  /**
   * 전체 종목 평가 → 임계값 통과 종목만 점수순으로 정렬해 반환
   */
  rank(symbols, marketStats, settings) {
    const { topN } = settings;
    const { rows, rejectedByRsi, rejectedBy24h } = this.rankAll(symbols, marketStats, settings);

    this.lastRejectedByRsi = rejectedByRsi;
    this.lastRejectedBy24h = rejectedBy24h;
    return rows
      .filter((r) => r.passed)
      .slice(0, topN)
      .map(({ passed, reasons, ...row }) => row);
  }

  /**
   * 임계값에 걸려 어깝난 종목 중 가장 가까운 몇 건.
   * 후보가 비었을 때 "무엇을 낮춰야 하는가" 를 알려주기 위한 진단 정보.
   */
  nearMisses(symbols, marketStats, settings, limit = 5) {
    const {
      zScoreThreshold,
      surgeRatioThreshold,
      minMinuteQuoteVolumeUSDT,
      min24hQuoteVolumeUSDT,
      useRsiFilter,
      rsiMin,
      rsiMax,
      use24hChangeFilter,
      minChange24hPct,
    } = settings;
    const rsiEnabled = Boolean(useRsiFilter);
    const chgEnabled = Boolean(use24hChangeFilter);
    const rows = [];

    for (const symbol of symbols) {
      const stat = marketStats.get(symbol);
      if (!stat || stat.quoteVolume < min24hQuoteVolumeUSDT) continue;

      const m = this.evaluate(symbol, {
        rsiPeriod: settings.rsiPeriod ?? this.rsiPeriod,
        recentWindowMinutes: settings.recentWindowMinutes ?? this.recentWindowMinutes,
        lookbackMinutes: settings.lookbackMinutes ?? this.lookbackMinutes,
      });
      if (!m || m.recentAvg < minMinuteQuoteVolumeUSDT) continue;

      // 통과 조건 중 어긋난 항목만 모은다
      const reasons = [];
      if (m.ratio < surgeRatioThreshold) reasons.push(`급등 ${m.ratio.toFixed(2)}배 < ${surgeRatioThreshold}배`);
      if (m.z < zScoreThreshold) reasons.push(`z ${m.z.toFixed(2)} < ${zScoreThreshold}`);
      if (chgEnabled && stat.priceChangePercent < minChange24hPct) {
        reasons.push(`24h 변동 ${stat.priceChangePercent.toFixed(2)}% < ${minChange24hPct}%`);
      }
      if (rsiEnabled && m.rsi !== null && (m.rsi < rsiMin || m.rsi > rsiMax)) {
        reasons.push(`RSI ${m.rsi.toFixed(1)} 범위 밖 (${rsiMin}~${rsiMax})`);
      }
      if (!reasons.length) continue;

      // 24h 변동 조건이 가장 먼 차단 사유라면 그 지정을 우선 표시한다
      const blockedOnlyBy24h =
        chgEnabled &&
        stat.priceChangePercent < minChange24hPct &&
        m.ratio >= surgeRatioThreshold &&
        m.z >= zScoreThreshold &&
        !(rsiEnabled && m.rsi !== null && (m.rsi < rsiMin || m.rsi > rsiMax));

      rows.push({
        symbol,
        z: round(m.z, 2),
        ratio: round(m.ratio, 2),
        rsi: m.rsi === null ? null : round(m.rsi, 1),
        change24hPct: stat.priceChangePercent,
        blockedOnlyBy24h,
        // 가장 가까운 후보 = 기준 대비 비율이 가장 높은 종목
        gap: m.ratio < surgeRatioThreshold ? m.ratio / surgeRatioThreshold : m.z / zScoreThreshold,
        reasons,
      });
    }

    // 24h 조건 하나만으로 막힌 종목을 맨 위로 (조치 방법이 하나이기 때문)
    rows.sort((a, b) => Number(b.blockedOnlyBy24h) - Number(a.blockedOnlyBy24h) || b.gap - a.gap);
    return rows.slice(0, limit);
  }

  /** 하위 N개 종목 히스토리 정리 (메모리 관리) */
  prune(keepSymbols) {
    if (this.history.size <= keepSymbols) return;
    for (const symbol of this.history.keys()) {
      if (this.history.size <= keepSymbols) break;
      if (!keepSymbols.has(symbol)) this.history.delete(symbol);
    }
  }

  stats() {
    return { tracked: this.history.size };
  }
}
