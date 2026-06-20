/**
 * 音声合成キュー(純クラウド)。
 * バックエンド /api/tts (Aivis Cloud API / AivisSpeech) が返す MP3 を Web Audio で再生し、
 * 実際の音量を解析してリップシンクする。
 * クラウド合成が使えない場合(キー未設定=204 や失敗)は無音で続行する
 * — ローカル/ブラウザ読み上げへのフォールバックは持たない。
 */

interface QueuedUtterance {
  text: string;
  emotion?: string;
}

export class SpeechQueue {
  private queue: QueuedUtterance[] = [];
  private playing = false;
  private enabled = true;
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private analyserData: Uint8Array | null = null;
  private currentSource: AudioBufferSourceNode | null = null;

  /**
   * キューを再生し切って無音になった瞬間に呼ばれる。
   * 会話モードでは「相手が話し終わった」= ユーザーの聞き取りを再開する合図に使う。
   */
  onDrained: (() => void) | null = null;

  /** いま発話中か(再生中 or 再生待ちが残っている)。 */
  isSpeaking(): boolean {
    return this.playing || this.queue.length > 0;
  }

  /** 現在の口の開き具合 (0..1) — Viewer が毎フレーム参照する */
  mouthLevel = (): number => {
    if (this.analyser && this.analyserData) {
      this.analyser.getByteFrequencyData(this.analyserData);
      let sum = 0;
      for (let i = 0; i < this.analyserData.length; i++) {
        sum += this.analyserData[i];
      }
      const volume = sum / this.analyserData.length / 255;
      return Math.min(volume * 4, 1);
    }
    return 0;
  };

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.stop();
  }

  /**
   * ブラウザの自動再生ポリシー対策: AudioContext はユーザー操作(クリック/キー入力等)
   * を経ないと再生開始できない。挨拶やアイドル時の声かけはユーザー操作なしに発火するため、
   * 最初のユーザー操作のタイミングで前もって AudioContext を作成・resume しておく。
   */
  unlock(): void {
    this.audioContext ??= new AudioContext();
    if (this.audioContext.state === 'suspended') {
      void this.audioContext.resume();
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  enqueue(text: string, emotion?: string): void {
    const clean = text.trim();
    if (!clean || !this.enabled) return;
    this.queue.push({ text: clean, emotion });
    if (!this.playing) void this.processQueue();
  }

  stop(): void {
    this.queue = [];
    if (this.currentSource) {
      try {
        this.currentSource.stop();
      } catch {
        /* 既に停止済みなら無視 */
      }
      this.currentSource = null;
    }
    this.analyser = null;
    this.analyserData = null;
  }

  private async processQueue(): Promise<void> {
    this.playing = true;
    while (this.queue.length > 0 && this.enabled) {
      const utterance = this.queue.shift()!;
      try {
        await this.playFromBackend(utterance.text, utterance.emotion);
      } catch {
        // 1文の失敗(合成不可・再生不可)は無視して次へ。フォールバックはしない。
      }
    }
    this.playing = false;
    // 発話し切ったことを通知(会話モードの聞き取り再開トリガ)。
    if (this.queue.length === 0) this.onDrained?.();
  }

  private async playFromBackend(text: string, emotion?: string): Promise<void> {
    const params = new URLSearchParams({ text });
    if (emotion) params.set('emotion', emotion);
    const response = await fetch(`/api/tts?${params.toString()}`);
    // 204 = クラウド合成が使えない(キー未設定など)→ 無音で続行
    if (response.status !== 200) return;
    const buffer = await response.arrayBuffer();

    this.audioContext ??= new AudioContext();
    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
    }
    const audioBuffer = await this.audioContext.decodeAudioData(buffer);
    const source = this.audioContext.createBufferSource();
    source.buffer = audioBuffer;

    this.analyser = this.audioContext.createAnalyser();
    this.analyser.fftSize = 64;
    this.analyserData = new Uint8Array(this.analyser.frequencyBinCount);
    source.connect(this.analyser);
    this.analyser.connect(this.audioContext.destination);

    this.currentSource = source;
    await new Promise<void>((resolve) => {
      source.onended = () => resolve();
      source.start();
    });
    this.currentSource = null;
    this.analyser = null;
    this.analyserData = null;
  }
}

/** ストリーミングテキストから「文」が完成するたびに取り出すための分割器 */
export class SentenceSplitter {
  private buffer = '';

  feed(chunk: string): string[] {
    this.buffer += chunk;
    const sentences: string[] = [];
    const re = /[^。!?！？\n]*[。!?！？\n]/g;
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(this.buffer)) !== null) {
      const sentence = match[0].trim();
      if (sentence) sentences.push(sentence);
      lastIndex = re.lastIndex;
    }
    this.buffer = this.buffer.slice(lastIndex);
    return sentences;
  }

  flush(): string | null {
    const rest = this.buffer.trim();
    this.buffer = '';
    return rest || null;
  }
}
