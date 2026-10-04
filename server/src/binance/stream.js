import { WebSocket } from 'ws';

const FSTREAM = process.env.BINANCE_FSTREAM_BASE || 'wss://fstream.binance.com';

/**
 * 자동 재접속을 지원하는 바이낸선 스트림.
 * onMessage(type, payload) 로 이벤트를 넘기고, 연결 상태를 onStatus 로 알린다.
 */
export class BinanceStream {
  constructor({ name, buildPath, onMessage, onStatus }) {
    this.name = name;
    this.buildPath = buildPath;
    this.onMessage = onMessage;
    this.onStatus = onStatus ?? (() => {});
    this.ws = null;
    this.closedByUser = false;
    this.intentionalClose = false;
    this.retry = 0;
    this.heartbeatTimer = null;
    this.lastMessageAt = 0;
  }

  get connected() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  open() {
    this.closedByUser = false;
    this.#connect();
  }

  #connect() {
    if (this.closedByUser) return;
    const path = this.buildPath();
    if (!path) return; // 구독할 스트림 없음

    this.onStatus({ stream: this.name, state: this.retry === 0 ? 'connecting' : 'reconnecting' });
    const ws = new WebSocket(path, { handshakeTimeout: 15_000 });
    this.ws = ws;
    this.intentionalClose = false;

    ws.on('open', () => {
      this.retry = 0;
      this.lastMessageAt = Date.now();
      this.onStatus({ stream: this.name, state: 'open' });

      // 30분 ping (바이낸스 연결 유지 규약)
      this.heartbeatTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.ping();
      }, 30 * 60 * 1000);
    });

    ws.on('message', (raw) => {
      this.lastMessageAt = Date.now();
      let frame;
      try {
        frame = JSON.parse(raw.toString());
      } catch {
        return;
      }
      // combined stream → { stream, data }
      const payload = frame?.data ?? frame;
      try {
        this.onMessage(payload);
      } catch (err) {
        console.error(`[stream:${this.name}] 메시지 처리 오류:`, err.message);
      }
    });

    const handleDown = (label) => () => {
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.closedByUser) {
        this.onStatus({ stream: this.name, state: 'closed' });
        return;
      }
      this.retry += 1;
      const delay = Math.min(30_000, 1_000 * 2 ** Math.min(this.retry, 5));
      console.warn(`[stream:${this.name}] ${label} → ${delay / 1000}초 후 재접속 시도 (${this.retry}회)`);
      this.onStatus({ stream: this.name, state: 'reconnecting', inMs: delay });
      setTimeout(() => this.#connect(), delay);
    };

    ws.on('close', handleDown('연결 종료'));
    ws.on('error', (err) => {
      // 구독 대상 변경으로 핸드셰이크 도중 의도적으로 닫은 경우는 오류가 아니다
      if (this.intentionalClose) return;
      console.error(`[stream:${this.name}] 오류:`, err.message);
    });
  }

  close() {
    this.closedByUser = true;
    this.intentionalClose = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.ws?.close();
    this.ws = null;
  }
}

/**
 * 여러 후보 스트림을 순차적으로 시도하는 스트림.
 *
 * 이유: 네트워크/지역 환경에 따라 바이낸스의 일부 스트림이
 * "handshake 는 성공하지만 데이터를 전혀 보내지 않는" 경우가 있다.
 * (예: fstream 의 @aggTrade, !ticker@arr, @kline_1m)
 * probeMs 안에 메시지가 하나도 오지 않으면 다음 후보로 자동 전환한다.
 */
export class ResilientStream {
  /**
   * @param {object} opts
   * @param {string} opts.name
   * @param {Array<{id:string, build:(ctx:any)=>string|null, handle:(payload:any, ctx:any)=>void}>} opts.specs
   * @param {number} [opts.probeMs] 데이터 미수신 시 다음 후보로 전환까지의 시간
   */
  constructor({ name, specs, probeMs = 12_000, onStatus }) {
    this.name = name;
    this.specs = specs;
    this.probeMs = probeMs;
    this.onStatus = onStatus ?? (() => {});
    this.index = 0;
    this.ctx = null;
    this.inner = null;
    this.probeTimer = null;
    this.received = 0;
    this.activeId = null;
  }

  get spec() {
    return this.specs[this.index];
  }

  /** 구독 대상이 바뀌면 재연결 (같은 스펙이면 그대로 유지) */
  open(ctx) {
    const path = this.spec?.build(ctx);
    if (!path) return; // 구독 대상이 없음
    if (this.activeId === this.spec.id && this.path === path && this.inner?.connected) {
      this.ctx = ctx;
      return;
    }
    this.ctx = ctx;
    this.path = path;
    this.#connect();
  }

  #connect() {
    this.inner?.close();
    clearTimeout(this.probeTimer);

    const spec = this.spec;
    if (!spec) return;

    const path = spec.build(this.ctx);
    if (!path) return;
    this.activeId = spec.id;
    this.received = 0;
    this.onStatus({ stream: this.name, state: 'connecting', specId: spec.id });

    this.inner = new BinanceStream({
      name: this.name,
      buildPath: () => path,
      onStatus: (s) => {
        // 재접속은 같은 스펙 안에서만 반복
        if (s.state === 'open') this.#armProbe();
        this.onStatus({ ...s, specId: spec.id, index: this.index, total: this.specs.length });
      },
      onMessage: (payload) => {
        this.received += 1;
        this.#armProbe();
        try {
          spec.handle(payload, this.ctx);
        } catch (err) {
          console.error(`[stream:${this.name}] ${spec.id} 처리 오류:`, err.message);
        }
      },
    });
    this.inner.open();
    this.#armProbe();
  }

  #armProbe() {
    clearTimeout(this.probeTimer);
    this.probeTimer = setTimeout(() => {
      if (this.received > 0) return; // 데이터가 오고 있으면 정상
      const nextIndex = this.index + 1;
      if (nextIndex < this.specs.length) {
        console.warn(`[stream:${this.name}] '${this.spec.id}' 스트림이 데이터를 보내지 않아 '${this.specs[nextIndex].id}'로 전환합니다.`);
        this.index = nextIndex;
        this.onStatus({ stream: this.name, state: 'fallback', specId: this.spec.id });
        this.#connect();
      } else {
        console.error(`[stream:${this.name}] 모든 후보 스트림이 무응답입니다. REST 폴링으로 대체됩니다.`);
        this.onStatus({ stream: this.name, state: 'silent', specId: this.spec.id, exhausted: true });
        // 마지막 후보로 되돌아와 주기적으로 재시도
        this.index = 0;
        this.probeTimer = setTimeout(() => this.#connect(), 60_000);
      }
    }, this.probeMs);
  }

  close() {
    clearTimeout(this.probeTimer);
    this.inner?.close();
    this.inner = null;
    this.activeId = null;
  }
}
