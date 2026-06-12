import { FormEvent, useState } from 'react';
import type { CompanionState } from '../features/chat/types';

interface Props {
  state: CompanionState | null;
  onSaveName: (name: string) => Promise<void>;
}

export function StatusBar({ state, onSaveName }: Props) {
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);

  const progress =
    state?.next_stage_at != null
      ? Math.min(state.affinity / state.next_stage_at, 1)
      : 1;

  const submitName = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    try {
      await onSaveName(name.trim());
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="status-bar">
      <div className="brand">
        <span className="brand-mark">Aikata</span>
        <span className="brand-sub">シロ</span>
      </div>
      {state && (
        <div className="affinity" title={`親密度 ${state.affinity}`}>
          <span className="affinity-stage">{state.stage}</span>
          <span className="affinity-track" role="progressbar" aria-valuenow={state.affinity}>
            <span className="affinity-fill" style={{ width: `${progress * 100}%` }} />
          </span>
          <span className="affinity-score">♡ {state.affinity}</span>
        </div>
      )}
      {state && !state.user_name && (
        <form className="name-form" onSubmit={submitName}>
          <input
            type="text"
            value={name}
            maxLength={40}
            placeholder="呼んでほしい名前は?"
            onChange={(event) => setName(event.target.value)}
            aria-label="名前"
          />
          <button type="submit" disabled={saving || !name.trim()}>
            教える
          </button>
        </form>
      )}
    </div>
  );
}
