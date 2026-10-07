import crypto from 'node:crypto';

/**
 * 바이낸스 선물 "인증 필요" REST 클라이언트 (서명 방식)
 *
 * - 테스트넷: https://testnet.binancefuture.com
 * - 실거래  : https://fapi.binance.com
 *
 * 보안 주의
 *  - apiSecret 은 이 모듈 밖으로 절대 노출되지 않는다 (로그/응답 금지)
 *  - 타임스페이스 + 서명 → 리플레이 공격 방지
 */

export const ENDPOINTS = {
  testnet: { rest: 'https://testnet.binancefuture.com', ws: 'wss://stream.binancefuture.com' },
  production: { rest: 'https://fapi.binance.com', ws: 'wss://fstream.binance.com' },
};

const RECV_WINDOW = 15_000; // 시계가 어긋난 요청 허용 (기본 5000보다 여유)
const MAX_RETRIES = 3;

export class BinancePrivateError extends Error {
  constructor(message, { code, status, endpoint } = {}) {
    super(message);
    this.name = 'BinancePrivateError';
    this.code = code;
    this.status = status;
    this.endpoint = endpoint;
  }

  /** 사용자에게 보여줄 한국어 설명 */
  get friendly() {
    const map = {
      '-2015': 'API 키에 선물 주문 권한이 없습니다. 바이낸스 API 관리에서 해당 키의 "선물(Futures) 거래 허용"을 켜주세요. (조회는 되지만 주문만 거부되는 경우 이 원인이 99%입니다)',
      '-2014': 'API 키 형식이 올바르지 않습니다.',
      '-1022': '서명이 일치하지 않습니다. 시크릿을 다시 입력하세요.',
      '-1021': '서버 시각과 로컬 시각이 너무 다릅니다. 시간을 동기화하세요.',
      '-1003': '요청이 너무 많습니다. 잠시 후 다시 시도하세요.',
      '-2019': '계정 잔고가 부족합니다.',
      '-4046': '주문 수량/가격이 거래소 규칙(LOT_SIZE)에 맞지 않습니다.',
      '-4164': '주문 수량이 최소 금액(MIN_NOTIONAL)에 미달합니다.',
      '-4131': '이 지갑은 후손 계정 간 이체 전용입니다. 거래 권한이 있는 키를 사용하세요.',
      '-1102': '선택한 포지션이 없습니다. 포지션 모드(one-way/hedge)가 올바른지 확인하세요.',
      '-4047': 'reduceOnly 주문인데 청산할 포지션이 없습니다.',
    };
    return map[this.code] ?? this.message;
  }
}

export class PrivateClient {
  /**
   * @param {{apiKey:string, apiSecret:string, network:'testnet'|'production'}} creds
   */
  constructor({ apiKey, apiSecret, network = 'testnet' }) {
    if (!apiKey || !apiSecret) throw new BinancePrivateError('API 키와 시크릿이 필요합니다.');
    this.apiKey = String(apiKey).trim();
    this.apiSecret = String(apiSecret).trim();
    this.network = network === 'production' ? 'production' : 'testnet';
    this.base = ENDPOINTS[this.network].rest;
    /** @type {Map<string, {stepSize:number, minQty:number, minNotional:number, tickSize:number}>} */
    this.filters = new Map();
  }

  get isTestnet() {
    return this.network === 'testnet';
  }

  /** 서명된 요청 — GET/DELETE 는 쿼리스트링, POST 는 바디에 서명을 넣는다 */
  async signedRequest(method, pathname, params = {}, { timeout = 15_000 } = {}) {
    const verb = String(method).toUpperCase();
    const withBody = verb === 'POST' || verb === 'PUT';

    const buildQuery = () => {
      const query = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) {
        if (v === undefined || v === null) continue;
        query.set(k, String(v));
      }
      query.set('recvWindow', RECV_WINDOW);
      query.set('timestamp', String(Date.now()));
      return query.toString();
    };

    const sign = (q) => crypto.createHmac('sha256', this.apiSecret).update(q).digest('hex');
    let signed = `${buildQuery()}&signature=${sign(buildQuery())}`;

    let lastError = null;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
      const url = new URL(pathname, this.base);
      if (!withBody) {
        // GET/HEAD 는 바디를 보낼 수 없으므로 URL 에 서명 쿼리를 붙여야 한다
        url.search = signed;
      }

      const res = await fetch(url, {
        method: verb,
        headers: {
          'X-MBX-APIKEY': this.apiKey,
          ...(withBody ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
        },
        body: withBody ? signed : undefined,
        signal: AbortSignal.timeout(timeout),
      }).catch((err) => {
        throw new BinancePrivateError(`네트워크 오류: ${err.message}`, { endpoint: pathname });
      });

      const text = await res.text();
      let data;
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        throw new BinancePrivateError(`서버 응답이 JSON이 아닙니다 (HTTP ${res.status}).`, { status: res.status, endpoint: pathname });
      }

