import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api.js';
import { fmtCompact, fmtPct, fmtPrice, fmtUsd, pnlClass } from '../lib/format.js';

/** RSI 게이지 (MarketTable과 동일 표시) */
function RsiGauge({ rsi, min, max }) {
  if (rsi === null || rsi === undefined) return <span className="dim">—</span>;
  const inRange = rsi >= min && rsi <= max;
  const zone = rsi >= 70 ? 'overbought' : rsi <= 30 ? 'oversold' : 'neutral';
  return (
    <span className={`rsi ${inRange ? 'ok' : 'out'}`} title={`RSI ${rsi} (${zone}) · 허용 ${min}~${max}`}>
      <span className="rsi-track">
        <i className="rsi-band" style={{ left: `${min}%`, width: `${Math.max(0, max - min)}%` }} />
        <i className={`rsi-dot ${zone}`} style={{ left: `${Math.min(100, Math.max(0, rsi))}%` }} />
      </span>
      <b>{rsi.toFixed(1)}</b>
    </span>
  );
}

const FILTERS = [
  ['all', '전체'],
  ['passed', '통과만'],
  ['failed', '탈락만'],
];

/**
 * 전체 평가 리스트 창.
 * 상위 N개로 잘린 후보가 아니라, 평가된 전 종목을 점수순으로 보여준다.
 * 각 행에 통과 여부와 탈락 사유가 표시된다.
 */
export function CandidateList({ open, onClose, settings, live, selected, onSelect, onManualBuy }) {
  const [rows, setRows] = useState([]);
  const [passedCount, setPassedCount] = useState(0);
  const [ms, setMs] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.allCandidates();
      setRows(res.rows ?? []);
      setPassedCount(res.passedCount ?? 0);
      setMs(res.ms ?? 0);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) {
      setFilter('all');
      setQuery('');
      load();
    } else {
      setRows([]);
    }
  }, [open, load]);

  const visible = useMemo(() => {
    const q = query.trim().toUpperCase();
    return rows.filter((r) => {
      if (filter === 'passed' && !r.passed) return false;
      if (filter === 'failed' && r.passed) return false;
      if (q && !r.symbol.includes(q)) return false;
      return true;
    });
  }, [rows, filter, query]);

  if (!open) return null;

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal modal-wide" role="dialog" aria-modal="true" aria-label="전체 평가 리스트">
        <div className="modal-head">
          <div>
            <h2>전체 평가 리스트</h2>
            <p>
              평가 {rows.length}종목 중 통과 {passedCount}종목
              {ms ? ` · 집계 ${ms}ms` : ''} · 점수순 정렬
            </p>
          </div>
          <button className="btn btn-ghost btn-icon" onClick={onClose} aria-label="닫기">
            ✕
          </button>
        </div>

        <div className="modal-body">
          <div className="row-actions" style={{ marginTop: 0 }}>
            <div className="segmented">
              {FILTERS.map(([v, label]) => (
                <button key={v} className={filter === v ? 'on' : ''} onClick={() => setFilter(v)}>
                  {label}
                </button>
              ))}
            </div>
            <input
              type="text"
              className="search-input"
              placeholder="종목 검색 (예: BTC)"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <div className="spacer" />
            <button className="btn btn-sm btn-ghost" onClick={load} disabled={loading}>
              {loading ? '불러오는 중…' : '↻ 새로고침'}
            </button>
          </div>

          {error ? <div className="banner banner-error">{error}</div> : null}

          {visible.length === 0 && !loading ? (
            <div className="empty-state small">
              <div className="empty-icon">◎</div>
              <p>표시할 종목이 없습니다.</p>
            </div>
          ) : (
            <div className="table-wrap tall">
              <table className="table compact">
                <thead>
                  <tr>
                    <th className="left">종목</th>
                    <th className="right">가격</th>
                    <th className="right">24h 변동</th>
                    <th className="right">배수</th>
                    <th className="right">z</th>
                    <th className="rsi-col">RSI</th>
                    <th className="right">평균/분</th>
                    <th className="right">24h 거래대금</th>
                    <th className="center">판정</th>
                    <th className="left">탈락 사유</th>
                    <th className="right">액션</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((r) => (
                    <tr
                      key={r.symbol}
                      className={selected === r.symbol ? 'row-selected' : ''}
                      onClick={() => onSelect(r.symbol)}
                    >
                      <td className="left">
                        <div className="sym">
                          <strong>{r.symbol.replace(/USDT$/, '')}</strong>
                          <small>/USDT</small>
                        </div>
                      </td>
                      <td className="right mono">{fmtPrice(live[r.symbol] ?? r.price)}</td>
                      <td className={`right mono ${pnlClass(r.change24hPct)}`}>{fmtPct(r.change24hPct)}</td>
                      <td className="right mono">
                        <span className="surge">{r.ratio.toFixed(2)}배</span>
                      </td>
                      <td className="right mono">{r.z.toFixed(2)}</td>
                      <td className="rsi-col">
                        <RsiGauge rsi={r.rsi} min={settings.rsiMin} max={settings.rsiMax} />
                      </td>
                      <td className="right mono dim">
                        {fmtCompact(r.recentAvg)}
                        {r.livePace ? <small className="block dim">↗ {fmtCompact(r.livePace)}</small> : null}
                      </td>
                      <td className="right mono dim">{fmtCompact(r.quoteVolume24h)}</td>
                      <td className="center">
                        {r.passed ? (
                          <span className="badge badge-ready">통과</span>
                        ) : (
                          <span className="badge badge-cool">탈락</span>
                        )}
                      </td>
                      <td className="left dim small">{r.passed ? '—' : r.reasons.join(' · ')}</td>
                      <td className="right" onClick={(e) => e.stopPropagation()}>
                        <button
                          className="btn btn-xs"
                          disabled={r.held || r.cooldownLeftMin > 0}
                          onClick={() => onManualBuy(r.symbol)}
                          title={`${fmtUsd(settings.positionSizeUSDT)} 수동 매수`}
                        >
                          매수
                        </button>
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
