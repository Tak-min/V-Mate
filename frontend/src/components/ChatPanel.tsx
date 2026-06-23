import { FormEvent, useEffect, useRef, useState } from 'react';
import { fetchDiary } from '../features/chat/api';
import type { VoiceMode } from '../features/chat/useCompanion';
import type { ChatMessage, CompanionState, DiaryEntry, Emotion } from '../features/chat/types';

const EMOTION_EMOJI: Record<Emotion, string> = {
  neutral: '',
  happy: '😊',
  sad: '🥺',
  angry: '😤',
  relaxed: '😌',
  shy: '😳',
};

const NEW_VISITOR_STAGE = 'はじめまして';

const TIME_OF_DAY_PROMPTS = {
  morning: ['おはよう、今日はどんな一日にする?', '朝ごはん食べた?'],
  daytime: ['今日あったことを話したいな', 'いま何してるの?'],
  evening: ['今日も一日お疲れさま。何があった?', '夕方になると少し落ち着くね。今の気分は?'],
  night: ['もう遅い時間だね。眠れてる?', '今日のこと、寝る前に少し話そうか'],
} as const;

const NEW_VISITOR_PROMPTS = ['好きな食べ物は?', 'はじめまして、よろしくね。何て呼んだらいい?'];

const FAMILIAR_PROMPTS = ['少し元気がないの聞いてほしいな', '前に話してたこと、また聞きたいな'];

const FOLLOW_UP_PROMPTS: Record<Emotion, string[]> = {
  neutral: ['もう少し詳しく聞かせて', '他にはどんなことがあった?'],
  happy: ['それいいね、もっと聞きたいな', 'どんなところが楽しかった?'],
  sad: ['つらかったね、もう少し話してもいいよ', 'いま気分はどう?'],
  angry: ['それは大変だったね、何があったの?', 'もう少し聞かせてくれる?'],
  relaxed: ['いい感じだね、他には何かあった?', 'のんびりできてよかったね'],
  shy: ['恥ずかしがらなくて大丈夫だよ', 'ゆっくり話してくれていいよ'],
};

function buildFollowUps(messages: ChatMessage[]): string[] {
  const lastAssistant = [...messages].reverse().find((message) => message.role === 'assistant' && message.content);
  if (!lastAssistant) return [];
  return FOLLOW_UP_PROMPTS[lastAssistant.emotion ?? 'neutral'];
}

const DIARY_CALLBACK_PREVIEW_LENGTH = 36;

function previewDiaryEntry(entry: DiaryEntry): string {
  const trimmed = entry.content.trim();
  if (trimmed.length <= DIARY_CALLBACK_PREVIEW_LENGTH) return trimmed;
  return `${trimmed.slice(0, DIARY_CALLBACK_PREVIEW_LENGTH)}…`;
}

function timeBucketFor(now: Date): keyof typeof TIME_OF_DAY_PROMPTS {
  const hour = now.getHours();
  if (hour >= 5 && hour < 10) return 'morning';
  if (hour >= 10 && hour < 17) return 'daytime';
  if (hour >= 17 && hour < 21) return 'evening';
  return 'night';
}

function buildStarters(state: CompanionState | null, now: Date): string[] {
  const timePrompts = TIME_OF_DAY_PROMPTS[timeBucketFor(now)];
  const isNewVisitor = !state || state.stage === NEW_VISITOR_STAGE;
  const tailoredPrompts = isNewVisitor ? NEW_VISITOR_PROMPTS : FAMILIAR_PROMPTS;
  return [...timePrompts, ...tailoredPrompts];
}

interface Props {
  messages: ChatMessage[];
  busy: boolean;
  state: CompanionState | null;
  daysAway: number | null;
  voiceMode: VoiceMode;
  onInputActivity: () => void;
  onSend: (text: string) => void;
  onOpenDiary: () => void;
}

export function ChatPanel({ messages, busy, state, daysAway, voiceMode, onInputActivity, onSend, onOpenDiary }: Props) {
  const [draft, setDraft] = useState('');
  const [latestDiaryEntry, setLatestDiaryEntry] = useState<DiaryEntry | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);
  const starterPrompts = buildStarters(state, new Date());
  const showFollowUps = messages.length > 0 && !busy && voiceMode === 'off';
  const followUpPrompts = showFollowUps ? buildFollowUps(messages) : [];

  useEffect(() => {
    logRef.current?.scrollTo({
      top: logRef.current.scrollHeight,
      behavior: 'smooth',
    });
  }, [messages]);

  useEffect(() => {
    fetchDiary()
      .then(({ entries }) => setLatestDiaryEntry(entries[0] ?? null))
      .catch(() => setLatestDiaryEntry(null));
  }, []);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!draft.trim() || busy) return;
    onSend(draft);
    setDraft('');
  };

  return (
    <section className="chat-panel" aria-label="シロとのチャット">
      {daysAway !== null && (
        <p className="chat-welcome-back">おかえり。{daysAway}日ぶりだね。</p>
      )}
      <div className="chat-log" ref={logRef}>
        {messages.length === 0 && (
          <div className="chat-empty">
            <p>シロに話しかけてみよう。今日あったこと、好きなもの、なんでも。</p>
            {state?.recent_facts && state.recent_facts.length > 0 && (
              <div className="chat-remembered">
                <span className="chat-remembered-label">覚えていること</span>
                <div className="chat-suggestions">
                  {state.recent_facts.slice(0, 2).map((fact) => (
                    <span key={fact} className="chat-remembered-chip">
                      {fact}
                    </span>
                  ))}
                </div>
              </div>
            )}
            {latestDiaryEntry && (
              <button type="button" className="chat-diary-callback" onClick={onOpenDiary}>
                <span className="chat-diary-callback-label">{latestDiaryEntry.entry_date}の日記にこう書いたよ</span>
                <span className="chat-diary-callback-preview">「{previewDiaryEntry(latestDiaryEntry)}」</span>
              </button>
            )}
            <div className="chat-suggestions">
              {starterPrompts.map((prompt) => (
                <button
                  key={prompt}
                  type="button"
                  className="chat-suggestion-chip"
                  onClick={() => {
                    onInputActivity();
                    onSend(prompt);
                  }}
                >
                  {prompt}
                </button>
              ))}
            </div>
          </div>
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
      {followUpPrompts.length > 0 && (
        <div className="chat-suggestions chat-follow-ups">
          {followUpPrompts.map((prompt) => (
            <button
              key={prompt}
              type="button"
              className="chat-suggestion-chip"
              onClick={() => {
                onInputActivity();
                onSend(prompt);
              }}
            >
              {prompt}
            </button>
          ))}
        </div>
      )}
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
          onKeyDown={(event) => {
            // IME変換確定のEnterがそのままフォーム送信に化けて、未確定の文字列が
            // 送られてしまうのを防ぐ(日本語入力で頻発する既知のReactフォーム不具合)。
            if (event.key === 'Enter' && event.nativeEvent.isComposing) {
              event.preventDefault();
            }
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
