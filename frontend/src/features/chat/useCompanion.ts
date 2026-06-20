import { useCallback, useEffect, useRef, useState } from 'react';
import { CompanionViewer } from '../vrm/viewer';
import { SentenceSplitter, SpeechQueue } from '../voice/speech';
import { isSpeechRecognitionSupported, SpeechRecognizer } from '../voice/recognition';
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
// 会話モードで「聞いてるよ」の所作を維持する注視時間。
const LISTENING_NOTICE_S = 6;
// 発話し終えてからマイクを開け直すまでの待ち。スピーカー残響の拾い込みを防ぐ。
const RESUME_DELAY_MS = 500;

/** ハンズフリー音声会話の状態。off=テキストのみ / listening=聞き取り中 / thinking=応答待ち / speaking=発話中 */
export type VoiceMode = 'off' | 'listening' | 'thinking' | 'speaking';

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

  // --- ハンズフリー音声会話 ---
  const [voiceMode, setVoiceMode] = useState<VoiceMode>('off');
  const [partialTranscript, setPartialTranscript] = useState('');
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [voiceSupported] = useState(isSpeechRecognitionSupported);

  const greeted = useRef(false);
  const idleTimer = useRef<number | undefined>(undefined);
  const relaxTimer = useRef<number | undefined>(undefined);
  const recognizerRef = useRef<SpeechRecognizer | null>(null);
  const voiceModeRef = useRef<VoiceMode>('off'); // 非同期コールバックから最新値を読むため
  const responseDoneRef = useRef(false); // 応答ストリームが完了したか
  const abortRef = useRef<AbortController | null>(null); // バージイン用
  const resumeTimer = useRef<number | undefined>(undefined); // 聞き取り再開の遅延タイマ

  const speech = speechRef.current;

  const setVoiceModeBoth = useCallback((mode: VoiceMode) => {
    voiceModeRef.current = mode;
    setVoiceMode(mode);
  }, []);

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
    // 会話モード中は常時聞き取っているので、自発的な声かけ(エコー源)は出さない。
    if (voiceModeRef.current !== 'off') return;
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

  // 聞き取り再開(発話し終わって、まだ会話モードならマイクを開け直す)。
  const resumeListening = useCallback(() => {
    if (voiceModeRef.current === 'off') return;
    responseDoneRef.current = false;
    setPartialTranscript('');
    setVoiceModeBoth('listening');
    viewerRef.current?.notice('listening', LISTENING_NOTICE_S);
    // スピーカー出力が落ち着くまで少し待ってからマイクを開く(自分の声の拾い込み防止)。
    window.clearTimeout(resumeTimer.current);
    resumeTimer.current = window.setTimeout(() => {
      if (voiceModeRef.current === 'listening') recognizerRef.current?.start();
    }, RESUME_DELAY_MS);
  }, [setVoiceModeBoth]);

  // 「応答が終わっている」かつ「発話キューが空」になったら聞き取りへ戻す。
  const maybeResumeListening = useCallback(() => {
    if (voiceModeRef.current === 'off') return;
    if (!responseDoneRef.current) return;
    if (speech.isSpeaking()) return;
    resumeListening();
  }, [resumeListening, speech]);

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
      const controller = new AbortController();
      abortRef.current = controller;

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
        await streamChat(
          message,
          condition,
          {
            onEmotion: (e) => {
              emotion = e;
              showEmotion(e);
            },
            onToken: (text) => {
              viewerRef.current?.notice('speaking', 2.2);
              // 会話モードでは最初のトークンで「話し始めた」状態へ遷移。
              if (voiceModeRef.current === 'thinking') setVoiceModeBoth('speaking');
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
          },
          controller.signal,
        );
      } catch {
        // バージイン(意図的な中断)はエラー表示しない。
        if (!controller.signal.aborted) {
          appendToLast('(接続が切れちゃったみたい…バックエンドは起動してる?)');
        }
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
        setBusy(false);
        resetIdleTimer();
        // 会話モードなら応答完了を記録し、発話キューが空き次第また聞き取りへ。
        if (voiceModeRef.current !== 'off') {
          responseDoneRef.current = true;
          maybeResumeListening();
        }
      }
    },
    [busy, condition, showEmotion, speech, resetIdleTimer, maybeResumeListening, setVoiceModeBoth],
  );

  // マイクが1ターン分の発話を確定 → 送信。エコー防止に聞き取りは一旦止める。
  const handleUtterance = useCallback(
    (text: string) => {
      if (voiceModeRef.current === 'off') return;
      recognizerRef.current?.stop();
      setPartialTranscript('');
      setVoiceModeBoth('thinking');
      responseDoneRef.current = false;
      void send(text);
    },
    [send, setVoiceModeBoth],
  );

  // 認識エンジンは1度だけ生成され onUtterance を掴み続けるため、最新の
  // handleUtterance(=最新の send)を ref 経由で呼べるようにしておく。
  const handleUtteranceRef = useRef(handleUtterance);
  handleUtteranceRef.current = handleUtterance;

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

  // ハンズフリー会話モードの ON/OFF。
  const toggleVoiceMode = useCallback(() => {
    if (voiceModeRef.current !== 'off') {
      recognizerRef.current?.stop();
      window.clearTimeout(resumeTimer.current);
      setPartialTranscript('');
      setVoiceModeBoth('off');
      viewerRef.current?.relax();
      resetIdleTimer();
      if (condition) void logResearchEvent(condition, 'voice_mode', { active: false });
      return;
    }
    if (!voiceSupported) {
      setVoiceError('このブラウザは音声入力に対応していません(Chrome / Edge 推奨)。');
      return;
    }
    setVoiceError(null);
    speech.unlock(); // 自動再生ポリシー解禁(声かけが無音にならないように)
    if (!voiceEnabled) toggleVoice(); // 会話なので相手の声も聞こえるように
    window.clearTimeout(idleTimer.current);
    if (!recognizerRef.current) {
      recognizerRef.current = new SpeechRecognizer({
        onPartial: (t) => {
          setPartialTranscript(t);
          viewerRef.current?.notice('listening', 4);
        },
        onUtterance: (t) => handleUtteranceRef.current(t),
        onError: (kind, message) => {
          // transient(no-speech/network 等)は再起動ロジックに任せて無視。
          // permission / no-mic / stalled は会話継続不能 → モードを切って知らせる。
          if (kind === 'transient') return;
          setVoiceError(message);
          recognizerRef.current?.stop();
          window.clearTimeout(resumeTimer.current);
          setVoiceModeBoth('off');
          viewerRef.current?.relax();
        },
      });
    }
    responseDoneRef.current = false;
    setVoiceModeBoth('listening');
    viewerRef.current?.notice('listening', LISTENING_NOTICE_S);
    recognizerRef.current.start();
    if (condition) void logResearchEvent(condition, 'voice_mode', { active: true });
  }, [voiceSupported, voiceEnabled, condition, speech, toggleVoice, resetIdleTimer, setVoiceModeBoth]);

  // バージイン: 発話/応答待ちの最中にユーザーが割り込んで止める → すぐ聞き取りへ。
  const interrupt = useCallback(() => {
    if (voiceModeRef.current === 'off') return;
    abortRef.current?.abort(); // 進行中のSSEを中断
    speech.stop(); // 再生中のTTSを止める
    responseDoneRef.current = true;
    resumeListening();
  }, [speech, resumeListening]);

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
    // 読み込み失敗(モデル欠損・パース失敗等)でもローディング画面で固まらせない。
    void viewer
      .load(setLoadProgress)
      .then(() => setReady(true))
      .catch(() => setReady(true));
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

  // 発話キューが空いたら聞き取り再開を試みる(会話モードの自動ターン回し)。
  useEffect(() => {
    speech.onDrained = maybeResumeListening;
    return () => {
      speech.onDrained = null;
    };
  }, [speech, maybeResumeListening]);

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

  // タイマー・認識エンジンの後始末
  useEffect(
    () => () => {
      window.clearTimeout(idleTimer.current);
      window.clearTimeout(relaxTimer.current);
      window.clearTimeout(resumeTimer.current);
      recognizerRef.current?.dispose();
      recognizerRef.current = null;
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
  };
}
