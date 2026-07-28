import { useState, useCallback, useEffect } from 'react';
import { useCompanion } from './features/chat/useCompanion';
import { AuthBar } from './components/AuthBar';
import { ChatPanel } from './components/ChatPanel';
import { DiaryDrawer } from './components/DiaryDrawer';
import { OnboardingOverlay } from './components/OnboardingOverlay';
import { StatusBar } from './components/StatusBar';
import { VoiceControl } from './components/VoiceControl';
import { isFirstVisit, isOnboardingComplete } from './features/chat/onboarding';
import { fetchAge, type AgeBand } from './features/chat/api';

export default function App() {
  const [ageBand, setAgeBand] = useState<AgeBand | null | undefined>(undefined);
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
    stageUp,
    voiceMode,
    partialTranscript,
    voiceSupported,
    voiceError,
    whisperLoadState,
    noticeInputActivity,
    send,
    saveName,
    toggleVoice,
    toggleVoiceMode,
    interrupt,
    fireGreeting,
    capturePhoto,
  } = useCompanion(ageBand === 'minor' || ageBand === 'adult');
  const [diaryOpen, setDiaryOpen] = useState(false);
  // Capture firstVisit at mount time BEFORE onboarding can mark it via completeOnboarding().
  const [wasFirstVisit] = useState(() => isFirstVisit());
  const [onboardingDone, setOnboardingDone] = useState(isOnboardingComplete());

  useEffect(() => {
    fetchAge()
      .then((status) => setAgeBand(status.age_band))
      .catch(() => setAgeBand(null));
  }, []);

  const handleOnboardingComplete = useCallback((name?: string) => {
    if (name) saveName(name);
    setOnboardingDone(true);
    fireGreeting(wasFirstVisit);
  }, [saveName, fireGreeting, wasFirstVisit]);

  const handleCapture = useCallback(async () => {
    const blob = await capturePhoto();
    if (!blob) return;
    const file = new File([blob], `シロ_${Date.now()}.png`, { type: 'image/png' });
    try {
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title: 'シロ' });
        return;
      }
    } catch {
      // ユーザーがシェアをキャンセルした場合(AbortError)は何もしない。
      return;
    }
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = file.name;
    link.click();
    URL.revokeObjectURL(url);
  }, [capturePhoto]);

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

      {ageBand === undefined && (
        <div className="onboarding-backdrop">
          <div className="onboarding-card" role="status">
            <p className="onboarding-subtitle">利用情報を確認しています…</p>
          </div>
        </div>
      )}
      {ageBand !== undefined && (ageBand === null || ageBand === 'under13' || !onboardingDone) && (
        <OnboardingOverlay
          ageBand={ageBand}
          onAgeVerified={setAgeBand}
          onComplete={handleOnboardingComplete}
        />
      )}
      <AuthBar />
      <StatusBar state={state} isStageUp={stageUp} onSaveName={saveName} />

      <div className="toolbar">
        <VoiceControl
          supported={voiceSupported}
          mode={voiceMode}
          partial={partialTranscript}
          error={voiceError}
          whisperLoadState={whisperLoadState}
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
        <button
          type="button"
          className="icon-button"
          onClick={handleCapture}
          title="写真を撮る"
        >
          📷
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