      if (res.ok) return data;

      const err = new BinancePrivateError(data?.msg ?? `HTTP ${res.status}`, { code: data?.code, status: res.status, endpoint: pathname });

      // 타임스페이스 어긋남 → timestamp 갱신 후 재시도
      if (data?.code === -1021 && attempt < MAX_RETRIES - 1) {
        await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
        signed = `${buildQuery()}&signature=${sign(buildQuery())}`;
        continue;
      }
      // 일시적 서버/레이트리밋 오류 → 지수 백오프
      if ([-1003, -1006, -1007, 429, 418].includes(data?.code) || res.status >= 500) {
        lastError = err;
        await new Promise((r) => setTimeout(r, 800 * 2 ** attempt));
        signed = `${buildQuery()}&signature=${sign(buildQuery())}`;
        continue;
      }
      throw err;
    }
    throw lastError ?? new BinancePrivateError('요청 실패', { endpoint: pathname });
  }

  /** 공개 요청 (서명 불필요) */
  async publicRequest(pathname, params = {}, { timeout = 15_000 } = {}) {
    const url = new URL(pathname, this.base);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    const res = await fetch(url, { signal: AbortSignal.timeout(timeout) });
    if (!res.ok) throw new BinancePrivateError(`HTTP ${res.status}`, { status: res.status, endpoint: pathname });
    return res.json();
  }

  // ── 연결 확인 / 계정 ─────────────────────────────────────────

  /** API 키 유효성 + 지갑 권한 확인 */
  async verify() {
    const account = await this.signedRequest('GET', '/fapi/v2/account');
    return {
      canTrade: Boolean(account.canTrade),
      canDeposit: Boolean(account.canDeposit),
      totalWalletBalance: Number(account.totalWalletBalance ?? 0),
      availableBalance: Number(account.availableBalance ?? 0),
      positionMode: account.positionSide === 'BOTH' ? 'one-way' : 'hedge',
      serverTime: account.updateTime ?? null,
    };
  }

  /** USDT 잔고 */
  async fetchBalance() {
    const account = await this.signedRequest('GET', '/fapi/v2/account');
    const usdt = (account.assets ?? []).find((a) => a.asset === 'USDT');
    return {
      walletBalance: Number(usdt?.walletBalance ?? 0),
      availableBalance: Number(usdt?.availableBalance ?? 0),
      unrealizedProfit: Number(usdt?.unrealizedProfit ?? 0),
      marginBalance: Number(usdt?.marginBalance ?? 0),
      positionMode: account.positionSide === 'BOTH' ? 'one-way' : 'hedge',
    };
  }

  /** 현재 열린 포지션 (순수 롱 전략이므로 LONG/BOTH 만) */
  async fetchPositions() {
    const rows = await this.signedRequest('GET', '/fapi/v2/positionRisk');
    return rows
      .filter((r) => Number(r.positionAmt) !== 0)
      .map((r) => ({
        symbol: r.symbol,
        positionAmt: Number(r.positionAmt),
        entryPrice: Number(r.entryPrice),
        markPrice: Number(r.markPrice),
        unRealizedProfit: Number(r.unRealizedProfit),
        leverage: Number(r.leverage),
        positionSide: r.positionSide,
      }));
  }

  // ── 주문 ────────────────────────────────────────────────────

  /**
   * 시장가 마진 매수 (진입)
   * @returns {{orderId:number, symbol:string, avgPrice:number, qty:number, cost:number}}
   */
  async marketBuy(symbol, quantity, { reduceOnly = false, positionSide = null } = {}) {
    return this.#order(symbol, 'BUY', quantity, reduceOnly, positionSide);
  }

  /** 시장가 매도 (청산) */
  async marketSell(symbol, quantity, { reduceOnly = false, positionSide = null } = {}) {
    return this.#order(symbol, 'SELL', quantity, reduceOnly, positionSide);
  }

  async #order(symbol, side, quantity, reduceOnly, positionSide) {
    const qty = this.roundQuantity(symbol, quantity);
    if (!(qty > 0)) throw new BinancePrivateError(`수량이 0이 되어 주문을 취소했습니다 (${symbol}).`, { code: -1013 });

    const order = await this.signedRequest('POST', '/fapi/v1/order', {
      symbol,
      side,
      type: 'MARKET',
      quantity: qty,
      // Hedge 모드에서는 reduceOnly 와 positionSide 를 함께 쓸 수 없다
      reduceOnly: positionSide ? undefined : reduceOnly ? 'true' : 'false',
      positionSide: positionSide ?? undefined,
      newOrderRespType: 'RESULT',
    });

    if (order.status === 'REJECTED' || order.status === 'EXPIRED') {
      throw new BinancePrivateError(`주문이 거절되었습니다: ${order.avgPrice || order.status}`, { code: -2010 });
    }
    if (order.status === 'FILLED' || order.status === 'PARTIALLY_FILLED') {
      const avg = Number(order.avgPrice);
      const executed = Number(order.executedQty);
      if (!(avg > 0) || !(executed > 0)) {
        throw new BinancePrivateError('체결 정보를 확인할 수 없습니다. 포지션을 동기화하세요.', { code: -2010 });
      }
      return {
        orderId: order.orderId,
        symbol: order.symbol,
        side: order.side,
        avgPrice: avg,
        qty: executed,
        cost: avg * executed,
        reduceOnly: order.reduceOnly === true,
        status: order.status,
        fee: Number(order.commission ?? 0),
        feeAsset: order.commissionAsset,
        time: order.updateTime,
      };
    }
    throw new BinancePrivateError(`주문 상태가 예상과 다릅니다: ${order.status}`, { code: -2010 });
  }

  /** 해당 종목의 미체결 주문 ( Hedge 모드에서 reduceOnly 불가 판정에 사용) */
  async fetchOpenOrders(symbol = undefined) {
    const rows = await this.signedRequest('GET', '/fapi/v1/openOrders', symbol ? { symbol } : {});
    return Array.isArray(rows) ? rows : [];
  }

  // ── 거래 규격 (stepSize / minNotional) ──────────────────────

  /** 종목 거래 규격 조회 및 캐시 */
  async loadFilters(symbols = []) {
    if (!this.filters.size) {
      const info = await this.publicRequest('/fapi/v1/exchangeInfo');
      for (const s of info.symbols ?? []) {
        this.filters.set(s.symbol, parseFilters(s));
      }
    }
    if (symbols.length) {
      const info = await this.publicRequest('/fapi/v1/exchangeInfo');
      for (const s of info.symbols ?? []) {
        if (symbols.includes(s.symbol)) this.filters.set(s.symbol, parseFilters(s));
      }
    }
    return this.filters;
  }

  filterFor(symbol) {
    return (
      this.filters.get(symbol) ?? {
        stepSize: 0.001,
        minQty: 0.001,
        minNotional: 5,
        tickSize: 0.01,
      }
    );
  }

  /** stepSize 에 맞춰 수량 내림 (거래소가 거절하는 걸 사전에 방지) */
  roundQuantity(symbol, qty) {
    const f = this.filterFor(symbol);
    if (!(f.stepSize > 0)) return qty;
    const steps = Math.floor(qty / f.stepSize);
    return Number((steps * f.stepSize).toFixed(12));
  }

  /** 주문 가능 여부 사전 검증 */
  validateOrder(symbol, quantity, price) {
    const f = this.filterFor(symbol);
    const errors = [];
    if (quantity < f.minQty) errors.push(`수량 ${quantity} 가 최소 ${f.minQty} 미만`);
    if (price * quantity < f.minNotional) errors.push(`주문금액 ${(price * quantity).toFixed(2)} USDT 가 최소 ${f.minNotional} 미만`);
    return { ok: errors.length === 0, errors, minNotional: f.minNotional, stepSize: f.stepSize };
  }
}

