import { useState } from 'react';
import { useCompanion } from './features/chat/useCompanion';
import { AuthBar } from './components/AuthBar';
import { ChatPanel } from './components/ChatPanel';
import { DiaryDrawer } from './components/DiaryDrawer';
import { ResearchSurvey } from './components/ResearchSurvey';
import { StatusBar } from './components/StatusBar';
import { VoiceControl } from './components/VoiceControl';

export default function App() {
  const {
    canvasRef,
    messages,
    state,
    busy,
    ready,
    loadProgress,
    voiceEnabled,
    condition,
    userTurns,
    voiceMode,
    partialTranscript,
    voiceSupported,
    voiceError,
    noticeInputActivity,
    send,
    saveName,
    toggleVoice,
    toggleVoiceMode,
    interrupt,
    submitSurvey,
  } = useCompanion();
  const [diaryOpen, setDiaryOpen] = useState(false);
  const visualBodyEnabled = condition !== 'text';

  return (
    <div className={`app condition-${condition ?? 'loading'}`}>
      <div className={`stage${visualBodyEnabled ? '' : ' stage-text-only'}`}>
        {visualBodyEnabled && <canvas ref={canvasRef} className="vrm-canvas" />}
        {condition && !visualBodyEnabled && (
          <div className="text-only-presence" aria-hidden="true">
            <span className="text-only-pulse" />
          </div>
        )}
        {condition && !ready && (
          <div className="loading" role="status">
            <div className="loading-ring" />
            <p>シロを起こしてる… {Math.round(loadProgress * 100)}%</p>
          </div>
        )}
      </div>

      <AuthBar />
      <StatusBar state={state} onSaveName={saveName} />

      <div className="toolbar">
        <VoiceControl
          supported={voiceSupported}
          mode={voiceMode}
          partial={partialTranscript}
          error={voiceError}
          onToggle={toggleVoiceMode}
          onInterrupt={interrupt}
        />
        <button
          type="button"
          className={`icon-button${voiceEnabled ? ' active' : ''}`}
          onClick={toggleVoice}
          aria-pressed={voiceEnabled}
          title={voiceEnabled ? '声をオフにする' : '声をオンにする'}
        >
          {voiceEnabled ? '🔊' : '🔇'}
        </button>
        <button
          type="button"
          className={`icon-button${diaryOpen ? ' active' : ''}`}
          onClick={() => setDiaryOpen((prev) => !prev)}
          aria-pressed={diaryOpen}
          title={diaryOpen ? '日記を閉じる' : 'シロの日記を読む'}
        >
          📔
        </button>
      </div>

      <ChatPanel
        messages={messages}
        busy={busy}
        onInputActivity={noticeInputActivity}
        onSend={send}
      />
      <ResearchSurvey visible={userTurns >= 2} onSubmit={submitSurvey} />
      <DiaryDrawer open={diaryOpen} onClose={() => setDiaryOpen(false)} />
    </div>
  );
}
