import { fmtCompact, fmtDuration, fmtPct, fmtSignedUsd, fmtUsd, pnlClass } from '../lib/format.js';

function Stat({ label, value, sub, tone }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className={`stat-value ${tone ?? ''}`}>{value}</div>
      {sub ? <div className="stat-sub">{sub}</div> : null}
    </div>
  );
}

export function Header({
  state,
  connected,
  onOpenSettings,
  onOpenAccount,
  onToggleEngine,
  onReset,
  busy,
  user,
  accounts,
  activeAccountId,
  onSelectAccount,
  onLogout,
  onOpenMaster,
  onOpenUsers,
  onRestartServer,
  restarting,
}) {
  const activeAccount = accounts?.find((a) => a.id === activeAccountId) ?? null;
  const s = state?.summary;
  const status = state?.status ?? {};
  const totalPnl = s?.totalPnl ?? 0;
  const live = Boolean(s?.live);
  const isProd = s?.network === 'production';
  const dryRun = Boolean(s?.dryRun);

  // 모드 라벨 — 주문 시뮬레이션을 별도 모드로 구분
  const modeTag = live ? (dryRun ? '시뮬레이션' : isProd ? '실거래' : '테스트넷') : '가상';
  const modeClass = live ? (dryRun ? 'dry' : isProd ? 'prod' : 'testnet') : 'paper';

  const marketOk = status.market === 'polling';
  const feedLabel = { bookTicker: '호가 스트림', trade: '체결 스트림', rest: 'REST 폴링', pending: '연결 대기' }[status.priceFeed] ?? status.priceFeed;
  const connectionTone = !connected ? 'err' : marketOk ? 'ok' : status.market === 'loading' ? 'warn' : 'err';
  const connectionText = !connected
    ? '대시보드 연결 끊김'
    : status.market === 'loading'
      ? '시세 불러오는 중…'
      : marketOk
        ? `바이낸스 연결됨 · 실시간 가격 ${feedLabel}`
        : '시세 폴링 재시도 중';

  return (
    <header className="header">
      <div className="header-top">
        <div className="brand">
          <span className="brand-mark">◈</span>
          <div>
            <h1>
              Coin Surfer
              <span className={`mode-tag ${modeClass}`}>{modeTag}</span>
            </h1>
            <p>
              바이낸스 USDⓈ-M 선물 · 거래량 급등 감지
              {live ? (dryRun ? ' · 주문 없음 (시뮬레이션)' : ' · 실제 주문') : ' · 가상 투자'}
            </p>
          </div>
        </div>

        <div className="header-actions">
          {accounts?.length > 1 ? (
            <select
              className="select-account"
              value={activeAccountId ?? ''}
              onChange={(e) => onSelectAccount(e.target.value)}
              title="거래 계정 전환"
            >
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}{a.ownerName ? ` (${a.ownerName})` : ''}
                </option>
              ))}
            </select>
          ) : activeAccount ? (
            <span className="chip" title="거래 계정">{activeAccount.name}</span>
          ) : null}
          <div className={`conn conn-${connectionTone}`}>
            <span className="dot" />
            <div>
              <strong>{connected ? connectionText : '대시보드 연결 끊김'}</strong>
              <small>
                {status.scanCount ? `스캔 ${status.scanCount}회 · ${status.lastScanMs ?? 0}ms` : '스캔 대기'}
                {status.nextScanAt ? ` · 다음 스캔 ${fmtDuration(status.nextScanAt - Date.now())}` : ''}
                {status.lastBarPollAt ? ` · 1분봉 ${fmtDuration(Date.now() - status.lastBarPollAt)} 전` : ''}
              </small>
            </div>
          </div>
          <button className={`btn ${live && !dryRun ? 'btn-danger' : 'btn-account'}`} onClick={onOpenAccount}>
            {modeTag === '가상' ? '계정 · 실거래' : `⚠ 계정 · ${modeTag}`}
          </button>
          <button className="btn" onClick={onOpenSettings}>
            ⚙︎ 설정
          </button>
          <button className="btn" onClick={onToggleEngine} disabled={busy}>
            {state?.running ? '⏸ 일시정지' : '▶ 시작'}
          </button>
          <button className="btn btn-ghost" onClick={onReset} disabled={busy} title="가상 자산을 초기 자본으로 리셋">
            ↺ 초기화
          </button>
          {user?.role === 'master' ? (
            <>
              <button className="btn btn-ghost" onClick={onOpenMaster} title="전 계정 현황 · 거래계정 · 전체 로그">
                ♛ 마스터
              </button>
              <button className="btn btn-ghost" onClick={onOpenUsers} title="로그인 회원 생성 · 비밀번호 변경 · 정지 · 삭제">
                👥 회원 관리
              </button>
              <button
                className="btn btn-ghost"
                onClick={onRestartServer}
                disabled={busy || restarting}
                title="서버 재시작 (실거래 모드 자동 해제, 약 30~60초간 접속 끊김)"
              >
                {restarting ? '재시작 중…' : '↻ 재시작'}
              </button>
            </>
          ) : null}
          <span className="chip" title={`${user?.name ?? ''} (${user?.role === 'master' ? '마스터' : '일반'})`}>
            {user?.role === 'master' ? '♛ ' : ''}{user?.name ?? ''}
          </span>
          <button className="btn btn-ghost btn-sm" onClick={onLogout} title="로그아웃">
            로그아웃
          </button>
        </div>
      </div>

      <div className="stats">
        <Stat label="총 자산" value={`${fmtUsd(s?.equity ?? 0)} USDT`} sub={`초기 자본 ${fmtUsd(state?.settings?.initialCapitalUSDT ?? 0)}`} />
        <Stat label="총 손익" value={fmtSignedUsd(totalPnl)} sub={fmtPct(s?.totalPnlPct ?? 0)} tone={pnlClass(totalPnl)} />
        <Stat label="평가 손익" value={fmtSignedUsd(s?.unrealizedPnl ?? 0)} sub={`보유 ${s?.openCount ?? 0}/${s?.maxPositions ?? 0}종목`} tone={pnlClass(s?.unrealizedPnl ?? 0)} />
        <Stat label="실현 손익" value={fmtSignedUsd(s?.realizedPnl ?? 0)} sub={`거래 ${s?.tradeCount ?? 0}건 · 승률 ${s?.winRate ?? 0}%`} tone={pnlClass(s?.realizedPnl ?? 0)} />
        <Stat label="현금" value={`${fmtUsd(s?.cash ?? 0)} USDT`} sub={`수수료 누적 ${fmtUsd(s?.totalFees ?? 0)}`} />
        <Stat label="최대 낙폭" value={`${(s?.drawdownPct ?? 0).toFixed(2)}%`} sub={`24h 거래대금 상위 ${state?.marketCount ?? 0}종목 · 분봉 ${state?.trackedHistory ?? 0}종목`} />
      </div>

      {status.lastError ? <div className="banner banner-error">⚠ {status.lastError}</div> : null}
    </header>
  );
}

export { Stat };
