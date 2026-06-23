import { FormEvent, useEffect, useRef, useState } from 'react';
import type { CompanionState } from '../features/chat/types';

interface Props {
  state: CompanionState | null;
  onSaveName: (name: string) => Promise<void>;
}

// worker/src/persona.ts の AFFINITY_STAGES をミラー(段内進捗・次段階名の計算に必要)。
const STAGE_FLOORS = [0, 20, 50, 100, 200];
const STAGE_NAMES = ['はじめまして', '顔なじみ', '友達', '親友', '相棒'];

function stageProgress(affinity: number, nextStageAt: number | null): number {
  if (nextStageAt == null) return 1;
  const floor = [...STAGE_FLOORS].reverse().find((threshold) => affinity >= threshold) ?? 0;
  const span = nextStageAt - floor;
  if (span <= 0) return 1;
  return Math.min(Math.max((affinity - floor) / span, 0), 1);
}

function nextStageName(nextStageAt: number | null): string | null {
  if (nextStageAt == null) return null;
  const index = STAGE_FLOORS.indexOf(nextStageAt);
  return index >= 0 ? STAGE_NAMES[index] : null;
}

const STAGE_UP_DURATION_MS = 2400;

export function StatusBar({ state, onSaveName }: Props) {
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [isStageUp, setIsStageUp] = useState(false);
  const previousStageRef = useRef<string | null>(null);

  useEffect(() => {
    if (!state) return;
    const previousStage = previousStageRef.current;
    if (previousStage !== null && previousStage !== state.stage) {
      setIsStageUp(true);
      const timer = setTimeout(() => setIsStageUp(false), STAGE_UP_DURATION_MS);
      previousStageRef.current = state.stage;
      return () => clearTimeout(timer);
    }
    previousStageRef.current = state.stage;
  }, [state?.stage]);

  const progress = state ? stageProgress(state.affinity, state.next_stage_at) : 1;
  const remainingToNext =
    state?.next_stage_at != null ? Math.max(state.next_stage_at - state.affinity, 0) : null;
  const upcomingStageName = state ? nextStageName(state.next_stage_at) : null;

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
            <span
              className={isStageUp ? 'affinity-fill affinity-fill-stage-up' : 'affinity-fill'}
              style={{ width: `${progress * 100}%` }}
            />
          </span>
          <span className="affinity-score">♡ {state.affinity}</span>
          {isStageUp ? (
            <span className="affinity-next affinity-stage-up-text">『{state.stage}』になったよ</span>
          ) : (
            remainingToNext != null &&
            upcomingStageName && (
              <span className="affinity-next">あと{remainingToNext}で『{upcomingStageName}』</span>
            )
          )}
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
