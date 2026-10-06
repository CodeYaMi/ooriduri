import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { fmtSignedUsd, pnlClass } from '../lib/format.js';

const fmtRate = (v) => `${Number(v ?? 0).toFixed(1)}%`;

const PERIODS = [7, 14, 30, 90];
const WEEKDAY = ['일', '월', '화', '수', '목', '금', '토'];

function dayLabel(dateStr) {
  // 'YYYY-MM-DD' → 'M/D (요일)'
  const [y, m, d] = dateStr.split('-').map(Number);
  const w = WEEKDAY[new Date(y, m - 1, d).getDay()];
  return `${m}/${d} (${w})`;
}

function SummaryCard({ label, value, sub, tone }) {
  return (
    <div className="dstat">
      <span className="dstat-label">{label}</span>
      <strong className={`dstat-value ${tone ?? ''}`}>{value}</strong>
      {sub ? <small className="dstat-sub">{sub}</small> : null}
    </div>
  );
}

/**
 * 일별 실현 손익 창 (청산 기준).
 * 미청산 포지션은 포함하지 않는다 — 보유 중인 평가손익은 별도 행으로 표시.
 */
export function DailyPnl({ open, onClose, accountId, unrealizedPnl }) {
  const [days, setDays] = useState(30);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.dailyTrades(days);
      setData(res);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => {
    if (open) load();
    else setData(null);
  }, [open, load, accountId]);

  if (!open) return null;

  const rows = data?.daily ?? [];
  const total = data?.total ?? null;
  const maxAbs = Math.max(1, ...rows.map((r) => Math.abs(r.pnl)));

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal modal-wide" role="dialog" aria-modal="true" aria-label="일별 수익률">
        <div className="modal-head">
          <div>
            <h2>일별 수익률</h2>
            <p>청산된 거래의 실현 손익을 날짜별로 집계합니다 (서버 시간 기준)</p>
          </div>
          <button className="btn btn-ghost btn-icon" onClick={onClose} aria-label="닫기">
            ✕
          </button>
        </div>

        <div className="modal-body">
          <div className="row-actions" style={{ marginTop: 0 }}>
            <div className="segmented">
              {PERIODS.map((p) => (
                <button key={p} className={days === p ? 'on' : ''} onClick={() => setDays(p)}>
                  {p}일
                </button>
              ))}
            </div>
            <div className="spacer" />
            <button className="btn btn-sm btn-ghost" onClick={load} disabled={loading}>
              {loading ? '불러오는 중…' : '↻ 새로고침'}
            </button>
          </div>

          {error ? <div className="banner banner-error">{error}</div> : null}

          {total ? (
            <div className="dstats">
              <SummaryCard
                label="기간 실현 손익"
                value={fmtSignedUsd(total.pnl)}
                sub={`${total.days}일간 · ${total.trades}건`}
                tone={pnlClass(total.pnl)}
              />
              <SummaryCard label="일평균" value={fmtSignedUsd(total.avgPerDay)} tone={pnlClass(total.avgPerDay)} />
              <SummaryCard
                label="최고일"
                value={total.bestDay ? `${dayLabel(total.bestDay.date)} ${fmtSignedUsd(total.bestDay.pnl)}` : '—'}
                tone="up"
              />
              <SummaryCard
                label="최악일"
                value={total.worstDay ? `${dayLabel(total.worstDay.date)} ${fmtSignedUsd(total.worstDay.pnl)}` : '—'}
                tone="down"
              />
              <SummaryCard
                label="승률"
                value={fmtRate(total.winRate)}
                sub={`${total.wins}승 ${total.losses}패 · 수익일 ${total.upDays} / 손실일 ${total.downDays}`}
              />
            </div>
          ) : null}

          {Number.isFinite(unrealizedPnl) && unrealizedPnl !== 0 ? (
            <p className={`block-reject ${unrealizedPnl >= 0 ? '' : 'neg'}`}>
              보유 중 평가손익 <b>{fmtSignedUsd(unrealizedPnl)} USDT</b> (미청산 — 위 집계에 미포함)
            </p>
          ) : null}

          {rows.length === 0 && !loading ? (
            <div className="empty-state small">
              <div className="empty-icon">◷</div>
              <p>선택한 기간에 청산된 거래가 없습니다.</p>
            </div>
          ) : (
            <div className="table-wrap">
              <table className="table compact">
                <thead>
                  <tr>
                    <th className="left">날짜</th>
                    <th className="center">거래</th>
                    <th className="center">승 / 패</th>
                    <th className="center">승률</th>
                    <th className="left">일별 손익</th>
                    <th className="right">손익 (USDT)</th>
                    <th className="left">대표 종목</th>
                  </tr>
                </thead>
                <tbody>
                  {[...rows].reverse().map((r) => (
                    <tr key={r.date}>
                      <td className="left mono">{dayLabel(r.date)}</td>
                      <td className="center mono">{r.trades}</td>
                      <td className="center mono">
                        <span className="up">{r.wins}</span> / <span className="down">{r.losses}</span>
                      </td>
                      <td className="center mono">{fmtRate(r.winRate)}</td>
                      <td className="left">
                        <span className="pnlbar">
                          <i
                            className={r.pnl >= 0 ? 'fill-up' : 'fill-down'}
                            style={{ width: `${Math.max(2, (Math.abs(r.pnl) / maxAbs) * 100)}%` }}
                          />
                        </span>
                      </td>
                      <td className={`right mono ${pnlClass(r.pnl)}`}>
                        <strong>{fmtSignedUsd(r.pnl)}</strong>
                      </td>
                      <td className="left dim">
                        {r.topSymbol ? (
                          <>
                            {r.topSymbol.replace(/USDT$/, '')} <small>({fmtSignedUsd(r.topSymbolPnl)})</small>
                          </>
                        ) : (
                          '—'
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
