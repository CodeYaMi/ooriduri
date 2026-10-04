const ICON = { buy: '▲', profit: '✓', loss: '✕', info: 'i', warn: '!' };

export function Toasts({ toasts }) {
  if (!toasts.length) return null;
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.level}`}>
          <span className="toast-icon">{ICON[t.level] ?? 'i'}</span>
          <span className="toast-text">{t.text}</span>
        </div>
      ))}
    </div>
  );
}
