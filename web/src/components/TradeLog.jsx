import { REASON_LABEL, fmtDuration, fmtPct, fmtPrice, fmtSignedUsd, pnlClass } from '../lib/format.js';

export function TradeLog({ trades, onOpenDaily }) {
  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <h2>청산 내역</h2>
          <p>익절 · 손절 · 수동 매도 기록</p>
        </div>
        <div className="panel-head-right">
          <span className="chip">{trades.length}건</span>
          <button className="btn btn-sm" onClick={onOpenDaily} title="날짜별 실현 손익 집계">
            📊 일별 수익률
          </button>
        </div>
      </div>

      {trades.length === 0 ? (
        <div className="empty-state small">
          <div className="empty-icon">◷</div>
          <p>아직 청산된 거래가 없습니다.</p>
        </div>
      ) : (
        <div className="table-wrap tall">
          <table className="table compact">
            <thead>
              <tr>
                <th className="left">시각</th>
                <th className="left">종목</th>
                <th className="left">사유</th>
                <th className="right">진입가</th>
                <th className="right">청산가</th>
                <th className="right">수익률</th>
                <th className="right">손익(USDT)</th>
                <th className="right">보유</th>
              </tr>
            </thead>
            <tbody>
              {trades.map((t, i) => (
                <tr key={`${t.symbol}-${t.exitTime}-${i}`}>
                  <td className="left mono dim">{new Date(t.exitTime).toLocaleTimeString('ko-KR', { hour12: false })}</td>
                  <td className="left">
                    <strong>{t.symbol.replace(/USDT$/, '')}</strong>
                  </td>
                  <td className="left">
                    <span className={`badge badge-${t.reason}`}>{REASON_LABEL[t.reason] ?? t.reason}</span>
                  </td>
                  <td className="right mono dim">{fmtPrice(t.entryPrice)}</td>
                  <td className="right mono">{fmtPrice(t.exitPrice)}</td>
                  <td className={`right mono ${pnlClass(t.pnlPct)}`}>{fmtPct(t.pnlPct)}</td>
                  <td className={`right mono ${pnlClass(t.pnlUSDT)}`}>{fmtSignedUsd(t.pnlUSDT)}</td>
                  <td className="right mono dim">{fmtDuration(t.holdMinutes * 60_000)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
