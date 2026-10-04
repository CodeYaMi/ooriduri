import { useEffect, useMemo, useState } from 'react';
import { GROUPS_HINT, isBoolField } from './settingsMeta.js';

const fmtNumber = (n, step) => {
  if (!Number.isFinite(n)) return '';
  const decimals = step >= 1 ? 0 : step >= 0.1 ? 1 : 2;
  return Number(n.toFixed(decimals)).toLocaleString('en-US', { maximumFractionDigits: decimals });
};

/** 필드 한 줄 */
function Field({ name, def, value, onChange }) {
  const id = `f-${name}`;

  if (def.bool) {
    return (
      <label className="field field-bool" htmlFor={id}>
        <div className="field-text">
          <span className="field-label">{def.label}</span>
          {def.help ? <small>{def.help}</small> : null}
        </div>
        <div className="switch">
          <input id={id} type="checkbox" checked={Boolean(value)} onChange={(e) => onChange(name, e.target.checked ? 1 : 0)} />
          <i />
        </div>
      </label>
    );
  }

  const hasSuffix = def.suffix && def.suffix !== '';
  return (
    <div className="field">
      <div className="field-text">
        <label className="field-label" htmlFor={id}>
          {def.label}
        </label>
        {def.help ? <small>{def.help}</small> : null}
      </div>
      <div className="field-input">
        <input
          id={id}
          type="number"
          inputMode="decimal"
          min={def.min}
          max={def.max}
          step={def.step}
          value={value ?? ''}
          onChange={(e) => onChange(name, e.target.value === '' ? '' : Number(e.target.value))}
        />
        {hasSuffix ? <span className="suffix">{def.suffix}</span> : null}
      </div>
    </div>
  );
}

export function SettingsModal({ open, config, current, onClose, onSave, onResetDefaults, busy }) {
  const [draft, setDraft] = useState(current);
  const [error, setError] = useState(null);

  // 다이얼로그가 "열릴 때만" 서버 값을 초깃값으로 가져온다.
  // current 는 1초마다 새 스냅샷으로 교체되므로 current 를 의존성으로 두면
  // 사용자가 입력 중인 값이 매초 초기화된다.
  useEffect(() => {
    if (open) {
      setDraft({ ...current });
      setError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const dirty = useMemo(
    () => (draft && current ? Object.keys(current).some((k) => Number(draft[k]) !== Number(current[k])) : false),
    [draft, current],
  );

  if (!open || !config) return null;

  const { schema, groups, defaults } = config;
  const setValue = (name, value) => setDraft((prev) => ({ ...prev, [name]: value }));

  const validate = () => {
    const bad = Object.entries(schema).find(([key, def]) => {
      if (isBoolField(def)) return false;
      const v = draft[key];
      if (v === '' || v === null || !Number.isFinite(Number(v))) return true;
      return Number(v) < def.min || Number(v) > def.max;
    });
    if (bad) {
      setError(`${bad[1].label} 값이 유효하지 않습니다. (허용: ${bad[1].min} ~ ${bad[1].max})`);
      return false;
    }
    setError(null);
    return true;
  };

  const submit = (e) => {
    e?.preventDefault?.();
    if (!validate()) return;
    const payload = Object.fromEntries(
      Object.entries(draft).map(([k, v]) => [k, isBoolField(schema[k]) ? Number(v) : Number(v)]),
    );
    onSave(payload);
  };

  const keyPreview = [
    { label: '익절', value: draft.takeProfitPct, tone: 'up' },
    { label: '손절', value: draft.stopLossPct, tone: 'down' },
    { label: '최대 보유', value: draft.maxPositions, tone: '' },
  ];

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="설정">
        <div className="modal-head">
          <div>
            <h2>설정</h2>
            <p>수익·손절 기준과 급등 탐지 조건을 자유롭게 조정할 수 있습니다.</p>
          </div>
          <button className="btn btn-ghost btn-icon" onClick={onClose} aria-label="닫기">
            ✕
          </button>
        </div>

        <form onSubmit={submit} className="modal-body">
          <div className="preview-strip">
            {keyPreview.map((k) => (
              <div key={k.label} className={`preview-item ${k.tone}`}>
                <span>{k.label}</span>
                <strong>
                  {k.tone === 'down' ? '−' : k.tone === 'up' ? '+' : ''}
                  {k.value ?? '—'}
                  {k.tone === '' ? '' : '%'}
                </strong>
              </div>
            ))}
            <div className="preview-note">
              변경값은 <b>즉시</b> 서버에 반영되어 다음 틱부터 적용됩니다.
            </div>
          </div>

          {GROUPS_HINT.map((group) => (
            <fieldset key={group.id} className="group">
              <legend>
                <span>{group.name}</span>
                <small>{group.desc}</small>
              </legend>
              <div className="group-fields">
                {groups.filter((g) => g.id === group.id).flatMap((g) => Object.entries(schema).filter(([, def]) => def.group === group.id)).map(([key, def]) => (
                  <Field key={key} name={key} def={def} value={draft[key]} onChange={setValue} />
                ))}
              </div>
            </fieldset>
          ))}

          {error ? <div className="banner banner-error">{error}</div> : null}
        </form>

        <div className="modal-foot">
          <button type="button" className="btn btn-ghost" onClick={() => setDraft({ ...defaults })}>
            기본값 불러오기
          </button>
          <div className="spacer" />
          <button type="button" className="btn" onClick={onClose}>
            취소
          </button>
          <button type="button" className="btn btn-ghost" onClick={onResetDefaults} disabled={busy}>
            전체 초기화
          </button>
          {/* 이 버튼은 <form> 바깥(.modal-foot)에 있으므로 type="submit" 으로는 제출되지 않는다 */}
          <button type="button" className="btn btn-primary" onClick={() => submit()} disabled={busy || !dirty}>
            {busy ? '저장 중…' : dirty ? '저장' : '저장됨'}
          </button>
        </div>
      </div>
    </div>
  );
}
