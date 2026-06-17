import { FormEvent, useEffect, useRef, useState } from 'react';
import type { ChatMessage, Emotion } from '../features/chat/types';

const EMOTION_EMOJI: Record<Emotion, string> = {
  neutral: '',
  happy: '😊',
  sad: '🥺',
  angry: '😤',
  relaxed: '😌',
  shy: '😳',
};

interface Props {
  messages: ChatMessage[];
  busy: boolean;
  onInputActivity: () => void;
  onSend: (text: string) => void;
}

export function ChatPanel({ messages, busy, onInputActivity, onSend }: Props) {
  const [draft, setDraft] = useState('');
  const logRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    logRef.current?.scrollTo({
      top: logRef.current.scrollHeight,
      behavior: 'smooth',
    });
  }, [messages]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!draft.trim() || busy) return;
    onSend(draft);
    setDraft('');
  };

  return (
    <section className="chat-panel" aria-label="シロとのチャット">
      <div className="chat-log" ref={logRef}>
        {messages.length === 0 && (
          <p className="chat-empty">
            シロに話しかけてみよう。今日あったこと、好きなもの、なんでも。
          </p>
        )}
        {messages.map((message, index) => (
          <div
            key={index}
            className={`bubble bubble-${message.role}${
              message.role === 'assistant' && !message.content ? ' bubble-typing' : ''
            }`}
          >
            {message.role === 'assistant' && !message.content ? (
              <span className="typing-state" aria-live="polite">
                {message.cue && <span className="typing-cue">{message.cue}</span>}
                <span className="typing-dots" aria-label="入力中">
                  <i /><i /><i />
                </span>
              </span>
            ) : (
              <>
                {message.content}
                {message.role === 'assistant' && message.emotion && (
                  <span className="bubble-emotion">
                    {EMOTION_EMOJI[message.emotion]}
                  </span>
                )}
              </>
            )}
          </div>
        ))}
      </div>
      <form className="chat-input" onSubmit={submit}>
        <input
          type="text"
          value={draft}
          placeholder="メッセージを書く…"
          maxLength={2000}
          onFocus={onInputActivity}
          onChange={(event) => {
            setDraft(event.target.value);
            onInputActivity();
          }}
          aria-label="メッセージ入力"
        />
        <button type="submit" disabled={busy || !draft.trim()} aria-label="送信">
          ➤
        </button>
      </form>
    </section>
  );
}
