import { useCallback, useEffect, useRef, useState } from 'react';
import { CompanionViewer } from '../vrm/viewer';
import { SentenceSplitter, SpeechQueue } from '../voice/speech';
import {
  fetchHistory,
  fetchState,
  requestNudge,
  setProfile,
  streamChat,
} from './api';
import type { ChatMessage, CompanionState, Emotion } from './types';

const IDLE_NUDGE_MS = 120_000;
const RELAX_AFTER_MS = 6_000;

export function useCompanion() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const viewerRef = useRef<CompanionViewer | null>(null);
  const speechRef = useRef<SpeechQueue | null>(null);
  if (!speechRef.current) speechRef.current = new SpeechQueue();

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [state, setState] = useState<CompanionState | null>(null);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [loadProgress, setLoadProgress] = useState(0);
  const [voiceEnabled, setVoiceEnabled] = useState(true);

  const greeted = useRef(false);
  const idleTimer = useRef<number | undefined>(undefined);
  const relaxTimer = useRef<number | undefined>(undefined);

  const speech = speechRef.current;

  const showEmotion = useCallback((emotion: Emotion) => {
    viewerRef.current?.setEmotion(emotion);
    window.clearTimeout(relaxTimer.current);
    relaxTimer.current = window.setTimeout(
      () => viewerRef.current?.relax(),
      RELAX_AFTER_MS,
    );
  }, []);

  const pushAssistant = useCallback(
    (content: string, emotion: Emotion) => {
      setMessages((prev) => [...prev, { role: 'assistant', content, emotion }]);
      showEmotion(emotion);
      speech.enqueue(content);
    },
    [showEmotion, speech],
  );

  const resetIdleTimer = useCallback(() => {
    window.clearTimeout(idleTimer.current);
    idleTimer.current = window.setTimeout(async () => {
      try {
        const { text, emotion } = await requestNudge('idle');
        if (text) pushAssistant(text, emotion);
      } catch {
        /* サーバ停止中は黙っておく */
      }
    }, IDLE_NUDGE_MS);
  }, [pushAssistant]);

  // 3D ビューア初期化
  useEffect(() => {
    if (!canvasRef.current || viewerRef.current) return;
    const viewer = new CompanionViewer(canvasRef.current);
    viewer.getMouthLevel = speech.mouthLevel;
    viewerRef.current = viewer;
    void viewer.load(setLoadProgress).then(() => setReady(true));
    return () => {
      viewer.dispose();
      viewerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 初期状態・履歴の取得
  useEffect(() => {
    fetchState().then(setState).catch(() => {});
    fetchHistory().then(setMessages).catch(() => {});
  }, []);

  // モデル読み込み完了後にシロから挨拶(Replika 的プロアクティブ性)
  useEffect(() => {
    if (!ready || greeted.current) return;
    greeted.current = true;
    requestNudge('greeting')
      .then(({ text, emotion }) => {
        if (text) pushAssistant(text, emotion);
        resetIdleTimer();
      })
      .catch(() => {});
  }, [ready, pushAssistant, resetIdleTimer]);

  const send = useCallback(
    async (raw: string) => {
      const message = raw.trim();
      if (!message || busy) return;
      setBusy(true);
      setMessages((prev) => [...prev, { role: 'user', content: message }]);
      setMessages((prev) => [...prev, { role: 'assistant', content: '' }]);

      const splitter = new SentenceSplitter();
      let emotion: Emotion = 'neutral';

      const appendToLast = (text: string) =>
        setMessages((prev) => {
          const next = [...prev];
          const last = next[next.length - 1];
          next[next.length - 1] = {
            ...last,
            content: last.content + text,
            emotion,
          };
          return next;
        });

      try {
        await streamChat(message, {
          onEmotion: (e) => {
            emotion = e;
            showEmotion(e);
          },
          onToken: (text) => {
            appendToLast(text);
            for (const sentence of splitter.feed(text)) {
              speech.enqueue(sentence);
            }
          },
          onDone: (nextState: CompanionState) => {
            setState(nextState);
            const rest = splitter.flush();
            if (rest) speech.enqueue(rest);
          },
          onError: (errorMessage) => {
            appendToLast(errorMessage);
          },
        });
      } catch {
        appendToLast('(接続が切れちゃったみたい…バックエンドは起動してる?)');
      } finally {
        setBusy(false);
        resetIdleTimer();
      }
    },
    [busy, showEmotion, speech, resetIdleTimer],
  );

  const saveName = useCallback(async (name: string) => {
    const next = await setProfile(name);
    setState(next);
  }, []);

  const toggleVoice = useCallback(() => {
    setVoiceEnabled((prev) => {
      speech.setEnabled(!prev);
      return !prev;
    });
  }, [speech]);

  // タイマー後始末
  useEffect(
    () => () => {
      window.clearTimeout(idleTimer.current);
      window.clearTimeout(relaxTimer.current);
      speech.stop();
    },
    [speech],
  );

  return {
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
  };
}
