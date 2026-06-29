# オンデバイス Whisper STT — 音声をサーバに送信しない音声認識 (2026-06-29)

## 背景 / ユーザー要望

マイクで拾った音声がオンデバイスで処理されずにバックグラウンドサーバ(Google の
Web Speech API)に送信されており、これが致命的なレスポンスの無駄になっている。
音声データを一切外部に送信せず、ブラウザ内で完結する音声認識に切り替える。

## 問題分析

### 旧実装の問題

`frontend/src/features/voice/recognition.ts` は Web Speech API (`SpeechRecognition` /
`webkitSpeechRecognition`) を使用していた。これは「ブラウザ内蔵」に見えて実は
**クラウドベースのサービス**:

- Chrome: 音声データが Google のサーバに送信され、クラウドで処理される
- Safari: Apple のサーバに送信される
- ネットワーク往復のレイテンシが常に発生
- プライバシー: 音声データがデバイス外に漏出
- ネットワーク障害時に STT が完全に停止

### 既存の良好な部分(変更不要)

- **VAD(音声区間検出)**: RMS ベースの AnalyserNode による発話検出は完全にオンデバイス。
  このアーキテクチャは維持する。
- **TTS(音声合成)**: Aivis Cloud API はクラウドだが、高品質 TTS にはクラウドが必要。
  これは仕様通り。
- **LLM**: Groq クラウド API。これも仕様通り。

## 解決策: Transformers.js + Whisper-tiny

### 技術選択

| 観点 | Transformers.js + Whisper(採用) | Web Speech API(旧) | Whisper.cpp WASM |
|------|------|------|------|
| オンデバイス処理 | **完全オンデバイス** | クラウド | オンデバイス |
| 音声データ外部送信 | **なし** | Google/Apple へ | なし |
| 日本語対応 | **Whisper-tiny で対応** | ネイティブ | 対応 |
| モデルサイズ | ~75MB(初回DL後キャッシュ) | N/A | ~75MB |
| GPU 加速 | **WebGPU 対応** | N/A | 限定的 |
| 統合の容易さ | **npm パッケージ** | ブラウザ組み込み | ビルド要 |
| メンテナンス | **Hugging Face が維持** | ブラウザ依存 | 自前管理 |

### アーキテクチャ

```
旧: マイク → VAD → Web Speech API(クラウド) → テキスト → バックエンド
新: マイク → VAD → ScriptProcessorNode(PCM バッファ) → Whisper(オンデバイス) → テキスト → バックエンド
```

VAD による発話ゲーティングはそのまま維持:
- 沈黙時: VAD が RMS を監視するだけ(録音しない)
- 発話検出: しきい値超え → PCM バッファリング開始
- 発話終了: 沈黙でバッファ停止 → Whisper で文字起こし → 1 ターン確定

## 変更ファイル

### 新規
- `frontend/src/features/voice/whisper-engine.ts` — Whisper モデルのロード/キャッシュ/推論
  - `loadWhisperPipeline()`: モデルのロード(初回 ~75MB DL、以降 IndexedDB キャッシュ)
  - `transcribeAudio()`: Float32 PCM → テキスト変換
  - `resampleTo16kHz()`: ブラウザのサンプルレート(44.1/48kHz)から 16kHz へのリサンプル

### 変更
- `frontend/src/features/voice/recognition.ts` — 全面書き換え
  - `beginCapture()`: ScriptProcessorNode で PCM バッファリング開始(Web Speech API ではなく)
  - `endCapture()`: バッファ停止 → Whisper で文字起こし
  - `processWithWhisper()`: バッファ結合 → 無音トリム → リサンプル → Whisper 推論
  - **フォールバック**: Whisper 読込失敗時は Web Speech API に自動切替
  - `preLoadWhisper()`: モデルをバックグラウンドでプリロード
