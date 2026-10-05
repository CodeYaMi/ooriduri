import { useCallback, useEffect, useMemo, useState } from 'react';
import { useEngineSocket } from './hooks/useEngineSocket.js';
import { api, setAuthToken, getAuthToken, setActiveAccount, getActiveAccount, onAuthExpired } from './lib/api.js';

import { Header } from './components/Header.jsx';
import { MarketTable } from './components/MarketTable.jsx';
import { PortfolioPanel } from './components/PortfolioPanel.jsx';
import { SettingsModal } from './components/SettingsModal.jsx';
import { AccountModal } from './components/AccountModal.jsx';
import { PriceChart } from './components/PriceChart.jsx';
import { TradeLog } from './components/TradeLog.jsx';
import { EventLog } from './components/EventLog.jsx';
import { MasterPanel } from './components/MasterPanel.jsx';
import { UserManager } from './components/UserManager.jsx';
import { AuthScreen } from './components/Login.jsx';
import { Toasts } from './components/Toasts.jsx';

export default function App() {
  const [token, setToken] = useState(() => getAuthToken());
  const [session, setSession] = useState(null); // { user, accounts, defaultAccountId }
  const [setupRequired, setSetupRequired] = useState(null);
  const [activeAccountId, setActiveAccountId] = useState(() => getActiveAccount());

  const { states, live, toasts, connected, authError, pushToast } = useEngineSocket(token);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [masterOpen, setMasterOpen] = useState(false);
  const [usersOpen, setUsersOpen] = useState(false);
  const [config, setConfig] = useState(null);
  const [account, setAccount] = useState(null);
  const [selected, setSelected] = useState(null);
  const [busy, setBusy] = useState(false);
  const [scanning, setScanning] = useState(false);

  const user = session?.user ?? null;
  const isMaster = user?.role === 'master';
  const tradingAccounts = useMemo(() => session?.accounts ?? [], [session]);

  // 활성 계정 검증 — 목록에 없으면 기본값으로
  useEffect(() => {
    if (!tradingAccounts.length) return;
    if (!tradingAccounts.some((a) => a.id === activeAccountId)) {
      const fallback = tradingAccounts[0].id;
      setActiveAccountId(fallback);
      setActiveAccount(fallback);
    }
  }, [tradingAccounts, activeAccountId]);

  const state = (activeAccountId && states[activeAccountId]) || null;
  const settings = state?.settings;
  // 실거래 여부 (useEngineSocket 가 반환하는 live 는 실시간 가격 맵이므로 이름을 분리한다)
  const isLiveMode = Boolean(state?.summary?.live);

  // ── 세션 부트스트랩 ──────────────────────────────────────────
  useEffect(() => {
    api.authStatus().then(
      (r) => {
        setSetupRequired(r.setupRequired);
        if (!r.setupRequired && getAuthToken()) {
          api.me().then(
            (me) => {
              setSession({ user: me.user, accounts: me.accounts, defaultAccountId: me.defaultAccountId });
              if (!getActiveAccount() && me.defaultAccountId) setActiveAccount(me.defaultAccountId);
              setActiveAccountId(getActiveAccount() || me.defaultAccountId || '');
            },
            () => {
              setAuthToken('');
              setToken('');
            },
          );
        }
      },
      () => setSetupRequired(false),
    );
  }, []);

  // 401 → 세션 만료 처리
  useEffect(() => {
    onAuthExpired(() => {
      setToken('');
      setSession(null);
      pushToast({ level: 'warn', text: '세션이 만료되었습니다. 다시 로그인하세요.' });
    });
  }, [pushToast]);

  // 설정 스키마 로드 (계정 변경 시마다)
  useEffect(() => {
    if (!token || !activeAccountId) return;
    api.getSettings().then(setConfig).catch((err) => pushToast({ level: 'warn', text: `설정 로드 실패: ${err.message}` }));
  }, [pushToast, token, activeAccountId]);

  // 바이낸스 연결 상태 로드 (계정 변경 시마다)
  useEffect(() => {
    if (!token || !activeAccountId) return;
    api.getAccount().then(setAccount).catch(() => setAccount(null));
  }, [token, activeAccountId]);

  // 선택 종목 자동 추종
  useEffect(() => {
    if (selected) return;
    const first = state?.candidates?.[0]?.symbol ?? state?.positions?.[0]?.symbol;
    if (first) setSelected(first);
  }, [state, selected]);

  // Escape 로 모달 닫기
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      setSettingsOpen(false);
      setAccountOpen(false);
      setMasterOpen(false);
      setUsersOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const withBusy = useCallback(async (fn, failLevel = 'warn') => {
    setBusy(true);
    try {
      return await fn();
    } catch (err) {
      pushToast({ level: failLevel, text: err.message });
      return null;
    } finally {
      setBusy(false);
    }
  }, [pushToast]);

  const handleAuthDone = useCallback((res) => {
    setToken(res.token);
    setSession({ user: res.user, accounts: res.accounts, defaultAccountId: res.defaultAccountId });
    const first = res.defaultAccountId ?? res.accounts?.[0]?.id ?? '';
    setActiveAccountId(first);
    setActiveAccount(first);
    setSelected(null);
  }, []);

  const handleLogout = useCallback(() => {
    withBusy(async () => {
      try {
        await api.logout();
      } catch {
        /* 토큰이 이미 무효해도 로컬은 정리 */
      }
      setAuthToken('');
      setToken('');
      setSession(null);
      setConfig(null);
      setAccount(null);
    });
  }, [withBusy]);

  const handleSelectAccount = useCallback((id) => {
    setActiveAccountId(id);
    setActiveAccount(id);
    setSelected(null);
  }, []);

  const refreshSession = useCallback(async () => {
    try {
      const me = await api.me();
      setSession({ user: me.user, accounts: me.accounts, defaultAccountId: me.defaultAccountId });
    } catch {
      /* 무시 */
    }
  }, []);

  // 파생 상태 — early return 보다 반드시 먼저 (Rules of Hooks)
  const candidates = state?.candidates ?? [];
  const positions = state?.positions ?? [];
  const trades = state?.trades ?? [];
  const selectedPrice = selected ? (live[selected] ?? positions.find((p) => p.symbol === selected)?.markPrice ?? candidates.find((c) => c.symbol === selected)?.price) : null;

  const heldSymbols = useMemo(() => new Set(positions.map((p) => p.symbol)), [positions]);

  // WS 스냅샷마다 새 객체가 만들어지지 않도록 메모이제이션
  // (모달이 사용자 입력을 초기화하는 것을 막기 위함)
  const accountView = useMemo(
    () => account ?? { ...state?.account, ...state?.summary, liveActive: isLiveMode },
    [account, state?.account, state?.summary, isLiveMode],
  );

  // ── 인증 게이트 ──────────────────────────────────────────────
  if (setupRequired === null) {
    return (
      <div className="boot">
        <div className="boot-inner">
          <div className="brand-mark big">◈</div>
          <h1>Coin Surfer</h1>
          <p>서버에 연결 중…</p>
          <div className="boot-spinner" />
        </div>
      </div>
    );
  }

  if (!token || !session) {
    return (
      <div className="app">
        <AuthScreen setupRequired={setupRequired} onDone={handleAuthDone} pushToast={pushToast} />
        <Toasts toasts={toasts} />
      </div>
    );
  }

  const handleSaveSettings = (payload) =>
    withBusy(async () => {
      const res = await api.saveSettings(payload);
      for (const w of res.warnings ?? []) pushToast({ level: 'warn', text: w });
      pushToast({ level: 'info', text: '설정을 저장했습니다. 다음 틱부터 적용됩니다.' });
      setSettingsOpen(false);
    }, 'error');

  const handleResetSettings = () =>
    withBusy(async () => {
      const res = await api.resetSettings();
      setConfig((prev) => (prev ? { ...prev, settings: res.settings } : prev));
      pushToast({ level: 'info', text: '설정을 기본값으로 되돌렸습니다.' });
      setSettingsOpen(false);
    });

  const handleToggleEngine = () =>
    withBusy(async () => {
      const running = state?.running;
      const res = await api.engine(running ? 'stop' : 'start');
      pushToast({ level: 'info', text: running ? '자동 매매를 일시정지했습니다.' : '자동 매매를 시작했습니다.' });
      return res;
    });

  const handleResetPortfolio = () => {
    if (isLiveMode) {
      pushToast({ level: 'warn', text: '실거래 모드에서는 가상 자산을 초기화할 수 없습니다. 계정 화면에서 실거래를 해제하세요.' });
      return;
    }
    if (!window.confirm('가상 자산을 초기 자본으로 리셋할까요? 보유 포지션과 거래 내역이 모두 사라집니다.')) return;
    withBusy(() => api.resetPortfolio());
  };

  const handleSell = (symbol) =>
    withBusy(async () => {
      await api.sell(symbol);
      return true;
    }, 'error');

  const handleManualBuy = (symbol) =>
    withBusy(async () => {
      await api.buy(symbol);
      return true;
    }, 'error');

  const handleCloseAll = () => {
    const msg = isLiveMode
      ? '거래소에서 실제 포지션 전부를 시장가로 청산합니다. 계속할까요?'
      : '보유 중인 모든 포지션을 시장가로 청산할까요?';
    if (!window.confirm(msg)) return;
    withBusy(() => api.closeAll());
  };

  const handleScan = () => {
    setScanning(true);
    withBusy(async () => {
      await api.engine('scan');
      setTimeout(() => setScanning(false), 800);
    }).finally(() => setScanning(false));
  };

  if (!state) {
    return (
      <div className="app">
        <Header
          state={null}
          connected={connected}
          onOpenSettings={() => setSettingsOpen(true)}
          onOpenAccount={() => setAccountOpen(true)}
          onToggleEngine={handleToggleEngine}
          onReset={handleResetPortfolio}
          busy={busy}
          user={user}
          accounts={tradingAccounts}
          activeAccountId={activeAccountId}
          onSelectAccount={handleSelectAccount}
          onLogout={handleLogout}
          onOpenMaster={() => setMasterOpen(true)}
          onOpenUsers={() => setUsersOpen(true)}
        />
        <div className="boot">
          <div className="boot-inner">
            <div className="brand-mark big">◈</div>
            <h1>Coin Surfer</h1>
            <p>
              {authError
                ? '인증에 실패했습니다. 다시 로그인하세요.'
                : connected
                  ? '시세를 불러오는 중…'
                  : '서버에 연결 중…'}
            </p>
            <div className="boot-spinner" />
            <Toasts toasts={toasts} />
          </div>
        </div>
      </div>
    );
  }

  if (!settings) return null;

  return (
    <div className="app">
      <Header
        state={state}
        connected={connected}
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenAccount={() => setAccountOpen(true)}
        onToggleEngine={handleToggleEngine}
        onReset={handleResetPortfolio}
        busy={busy}
        user={user}
        accounts={tradingAccounts}
        activeAccountId={activeAccountId}
        onSelectAccount={handleSelectAccount}
        onLogout={handleLogout}
        onOpenMaster={() => setMasterOpen(true)}
        onOpenUsers={() => setUsersOpen(true)}
      />

      <main className="layout">
        <PriceChart
          symbol={selected}
          livePrice={selectedPrice}
          takeProfitPct={settings.takeProfitPct}
          stopLossPct={settings.stopLossPct}
        />

        <MarketTable
          candidates={candidates}
          live={live}
          settings={settings}
          nearMiss={state.nearMiss}
          entryRejects={state.entryRejects}
          onSelect={setSelected}
          selected={selected}
          onManualBuy={handleManualBuy}
          onScan={handleScan}
          scanning={scanning}
        />

        <PortfolioPanel
          positions={positions}
          live={live}
          settings={settings}
          onSell={handleSell}
          onSelect={setSelected}
          selected={selected}
          onCloseAll={handleCloseAll}
        />

        <TradeLog trades={trades} />

        <EventLog accountId={activeAccountId} />

        <aside className="panel side-panel">
          <div className="panel-head">
            <h2>운용 요약</h2>
          </div>
          <ul className="summary-list">
            <li>
              <span>진입 조건</span>
              <b>
                z ≥ {settings.zScoreThreshold} · {settings.surgeRatioThreshold}배 이상
              </b>
            </li>
            <li>
              <span>익절 / 손절</span>
              <b className="up">
                +{settings.takeProfitPct}% / −{settings.stopLossPct}%
              </b>
            </li>
            <li>
              <span>트레일링 스탑</span>
              <b>{settings.trailingStopPct > 0 ? `${settings.trailingStopPct}%` : '사용 안 함'}</b>
            </li>
            <li>
              <span>RSI 진입 조건</span>
              <b className={settings.useRsiFilter ? '' : 'dim'}>
                {settings.useRsiFilter ? `${settings.rsiMin} ~ ${settings.rsiMax} (${settings.rsiPeriod})` : '사용 안 함'}
              </b>
            </li>
            <li>
              <span>24h 변동 조건</span>
              <b className={settings.use24hChangeFilter ? '' : 'dim'}>
                {settings.use24hChangeFilter ? `≥ ${settings.minChange24hPct}%` : '사용 안 함'}
              </b>
            </li>
            <li>
              <span>최대 보유 시간</span>
              <b>{settings.maxHoldMinutes > 0 ? `${settings.maxHoldMinutes}분` : '무제한'}</b>
            </li>
            <li>
              <span>재진입 쿨다운</span>
              <b>{settings.cooldownMinutes > 0 ? `${settings.cooldownMinutes}분` : '없음'}</b>
            </li>
            <li>
              <span>자동 매매</span>
              <b className={settings.autoTrade ? 'up' : 'down'}>{settings.autoTrade ? 'ON' : 'OFF'}</b>
            </li>
            <li>
              <span>보유 / 후보</span>
              <b>
                {heldSymbols.size} / {candidates.length}
              </b>
            </li>
            <li>
              <span>비용 (수수료·슬리피지)</span>
              <b>
                {settings.takerFeeBps}bp / {settings.slippageBps}bp
              </b>
            </li>
            <li>
              <span>실시간 가격 소스</span>
              <b className={state.status.priceFeed === 'bookTicker' || state.status.priceFeed === 'trade' ? 'up' : 'down'}>
                {{ bookTicker: '호가 스트림', trade: '체결 스트림', rest: 'REST 폴링', pending: '대기' }[state.status.priceFeed] ??
                  '알 수 없음'}
              </b>
            </li>
            <li>
              <span>시세 갱신 주기</span>
              <b>
                {settings.marketPollSec}초 / {settings.barPollSec}초
              </b>
            </li>
          </ul>
          <p className="disclaimer">
            본 화면은 실제 주문이 발생하지 않는 <b>가상(시뮬레이션)</b> 결과입니다. 과거 거래량 급등이 이후 수익을 보장하지 않으며,
            투자 판단의 책임은 이용자 본인에게 있습니다.
          </p>
        </aside>
      </main>

      <SettingsModal
        open={settingsOpen}
        config={config}
        current={state.settings}
        onClose={() => setSettingsOpen(false)}
        onSave={handleSaveSettings}
        onResetDefaults={handleResetSettings}
        busy={busy}
      />

      <AccountModal
        open={accountOpen}
        account={accountView}
        onClose={() => setAccountOpen(false)}
        onChanged={() => {
          api.getAccount().then(setAccount).catch(() => {});
          refreshSession();
        }}
        pushToast={pushToast}
      />

      {isMaster ? (
        <>
          <MasterPanel open={masterOpen} onClose={() => setMasterOpen(false)} pushToast={pushToast} />
          <UserManager open={usersOpen} onClose={() => setUsersOpen(false)} pushToast={pushToast} myUserId={user.id} />
        </>
      ) : null}

      <Toasts toasts={toasts} />
    </div>
  );
}
