/**
 * 音声入力(STT)。Web Speech API (SpeechRecognition) を **VAD(音声区間検出)で
 * ゲートして** 回す。マイク音量を常時監視し、ユーザーが実際に話し始めた時だけ
 * 認識を起動、沈黙が続いたら止める。これにより「認識が終わるたびに無条件で
 * 再起動 → 沈黙中も録音し続ける無限ループ」を構造的に排除する。
 *
 * - 沈黙時: 認識は起動しない(録音しない)。マイク音量だけを監視。
 * - 発話検出: しきい値超え → 認識開始 → 文字起こし。
 * - 発話終了: 一定時間の沈黙(ハングオーバ) → 認識停止 → 1ターン確定。
 *
 * ブラウザ内蔵のため追加キー/バックエンド不要。非対応環境(iOS WKWebView 等)では
 * isSpeechRecognitionSupported() が false を返す。STT は本クラスに閉じているので
 * 将来クラウドSTTやネイティブへ差し替える場合もここだけ置き換えればよい。
 */

type RecognizerErrorKind = 'permission' | 'no-mic' | 'transient';

export interface RecognizerCallbacks {
  /** 確定+暫定を結合した「いま聞こえている文字列」。リアルタイム表示用。 */
  onPartial: (text: string) => void;
  /** 沈黙で確定した1ターン分の発話。 */
  onUtterance: (text: string) => void;
  onError: (kind: RecognizerErrorKind, message: string) => void;
}

// --- VAD パラメータ ---
const VAD_INTERVAL_MS = 60; // 監視周期(rAFではなくtab非表示でも動くsetInterval)
const VAD_FFT = 1024; // 時間領域サンプル数
const ONSET_FRAMES = 2; // 連続でしきい値超え → 発話開始とみなすフレーム数(誤爆抑制)
const HANGOVER_MS = 1100; // この時間沈黙が続いたら1ターン終了(言い淀みで切らない長さ)
const MIN_THRESHOLD = 0.025; // RMS(正規化)の下限しきい値
const NOISE_MARGIN = 1.8; // ノイズフロアに対する余裕係数
const MAX_CAPTURE_MS = 15_000; // 1キャプチャの安全上限
const MIN_UTTERANCE_LEN = 2; // これ未満の確定はエコー/雑音とみなし破棄

// --- Web Speech API の最小型(vendor-prefixed で lib.dom に無い環境があるため自前定義) ---
interface SpeechAlternativeLike {
  readonly transcript: string;
}
interface SpeechResultLike {
  readonly isFinal: boolean;
  readonly length: number;
  readonly [index: number]: SpeechAlternativeLike;
}
interface SpeechResultListLike {
  readonly length: number;
  readonly [index: number]: SpeechResultLike;
}
interface SpeechRecognitionEventLike extends Event {
  readonly resultIndex: number;
  readonly results: SpeechResultListLike;
}
interface SpeechRecognitionErrorEventLike extends Event {
  readonly error: string;
}
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;
type AudioContextCtor = new () => AudioContext;

