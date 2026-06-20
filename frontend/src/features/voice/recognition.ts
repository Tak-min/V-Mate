/**
 * 音声入力(STT)。Web Speech API (SpeechRecognition) を継続モードで回し、
 * 沈黙を検出して「1ターン分の発話」を確定する。ブラウザ内蔵のため追加キー/
 * バックエンド不要で、フロントエンドのビルドだけで本番(Cloudflare Worker)に乗る。
 *
 * 非対応環境(iOS WKWebView / 旧Firefox 等)では isSpeechRecognitionSupported() が
 * false を返す。STT は本クラスに閉じているため、将来クラウドSTT(Groq Whisper 等)や
 * iOSネイティブ(SFSpeechRecognizer)へ差し替える場合もここを置き換えるだけで済む。
 *
 * 【再起動ストーム対策】Web Speech は継続モードでも周期的に onend を発火する。
 * これを無条件に start() し直すと、音声サービスに繋がらない/即終了する環境では
 * 「録音が何度も呼ばれるループ」になる。そこで「生産的セッション(結果が出た or
 * 一定時間続いた)」かどうかで再起動を判定し、不発が続いたら指数バックオフ→上限で
 * 停止する。正常環境では結果が出るたびカウンタがリセットされるので影響しない。
 */

type RecognizerErrorKind = 'permission' | 'no-mic' | 'stalled' | 'transient';

export interface RecognizerCallbacks {
  /** 確定+暫定を結合した「いま聞こえている文字列」。リアルタイム表示用。 */
  onPartial: (text: string) => void;
  /** 沈黙で確定した1ターン分の発話。 */
  onUtterance: (text: string) => void;
  onError: (kind: RecognizerErrorKind, message: string) => void;
}

// 沈黙がこの時間続いたら「話し終わった」とみなす。短すぎると言い淀みで切れる。
const SILENCE_MS = 1400;
// 短すぎる確定はエコー/雑音の誤爆とみなして捨てる(自分の声の拾い込み対策)。
const MIN_UTTERANCE_LEN = 2;
// 再起動バックオフ。不発が続くほど間隔を空け、最終的に停止する。
const BASE_RESTART_MS = 400;
const MAX_RESTART_MS = 5000;
// このミリ秒以上続いたセッションは「正常(沈黙待ち)」とみなし、不発カウントしない。
const PRODUCTIVE_SESSION_MS = 2000;
// 不発(=即終了)がこの回数を超えたら会話モードを諦める。
const MAX_UNPRODUCTIVE = 6;

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
  private sessionStartTs = 0; // 直近セッションの onstart 時刻
  private gotResultThisSession = false; // 直近セッションで結果が出たか
  private unproductiveStreak = 0; // 即終了(不発)が連続した回数

  constructor(
    private readonly callbacks: RecognizerCallbacks,
    private readonly lang = 'ja-JP',
  ) {}

  /** 聞き取り開始(1ターン分のバッファと不発カウンタをリセットして稼働させる)。 */
  start(): void {
    this.shouldRun = true;
    this.finalText = '';
    this.unproductiveStreak = 0;
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
      this.sessionStartTs = performance.now();
      this.gotResultThisSession = false;
    };
    rec.onresult = (event) => this.handleResult(event);
    rec.onerror = (event) => this.handleError(event.error);
    rec.onend = () => {
      this.running = false;
      if (this.shouldRun) this.scheduleNextSession();
    };
    this.recognition = rec;
    try {
      rec.start();
    } catch {
      // start の二重呼び出し(InvalidStateError)は無視。onend 経由で再開する。
    }
  }

  /**
   * onend 後に再起動するか/どれだけ待つかを決める。
   * 結果が出た or 一定時間続いたセッションは「正常」とみなして即時再開。
   * 即終了(不発)が続く場合は指数バックオフし、上限を超えたら停止する。
   */
  private scheduleNextSession(): void {
    const sessionMs = performance.now() - this.sessionStartTs;
    const productive = this.gotResultThisSession || sessionMs >= PRODUCTIVE_SESSION_MS;
    if (productive) {
      this.unproductiveStreak = 0;
    } else {
      this.unproductiveStreak++;
    }

    if (this.unproductiveStreak > MAX_UNPRODUCTIVE) {
      this.shouldRun = false;
      this.clearTimers();
      this.callbacks.onError(
        'stalled',
        '音声認識がうまく繋がらないみたい。会話モードをいったん切るね。',
      );
      return;
    }

    const delay =
      this.unproductiveStreak === 0
        ? BASE_RESTART_MS
        : Math.min(BASE_RESTART_MS * 2 ** this.unproductiveStreak, MAX_RESTART_MS);
    window.clearTimeout(this.restartTimer);
    this.restartTimer = window.setTimeout(() => this.ensureRunning(), delay);
  }

  private handleResult(event: SpeechRecognitionEventLike): void {
    this.gotResultThisSession = true;
    this.unproductiveStreak = 0;
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
    // 1〜0文字の確定はエコー/雑音とみなして捨てる。
    if (text.length >= MIN_UTTERANCE_LEN) this.callbacks.onUtterance(text);
  }

  private handleError(kind: string): void {
    if (kind === 'not-allowed' || kind === 'service-not-allowed') {
      this.shouldRun = false;
      this.clearTimers();
      this.callbacks.onError('permission', 'マイクの使用が許可されていないみたい。設定から許可してね。');
      return;
    }
    if (kind === 'audio-capture') {
      this.shouldRun = false;
      this.clearTimers();
      this.callbacks.onError('no-mic', 'マイクが見つからないみたい。接続を確認してね。');
      return;
    }
    // no-speech / aborted / network は一時的。再起動の可否は onend(scheduleNextSession)が判断する。
    this.callbacks.onError('transient', kind);
  }

  private clearTimers(): void {
    window.clearTimeout(this.silenceTimer);
    window.clearTimeout(this.restartTimer);
  }
}