function parseFilters(symbol) {
  const get = (type, key, fallback) => {
    const f = (symbol.filters ?? []).find((x) => x.filterType === type);
    return f ? Number(f[key] ?? f[key.toLowerCase()] ?? fallback) : fallback;
  };
  return {
    stepSize: get('LOT_SIZE', 'stepSize', 0.001),
    minQty: get('LOT_SIZE', 'minQty', 0.001),
    minNotional: get('MIN_NOTIONAL', 'notional', 5),
    tickSize: get('PRICE_FILTER', 'tickSize', 0.01),
  };
}

/** 키가 제대로 들어왔는지 최소한의 형식 검사 (노출 없이) */
export function validateCredentialShape({ apiKey, apiSecret }) {
  const errors = [];
  const key = String(apiKey ?? '').trim();
  const secret = String(apiSecret ?? '').trim();
  if (!key) errors.push('API 키를 입력하세요.');
  if (!secret) errors.push('API 시크릿을 입력하세요.');
  if (key && key.length < 20) errors.push('API 키 형식이 올바르지 않습니다 (너무 짧음).');
  if (secret && secret.length < 20) errors.push('API 시크릿 형식이 올바르지 않습니다 (너무 짧음).');
  if (/[\s"'\\]/.test(key)) errors.push('API 키에 공백이나 특수문자가 포함되어 있습니다.');
  if (/[\s"'\\]/.test(secret)) errors.push('API 시크릿에 공백이나 특수문자가 포함되어 있습니다.');
  return { ok: errors.length === 0, errors };
}

/** 마스킹 — 클라이언트에 보여줄 안전한 표식 */
export function maskKey(key) {
  const k = String(key ?? '');
  if (k.length <= 8) return '•'.repeat(k.length);
  return `${k.slice(0, 4)}${'•'.repeat(Math.max(4, k.length - 8))}${k.slice(-4)}`;
}
