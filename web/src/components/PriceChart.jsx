import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { fmtPrice, fmtPct, pnlClass } from '../lib/format.js';

const INTERVALS = [
  { value: '1m', label: '1분' },
  { value: '5m', label: '5분' },
  { value: '15m', label: '15분' },
];

/**
 * 선택 종목의 실시간 가격 차트.
 * REST 분봉으로 몸통을 채우고, WebSocket 실시간 가격을 오른쪽 끝에 이어 붙인다.
 * 진입가 기준 익절/손절 라인도 함께 그린다.
 */
export function PriceChart({ symbol, livePrice, takeProfitPct, stopLossPct }) {
  const [interval, setInterval_] = useState('1m');
  const [candles, setCandles] = useState([]);
  const [meta, setMeta] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  const canvasRef = useRef(null);
  const dataRef = useRef({ candles: [], tp: takeProfitPct, sl: stopLossPct, livePrice: 0 });

  // ref 는 렌더 중 갱신해 rAF 루프가 항상 최신 값을 보게 한다
  dataRef.current = { candles, tp: takeProfitPct, sl: stopLossPct, livePrice };

  useEffect(() => {
    if (!symbol) {
      setCandles([]);
      setMeta(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .klines(symbol, interval, 150)
      .then(({ klines }) => {
        if (cancelled) return;
        setCandles(klines);
        setMeta(
          klines.length
            ? {
                changePct: ((klines.at(-1).close - klines[0].open) / klines[0].open) * 100,
                high: Math.max(...klines.map((k) => k.high)),
                low: Math.min(...klines.map((k) => k.low)),
                volume: klines.reduce((a, k) => a + k.quoteVolume, 0),
              }
            : null,
        );
      })
      .catch((err) => !cancelled && setError(err.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [symbol, interval]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const render = () => {
      const { candles: cs, tp, sl, livePrice: lp } = dataRef.current;
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (!w || !h) return; // 아직 레이아웃 전

      const needW = Math.round(w * dpr);
      const needH = Math.round(h * dpr);
      if (canvas.width !== needW || canvas.height !== needH) {
        canvas.width = needW;
        canvas.height = needH;
      }

      const ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      if (cs.length < 2) return;

      const pad = { top: 12, right: 66, bottom: 16, left: 8 };
      const plotW = Math.max(10, w - pad.left - pad.right);
      const plotH = Math.max(10, h - pad.top - pad.bottom);

      // 분봉 + 실시간 가격을 이어 붙인다
      const series = cs.map((c) => c.close);
      if (Number.isFinite(lp) && lp > 0) series.push(lp);

      const first = series[0];
      const last = series.at(-1);
      const up = last >= first;
      const color = up ? '#22c55e' : '#ef4444';

      // 진입가 기준선: 마지막 확정봉 종가를 진입가로 간주
      const entry = cs.at(-1)?.close ?? first;
      const tpLine = entry * (1 + (tp ?? 10) / 100);
      const slLine = entry * (1 - (sl ?? 5) / 100);

      const lo = Math.min(...series, slLine);
      const hi = Math.max(...series, tpLine);
      const range = hi - lo || Math.abs(hi) * 0.01 || 1;
      const y = (v) => pad.top + plotH - ((v - lo) / range) * plotH;
      const x = (i) => pad.left + (i / (series.length - 1 || 1)) * plotW;

      // 손절 / 익절 영역
      ctx.fillStyle = 'rgba(239, 68, 68, 0.07)';
      ctx.fillRect(pad.left, y(slLine), plotW, pad.top + plotH - y(slLine));
      ctx.fillStyle = 'rgba(34, 197, 94, 0.07)';
      ctx.fillRect(pad.left, pad.top, plotW, y(tpLine) - pad.top);

      // 가격 라인
      ctx.beginPath();
      series.forEach((v, i) => (i === 0 ? ctx.moveTo(x(i), y(v)) : ctx.lineTo(x(i), y(v))));
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.6;
      ctx.lineJoin = 'round';
      ctx.stroke();

      // 영역 채우기
      const grad = ctx.createLinearGradient(0, pad.top, 0, pad.top + plotH);
      grad.addColorStop(0, up ? 'rgba(34,197,94,0.26)' : 'rgba(239,68,68,0.26)');
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.lineTo(x(series.length - 1), pad.top + plotH);
      ctx.lineTo(x(0), pad.top + plotH);
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();

      // 기준선 + 라벨
      const line = (value, stroke, label) => {
        const ly = y(value);
        ctx.setLineDash([4, 4]);
        ctx.strokeStyle = stroke;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(pad.left, ly);
        ctx.lineTo(pad.left + plotW, ly);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = stroke;
        ctx.font = '10px ui-monospace, SFMono-Regular, monospace';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, pad.left + plotW + 6, Math.min(pad.top + plotH - 6, Math.max(pad.top + 6, ly)));
      };
      line(tpLine, '#22c55e', `TP +${tp}%`);
      line(entry, '#94a3b8', 'entry');
      line(slLine, '#ef4444', `SL −${sl}%`);

      // 현재가 마커
      const mx = x(series.length - 1);
      const my = y(last);
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.3;
      ctx.beginPath();
      ctx.arc(mx, my, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.beginPath();
      ctx.arc(mx, my, 2.5, 0, Math.PI * 2);
      ctx.fill();
    };

    // rAF 에 의존하지 않고 즉시 1회 렌더 (백그라운드 탭에서도 그려지도록)
    render();

    const onVisible = () => {
      if (document.visibilityState === 'visible') render();
    };
    document.addEventListener('visibilitychange', onVisible);

    const observer = new ResizeObserver(() => render());
    observer.observe(canvas);

    let raf = requestAnimationFrame(function loop() {
      render();
      raf = requestAnimationFrame(loop);
    });

    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [candles.length, takeProfitPct, stopLossPct]);

  if (!symbol) {
    return (
      <section className="panel chart-panel">
        <div className="panel-head">
          <h2>실시간 가격 차트</h2>
        </div>
        <div className="empty-state small">
          <div className="empty-icon">◧</div>
          <p>후보 종목이나 보유 포지션을 선택하면 실시간 차트가 표시됩니다.</p>
        </div>
      </section>
    );
  }

  const lastCandle = candles.at(-1);
  const price = livePrice ?? lastCandle?.close;
  const delta = lastCandle ? price - lastCandle.close : 0;

  return (
    <section className="panel chart-panel">
      <div className="panel-head">
        <div className="chart-title">
          <h2>
            {symbol.replace(/USDT$/, '')}
            <small>/USDT · {INTERVALS.find((i) => i.value === interval)?.label}</small>
          </h2>
          <div className="chart-price">
            <strong className={pnlClass(delta)}>{fmtPrice(price)}</strong>
            {meta ? <span className={pnlClass(meta.changePct)}>{fmtPct(meta.changePct)}</span> : null}
          </div>
        </div>
        <div className="panel-head-right">
          {meta ? (
            <div className="chart-ohlc">
              <span>
                고 <b>{fmtPrice(meta.high)}</b>
              </span>
              <span>
                저 <b>{fmtPrice(meta.low)}</b>
              </span>
              <span>
                거래대금 <b>{(meta.volume / 1e6).toFixed(1)}M</b>
              </span>
            </div>
          ) : null}
          <div className="segmented">
            {INTERVALS.map((i) => (
              <button key={i.value} className={interval === i.value ? 'on' : ''} onClick={() => setInterval_(i.value)}>
                {i.label}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="canvas-wrap">
        <canvas ref={canvasRef} />
        {loading ? <div className="chart-loading">불러오는 중…</div> : null}
        {error ? <div className="chart-loading err">{error}</div> : null}
      </div>
    </section>
  );
}
