import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api.js';

const EVENT_LABEL = { buy: '매수', sell: '매도', error: '오류', settings: '설정', account: '계정', system: '시스템' };

function timeStr(ts) {
  try {
    return new Date(ts).toLocaleTimeString('ko-KR', { hour12: false });
  } catch {
    return '—';
  }
}

/** 활성 거래 계정의 이벤트 로그 (본인 계정만 — 서버에서 강제) */
export function EventLog({ accountId }) {
  const [events, setEvents] = useState([]);
  const [type, setType] = useState('');
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!accountId) return;
    setLoading(true);
    try {
      const res = await api.myEvents({ type: type || undefined, limit: 60 });
      setEvents(res.events ?? []);
    } catch {
      setEvents([]);
    } finally {
      setLoading(false);
    }
  }, [accountId, type]);

  useEffect(() => {
    load();
    const id = setInterval(load, 15_000);
    return () => clearInterval(id);
  }, [load]);

  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <h2>이벤트 로그</h2>
          <p>매수·매도·설정 변경·오류 기록</p>
        </div>
        <div className="panel-head-right">
          <select className="select-sm" value={type} onChange={(e) => setType(e.target.value)}>
            <option value="">전체</option>
            {Object.entries(EVENT_LABEL).map(([k, v]) => (
              <option key={k} value={k}>{v}</option>
            ))}
          </select>
          <button className="btn btn-sm btn-ghost" onClick={load} disabled={loading}>
            {loading ? '…' : '↻'}
          </button>
        </div>
      </div>

      {events.length === 0 ? (
        <div className="empty-state small">
          <div className="empty-icon">◷</div>
          <p>기록된 이벤트가 없습니다.</p>
        </div>
      ) : (
        <div className="table-wrap tall">
          <table className="table compact">
            <thead>
              <tr>
                <th className="left">시각</th>
                <th className="left">유형</th>
                <th className="left">내용</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e, i) => (
                <tr key={`${e.ts}-${i}`}>
                  <td className="left mono dim">{timeStr(e.ts)}</td>
                  <td className="left">
                    <span className={`badge badge-${e.type === 'error' ? 'stop-loss' : e.type === 'buy' ? 'ready' : e.type === 'sell' ? 'take-profit' : 'manual'}`}>
                      {EVENT_LABEL[e.type] ?? e.type}
                    </span>
                  </td>
                  <td className="left event-msg">
                    {e.msg}
                    {e.actor ? <small className="dim"> · {e.actor}</small> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