function getRecognitionCtor(): SpeechRecognitionCtor | null {
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

function getAudioContextCtor(): AudioContextCtor | null {
  const w = window as unknown as {
    AudioContext?: AudioContextCtor;
    webkitAudioContext?: AudioContextCtor;
  };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

export function isSpeechRecognitionSupported(): boolean {
  return (
    getRecognitionCtor() !== null &&
    getAudioContextCtor() !== null &&
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia
  );
}

export class SpeechRecognizer {
  private running = false; // 会話モードとして稼働中か
  private recognition: SpeechRecognitionLike | null = null;
  private capturing = false; // いま認識(録音)している最中か
  private finalText = '';

  // VAD 用
  private stream: MediaStream | null = null;
  private audioCtx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private timeData: Uint8Array | null = null;
  private vadTimer: number | undefined;
  private aboveFrames = 0;
  private lastVoiceTs = 0;
  private captureStartTs = 0;
  private noiseFloor = 0.01;

  constructor(
    private readonly callbacks: RecognizerCallbacks,
    private readonly lang = 'ja-JP',
  ) {}

  /** 聞き取り開始(マイクを開いてVAD監視を始める。認識は発話検出時のみ起動)。 */
  start(): void {
    if (this.running) return;
    this.running = true;
    void this.openMic();
  }

  /** 聞き取り停止(発話中のエコー防止・会話モード終了の双方で使う。マイクも解放)。 */
  stop(): void {
    this.running = false;
    window.clearInterval(this.vadTimer);
    this.vadTimer = undefined;
    if (this.recognition && this.capturing) {
      try {
        this.recognition.abort();
      } catch {
        /* 既に停止済みなら無視 */
      }
    }
    this.capturing = false;
    this.finalText = '';
    this.aboveFrames = 0;
    if (this.source) {
      try {
        this.source.disconnect();
      } catch {
        /* noop */
      }
      this.source = null;
    }
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
      this.stream = null;
    }
    if (this.audioCtx) {
      void this.audioCtx.close().catch(() => {});
      this.audioCtx = null;
    }
    this.analyser = null;
    this.timeData = null;
  }

  dispose(): void {
    this.stop();
    this.recognition = null;
  }

  get active(): boolean {
    return this.running;
  }

  private async openMic(): Promise<void> {
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (error) {
      this.running = false;
      const denied = error instanceof DOMException && error.name === 'NotAllowedError';
      if (denied) {
        this.callbacks.onError('permission', 'マイクの使用が許可されていないみたい。設定から許可してね。');
      } else {
        this.callbacks.onError('no-mic', 'マイクが見つからないみたい。接続を確認してね。');
      }
      return;
    }
    // await 中に stop() された場合は後始末して終了。
    if (!this.running) {
      for (const track of stream.getTracks()) track.stop();
      return;
    }
    const Ctx = getAudioContextCtor();
    if (!Ctx) {
      this.running = false;
      for (const track of stream.getTracks()) track.stop();
      this.callbacks.onError('no-mic', '音声の解析に対応していないブラウザだよ。');
      return;
    }
    this.stream = stream;
    this.audioCtx = new Ctx();
    this.source = this.audioCtx.createMediaStreamSource(stream);
    this.analyser = this.audioCtx.createAnalyser();
    this.analyser.fftSize = VAD_FFT;
    this.source.connect(this.analyser);
    this.timeData = new Uint8Array(this.analyser.fftSize);
    this.aboveFrames = 0;
    this.lastVoiceTs = 0;
    this.noiseFloor = 0.01;
    this.vadTimer = window.setInterval(() => this.monitor(), VAD_INTERVAL_MS);
  }

  /** マイク音量を周期監視し、発話の開始/終了を判定して認識をゲートする。 */
  private monitor(): void {
    if (!this.running || !this.analyser || !this.timeData) return;
    this.analyser.getByteTimeDomainData(this.timeData);
    let sumSq = 0;
    for (let i = 0; i < this.timeData.length; i++) {
      const d = (this.timeData[i] - 128) / 128;
      sumSq += d * d;
    }
    const rms = Math.sqrt(sumSq / this.timeData.length);
    const threshold = Math.max(MIN_THRESHOLD, this.noiseFloor * NOISE_MARGIN + 0.01);
    const now = performance.now();

    if (rms > threshold) {
      this.aboveFrames++;
      this.lastVoiceTs = now;
      if (!this.capturing && this.aboveFrames >= ONSET_FRAMES) this.beginCapture();
    } else {
      this.aboveFrames = 0;
      // 静かな間だけノイズフロアを追従させる(環境雑音に適応)。
      if (!this.capturing) this.noiseFloor = this.noiseFloor * 0.95 + rms * 0.05;
      if (this.capturing && now - this.lastVoiceTs > HANGOVER_MS) this.endCapture();
    }
    if (this.capturing && now - this.captureStartTs > MAX_CAPTURE_MS) this.endCapture();
  }

  private beginCapture(): void {
    const Ctor = getRecognitionCtor();
    if (!Ctor) return;
    const rec = this.recognition ?? new Ctor();
    rec.lang = this.lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    rec.onresult = (event) => this.handleResult(event);
    rec.onerror = (event) => this.handleError(event.error);
    rec.onend = () => {
      // 認識終了(VADによる stop か、エンジン自身の終了/エラー)→ 1ターン確定。
      this.capturing = false;
      this.commit();
    };
    this.recognition = rec;
    this.finalText = '';
    this.capturing = true;
    this.captureStartTs = performance.now();
    try {
      rec.start();
    } catch {
      // 直前のセッションが終わりきっていない場合の InvalidStateError は無視。
    }
  }

  private endCapture(): void {
    if (!this.capturing || !this.recognition) return;
    try {
      this.recognition.stop(); // 確定結果を得るため abort ではなく stop。onend で commit。
    } catch {
      /* noop */
    }
  }

  private commit(): void {
    const text = this.finalText.trim();
    this.finalText = '';
    if (text.length >= MIN_UTTERANCE_LEN) this.callbacks.onUtterance(text);
  }

  private handleResult(event: SpeechRecognitionEventLike): void {
    let interim = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      const text = result[0]?.transcript ?? '';
      if (result.isFinal) this.finalText += text;
      else interim += text;
    }
    // 認識結果が来ている間は発話中とみなしてハングオーバを延長。
    this.lastVoiceTs = performance.now();
    const combined = (this.finalText + interim).trim();
    if (combined) this.callbacks.onPartial(combined);
  }

  private handleError(kind: string): void {
    if (kind === 'not-allowed' || kind === 'service-not-allowed') {
      this.stop();
      this.callbacks.onError('permission', 'マイクの使用が許可されていないみたい。設定から許可してね。');
      return;
    }
    if (kind === 'audio-capture') {
      this.stop();
      this.callbacks.onError('no-mic', 'マイクが見つからないみたい。接続を確認してね。');
      return;
    }
    // no-speech / aborted / network は一時的。onend が capturing を畳む。VADが次の発話で再起動。
    this.callbacks.onError('transient', kind);
  }
}
