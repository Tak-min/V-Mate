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
    loadError,
    voiceEnabled,
    condition,
    userTurns,
    daysAway,
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

  return (
    <div className={`app condition-${condition ?? 'loading'}`}>
      <div className="stage">
        {/* 本番では研究条件に関わらず常にシロを表示する(canvasは常設)。 */}
        <canvas ref={canvasRef} className="vrm-canvas" />
        {!ready && !loadError && (
          <div className="loading" role="status">
            <div className="loading-ring" />
            <p>シロを起こしてる… {Math.round(loadProgress * 100)}%</p>
          </div>
        )}
        {loadError && (
          <div className="loading load-error" role="alert">
            <p>シロの読み込みに失敗しました。</p>
            <button type="button" className="retry-button" onClick={() => window.location.reload()}>
              再読み込み
            </button>
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
        state={state}
        daysAway={daysAway}
        voiceMode={voiceMode}
        onInputActivity={noticeInputActivity}
        onSend={send}
        onOpenDiary={() => setDiaryOpen(true)}
      />
      <ResearchSurvey visible={userTurns >= 2} onSubmit={submitSurvey} />
      <DiaryDrawer open={diaryOpen} onClose={() => setDiaryOpen(false)} />
    </div>
  );
}
