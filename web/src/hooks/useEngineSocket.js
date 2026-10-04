import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * 서버 WebSocket 연결을 관리한다.
 *  state : 서버 스냅샷 (1Hz)
 *  live  : 실시간 가격 (4Hz) — 흐름 있는 UI용
 *  toasts: 거래 이벤트 알림
 */
export function useEngineSocket() {
  const [state, setState] = useState(null);
  const [live, setLive] = useState({});
  const [toasts, setToasts] = useState([]);
  const [connected, setConnected] = useState(false);

  const wsRef = useRef(null);
  const retryRef = useRef(0);
  const timerRef = useRef(null);
  const toastsRef = useRef([]);
  const idRef = useRef(0);

  const pushToast = useCallback((toast) => {
    const id = ++idRef.current;
    setToasts((prev) => [...prev.slice(-4), { ...toast, id }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 7000);
  }, []);

  useEffect(() => {
    let disposed = false;

    const connect = () => {
      if (disposed) return;
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${location.host}/ws`);
      wsRef.current = ws;

      ws.onopen = () => {
        setConnected(true);
        retryRef.current = 0;
      };

      ws.onmessage = (event) => {
        let msg;
        try {
          msg = JSON.parse(event.data);
        } catch {
          return;
        }
        switch (msg.type) {
          case 'state':
            setState(msg.data);
            break;
          case 'live':
            setLive(msg.data.prices ?? {});
            break;
          case 'toast':
            pushToast(msg.data);
            break;
          case 'status':
            setState((prev) => (prev ? { ...prev, status: msg.data } : prev));
            break;
          case 'settings':
            setState((prev) => (prev ? { ...prev, settings: msg.data } : prev));
            break;
          default:
            break;
        }
      };

      ws.onclose = () => {
        setConnected(false);
        if (disposed) return;
        retryRef.current += 1;
        const delay = Math.min(8000, 600 * 2 ** Math.min(retryRef.current, 4));
        timerRef.current = setTimeout(connect, delay);
      };

      ws.onerror = () => ws.close();
    };

    connect();
    return () => {
      disposed = true;
      clearTimeout(timerRef.current);
      wsRef.current?.close();
    };
  }, [pushToast]);

  return { state, live, toasts, connected, pushToast };
}
