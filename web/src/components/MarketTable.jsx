import { useMemo, useState } from 'react';
import { fmtCompact, fmtPct, fmtPrice, fmtUsd, pnlClass } from '../lib/format.js';
import { CandidateList } from './CandidateList.jsx';

/** 분봉 거래량 미니 차트 (급등 구간 하이라이트) */
function VolumeBars({ bars, recentWindow = 3 }) {
  if (!bars?.length) return <div className="vbars empty" />;
  const max = Math.max(...bars, 1);
  const split = bars.length - recentWindow;
  return (
    <div className="vbars" title="최근 1분봉 거래대금 (하이라이트 = 급등 구간)">
      {bars.map((v, i) => (
        <span
          key={i}
          className={i >= split ? 'bar hot' : 'bar'}
          style={{ height: `${Math.max(6, (v / max) * 100)}%` }}
        />
      ))}
    </div>
  );
}

/** RSI 게이지 — 허용 구간 안이면 초록, 밖이면 회색 */
function RsiGauge({ rsi, min, max }) {
  if (rsi === null || rsi === undefined) return <span className="dim">—</span>;

  const inRange = rsi >= min && rsi <= max;
  const zone = rsi >= 70 ? 'overbought' : rsi <= 30 ? 'oversold' : 'neutral';
  const label = zone === 'overbought' ? '과매수' : zone === 'oversold' ? '과매도' : '중립';

  return (
    <span className={`rsi ${inRange ? 'ok' : 'out'}`} title={`RSI ${rsi} (${label}) · 허용 ${min}~${max}`}>
      <span className="rsi-track">
        <i className="rsi-band" style={{ left: `${min}%`, width: `${Math.max(0, max - min)}%` }} />
        <i className={`rsi-dot ${zone}`} style={{ left: `${Math.min(100, Math.max(0, rsi))}%` }} />
      </span>
      <b>{rsi.toFixed(1)}</b>
    </span>
  );
}

