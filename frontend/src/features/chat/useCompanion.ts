import { useCallback, useEffect, useRef, useState } from 'react';
import { CompanionViewer } from '../vrm/viewer';
import { SentenceSplitter, SpeechQueue } from '../voice/speech';
import {
  fetchHistory,
  fetchState,
  logResearchEvent,
  requestedConditionFromUrl,
  requestNudge,
  setProfile,
  startResearchSession,
  streamChat,
  submitResearchSurvey,
} from './api';
import type {
  ChatMessage,
  CompanionState,
  Emotion,
  PresentationCondition,
  ResearchSurveyScores,
} from './types';

// AIが干渉しすぎる(短い間隔で自発的に話しかける)との指摘を受けて 120s → 240s に緩和。
const IDLE_NUDGE_MS = 240_000;
const RELAX_AFTER_MS = 6_000;

const DEFAULT_WAITING_CUES = [
  'うん、聞いてる。',
  '少し考えるね。',
  'ちゃんと受け取ったよ。',
  '今の言葉、ゆっくり見てる。',
];

function pick<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)];
}

function waitingCueFor(message: string): string {
  if (/[疲つか]れ|しんど|眠|ねむ|つら|辛|だる|限界/.test(message)) {
    return pick(['そっか、少し重かったんだね。', 'うん、無理しないで聞くね。']);
  }
  if (/[不安怖こわ]|心配|緊張|泣|かなしい|悲/.test(message)) {
    return pick(['大丈夫、急がなくていいよ。', 'ここにいるから、ゆっくりでいいよ。']);
  }
  if (/[嬉うれ]|楽しか|最高|できた|成功|よかった/.test(message)) {
    return pick(['わ、それ聞きたい。', 'いいね、ちゃんと聞かせて。']);
  }
  if (/[?？]$|どう|なぜ|なんで|教えて|かな/.test(message)) {
    return pick(['うん、いっしょに考える。', '少し整理してみるね。']);
  }
  if (message.length > 80) {
    return pick(['長めに話してくれてるね。ちゃんと読んでる。', 'ひとつずつ受け取るね。']);
  }
  return pick(DEFAULT_WAITING_CUES);
}

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
  const [condition, setCondition] = useState<PresentationCondition | null>(null);
  const [userTurns, setUserTurns] = useState(0);

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
      speech.enqueue(content, emotion);
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

  const noticeInputActivity = useCallback(() => {
    viewerRef.current?.notice('typing', 1.6);
    resetIdleTimer();
  }, [resetIdleTimer]);

  // 研究条件の取得。URL指定が無ければサーバが参加者ごとに安定割付する。
  useEffect(() => {
    let cancelled = false;
    startResearchSession(requestedConditionFromUrl())
      .then((session) => {
        if (cancelled) return;
        setCondition(session.condition);
        void logResearchEvent(session.condition, 'condition_loaded', {
          viewport: { width: window.innerWidth, height: window.innerHeight },
        });
      })
      .catch(() => {
        if (!cancelled) setCondition('stylized');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 3D ビューア初期化。text 条件では身体提示だけを消し、会話・記憶・音声は維持する。
  useEffect(() => {
    if (!condition || viewerRef.current) return;
    if (condition === 'text') {
      setLoadProgress(1);
      setReady(true);
      return;
    }
    if (!canvasRef.current) return;
    const viewer = new CompanionViewer(canvasRef.current, {
      modelUrl: condition === 'realistic' ? '/models/realistic.vrm' : '/models/shiro.vrm',
      fallbackModelUrl: '/models/shiro.vrm',
    });
    viewer.getMouthLevel = speech.mouthLevel;
    viewerRef.current = viewer;
    void viewer.load(setLoadProgress).then(() => setReady(true));
    return () => {
      viewer.dispose();
      viewerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [condition]);

  // 初期状態・履歴の取得
  useEffect(() => {
    fetchState().then(setState).catch(() => {});
    fetchHistory().then(setMessages).catch(() => {});
  }, []);

  // 最初のユーザー操作で AudioContext を解禁する(挨拶・アイドル声かけが
  // ユーザー操作なしに音声再生を試みて自動再生ブロックで無音になるのを防ぐ)。
  useEffect(() => {
    const unlock = () => {
      speech.unlock();
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
    return () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
  }, [speech]);

  useEffect(() => {
    if (state) viewerRef.current?.setAffinity(state.affinity);
  }, [state]);

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
      if (!message || busy || !condition) return;
      setBusy(true);
      viewerRef.current?.notice('thinking', 4.8);
      setMessages((prev) => [...prev, { role: 'user', content: message }]);
      setUserTurns((prev) => prev + 1);
      setMessages((prev) => [
        ...prev,
        { role: 'assistant', content: '', emotion: 'relaxed', cue: waitingCueFor(message) },
      ]);

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
        await streamChat(message, condition, {
          onEmotion: (e) => {
            emotion = e;
            showEmotion(e);
          },
          onToken: (text) => {
            viewerRef.current?.notice('speaking', 2.2);
            appendToLast(text);
            for (const sentence of splitter.feed(text)) {
              speech.enqueue(sentence, emotion);
            }
          },
          onDone: (nextState: CompanionState) => {
            setState(nextState);
            const rest = splitter.flush();
            if (rest) speech.enqueue(rest, emotion);
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
    [busy, condition, showEmotion, speech, resetIdleTimer],
  );

  const saveName = useCallback(async (name: string) => {
    const next = await setProfile(name);
    setState(next);
  }, []);

  const toggleVoice = useCallback(() => {
    setVoiceEnabled((prev) => {
      speech.setEnabled(!prev);
      if (condition) void logResearchEvent(condition, 'voice_toggled', { enabled: !prev });
      return !prev;
    });
  }, [condition, speech]);

  const submitSurvey = useCallback(
    async (scores: ResearchSurveyScores) => {
      if (!condition) return;
      await submitResearchSurvey(condition, scores, {
        user_turns: userTurns,
        message_count: messages.length,
        voice_enabled: voiceEnabled,
      });
    },
    [condition, messages.length, userTurns, voiceEnabled],
  );

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
    condition,
    userTurns,
    noticeInputActivity,
    send,
    saveName,
    toggleVoice,
    submitSurvey,
  };
}
