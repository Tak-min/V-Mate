/**
 * 音声入力(STT) — オンデバイス Whisper + VAD(音声区間検出)。
 *
 * マイク音声を **一切サーバに送信せず** ブラウザ内でテキスト化する。
 * @huggingface/transformers の Whisper-tiny モデルを WebGPU/WASM で実行し、
 * VAD は既存の RMS ベース(AnalyserNode)を維持する。
 *
 * 処理フロー:
 * - 沈黙時: VAD が RMS を監視(録音しない)。
 * - 発話検出: しきい値超え → ScriptProcessorNode で PCM バッファリング開始。
 * - 発話終了: 沈黙でバッファ停止 → Whisper で文字起こし → 1ターン確定。
 *
 * Whisper モデルは初回のみダウンロード(約75MB)、以降は IndexedDB にキャッシュ。
 * 非対応環境やモデル読込失敗時は Web Speech API にフォールバック。
 */

import {
  loadWhisperPipeline,
  transcribeAudio,
  resampleTo16kHz,
  isWhisperLoaded,
} from './whisper-engine';

type RecognizerErrorKind = 'permission' | 'no-mic' | 'transient';

export interface RecognizerCallbacks {
  /** 発話検出〜認識完了の間のステータス表示用。 */
  onPartial: (text: string) => void;
  /** 沈黙で確定した1ターン分の発話。 */
  onUtterance: (text: string) => void;
  onError: (kind: RecognizerErrorKind, message: string) => void;
}

// --- VAD パラメータ ---
const VAD_INTERVAL_MS = 60;
const VAD_FFT = 1024;
const ONSET_FRAMES = 2;
const HANGOVER_MS = 1100;
const MIN_THRESHOLD = 0.025;
const NOISE_MARGIN = 1.8;
const MAX_CAPTURE_MS = 15_000;
const MIN_UTTERANCE_LEN = 2;

// --- 音声バッファリング ---
const SCRIPT_BUFFER_SIZE = 4096; // ScriptProcessorNode のバッファサイズ

type AudioContextCtor = new () => AudioContext;

