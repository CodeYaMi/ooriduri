import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api.js';

/**
 * 로그인 회원 관리 창 (마스터 전용, 별도 창).
 * 사용자 생성 · 비밀번호 변경 · 정지/활성 · 삭제.
 * 서버도 마스터만 허용한다 (403).
 */
export function UserManager({ open, onClose, pushToast, myUserId, onChanged }) {
  const [users, setUsers] = useState([]);
  const [busy, setBusy] = useState(false);
  const [newUser, setNewUser] = useState({ name: '', password: '', role: 'user' });

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      const us = await api.listUsers();
      setUsers(us.users ?? []);
    } catch (err) {
      pushToast({ level: 'warn', text: `불러오기 실패: ${err.message}` });
    } finally {
      setBusy(false);
    }
  }, [pushToast]);

  useEffect(() => {
    if (open) {
      setNewUser({ name: '', password: '', role: 'user' });
      refresh();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open ]);

  if (!open) return null;

  const run = async (fn, okMsg) => {
    try {
      await fn();
      if (okMsg) pushToast({ level: 'info', text: okMsg });
      await refresh();
      onChanged?.();
    } catch (err) {
      pushToast({ level: 'warn', text: err.message });
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal modal-wide" role="dialog" aria-modal="true" aria-label="로그인 회원 관리">
        <div className="modal-head">
          <div>
            <h2>로그인 회원 관리</h2>
            <p>사용자 생성 · 비밀번호 변경 · 정지 · 삭제 (본인·마지막 마스터 보호)</p>
          </div>
          <button className="btn btn-ghost btn-icon" onClick={onClose} aria-label="닫기">
            ✕
          </button>
        </div>

        <div className="modal-body">
          <div className="inline-form">
            <input type="text" placeholder="이름" value={newUser.name} onChange={(e) => setNewUser((p) => ({ ...p, name: e.target.value }))} />
            <input
              type="password"
              placeholder="비밀번호 (8자 이상)"
              value={newUser.password}
              autoComplete="new-password"
              onChange={(e) => setNewUser((p) => ({ ...p, password: e.target.value }))}
            />
            <select value={newUser.role} onChange={(e) => setNewUser((p) => ({ ...p, role: e.target.value }))}>
              <option value="user">일반</option>
              <option value="master">마스터</option>
            </select>
            <button
              className="btn btn-primary btn-sm"
              onClick={() =>
                run(
                  () => api.createUser(newUser).then(() => setNewUser({ name: '', password: '', role: 'user' })),
                  '사용자를 만들었습니다 (기본 거래계정 포함).',
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
                  <th className="center">권한</th>
                  <th className="center">계정 수</th>
                  <th className="center">상태</th>
                  <th className="right">관리</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id}>
                    <td className="left">
                      <strong>{u.name}</strong>
                      {u.id === myUserId ? <small className="dim"> (나)</small> : null}
                    </td>
                    <td className="center">
                      <span className={`badge badge-${u.role}`}>{u.role === 'master' ? '마스터' : '일반'}</span>
                    </td>
                    <td className="center mono">{u.accountCount}</td>
                    <td className="center">{u.disabled ? <span className="badge badge-stop-loss">정지</span> : <span className="badge badge-ready">활성</span>}</td>
                    <td className="right">
                      <button
                        className="btn btn-xs"
                        disabled={u.id === myUserId}
                        onClick={() => {
                          const pw = window.prompt(`${u.name} 의 새 비밀번호 (8자 이상)`);
                          if (pw) run(() => api.resetUserPassword(u.id, pw), '비밀번호를 변경했습니다.');
                        }}
                      >
                        비번 변경
                      </button>{' '}
                      <button
                        className="btn btn-xs"
                        disabled={u.id === myUserId}
                        onClick={() => run(() => api.setUserDisabled(u.id, !u.disabled), u.disabled ? '활성화했습니다.' : '정지했습니다.')}
                      >
                        {u.disabled ? '활성화' : '정지'}
                      </button>{' '}
                      <button
                        className="btn btn-xs btn-sell"
                        disabled={u.id === myUserId}
                        onClick={() => {
                          if (window.confirm(`"${u.name}" 사용자를 삭제할까요? 보유 계정은 정지됩니다.`)) {
                            run(() => api.deleteUser(u.id), '사용자를 삭제했습니다.');
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
            {users.length === 0 && !busy ? <div className="empty-state small"><p>사용자가 없습니다.</p></div> : null}
          </div>
        </div>
      </div>
    </div>
  );
}
