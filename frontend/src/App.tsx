import { useState } from 'react';
import { useCompanion } from './features/chat/useCompanion';
import { ChatPanel } from './components/ChatPanel';
import { DiaryDrawer } from './components/DiaryDrawer';
import { StatusBar } from './components/StatusBar';

export default function App() {
  const {
    canvasRef,
    messages,
    state,
    busy,
    ready,
    loadProgress,
    voiceEnabled,
    send,
    saveName,
    toggleVoice,
  } = useCompanion();
  const [diaryOpen, setDiaryOpen] = useState(false);

  return (
    <div className="app">
      <div className="stage">
        <canvas ref={canvasRef} className="vrm-canvas" />
        {!ready && (
          <div className="loading" role="status">
            <div className="loading-ring" />
            <p>シロを起こしてる… {Math.round(loadProgress * 100)}%</p>
          </div>
        )}
      </div>

      <StatusBar state={state} onSaveName={saveName} />

      <div className="toolbar">
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
          className="icon-button"
          onClick={() => setDiaryOpen(true)}
          title="シロの日記を読む"
        >
          📔
        </button>
      </div>

      <ChatPanel messages={messages} busy={busy} onSend={send} />
      <DiaryDrawer open={diaryOpen} onClose={() => setDiaryOpen(false)} />
    </div>
  );
}