- `frontend/src/features/chat/useCompanion.ts` — `whisperLoadState` 状態を追加・公開
- `frontend/src/components/VoiceControl.tsx` — Whisper ローディング表示を追加
- `frontend/src/App.tsx` — `whisperLoadState` を VoiceControl に配線
- `frontend/src/styles/global.css` — `.voice-whisper-loading` スタイル追加

### 依存関係
- `frontend/package.json` — `@huggingface/transformers` を追加

## ビルド結果

- `npm run build` **成功**
  - `tsc --noEmit` 型チェック: エラーなし
  - Vite build: 69 モジュール、3.24 秒
  - 出力: `backend/static/`
    - `ort-wasm-simd-threaded.asyncify.wasm` (23.5MB) — ONNX Runtime WASM ランタイム
    - `transformers.web.js` (558KB) — Transformers.js コア
    - `index.js` (971KB) — アプリ本体
- バックエンドテスト: **63 passed** (変更なし)

## モデルのダウンロードとキャッシュ

1. ユーザーがマイクボタンを押すと、`toggleVoiceMode` が `SpeechRecognizer` を生成
2. `openMic()` 内で `preloadWhisper()` がバックグラウンドでモデルをロード開始
3. 初回: `Xenova/whisper-tiny` (~75MB) を Hugging Face CDN からダウンロード
4. 2 回目以降: IndexedDB からキャッシュロード(数秒)
5. VoiceControl に「音声認識モデルを読み込み中…」と表示
6. ロード完了後、通常の会話モードとして動作

## フォールバック設計

Whisper のロード/推論に失敗した場合、自動的に Web Speech API にフォールバック:
- モデル DL 失敗 → `whisperState = 'failed'` → `useFallback = true`
- 推論エラー → `useFallback = true` → 次回発話から Web Speech API を使用
- ユーザーに「音声認識をサーバー方式に切り替えたよ」的通知

## ハマりどころ (Symptom → Cause → Fix)

- **Symptom**: `pipeline()` のオプションで `chunk_length_s`, `language`, `task` を指定すると
  TypeScript 型エラー。
  **Cause**: Transformers.js の `pipeline()` は `PretrainedModelOptions` 型を受け、
  `language`/`task` はパイプライン呼び出し時(而非生成時)のパラメータ。
  **Fix**: パイプライン生成時は `progress_callback` のみ渡し、`transcribeAudio()` 呼び出し時に
  `{ language: 'japanese', task: 'transcribe' }` を渡すように修正。

- **Symptom**: `ScriptProcessorNode` が `destination` に接続しないと動作しないブラウザがある。
  **Cause**: `onaudioprocess` コールバックは `destination` に接続されたノードでないと
  発火しないブラウザ実装がある(Chrome の既知の挙動)。
  **Fix**: `scriptNode.connect(this.audioCtx.destination)` で接続。出力は無音(バッファサイズ
  が小さいため)。

## 申し送り / 次のステップ

1. **実機検証(最優先)**: ブラウザ(Chrome/Edge) + マイクで Whisper の音声認識精度を確認。
   特に日本語の短い発話(1〜3 文)での精度。
2. **WebGPU 確認**: WebGPU 対応ブラウザ(Win Chrome 113+等)で GPU 加速が有効になっているか
   を `env.backends.onnx.wasm.numThreads` 等で確認。
3. **モデルのアップグレード**: `whisper-tiny` の精度が不十分な場合は `whisper-base`(~140MB)
   への切替を検討。トレードオフ: ダウンロードサイズ vs 精度。
4. **iOS WKWebView**: iOS アプリ(`ios/`)では `SFSpeechRecognizer` を使用(既にオンデバイス
   対応済み)。WebView では Whisper WASM が動作するか要確認。
5. **キャッシュ戦略**: モデルのキャッシュ有効期限や更新方法の検討。
6. **VAD パラメータの較正**: Whisper は Web Speech API より長めの音声バッファを好む傾向。
   `HANGOVER_MS` の調整が必要かもしれない。
