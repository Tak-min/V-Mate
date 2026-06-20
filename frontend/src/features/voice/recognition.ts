/**
 * 音声入力(STT)。Web Speech API (SpeechRecognition) を継続モードで回し、
 * 沈黙を検出して「1ターン分の発話」を確定する。ブラウザ内蔵のため追加キー/
 * バックエンド不要で、フロントエンドのビルドだけで本番(Cloudflare Worker)に乗る。
 *
 * 非対応環境(iOS WKWebView / 旧Firefox 等)では isSpeechRecognitionSupported() が
 * false を返す。STT は本クラスに閉じているため、将来クラウドSTT(Groq Whisper 等)や
 * iOSネイティブ(SFSpeechRecognizer)へ差し替える場合もここを置き換えるだけで済む。
 */

type RecognizerErrorKind = 'permission' | 'transient';

export interface RecognizerCallbacks {
  /** 確定+暫定を結合した「いま聞こえている文字列」。リアルタイム表示用。 */
  onPartial: (text: string) => void;
  /** 沈黙で確定した1ターン分の発話。 */
  onUtterance: (text: string) => void;
  onError: (kind: RecognizerErrorKind, message: string) => void;
}

// 沈黙がこの時間続いたら「話し終わった」とみなす。短すぎると言い淀みで切れる。
const SILENCE_MS = 1400;
// onend 後の再開ディレイ(Chrome は継続モードでも周期的にエンジンを止めるため)。
const RESTART_DELAY_MS = 250;

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

function getRecognitionCtor(): SpeechRecognitionCtor | null {
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function isSpeechRecognitionSupported(): boolean {
  return getRecognitionCtor() !== null;
}

export class SpeechRecognizer {
  private recognition: SpeechRecognitionLike | null = null;
  private shouldRun = false; // 連続稼働させるべきか(= listening 状態か)
  private running = false; // 実エンジンが稼働中か
  private finalText = ''; // このターンで確定済みのテキスト
  private silenceTimer: number | undefined;
  private restartTimer: number | undefined;

  constructor(
    private readonly callbacks: RecognizerCallbacks,
    private readonly lang = 'ja-JP',
  ) {}

  /** 聞き取り開始(1ターン分のバッファをリセットして稼働させる)。 */
  start(): void {
    this.shouldRun = true;
    this.finalText = '';
    this.ensureRunning();
  }

  /** 聞き取り停止(発話中のエコー防止・会話モード終了の双方で使う)。 */
  stop(): void {
    this.shouldRun = false;
    this.clearTimers();
    this.finalText = '';
    if (this.recognition && this.running) {
      try {
        this.recognition.abort();
      } catch {
        /* 既に停止済みなら無視 */
      }
    }
  }

  dispose(): void {
    this.stop();
    this.recognition = null;
  }

  get active(): boolean {
    return this.shouldRun;
  }

  private ensureRunning(): void {
    if (!this.shouldRun || this.running) return;
    const Ctor = getRecognitionCtor();
    if (!Ctor) return;
    const rec = this.recognition ?? new Ctor();
    rec.lang = this.lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    rec.onstart = () => {
      this.running = true;
    };
    rec.onresult = (event) => this.handleResult(event);
    rec.onerror = (event) => this.handleError(event.error);
    rec.onend = () => {
      this.running = false;
      // 継続モードでも周期的に止まる → 稼働すべきなら再開する。
      if (this.shouldRun) this.scheduleRestart();
    };
    this.recognition = rec;
    try {
      rec.start();
    } catch {
      // start の二重呼び出し(InvalidStateError)は無視。onend 経由で再開する。
    }
  }

  private scheduleRestart(): void {
    window.clearTimeout(this.restartTimer);
    this.restartTimer = window.setTimeout(() => this.ensureRunning(), RESTART_DELAY_MS);
  }

  private handleResult(event: SpeechRecognitionEventLike): void {
    let interim = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      const text = result[0]?.transcript ?? '';
      if (result.isFinal) this.finalText += text;
      else interim += text;
    }
    const combined = (this.finalText + interim).trim();
    if (combined) this.callbacks.onPartial(combined);
    this.resetSilenceTimer();
  }

  private resetSilenceTimer(): void {
    window.clearTimeout(this.silenceTimer);
    this.silenceTimer = window.setTimeout(() => this.commitUtterance(), SILENCE_MS);
  }

  private commitUtterance(): void {
    const text = this.finalText.trim();
    this.finalText = '';
    if (text) this.callbacks.onUtterance(text);
  }

  private handleError(kind: string): void {
    if (kind === 'not-allowed' || kind === 'service-not-allowed') {
      this.shouldRun = false;
      this.clearTimers();
      this.callbacks.onError('permission', 'マイクの使用が許可されていません。設定から許可してね。');
      return;
    }
    // no-speech / aborted / network / audio-capture は一時的 → onend が再開を担当。
    this.callbacks.onError('transient', kind);
  }

  private clearTimers(): void {
    window.clearTimeout(this.silenceTimer);
    window.clearTimeout(this.restartTimer);
  }
}
