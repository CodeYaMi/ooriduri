import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { fmtPct, fmtSignedUsd, fmtUsd, pnlClass } from '../lib/format.js';

const EVENT_LABEL = { buy: '매수', sell: '매도', error: '오류', settings: '설정', account: '계정', system: '시스템' };

function timeStr(ts) {
  try {
    return new Date(ts).toLocaleString('ko-KR', { hour12: false });
  } catch {
    return '—';
  }
}

/**
 * 마스터 전용 패널: 전체 현황 · 거래계정 관리 · 전체 로그.
 * 로그인 회원 관리는 별도 UserManager 창에서 한다.
 * regular 사용자에게는 렌더링하지 않는다 (서버도 403으로 차단).
 */
export function MasterPanel({ open, onClose, pushToast }) {
  const [tab, setTab] = useState('overview');
  const [overview, setOverview] = useState([]);
  const [users, setUsers] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [events, setEvents] = useState([]);
  const [busy, setBusy] = useState(false);

  // 생성 폼
  const [newAccount, setNewAccount] = useState({ name: '', ownerUserId: '' });
  // 로그 필터
  const [flt, setFlt] = useState({ accountId: '', type: '', q: '', limit: 200 });

  const refreshAll = useCallback(async () => {
    setBusy(true);
    try {
      const [ov, us, ac] = await Promise.all([api.adminOverview(), api.listUsers(), api.listTradingAccounts()]);
      setOverview(ov.accounts ?? []);
      setUsers(us.users ?? []);
      setAccounts(ac.accounts ?? []);
    } catch (err) {
      pushToast({ level: 'warn', text: `불러오기 실패: ${err.message}` });
    } finally {
      setBusy(false);
    }
  }, [pushToast]);

  useEffect(() => {
    if (open) {
      setTab('overview');
      refreshAll();
      loadEvents();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open ]);

  const loadEvents = useCallback(
    async (override = {}) => {
      try {
        const res = await api.adminEvents({ ...flt, ...override });
        setEvents(res.events ?? []);
      } catch (err) {
        pushToast({ level: 'warn', text: `로그 조회 실패: ${err.message}` });
      }
    },
    [flt, pushToast],
  );

  if (!open) return null;

  const run = async (fn, okMsg) => {
    try {
      await fn();
      if (okMsg) pushToast({ level: 'info', text: okMsg });
      await refreshAll();
    } catch (err) {
      pushToast({ level: 'warn', text: err.message });
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal modal-wide" role="dialog" aria-modal="true" aria-label="마스터 패널">
        <div className="modal-head">
          <div>
            <h2>마스터 패널</h2>
            <p>전 계정 현황 · 거래계정 관리 · 전체 로그 (회원 관리는 별도 창, API 시크릿 원문은 표시되지 않습니다)</p>
          </div>
          <button className="btn btn-ghost btn-icon" onClick={onClose} aria-label="닫기">
            ✕
          </button>
        </div>

        <div className="tabs">
          {[
            ['overview', '전체 현황'],
            ['accounts', '거래계정'],
            ['events', '전체 로그'],
          ].map(([id, label]) => (
            <button key={id} className={tab === id ? 'on' : ''} onClick={() => { setTab(id); if (id === 'events') loadEvents(); }}>
              {label}
            </button>
          ))}
          <div className="spacer" />
          <button className="btn btn-sm btn-ghost" onClick={refreshAll} disabled={busy}>
            {busy ? '새로고침 중…' : '↻ 새로고침'}
          </button>
        </div>

        <div className="modal-body">
          {tab === 'overview' ? (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th className="left">거래계정</th>
                    <th className="left">소유자</th>
                    <th className="center">모드</th>
                    <th className="center">상태</th>
                    <th className="right">자산</th>
                    <th className="right">총 손익</th>
                    <th className="center">보유/거래</th>
                    <th className="right">승률</th>
                    <th className="right">후보</th>
                  </tr>
                </thead>
                <tbody>
                  {overview.map((a) => (
                    <tr key={a.id}>
                      <td className="left">
                        <strong>{a.name}</strong>
                        <small className="dim block">{a.id}</small>
                      </td>
                      <td className="left">{a.ownerName}</td>
                      <td className="center">
                        <span className={`badge badge-${a.mode}`}>
                          {a.mode === 'live' ? (a.network === 'production' ? '실거래' : '테스트넷') : '가상'}
                          {a.dryRun ? '·시뮬' : ''}
                        </span>
                      </td>
                      <td className="center">
                        {a.disabled ? (
                          <span className="badge badge-stop-loss">정지</span>
                        ) : (
                          <span className="badge badge-ready">{a.running ? '가동' : '중지'}</span>
                        )}
                      </td>
                      <td className="right mono">{a.equity !== null ? fmtUsd(a.equity) : '—'}</td>
                      <td className={`right mono ${pnlClass(a.totalPnl ?? 0)}`}>
                        {a.totalPnl !== null ? `${fmtSignedUsd(a.totalPnl)} (${fmtPct(a.totalPnlPct ?? 0)})` : '—'}
                      </td>
                      <td className="center mono">
                        {a.openCount}/{a.tradeCount}
                      </td>
                      <td className="right mono">{a.winRate}%</td>
                      <td className="right mono">{a.candidates}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {overview.length === 0 ? <div className="empty-state small"><p>거래 계정이 없습니다.</p></div> : null}
            </div>
          ) : null}

          {tab === 'accounts' ? (
            <>
              <div className="inline-form">
                <input
                  type="text"
                  placeholder="새 거래계정 이름"
                  value={newAccount.name}
                  onChange={(e) => setNewAccount((p) => ({ ...p, name: e.target.value }))}
                />
                <select value={newAccount.ownerUserId} onChange={(e) => setNewAccount((p) => ({ ...p, ownerUserId: e.target.value }))}>
                  <option value="">소유자 선택…</option>
                  {users.filter((u) => !u.disabled).map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name} ({u.role})
                    </option>
                  ))}
                </select>
                <button
                  className="btn btn-primary btn-sm"
                  onClick={() =>
                    run(
                      () => api.createTradingAccount({ name: newAccount.name || '기본', ownerUserId: newAccount.ownerUserId || undefined }).then(() => setNewAccount({ name: '', ownerUserId: '' })),
                      '거래 계정을 만들었습니다.',
                    )
                  }
                >
                  만들기
                </button>
              </div>
              <div className="table-wrap">
                <table className="table compact">
                  <thead>
                    <tr>
                      <th className="left">이름</th>
                      <th className="left">소유자</th>
                      <th className="center">모드</th>
                      <th className="center">보유</th>
                      <th className="center">정지</th>
                      <th className="right">관리</th>
                    </tr>
                  </thead>
                  <tbody>
                    {accounts.map((a) => (
                      <tr key={a.id}>
                        <td className="left"><strong>{a.name}</strong></td>
                        <td className="left">{a.ownerName ?? a.ownerUserId ?? '—'}</td>
                        <td className="center">{a.mode === 'live' ? '실거래' : '가상'}</td>
                        <td className="center mono">{a.openCount}</td>
                        <td className="center">
                          <label className="switch switch-sm">
                            <input
                              type="checkbox"
                              checked={Boolean(a.disabled)}
                              onChange={(e) =>
                                run(() => api.setTradingAccountDisabled(a.id, e.target.checked), e.target.checked ? '계정을 정지했습니다.' : '계정을 재개했습니다.')
                              }
                            />
                            <i />
                          </label>
                        </td>
                        <td className="right">
                          <button
                            className="btn btn-xs btn-ghost"
                            onClick={() => {
                              const name = window.prompt('새 이름', a.name);
                              if (name) run(() => api.renameTradingAccount(a.id, name), '이름을 변경했습니다.');
                            }}
                          >
                            이름
                          </button>{' '}
                          <button
                            className="btn btn-xs btn-sell"
                            onClick={() => {
                              if (window.confirm(`"${a.name}" 계정을 삭제할까요? 보유 포지션이 있으면 삭제되지 않습니다.`)) {
                                run(() => api.deleteTradingAccount(a.id), '계정을 삭제했습니다.');
                              }
                            }}
                          >
                            삭제
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : null}

          {tab === 'events' ? (
            <>
              <div className="inline-form">
                <select value={flt.accountId} onChange={(e) => { const v = e.target.value; setFlt((p) => ({ ...p, accountId: v })); loadEvents({ accountId: v }); }}>
                  <option value="">전체 계정</option>
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name} ({a.ownerName ?? ''})
                    </option>
                  ))}
                </select>
                <select value={flt.type} onChange={(e) => { const v = e.target.value; setFlt((p) => ({ ...p, type: v })); loadEvents({ type: v }); }}>
                  <option value="">전체 유형</option>
                  {Object.entries(EVENT_LABEL).map(([k, v]) => (
                    <option key={k} value={k}>{v}</option>
                  ))}
                </select>
                <input
                  type="text"
                  placeholder="검색어"
                  value={flt.q}
                  onChange={(e) => setFlt((p) => ({ ...p, q: e.target.value }))}
                  onKeyDown={(e) => { if (e.key === 'Enter') loadEvents(); }}
                />
                <button className="btn btn-sm" onClick={() => loadEvents()}>조회</button>
              </div>
              <div className="table-wrap tall">
                <table className="table compact">
                  <thead>
                    <tr>
                      <th className="left">시각</th>
                      <th className="left">계정</th>
                      <th className="left">유형</th>
                      <th className="left">내용</th>
                      <th className="left">행위자</th>
                    </tr>
                  </thead>
                  <tbody>
                    {events.map((e, i) => (
                      <tr key={`${e.ts}-${i}`}>
                        <td className="left mono dim">{timeStr(e.ts)}</td>
                        <td className="left">{e.accountName ?? e.accountId}</td>
                        <td className="left">
                          <span className={`badge badge-${e.type === 'error' ? 'stop-loss' : e.type === 'buy' ? 'ready' : e.type === 'sell' ? 'take-profit' : 'manual'}`}>
                            {EVENT_LABEL[e.type] ?? e.type}
                          </span>
                        </td>
                        <td className="left event-msg">{e.msg}</td>
                        <td className="left dim">{e.actor ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {events.length === 0 ? <div className="empty-state small"><p>로그가 없습니다.</p></div> : null}
              </div>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
