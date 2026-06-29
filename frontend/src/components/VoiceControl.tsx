import { useRef } from 'react';
import type { VoiceMode } from '../features/chat/useCompanion';
import type { WhisperLoadState } from '../features/voice/recognition';

interface Props {
  supported: boolean;
  mode: VoiceMode;
  partial: string;
  error: string | null;
  whisperLoadState: WhisperLoadState;
  onToggle: () => void;
  onInterrupt: () => void;
}

const STATUS_LABEL: Record<Exclude<VoiceMode, 'off'>, string> = {
  listening: '聞いてるよ',
  thinking: '考えてる…',
  speaking: '話してる',
};

const VOICE_ONBOARDING_SEEN_KEY = 'vmate.voiceOnboardingSeen';

function hasSeenVoiceOnboarding(): boolean {
  try {
    return window.localStorage.getItem(VOICE_ONBOARDING_SEEN_KEY) === '1';
  } catch {
    return false;
  }
}

function markVoiceOnboardingSeen(): void {
  try {
    window.localStorage.setItem(VOICE_ONBOARDING_SEEN_KEY, '1');
  } catch {
    // localStorageが使えない環境では毎回出るだけで、機能に影響しない
  }
}

export function VoiceControl({ supported, mode, partial, error, whisperLoadState, onToggle, onInterrupt }: Props) {
  const active = mode !== 'off';
  const canInterrupt = mode === 'thinking' || mode === 'speaking';
  const showOnboardingRef = useRef<boolean | null>(null);

  if (active && showOnboardingRef.current === null) {
    showOnboardingRef.current = !hasSeenVoiceOnboarding();
    if (showOnboardingRef.current) {
      markVoiceOnboardingSeen();
    }
  }
  const showOnboarding = active && showOnboardingRef.current === true;

  return (
    <div className="voice-control">
      <button
        type="button"
        className={`icon-button voice-mic${active ? ' active' : ''}${
          active && mode === 'listening' ? ' pulsing' : ''
        }`}
        onClick={onToggle}
        aria-pressed={active}
        disabled={!supported}
        title={
          !supported
            ? '音声入力に未対応のブラウザです(Chrome / Edge 推奨)'
            : active
              ? '会話モードをやめる'
              : 'マイクで話しかける(会話モード)'
        }
      >
        {active ? '🎙️' : '🎤'}
      </button>

      {active && (
        <div className="voice-hud" role="status" aria-live="polite">
          <span className={`voice-status voice-status-${mode}`} data-mode={mode}>
            <span className="voice-status-dot" />
            {STATUS_LABEL[mode]}
          </span>
          {whisperLoadState === 'loading' && (
            <p className="voice-whisper-loading">音声認識モデルを読み込み中…</p>
          )}
          {showOnboarding && (
            <p className="voice-onboarding">
              話し終えたら少し待つと、シロが応えるよ。「とめて話す」で割り込めるよ
            </p>
          )}
          {partial ? (
            <p className="voice-partial">{partial}</p>
          ) : (
            mode === 'listening' && whisperLoadState !== 'loading' && (
              <p className="voice-hint">そのまま話しかけてね</p>
            )
          )}
          {canInterrupt && (
            <button type="button" className="voice-interrupt" onClick={onInterrupt}>
              とめて話す
            </button>
          )}
        </div>
      )}

      {error && !active && <p className="voice-error">{error}</p>}
    </div>
  );
}