export function MarketTable({ candidates, live, settings, nearMiss, entryRejects, onSelect, selected, onManualBuy, onScan, scanning }) {
  const [hover, setHover] = useState(null);
  const [fullOpen, setFullOpen] = useState(false);

  const rows = useMemo(
    () =>
      candidates.map((c) => {
        const price = live[c.symbol] ?? c.price;
        return { ...c, livePrice: price };
      }),
    [candidates, live],
  );

  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <h2>거래량 급등 후보</h2>
          <p>
            최근 {settings.recentWindowMinutes}분 평균 ÷ 직전 {settings.lookbackMinutes}분 평균 기준 · z ≥ {settings.zScoreThreshold} ·{' '}
            {settings.surgeRatioThreshold}배 이상
            {settings.useRsiFilter
              ? ` · RSI ${settings.rsiMin}~${settings.rsiMax} (${settings.rsiPeriod})`
              : ' · RSI 조건 꺼짐'}
            {settings.use24hChangeFilter ? ` · 24h 변동 ≥ ${settings.minChange24hPct}%` : ' · 24h 변동 조건 꺼짐'}
          </p>
        </div>
        <div className="panel-head-right">
          <span className="chip">{rows.length}/{settings.topN}종목</span>
          <button className="btn btn-sm" onClick={() => setFullOpen(true)} title="통과 여부와 탈락 사유까지 전 종목 표시">
            📋 전체 리스트
          </button>
          <button className="btn btn-sm" onClick={onScan} disabled={scanning}>
            {scanning ? '스캔 중…' : '지금 스캔'}
          </button>
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="empty-state">
          <div className="empty-icon">◎</div>
          <strong>지금은 급등 후보가 없습니다</strong>
          <p>
            z ≥ {settings.zScoreThreshold} · {settings.surgeRatioThreshold}배 이상 · 분당 {fmtCompact(settings.minMinuteQuoteVolumeUSDT)} USDT
            {settings.useRsiFilter ? ` · RSI ${settings.rsiMin}~${settings.rsiMax}` : ''}
            {settings.use24hChangeFilter ? ` · 24h 변동 ≥ ${settings.minChange24hPct}%` : ''} 조건을 만족하는 종목이 없습니다.
            <br />
            다음 스캔 {settings.scanIntervalSec}초 후 · 조건을 낮추려면 <b>설정 ⚙︎</b>
          </p>

          {entryRejects?.by24h > 0 ? (
            <p className="block-reject">
              거래량 급등을 통과했지만 <b>24시간 변동률</b> 때문에 진입이 막힌 종목 {entryRejects.by24h}개 (RSI 로 막힌 {entryRejects.byRsi}개)
            </p>
          ) : null}

          {nearMiss?.length ? (
            <div className="nearmiss">
              <span className="nearmiss-title">조금만 더 느슨해지면 진입할 종목</span>
              <ul>
                {nearMiss.map((n) => (
                  <li key={n.symbol}>
                    <button className="link" onClick={() => onSelect(n.symbol)}>
                      {n.symbol.replace(/USDT$/, '')}
                    </button>
                    <span className="nearmiss-metrics">
                      z {n.z} · {n.ratio}배{n.rsi !== null ? ` · RSI ${n.rsi}` : ''}
                    </span>
                    <span className="nearmiss-reason">{n.reasons.join(' · ')}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th className="left">종목</th>
                <th className="right">실시간 가격</th>
                <th className="right">24h 변동</th>
                <th className="right">급등 배수</th>
                <th className="right">z-score</th>
                <th className="rsi-col">RSI{settings.useRsiFilter ? ` ${settings.rsiMin}~${settings.rsiMax}` : ''}</th>
                <th className="right">최근 평균/분</th>
                <th className="bars-col">거래량 추이</th>
                <th className="right">24h 거래대금</th>
                <th className="center">상태</th>
                <th className="right">액션</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr
                  key={c.symbol}
                  className={selected === c.symbol ? 'row-selected' : ''}
                  onMouseEnter={() => setHover(c.symbol)}
                  onMouseLeave={() => setHover(null)}
                  onClick={() => onSelect(c.symbol)}
                >
                  <td className="left">
                    <div className="sym">
                      <strong>{c.symbol.replace(/USDT$/, '')}</strong>
                      <small>/USDT</small>
                    </div>
                  </td>
                  <td className="right mono">{fmtPrice(c.livePrice)}</td>
                  <td className={`right mono ${pnlClass(c.change24hPct)}`}>{fmtPct(c.change24hPct)}</td>
                  <td className="right mono">
                    <span className="surge">{c.ratio.toFixed(2)}배</span>
                  </td>
                  <td className="right mono">
                    <span className="zbar">
                      <i style={{ width: `${Math.min(100, (c.z / 6) * 100)}%` }} />
                      <b>{c.z.toFixed(2)}</b>
                    </span>
                  </td>
                  <td className="rsi-col">
                    <RsiGauge rsi={c.rsi} min={settings.rsiMin} max={settings.rsiMax} />
                  </td>
                  <td className="right mono dim">
                    {fmtCompact(c.recentAvg)}
                    {c.livePace ? (
                      <small className={`block ${c.livePace > c.baseAvg ? 'up' : 'dim'}`} title="진행 중 1분봉을 분당 pace로 환산">
                        ↗ {fmtCompact(c.livePace)}
                      </small>
                    ) : null}
                  </td>
                  <td className="bars-col">
                    <VolumeBars bars={c.bars} recentWindow={settings.recentWindowMinutes} />
                  </td>
                  <td className="right mono dim">{fmtCompact(c.quoteVolume24h)}</td>
                  <td className="center">
                    {c.held ? (
                      <span className="badge badge-hold">보유 중</span>
                    ) : c.cooldownLeftMin > 0 ? (
                      <span className="badge badge-cool">쿨다운 {c.cooldownLeftMin}분</span>
                    ) : (
                      <span className="badge badge-ready">진입 가능</span>
                    )}
                  </td>
                  <td className="right" onClick={(e) => e.stopPropagation()}>
                    <button
                      className="btn btn-xs"
                      disabled={c.held || c.cooldownLeftMin > 0 || (hover !== c.symbol && !settings.autoTrade)}
                      onClick={() => onManualBuy(c.symbol)}
                      title={c.held ? '이미 보유 중' : `${fmtUsd(settings.positionSizeUSDT)} USDT 가상 매수`}
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

      <CandidateList
        open={fullOpen}
        onClose={() => setFullOpen(false)}
        settings={settings}
        live={live}
        selected={selected}
        onSelect={(s) => { onSelect(s); }}
        onManualBuy={onManualBuy}
      />
    </section>
  );
}
