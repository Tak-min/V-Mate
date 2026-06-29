import { useState, useCallback } from 'react';
import { useCompanion } from './features/chat/useCompanion';
import { AuthBar } from './components/AuthBar';
import { ChatPanel } from './components/ChatPanel';
import { DiaryDrawer } from './components/DiaryDrawer';
import { OnboardingOverlay } from './components/OnboardingOverlay';
import { StatusBar } from './components/StatusBar';
import { VoiceControl } from './components/VoiceControl';
import { isFirstVisit, isOnboardingComplete } from './features/chat/onboarding';

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
    fireGreeting,
  } = useCompanion();
  const [diaryOpen, setDiaryOpen] = useState(false);
  // Capture firstVisit at mount time BEFORE onboarding can mark it via completeOnboarding().
  const [wasFirstVisit] = useState(() => isFirstVisit());
  const [onboardingDone, setOnboardingDone] = useState(isOnboardingComplete());

  const handleOnboardingComplete = useCallback((name?: string) => {
    if (name) saveName(name);
    setOnboardingDone(true);
    fireGreeting(wasFirstVisit);
  }, [saveName, fireGreeting, wasFirstVisit]);

  return (
    <div className="app">
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

      {!onboardingDone && <OnboardingOverlay onComplete={handleOnboardingComplete} />}
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
      <DiaryDrawer open={diaryOpen} onClose={() => setDiaryOpen(false)} />
    </div>
  );
}
