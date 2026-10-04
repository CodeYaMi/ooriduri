import { fmtDuration, fmtPct, fmtPrice, fmtQty, fmtSignedUsd, fmtUsd, pnlClass } from '../lib/format.js';

/** 익절/손절까지 남은 진행률 바 */
function ExitBar({ pnlPct, settings, peakPnlPct }) {
  const sl = -settings.stopLossPct;
  const tp = settings.takeProfitPct;
  const span = tp - sl;
  const clamped = Math.max(sl, Math.min(tp, pnlPct));
  const left = ((clamped - sl) / span) * 100;

  return (
    <div className="exitbar" title={`손절 ${sl}% ← 현재 ${pnlPct.toFixed(2)}% → 익절 ${tp}%`}>
      <div className="exitbar-track">
        <i className="zone-sl" style={{ left: 0, width: `${(Math.abs(sl) / span) * 100}%` }} />
        <i className="zone-tp" style={{ left: `${(Math.abs(sl) / span) * 100}%`, right: 0 }} />
        {settings.trailingStopPct > 0 && peakPnlPct > 0 ? (
          <i className="peak" style={{ left: `${Math.max(0, Math.min(100, ((peakPnlPct - sl) / span) * 100))}%` }} title={`최고 ${peakPnlPct.toFixed(2)}%`} />
        ) : null}
        <b className={`marker ${pnlClass(pnlPct)}`} style={{ left: `${left}%` }} />
      </div>
      <div className="exitbar-labels">
        <span className="down">−{settings.stopLossPct}%</span>
        <span className="up">+{settings.takeProfitPct}%</span>
      </div>
    </div>
  );
}

/** 최대 보유 시간까지 남은 분 (음수면 이미 초과) */
const remainingHoldMin = (position, maxHoldMinutes) => maxHoldMinutes - position.holdMinutes;

export function PortfolioPanel({ positions, live, settings, onSell, onSelect, selected, onCloseAll }) {
  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <h2>보유 포지션</h2>
          <p>익절 +{settings.takeProfitPct}% · 손절 −{settings.stopLossPct}% · 종목당 {fmtUsd(settings.positionSizeUSDT, 0)} USDT</p>
        </div>
        <div className="panel-head-right">
          <span className="chip">
            {positions.length}/{settings.maxPositions}
          </span>
          {positions.length > 0 ? (
            <button className="btn btn-sm btn-ghost" onClick={onCloseAll}>
              전부 청산
            </button>
          ) : null}
        </div>
      </div>

      {positions.length === 0 ? (
        <div className="empty-state">
          <div className="empty-icon">◇</div>
          <strong>보유 중인 포지션이 없습니다</strong>
          <p>
            자동 매수가 켜져 있으면 급등 후보가 감지되는 즉시 진입합니다.
            <br />
            꺼져 있으면 후보 종목의 <b>매수</b> 버튼으로 직접 진입할 수 있습니다.
          </p>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th className="left">종목</th>
                <th className="right">수량</th>
                <th className="right">진입가</th>
                <th className="right">현재가</th>
                <th className="right">손익률</th>
                <th className="right">손익(USDT)</th>
                <th className="right">보유시간</th>
                <th className="exit-col">익절/손절 진행률</th>
                <th className="right">액션</th>
              </tr>
            </thead>
            <tbody>
              {positions.map((p) => {
                const price = live[p.symbol] ?? p.markPrice;
                const pnlPct = p.entryPrice ? ((price - p.entryPrice) / p.entryPrice) * 100 : 0;
                const pnlUSDT = (price - p.entryPrice) * p.qty;
                const toTP = p.entryPrice * (1 + settings.takeProfitPct / 100);
                const toSL = p.entryPrice * (1 - settings.stopLossPct / 100);

                return (
                  <tr key={p.symbol} className={`${selected === p.symbol ? 'row-selected' : ''} ${p.isNew ? 'row-new' : ''}`} onClick={() => onSelect(p.symbol)}>
                    <td className="left">
                      <div className="sym">
                        <strong>{p.symbol.replace(/USDT$/, '')}</strong>
                        <small>/USDT</small>
                      </div>
                      {p.signal?.z ? <small className="dim">z {p.signal.z} · {p.signal.ratio}배</small> : null}
                    </td>
                    <td className="right mono dim">{fmtQty(p.qty)}</td>
                    <td className="right mono">{fmtPrice(p.entryPrice)}</td>
                    <td className="right mono">
                      {fmtPrice(price)}
                      <small className="dim block">
                        TP {fmtPrice(toTP)} / SL {fmtPrice(toSL)}
                      </small>
                    </td>
                    <td className={`right mono ${pnlClass(pnlPct)}`}>
                      <strong>{fmtPct(pnlPct)}</strong>
                    </td>
                    <td className={`right mono ${pnlClass(pnlUSDT)}`}>{fmtSignedUsd(pnlUSDT)}</td>
                    <td className="right mono dim">
                      {fmtDuration(p.holdMinutes * 60_000)}
                      {settings.maxHoldMinutes > 0 ? (
                        <small className={`block ${remainingHoldMin(p, settings.maxHoldMinutes) <= 2 ? 'warn-text' : 'dim'}`}>
                          {remainingHoldMin(p, settings.maxHoldMinutes) > 0
                            ? `만료까지 ${fmtDuration(remainingHoldMin(p, settings.maxHoldMinutes) * 60_000)}`
                            : '만료 임박'}
                        </small>
                      ) : null}
                    </td>
                    <td className="exit-col">
                      <ExitBar pnlPct={pnlPct} peakPnlPct={p.peakPnlPct} settings={settings} />
                    </td>
                    <td className="right" onClick={(e) => e.stopPropagation()}>
                      <button className="btn btn-xs btn-sell" onClick={() => onSell(p.symbol)}>
                        매도
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
