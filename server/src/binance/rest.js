/** 바이낸스 USDⓈ-M 선물 퍼펙추얼 REST 클라이언트 */
const BASE = process.env.BINANCE_FAPI_BASE || 'https://fapi.binance.com';

const HEADERS = {
  'User-Agent': 'coin-surfer/1.0',
  Accept: 'application/json',
};

class BinanceError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'BinanceError';
    this.status = status;
  }
}

async function request(pathname, params = {}) {
  const url = new URL(pathname, BASE);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }

  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.json())?.msg ?? '';
    } catch {
      /* 본문이 JSON이 아닐 수 있음 */
    }
    throw new BinanceError(`${pathname} 실패 (HTTP ${res.status}) ${detail}`.trim(), res.status);
  }
  return res.json();
}

/** 계정 유효성 확인 */
export const ping = () => request('/fapi/v1/ping');

/** 거래 가능한 퍼펙추얼 심볼 목록 (onboardDate 포함) */
export async function fetchUniverse() {
  const info = await request('/fapi/v1/exchangeInfo');
  const now = Date.now();

  const symbols = [];
  for (const s of info.symbols) {
    if (s.status !== 'TRADING') continue;
    if (s.contractType !== 'PERPETUAL') continue;
    if (s.quoteAsset !== 'USDT') continue; // USDC 선물 제외 → USDT 기준만 사용

    // 레버리지 토큰(UP/DOWN/BULL/BEAR) 제외 — 가격이 배수라 수익률 계산이 무의미
    if (/(UP|DOWN|BULL|BEAR)$/.test(s.baseAsset)) continue;

    symbols.push({
      symbol: s.symbol,
      baseAsset: s.baseAsset,
      onboardDate: s.onboardDate || 0,
      ageDays: s.onboardDate ? (now - s.onboardDate) / 86_400_000 : 999,
    });
  }
  return symbols;
}

/** 24시간 티커 전량 */
export async function fetchAllTickers() {
  const rows = await request('/fapi/v1/ticker/24hr');
  return rows.map((r) => ({
    symbol: r.symbol,
    lastPrice: parseFloat(r.lastPrice),
    priceChangePercent: parseFloat(r.priceChangePercent),
    quoteVolume: parseFloat(r.quoteVolume),
    highPrice: parseFloat(r.highPrice),
    lowPrice: parseFloat(r.lowPrice),
  }));
}

/**
 * 분봉 (기본 1분)
 * @returns {Array<{openTime:number, open:number, high:number, low:number, close:number, quoteVolume:number, isClosed:boolean}>}
 */
export async function fetchKlines(symbol, interval = '1m', limit = 60) {
  const rows = await request('/fapi/v1/klines', { symbol, interval, limit });
  const now = Date.now();
  return rows.map((k) => ({
    openTime: k[0],
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    quoteVolume: parseFloat(k[7]),
    isClosed: k[6] < now,
  }));
}

/**
 * 가장 최근 1개 봉 (진행 중 봉 포함) — 분당 거래량 폴링용 (가중치 1)
 * @returns {Promise<{openTime:number, close:number, quoteVolume:number}|null>}
 */
export async function fetchLatestKline(symbol, interval = '1m') {
  const rows = await request('/fapi/v1/klines', { symbol, interval, limit: 1 });
  const k = rows.at(0);
  if (!k) return null;
  return {
    openTime: k[0],
    close: parseFloat(k[4]),
    quoteVolume: parseFloat(k[7]),
    isClosed: k[6] < Date.now(),
  };
}

/** 최우선 매수/매도 호가 → 슬리피지보다 현실적인 체결가 추정용 */
export async function fetchBookTicker(symbol) {
  const b = await request('/fapi/v1/ticker/bookTicker', { symbol });
  return { bid: parseFloat(b.bidPrice), ask: parseFloat(b.askPrice) };
}

/**
 * 동시 요청 수를 제한하며 작업 실행 (바이낸스 가중치 제한 보호)
 */
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      try {
        results[index] = { ok: true, value: await fn(items[index], index) };
      } catch (err) {
        results[index] = { ok: false, error: err };
      }
    }
  });

  await Promise.all(workers);
  return results;
}

export { BinanceError, BASE };