function getAudioContextCtor(): AudioContextCtor | null {
  const w = window as unknown as {
    AudioContext?: AudioContextCtor;
    webkitAudioContext?: AudioContextCtor;
  };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

/**
 * STT が利用可能かを返す。
 * オンデバイス Whisper(=Transformers.js + getUserMedia)が使えるかを確認。
 * どちらかが使えれば true(フォールバック含む)。
 */
export function isSpeechRecognitionSupported(): boolean {
  return (
    getAudioContextCtor() !== null &&
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia
  );
}

/** モデルのロード状態を外部から確認するための型 */
export type WhisperLoadState = 'idle' | 'loading' | 'ready' | 'failed';

export class SpeechRecognizer {
  private running = false;
  private capturing = false;
  private whisperState: WhisperLoadState = 'idle';

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

  // 音声バッファリング用(Whisper)
  private scriptNode: ScriptProcessorNode | null = null;
  private audioBuffers: Float32Array[] = [];
  private inputSampleRate = 16000;

  // フォールバック: Web Speech API
  private fallbackRecognition: any | null = null;
  private useFallback = false;
  private fallbackFinalText = '';

  constructor(
    private readonly callbacks: RecognizerCallbacks,
    private readonly _lang = 'ja-JP',
  ) {}

  /** 聞き取り開始(マイクを開いてVAD監視を始める)。 */
  start(): void {
    if (this.running) return;
    this.running = true;
    void this.openMic();
  }

  /** 聞き取り停止。 */
  stop(): void {
    this.running = false;
    window.clearInterval(this.vadTimer);
    this.vadTimer = undefined;
    this.capturing = false;
    this.aboveFrames = 0;
    this.audioBuffers = [];
    this.fallbackFinalText = '';

    // フォールバック認識を停止
    if (this.fallbackRecognition) {
      try { this.fallbackRecognition.abort(); } catch { /* noop */ }
    }

    // ScriptProcessorNode を切断
    if (this.scriptNode) {
      try { this.scriptNode.disconnect(); } catch { /* noop */ }
      this.scriptNode = null;
    }

    if (this.source) {
      try { this.source.disconnect(); } catch { /* noop */ }
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
    this.fallbackRecognition = null;
  }

  get active(): boolean {
    return this.running;
  }

  get whisperLoadState(): WhisperLoadState {
    return this.whisperState;
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
    this.inputSampleRate = this.audioCtx.sampleRate;
    this.source = this.audioCtx.createMediaStreamSource(stream);

    // VAD 用 AnalyserNode
    this.analyser = this.audioCtx.createAnalyser();
    this.analyser.fftSize = VAD_FFT;
    this.source.connect(this.analyser);
    this.timeData = new Uint8Array(this.analyser.fftSize);

    // 音声バッファリング用 ScriptProcessorNode
    this.scriptNode = this.audioCtx.createScriptProcessor(SCRIPT_BUFFER_SIZE, 1, 1);
    this.scriptNode.onaudioprocess = (event) => this.handleAudioProcess(event);
    // scriptNode は destination に接続しないと動かないブラウザがある(出力は無音)
    this.scriptNode.connect(this.audioCtx.destination);

    this.aboveFrames = 0;
    this.lastVoiceTs = 0;
    this.noiseFloor = 0.01;

    // Whisper モデルをバックグラウンドでプリロード(初回は数秒かかる)
    void this.preloadWhisper();

    this.vadTimer = window.setInterval(() => this.monitor(), VAD_INTERVAL_MS);
  }

  /** Whisper モデルをバックグラウンドでロード(失敗してもフォールバック可能)。 */
  private async preloadWhisper(): Promise<void> {
    if (isWhisperLoaded()) {
      this.whisperState = 'ready';
      return;
    }
    this.whisperState = 'loading';
    try {
      await loadWhisperPipeline((progress) => {
        if (progress.status === 'ready') this.whisperState = 'ready';
      });
    } catch (err) {
      console.warn('[SpeechRecognizer] Whisper model load failed, using Web Speech API fallback:', err);
      this.whisperState = 'failed';
      this.useFallback = true;
    }
  }

  /** ScriptProcessorNode のコールバック。capturing 中だけ PCM をバッファする。 */
  private handleAudioProcess(event: AudioProcessingEvent): void {
    if (!this.capturing) return;
    // 入力バッファをコピー(参照ではなく値を保持)
    const input = event.inputBuffer.getChannelData(0);
    this.audioBuffers.push(new Float32Array(input));
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
      if (!this.capturing) this.noiseFloor = this.noiseFloor * 0.95 + rms * 0.05;
      if (this.capturing && now - this.lastVoiceTs > HANGOVER_MS) this.endCapture();
    }
    if (this.capturing && now - this.captureStartTs > MAX_CAPTURE_MS) this.endCapture();
  }

  private beginCapture(): void {
    this.capturing = true;
    this.captureStartTs = performance.now();
    this.audioBuffers = [];
    this.fallbackFinalText = '';

    // フォールバック: Web Speech API を使う場合
    if (this.useFallback) {
      this.beginFallbackCapture();
    }
  }

  private endCapture(): void {
    if (!this.capturing) return;
    this.capturing = false;

    if (this.useFallback) {
      this.endFallbackCapture();
      return;
    }

    // オンデバイス Whisper で処理
    void this.processWithWhisper();
  }

  /** バッファされた PCM 音声を Whisper でテキスト化する。 */
  private async processWithWhisper(): Promise<void> {
    if (this.audioBuffers.length === 0) return;

    // 全バッファを結合
    const totalLength = this.audioBuffers.reduce((sum, buf) => sum + buf.length, 0);
    const combined = new Float32Array(totalLength);
    let offset = 0;
    for (const buf of this.audioBuffers) {
      combined.set(buf, offset);
      offset += buf.length;
    }
    this.audioBuffers = [];

    // 無音区間を除外(RMS が極端に小さい区間は切り詰め)
    const trimmed = this.trimSilence(combined);
    if (trimmed.length < this.inputSampleRate * 0.1) {
      // 100ms 未満は雑音とみなして破棄
      return;
    }

    // 16kHz にリサンプル(Whisper の入力仕様)
    const resampled = resampleTo16kHz(trimmed, this.inputSampleRate);

    try {
      this.callbacks.onPartial('…');
      const text = await transcribeAudio(resampled);
      if (text.length >= MIN_UTTERANCE_LEN) {
        this.callbacks.onUtterance(text);
      }
    } catch (err) {
      console.warn('[SpeechRecognizer] Whisper transcription failed:', err);
      // 認識失敗時はフォールバックへ切替
      this.useFallback = true;
      this.whisperState = 'failed';
      this.callbacks.onError('transient', '音声認識の処理に失敗したよ。もう一度話してみて。');
    }
  }

  /** 音声バッファの先頭・末尾の無音を切り詰める。 */
  private trimSilence(audio: Float32Array): Float32Array {
    const threshold = 0.01;
    let start = 0;
    let end = audio.length - 1;
    // 先頭の無音をスキップ
    while (start < end && Math.abs(audio[start]) < threshold) start++;
    // 末尾の無音をスキップ
    while (end > start && Math.abs(audio[end]) < threshold) end--;
    if (start === 0 && end === audio.length - 1) return audio;
    return audio.slice(start, end + 1);
  }

  // --- フォールバック: Web Speech API ---

  private beginFallbackCapture(): void {
    const w = window as unknown as {
      SpeechRecognition?: any;
      webkitSpeechRecognition?: any;
    };
    const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    if (!Ctor) return;

    const rec = this.fallbackRecognition ?? new Ctor();
    rec.lang = this._lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    rec.onresult = (event: any) => this.handleFallbackResult(event);
    rec.onerror = (event: any) => this.handleFallbackError(event.error);
    rec.onend = () => {
      this.capturing = false;
      this.commitFallback();
    };
    this.fallbackRecognition = rec;
    this.fallbackFinalText = '';
    try {
      rec.start();
    } catch { /* noop */ }
  }

  private endFallbackCapture(): void {
    if (!this.fallbackRecognition) return;
    try {
      this.fallbackRecognition.stop();
    } catch { /* noop */ }
  }

  private commitFallback(): void {
    const text = this.fallbackFinalText.trim();
    this.fallbackFinalText = '';
    if (text.length >= MIN_UTTERANCE_LEN) this.callbacks.onUtterance(text);
  }

  private handleFallbackResult(event: any): void {
    let interim = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      const text = result[0]?.transcript ?? '';
      if (result.isFinal) this.fallbackFinalText += text;
      else interim += text;
    }
    this.lastVoiceTs = performance.now();
    const combined = (this.fallbackFinalText + interim).trim();
    if (combined) this.callbacks.onPartial(combined);
  }

  private handleFallbackError(kind: string): void {
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
    this.callbacks.onError('transient', kind);
  }
}
