import { useState } from 'react';
import { api, setAuthToken, setActiveAccount } from '../lib/api.js';

/**
 * 로그인 + 최초 마스터 설정 화면.
 * onDone({ user, accounts, defaultAccountId, token }) 호출 후 App 이 세션을 이어받는다.
 */
export function AuthScreen({ setupRequired, onDone, pushToast }) {
  const [mode] = useState(setupRequired ? 'setup' : 'login');
  const [name, setName] = useState(setupRequired ? 'master' : '');
  const [password, setPassword] = useState('');
  const [password2, setPassword2] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const submit = async (e) => {
    e?.preventDefault?.();
    setError(null);
    if (mode === 'setup' && password !== password2) {
      setError('비밀번호 확인이 일치하지 않습니다.');
      return;
    }
    if (!name.trim() || !password) {
      setError('이름과 비밀번호를 입력하세요.');
      return;
    }
    setBusy(true);
    try {
      let res;
      if (mode === 'setup') {
        const created = await api.authSetup({ name: name.trim(), password });
        // setup 은 토큰을 주지 않으므로 즉시 로그인
        res = await api.login({ name: created.user.name, password });
        pushToast?.({ level: 'info', text: `마스터 계정 "${res.user.name}" 을 만들었습니다. 기존 데이터가 있으면 기본 계정으로 승계됩니다.` });
      } else {
        res = await api.login({ name: name.trim(), password });
      }
      setAuthToken(res.token);
      setActiveAccount(res.defaultAccountId ?? res.accounts?.[0]?.id ?? '');
      onDone({ ...res });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="boot">
      <div className="auth-card">
        <div className="brand-mark big">◈</div>
        <h1>Coin Surfer</h1>
        <p className="auth-sub">
          {mode === 'setup' ? '처음 실행입니다. 마스터 계정을 만드세요.' : '로그인하세요.'}
        </p>

        <form onSubmit={submit} className="auth-form">
          <label>
            <span>이름</span>
            <input
              type="text"
              value={name}
              autoComplete="username"
              placeholder={mode === 'setup' ? 'master' : '사용자 이름'}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label>
            <span>비밀번호{mode === 'setup' ? ' (8자 이상)' : ''}</span>
            <input
              type="password"
              value={password}
              autoComplete={mode === 'setup' ? 'new-password' : 'current-password'}
              placeholder="비밀번호"
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          {mode === 'setup' ? (
            <label>
              <span>비밀번호 확인</span>
              <input
                type="password"
                value={password2}
                autoComplete="new-password"
                placeholder="다시 입력"
                onChange={(e) => setPassword2(e.target.value)}
              />
            </label>
          ) : null}

          {error ? <div className="banner banner-error">{error}</div> : null}

          <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
            {busy ? '처리 중…' : mode === 'setup' ? '마스터 계정 만들기' : '로그인'}
          </button>
        </form>

        {mode === 'setup' ? (
          <p className="auth-note">
            마스터는 모든 계정의 현황·로그를 보고 사용자를 관리할 수 있습니다.
            <br />
            기존 단일 계정 데이터가 있으면 마스터의 기본 계정으로 자동 승계됩니다.
          </p>
        ) : null}
      </div>
    </div>
  );
}
