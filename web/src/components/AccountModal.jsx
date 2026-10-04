import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { fmtSignedUsd, fmtUsd } from '../lib/format.js';

/**
 * 계정 / 실거래 설정 화면.
 *
 * 보안
 *  - API 시크릿은 이 화면에 다시 표시되지 않는다 (마스킹만)
 *  - 저장·검증 요청만 전송되고, 시크릿은 서버 파일(권한 600)에만 보관된다
 *  - 실거래 전환은 별도 확인 + "무장" 상태를 거쳐야 한다
 */
export function AccountModal({ open, account, onClose, onChanged, pushToast }) {
  const [network, setNetwork] = useState('testnet');
  const [apiKey, setApiKey] = useState('');
  const [apiSecret, setApiSecret] = useState('');
  const [showSecret, setShowSecret] = useState(false);
  const [info, setInfo] = useState(null);
  const [busy, setBusy] = useState(null);
  const [errors, setErrors] = useState([]);
  const [liveConfirm, setLiveConfirm] = useState(false);
  const [liveTyped, setLiveTyped] = useState('');

  // /api/account 응답(info)이 가장 최신·권위 있는 상태다.
  // WS 스냅샷(account prop)은 연결 여부가 아니라 브로커 세션만 보여줄 수 있다.
  const saved = info?.connected ?? account?.connected ?? false;
  const live = info?.liveActive ?? account?.liveActive ?? false;
  const dryRun = info?.dryRun ?? account?.dryRun ?? false;
  const networkOf = info?.network ?? account?.network ?? null;
  const isProdAccount = networkOf === 'production';

  /** 현재 선택된 모드 — 주문 시뮬레이션 여부까지 구분 */
  const mode = live ? (dryRun ? 'live-dry' : 'live') : 'paper';

  useEffect(() => {
    if (!open) return;
    setErrors([]);
    setLiveConfirm(false);
    setLiveTyped('');
    setApiKey('');
    setApiSecret('');
    api
      .getAccount()
      .then((r) => {
        setInfo(r);
        // 저장된 키의 네트워크를 선택 상태에 반영
        if (r?.network) setNetwork(r.network);
      })
      .catch(() => setInfo(account));
    // account prop 은 WS 스냅샷마다 새 객체이므로 의존성으로 두면
    // 사용자가 작성 중인 확인 입력이 매초 초기화된다. 열릴 때만 초기화한다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  const isTestnet = network === 'testnet';

  const run = async (key, fn, { after } = {}) => {
    setBusy(key);
    setErrors([]);
    try {
      const res = await fn();
      if (after) after(res);
      return res;
    } catch (err) {
      setErrors([err.message]);
      return null;
    } finally {
      setBusy(null);
    }
  };

  const refresh = () => api.getAccount().then(setInfo).catch(() => {});

  const handleVerify = () =>
    run('verify', () => api.verifyCredentials({ apiKey, apiSecret, network }), {
      after: (r) => {
        setInfo((p) => ({ ...p, preview: r }));
        pushToast({
          level: 'info',
          text: `연결 확인 성공 · 지갑 ${fmtUsd(r.totalWalletBalance)} USDT · 거래 권한 ${r.canTrade ? '있음' : '없음'}`,
        });
      },
    });

  const handleSave = () =>
    run('save', () => api.saveCredentials({ apiKey, apiSecret, network }), {
      after: () => {
        setApiKey('');
        setApiSecret('');
        refresh();
        onChanged?.();
        pushToast({ level: 'info', text: 'API 키를 저장했습니다. 이제 연결할 수 있습니다.' });
      },
    });

  const handleConnectPaper = () =>
    run('paper', () => api.connect('paper', false), {
      after: () => {
        refresh();
        onChanged?.();
        pushToast({ level: 'info', text: '계정에 연결했습니다 (가상 모드 유지).' });
      },
    });

  /** 모드 카드 클릭 처리 — 주문 시뮬레이션은 확인 없이 전환 */
  const handleModePaper = () => {
    if (mode === 'paper') return;
    return handleConnectPaper();
  };

  const handleModeDry = () =>
    run('dry', () => api.connect('live', false, true), {
      after: () => {
        refresh();
        onChanged?.();
        pushToast({ level: 'info', text: '주문 시뮬레이션 모드로 전환했습니다. 주문은 넣지 않습니다.' });
      },
    });

  const handleToggleDryRun = (enabled) =>
    run('toggleDry', () => api.setDryRun(enabled), {
      after: () => {
        refresh();
        onChanged?.();
      },
    });

  const handleConnectLive = () => {
    if (liveTyped !== '실거래') {
      setErrors(['확인을 위해 정확히 "실거래" 를 입력하세요.']);
      return;
    }
    setLiveConfirm(false);
    return run('live', () => api.connect('live', true, false), {
      after: () => {
        setLiveTyped('');
        refresh();
        onChanged?.();
        pushToast({ level: 'warn', text: '실거래 모드로 전환했습니다. 실제 주문이 발생합니다.' });
      },
    });
  };

  const handleDisconnect = () =>
    run('disconnect', () => api.disconnect(), {
      after: () => {
        refresh();
        onChanged?.();
      },
    });

  const handleDelete = () => {
    if (!window.confirm('저장된 API 키를 삭제할까요? 삭제하면 실거래를 사용할 수 없습니다.')) return;
    return run('delete', () => api.deleteCredentials(), {
      after: () => {
        setInfo(null);
        onChanged?.();
        pushToast({ level: 'info', text: '저장된 API 키를 삭제했습니다.' });
      },
    });
  };

  const handleBalance = () =>
    run('balance', () => api.refreshBalance(), {
      after: () => {
        refresh();
        pushToast({ level: 'info', text: '잔고를 갱신했습니다.' });
      },
    });

  const handleSync = () =>
    run('sync', () => api.syncPositions(), {
      after: () => {
        refresh();
        onChanged?.();
        pushToast({ level: 'info', text: '거래소 포지션과 동기화했습니다.' });
      },
    });

  const balance = account?.balance ?? info?.balance;

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal modal-wide" role="dialog" aria-modal="true" aria-label="계정 설정">
        <div className="modal-head">
          <div>
            <h2>계정 및 실거래 설정</h2>
            <p>바이낸스 API 키를 연결해 실제 주문을 넣을 수 있습니다. 기본은 테스트넷입니다.</p>
          </div>
          <button className="btn btn-ghost btn-icon" onClick={onClose} aria-label="닫기">
            ✕
          </button>
        </div>

        <div className="modal-body">
          {/* ── 현재 모드 배너 ── */}
          <div className={`mode-banner ${mode === 'live' ? (isProdAccount ? 'danger' : 'live') : mode === 'live-dry' ? 'dry' : 'paper'}`}>
            <div className="mode-banner-main">
              <span className="mode-dot" />
              <div>
                <strong>
                  {mode === 'live'
                    ? isProdAccount
                      ? '실거래 모드 — 실제 자금이 움직입니다'
                      : '실거래 모드 (테스트넷) — 가상 자금'
                    : mode === 'live-dry'
                      ? '주문 시뮬레이션 — 실제 계정, 주문 없음'
                      : '가상 모드 — 실제 주문 없음'}
                </strong>
                <small>
                  {live
                    ? `네트워크 ${isProdAccount ? '실계정 (fapi.binance.com)' : '테스트넷 (testnet)'} · 포지션 ${info?.localPositions ?? account?.localPositions ?? 0}종목`
                    : 'API 키를 연결해도 기본은 가상 모드입니다. 실거래는 별도 확인이 필요합니다.'}
                </small>
              </div>
            </div>
            {live ? (
              <button className="btn btn-sm" onClick={handleDisconnect} disabled={Boolean(busy)}>
                가상 모드로 복귀
              </button>
            ) : null}
          </div>

          {balance ? (
            <div className="balance-strip">
              <div>
                <span>지갑 잔고</span>
                <strong>{fmtUsd(balance.walletBalance)}</strong>
              </div>
              <div>
                <span>가용 잔고</span>
                <strong>{fmtUsd(balance.availableBalance)}</strong>
              </div>
              <div>
                <span>미실현 손익</span>
                <strong className={balance.unrealizedProfit >= 0 ? 'up' : 'down'}>{fmtSignedUsd(balance.unrealizedProfit)}</strong>
              </div>
              <button className="btn btn-sm" onClick={handleBalance} disabled={Boolean(busy)}>
                {busy === 'balance' ? '갱신 중…' : '잔고 새로고침'}
              </button>
            </div>
          ) : null}

          {errors.length ? (
            <div className="banner banner-error">
              {errors.map((e) => (
                <div key={e}>{e}</div>
              ))}
            </div>
          ) : null}

          {/* ── 네트워크 선택 ── */}
          <fieldset className="group">
            <legend>
              <span>연결 대상</span>
              <small>실거래는 실제 자금이 사용됩니다. 반드시 테스트넷에서 먼저 검증하세요.</small>
            </legend>

            <div className="network-picker">
              <button
                type="button"
                className={`network-card ${isTestnet ? 'on' : ''}`}
                onClick={() => setNetwork('testnet')}
                disabled={Boolean(live)}
              >
                <div className="network-title">
                  <b>테스트넷</b>
                  {isTestnet ? <span className="badge badge-ready">권장</span> : null}
                </div>
                <code>testnet.binancefuture.com</code>
                <p>가상 자금으로 실제 주문을 넣고 검증합니다. 비용이 들지 않습니다.</p>
              </button>

              <button
                type="button"
                className={`network-card danger ${network === 'production' ? 'on' : ''}`}
                onClick={() => setNetwork('production')}
                disabled={Boolean(live)}
              >
                <div className="network-title">
                  <b>실계정</b>
                  {network === 'production' ? <span className="badge badge-stop-loss">위험</span> : null}
                </div>
                <code>fapi.binance.com</code>
                <p>실제 자금이 이동하며 손실이 발생할 수 있습니다.</p>
              </button>
            </div>
          </fieldset>

          {/* ── API 키 입력 ── */}
          <fieldset className="group">
            <legend>
              <span>API 키</span>
              <small>
                바이낸스 Futures API 관리 페이지에서 발급받으세요. 출금 권한(Withdraw)은 필요하지 않으며, 꺼두는 것을 권장합니다.
              </small>
            </legend>

            {saved ? (
              <div className="saved-key">
                <div>
                  <span>저장된 키</span>
                  <code>{info?.apiKeyMasked ?? '••••'}</code>
                </div>
                <div>
                  <span>네트워크</span>
                  <b>{networkOf === 'production' ? '실계정' : '테스트넷'}</b>
                </div>
                <div className="spacer" />
                <button className="btn btn-sm" onClick={handleDelete} disabled={Boolean(busy) || Boolean(live)}>
                  삭제
                </button>
              </div>
            ) : (
              <>
                <div className="field">
                  <div className="field-text">
                    <label className="field-label" htmlFor="apikey">
                      API Key
                    </label>
                    <small>예: 21 chars 영문/숫자</small>
                  </div>
                  <div className="field-input wide">
                    <input
                      id="apikey"
                      type="text"
                      value={apiKey}
                      autoComplete="off"
                      spellCheck={false}
                      placeholder="API 키를 입력하세요"
                      onChange={(e) => setApiKey(e.target.value.trim())}
                    />
                  </div>
                </div>

                <div className="field">
                  <div className="field-text">
                    <label className="field-label" htmlFor="apisecret">
                      API Secret
                    </label>
                    <small>서버에만 저장되며 화면에 다시 표시되지 않습니다</small>
                  </div>
                  <div className="field-input wide">
                    <input
                      id="apisecret"
                      type={showSecret ? 'text' : 'password'}
                      value={apiSecret}
                      autoComplete="off"
                      spellCheck={false}
                      placeholder="시크릿을 입력하세요"
                      onChange={(e) => setApiSecret(e.target.value.trim())}
                    />
                    <button
                      type="button"
                      className="btn btn-xs"
                      onClick={() => setShowSecret((v) => !v)}
                      title={showSecret ? '가리기' : '보이기'}
                    >
                      {showSecret ? '숨김' : '표시'}
                    </button>
                  </div>
                </div>

                <div className="row-actions">
                  <button className="btn" onClick={handleVerify} disabled={Boolean(busy) || !apiKey || !apiSecret}>
                    {busy === 'verify' ? '확인 중…' : '연결 확인 (저장 안 함)'}
                  </button>
                  <button
                    className="btn btn-primary"
                    onClick={handleSave}
                    disabled={Boolean(busy) || !apiKey || !apiSecret}
                  >
                    {busy === 'save' ? '저장 중…' : '키 저장'}
                  </button>
                </div>
              </>
            )}

            {info?.preview ? (
              <div className="verify-box">
                <span className="verify-ok">✓ 연결 확인 통과</span>
                <span>
                  지갑 {fmtUsd(info.preview.totalWalletBalance)} USDT · 거래 권한 {info.preview.canTrade ? '있음' : '없음'} · 포지션 모드{' '}
                  {info.preview.positionMode === 'one-way' ? '연속(one-way)' : '헤지(hedge)'}
                </span>
              </div>
            ) : null}
          </fieldset>

          {/* ── 거래 모드 선택 ── */}
          <fieldset className="group">
            <legend>
              <span>거래 모드</span>
              <small>
                현재 모드를 고르세요. 실거래 모드에서는 로컬 포지션을 비우고 거래소 포지션을 불러옵니다.
              </small>
            </legend>

            <div className="mode-picker">
              <button
                type="button"
                className={`mode-card ${mode === 'paper' ? 'on' : ''}`}
                onClick={handleModePaper}
                disabled={Boolean(busy) || !saved}
              >
                <div className="mode-card-head">
                  <b>가상 모드</b>
                  {mode === 'paper' ? <span className="badge badge-ready">현재</span> : null}
                </div>
                <p>실제 주문 없음. 설정한 초기 자본으로 시뮬레이션합니다.</p>
              </button>

              <button
                type="button"
                className={`mode-card dry ${mode === 'live-dry' ? 'on' : ''}`}
                onClick={handleModeDry}
                disabled={Boolean(busy) || !saved}
              >
                <div className="mode-card-head">
                  <b>주문 시뮬레이션</b>
                  {mode === 'live-dry' ? <span className="badge badge-ready">현재</span> : null}
                </div>
                <p>
                  실제 계정·잔고·거래규격을 사용하되
                  <b> 주문은 넣지 않습니다</b>. 파이프라인을 안전하게 점검합니다.
                </p>
              </button>

              <button
                type="button"
                className={`mode-card danger ${mode === 'live' ? 'on' : ''}`}
                onClick={() => setLiveConfirm(true)}
                disabled={Boolean(busy) || !saved}
              >
                <div className="mode-card-head">
                  <b>실거래</b>
                  {mode === 'live' ? <span className="badge badge-stop-loss">현재</span> : null}
                </div>
                <p>
                  시장가 주문을 <b>실제로 전송</b>합니다. 손실이 발생할 수 있습니다.
                </p>
              </button>
            </div>

            {!saved ? <p className="hint">먼저 위에서 API 키를 저장하세요.</p> : null}

            {/* 실거래 모드일 때만 주문 시뮬레이션 토글 제공 */}
            {live ? (
              <div className="row-actions live-controls">
                <label className="switch-row">
                  <span className="switch">
                    <input type="checkbox" checked={Boolean(dryRun)} onChange={(e) => handleToggleDryRun(e.target.checked)} disabled={Boolean(busy)} />
                    <i />
                  </span>
                  <span className="switch-label">
                    주문 시뮬레이션
                    <small>
                      {dryRun
                        ? '주문을 넣지 않고 시나리오만 확인합니다.'
                        : '실제 시장가 주문이 전송됩니다.'}
                    </small>
                  </span>
                </label>
                <button className="btn btn-sm" onClick={handleSync} disabled={Boolean(busy)}>
                  {busy === 'sync' ? '동기화 중…' : '거래소 포지션 동기화'}
                </button>
                <button className="btn btn-sm btn-ghost" onClick={handleDisconnect} disabled={Boolean(busy)}>
                  가상 모드로 복귀
                </button>
              </div>
            ) : null}

            {live && dryRun ? (
              <p className="info-box">
                현재는 <b>주문을 넣지 않는 모드</b>입니다. 실제 잔고와 거래 규격으로 모든 판단이 동작하지만
                거래소로 주문은 전송되지 않습니다. 이상이 없으면 위 스위치를 끄세요.
              </p>
            ) : null}

            {liveConfirm ? (
              <div className="danger-confirm">
                <strong>
                  {network === 'production'
                    ? '실계정에서 실제 주문이 발생합니다'
                    : '테스트넷에서 실제 주문을 넣습니다 (가상 자금)'}
                </strong>
                <ul>
                  <li>자동 매수가 켜져 있으면 실제 포지션이 생성되고 손실이 발생할 수 있습니다.</li>
                  <li>포지션·손익 계산은 기존과 동일하게 동작합니다 (익절/손절/RSI/최대 보유시간).</li>
                  <li>서버를 재시작하면 실거래 모드는 자동으로 해제됩니다.</li>
                  <li>주문은 시장가(마켓)이며 체결 가격이 설정과 다를 수 있습니다.</li>
                </ul>
                <label className="confirm-typed">
                  확인하려면 <b>실거래</b> 를 입력하세요
                  <input
                    type="text"
                    value={liveTyped}
                    placeholder="실거래"
                    autoComplete="off"
                    onChange={(e) => setLiveTyped(e.target.value)}
                  />
                </label>
                <div className="row-actions">
                  <button className="btn btn-danger" onClick={handleConnectLive} disabled={Boolean(busy) || liveTyped !== '실거래'}>
                    {busy === 'live' ? '전환 중…' : '실거래 모드 시작'}
                  </button>
                  <button className="btn btn-ghost" onClick={() => setLiveConfirm(false)}>
                    취소
                  </button>
                </div>
              </div>
            ) : null}
          </fieldset>

          <p className="disclaimer">
            API 키는 <code>server/data/credentials.json</code> 에 권한 600으로 저장되며 화면에 다시 표시되지 않습니다.
            출금 권한이 있는 키를 사용하지 마세요. 이 프로그램은 출금 API를 사용하지 않습니다.
          </p>
        </div>
      </div>
    </div>
  );
}
