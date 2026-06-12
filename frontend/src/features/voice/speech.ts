/**
 * 音声合成キュー。
 * 1. バックエンド /api/tts (AivisSpeech) が使えれば WAV 再生 + 実音量リップシンク
 * 2. ダメなら Web Speech API (speechSynthesis) + 擬似リップシンク
 */

export class SpeechQueue {
  private queue: string[] = [];
  private playing = false;
  private enabled = true;
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private analyserData: Uint8Array | null = null;
  private fakeTalking = false;

  /** 現在の口の開き具合 (0..1) — Viewer が毎フレーム参照する */
  mouthLevel = (): number => {
    if (this.fakeTalking) {
      // 擬似リップシンク: なめらかなノイズ
      const t = performance.now() / 1000;
      return 0.25 + 0.35 * Math.abs(Math.sin(t * 9) * Math.sin(t * 2.3));
    }
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

  isEnabled(): boolean {
    return this.enabled;
  }

  enqueue(text: string): void {
    const clean = text.trim();
    if (!clean || !this.enabled) return;
    this.queue.push(clean);
    if (!this.playing) void this.processQueue();
  }

  stop(): void {
    this.queue = [];
    speechSynthesis.cancel();
    this.fakeTalking = false;
  }

  private async processQueue(): Promise<void> {
    this.playing = true;
    while (this.queue.length > 0 && this.enabled) {
      const text = this.queue.shift()!;
      try {
        const played = await this.playFromBackend(text);
        if (!played) await this.playFromBrowser(text);
      } catch {
        // 1文の失敗は無視して次へ
      }
    }
    this.playing = false;
  }

  private async playFromBackend(text: string): Promise<boolean> {
    const response = await fetch(`/api/tts?text=${encodeURIComponent(text)}`);
    if (response.status !== 200) return false;
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

    await new Promise<void>((resolve) => {
      source.onended = () => resolve();
      source.start();
    });
    this.analyser = null;
    this.analyserData = null;
    return true;
  }

  private playFromBrowser(text: string): Promise<void> {
    return new Promise((resolve) => {
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = 'ja-JP';
      utterance.rate = 1.05;
      utterance.pitch = 1.15;
      const voice = speechSynthesis
        .getVoices()
        .find((v) => v.lang.startsWith('ja'));
      if (voice) utterance.voice = voice;
      utterance.onstart = () => (this.fakeTalking = true);
      const finish = () => {
        this.fakeTalking = false;
        resolve();
      };
      utterance.onend = finish;
      utterance.onerror = finish;
      speechSynthesis.speak(utterance);
    });
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
