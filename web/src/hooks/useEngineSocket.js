import { useCallback, useEffect, useRef, useState } from 'react';
import { getAuthToken } from '../lib/api.js';

/**
 * 서버 WebSocket 연결을 관리한다.
 *  states: 계정별 스냅샷 맵 { accountId: state }
 *  live  : 실시간 가격 (4Hz, 전 계정 공유 — 비밀정보 없음)
 *  toasts: 거래 이벤트 알림 (accountId 포함)
 *
 * @param {string|null} token 세션 토큰. 없으면 연결하지 않는다.
 */
export function useEngineSocket(token) {
  const [states, setStates] = useState({});
  const [live, setLive] = useState({});
  const [toasts, setToasts] = useState([]);
  const [connected, setConnected] = useState(false);
  const [authError, setAuthError] = useState(false);

  const wsRef = useRef(null);
  const retryRef = useRef(0);
  const timerRef = useRef(null);
  const idRef = useRef(0);

  const pushToast = useCallback((toast) => {
    const id = ++idRef.current;
    setToasts((prev) => [...prev.slice(-9), { ...toast, id }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 7000);
  }, []);

  useEffect(() => {
    let disposed = false;
    setAuthError(false);

    if (!token) {
      setConnected(false);
      setStates({});
      return undefined;
    }

    const connect = () => {
      if (disposed) return;
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(getAuthToken() || token)}`);
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
            if (msg.accountId) {
              setStates((prev) => ({ ...prev, [msg.accountId]: msg.data }));
            }
            break;
          case 'live':
            setLive(msg.data.prices ?? {});
            break;
          case 'toast':
            pushToast(msg.data);
            break;
          default:
            break;
        }
      };

      ws.onclose = (event) => {
        setConnected(false);
        if (disposed) return;
        // 4401 = 인증 실패 → 재시도해도 소용없으므로 중단
        if (event.code === 4401) {
          setAuthError(true);
          return;
        }
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
  }, [token, pushToast]);

  return { states, live, toasts, connected, authError, pushToast };
}
