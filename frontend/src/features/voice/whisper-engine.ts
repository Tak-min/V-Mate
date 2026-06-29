/**
 * オンデバイス Whisper STT エンジン。
 * @huggingface/transformers で Whisper モデルをブラウザ内で実行し、
 * マイク音声をローカルでテキスト化する(音声は一切サーバに送信しない)。
 *
 * - モデル: Xenova/whisper-tiny (約75MB)。初回ダウンロード後は IndexedDB にキャッシュ。
 * - 推論: WebGPU 対応環境では GPU 加速、非対応では WASM フォールバック。
 * - VAD は既存の RMS ベース(AnalyserNode)をそのまま使用。音声バッファリングのみ追加。
 */

export type WhisperProgressCallback = (progress: { status: string; progress?: number }) => void;

let pipelineInstance: any = null;
let loadingPromise: Promise<any> | null = null;

/**
 * Whisper パイプラインをロード(またはキャッシュから復元)する。
 * モデルは初回のみダウンロード、以降は IndexedDB から即座にロード。
 */
export async function loadWhisperPipeline(
  onProgress?: WhisperProgressCallback,
): Promise<any> {
  if (pipelineInstance) return pipelineInstance;
  if (loadingPromise) return loadingPromise;

  loadingPromise = (async () => {
    const { pipeline, env } = await import('@huggingface/transformers');

    // WebGPU が使える場合は使用(大幅に高速化)。なければ WASM。
    // Transformers.js v3 はデフォルトで WebGPU を試みるが、明示的に設定する。
    env.allowLocalModels = false;

    onProgress?.({ status: 'loading_model' });

    const pipe = await pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny', {
      progress_callback: (data: any) => {
        if (data.status === 'progress' && typeof data.progress === 'number') {
          onProgress?.({ status: 'downloading', progress: data.progress });
        } else if (data.status === 'done') {
          onProgress?.({ status: 'ready' });
        }
      },
    });

    pipelineInstance = pipe;
    onProgress?.({ status: 'ready' });
    return pipe;
  })();

  return loadingPromise;
}

/**
 * Whisper が利用可能か(=ロード済みか)を返す。
 */
export function isWhisperLoaded(): boolean {
  return pipelineInstance !== null;
}

/**
 * Float32 PCM 音声(16kHz想定)をテキストに変換する。
 * @param audio Float32Array (16kHz, モノラル)
 * @returns 認識されたテキスト
 */
export async function transcribeAudio(audio: Float32Array): Promise<string> {
  if (!pipelineInstance) {
    throw new Error('Whisper pipeline not loaded. Call loadWhisperPipeline() first.');
  }

  const result = await pipelineInstance(audio, {
    language: 'japanese',
    task: 'transcribe',
  });

  // Transformers.js の Whisper 出力形式: { text: string } または { text: string }[]
  const text = Array.isArray(result) ? result[0]?.text : result?.text;
  return (text as string ?? '').trim();
}

/**
 * AudioContext のサンプルレートを 16kHz にリサンプルするユーティリティ。
 * Whisper は 16kHz 入力を前提としているため、ブラウザのデフォルト(44.1/48kHz)からの変換が必要。
 */
export function resampleTo16kHz(
  input: Float32Array,
  inputSampleRate: number,
): Float32Array {
  if (inputSampleRate === 16000) return input;
  const ratio = 16000 / inputSampleRate;
  const outputLength = Math.floor(input.length * ratio);
  const output = new Float32Array(outputLength);
  for (let i = 0; i < outputLength; i++) {
    const srcIndex = i / ratio;
    const lo = Math.floor(srcIndex);
    const hi = Math.min(lo + 1, input.length - 1);
    const frac = srcIndex - lo;
    output[i] = input[lo] * (1 - frac) + input[hi] * frac;
  }
  return output;
}
