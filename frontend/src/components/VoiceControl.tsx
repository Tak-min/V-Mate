import type { VoiceMode } from '../features/chat/useCompanion';

interface Props {
  supported: boolean;
  mode: VoiceMode;
  partial: string;
  error: string | null;
  onToggle: () => void;
  onInterrupt: () => void;
}

const STATUS_LABEL: Record<Exclude<VoiceMode, 'off'>, string> = {
  listening: '聞いてるよ',
  thinking: '考えてる…',
  speaking: '話してる',
};

export function VoiceControl({ supported, mode, partial, error, onToggle, onInterrupt }: Props) {
  const active = mode !== 'off';
  const canInterrupt = mode === 'thinking' || mode === 'speaking';

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
          {partial ? (
            <p className="voice-partial">{partial}</p>
          ) : (
            mode === 'listening' && <p className="voice-hint">そのまま話しかけてね</p>
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
