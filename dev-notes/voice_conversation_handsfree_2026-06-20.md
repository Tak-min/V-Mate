# ハンズフリー音声会話(連続ターン)の実装 — 2026-06-20

## 目的(ユーザー要望)

- 「音声での対話機能」をつけ、**人間とちゃんと会話しているように**感じさせる。
- 一問一答(ワンターン)ではなく、**毎回「更新ボタン」を押さずにそのまま会話を続けられる**こと。
- リアリスティックな会話体験を自律的に設計・構築する。

## 着手前の現状(分析)

- 既存の「音声」は **TTS(出力)のみ**(`features/voice/speech.ts` = `SpeechQueue`、Aivis Cloud の MP3 を Web Audio で再生+リップシンク)。
- **STT(音声入力)は完全に未実装**(`grep -ri "SpeechRecognition|getUserMedia|MediaRecorder"` でヒット 0)。
  → つまり「話しかける」手段が無く、毎回テキストを打って送信ボタンを押す一問一答だった。これが「更新ボタンを押す」体験の正体。
- 会話の核: `features/chat/useCompanion.ts` の `send()` が SSE ストリーミング → 文分割 → TTS キュー投入 + 表情/モーション。
- Viewer (`features/vrm/viewer.ts`) は既に `AttentionMode = 'idle'|'typing'|'listening'|'thinking'|'speaking'` を持ち、**`'listening'` の所作(注視・前傾)も実装済み** → 「聞き入る」表現に流用できた。

## 設計判断

### STT エンジン = Web Speech API(`SpeechRecognition`)を採用

| 観点 | Web Speech API(採用) | クラウドSTT(Groq Whisper 等) |
|---|---|---|
| 追加キー/バックエンド | **不要(フロント完結)** | 要(worker/ 改修・キー・D1 連携) |
| 本番反映 | `npm run build` のみ | worker デプロイが必要 |
| 部分認識(リアルタイム字幕) | **ネイティブ対応** | 自前実装が必要 |
| iOS WKWebView | **非対応**(後述) | getUserMedia は可 |

**本番ルール(`worker/` が本番、`backend/` は参照のみ)に一切抵触しない**点が決め手。STT は `features/voice/recognition.ts` の `SpeechRecognizer` に閉じ込めてあるので、将来クラウドSTT や iOS ネイティブへ**差し替え**ても他は無改修。

### ターンテイキング状態機械

`useCompanion.ts` に `VoiceMode = 'off' | 'listening' | 'thinking' | 'speaking'` を追加し、自動で回す:

```
off ──(マイクON)──▶ listening
listening ──(沈黙で発話確定)──▶ thinking ──(最初のトークン)──▶ speaking
speaking ──(TTSキュー枯渇)──▶ listening   ← 「更新ボタンを押さずに続く」核心
任意の状態で「とめて話す」──▶ listening（バージイン）
```

- **エコー対策**: `thinking`/`speaking` の間はマイクを止める(`recognizer.stop()`)。相手の声を自分のマイクが拾って誤認識するのを防ぐ。発話し終えてから聞き取りを再開。
- **自動再開トリガ**: `SpeechQueue` に `onDrained`(キューを再生し切った瞬間)と `isSpeaking()` を追加。`応答ストリーム完了(responseDoneRef)` かつ `発話キュー空` の AND で `resumeListening()`。ストリーミング途中の一瞬の空キューで誤発火しないよう AND にしている。
- **バージイン**: `streamChat` に `AbortSignal` を追加。`interrupt()` で進行中SSEを中断+TTS停止+即 listening。

## 追加/変更ファイル

- 新規 `frontend/src/features/voice/recognition.ts` — `SpeechRecognizer`(継続認識・沈黙確定・自動再開・能力検出)。
- 変更 `frontend/src/features/voice/speech.ts` — `onDrained` コールバック + `isSpeaking()`。
- 変更 `frontend/src/features/chat/api.ts` — `streamChat(..., signal?)`。
- 変更 `frontend/src/features/chat/useCompanion.ts` — 状態機械(`voiceMode`/`partialTranscript`/`voiceSupported`/`voiceError`/`toggleVoiceMode`/`interrupt`)。
- 新規 `frontend/src/components/VoiceControl.tsx` — マイクトグル+状態HUD+リアルタイム認識テキスト+「とめて話す」。
- 変更 `frontend/src/App.tsx` — ツールバーに配線。
- 変更 `frontend/src/styles/global.css` — `.voice-*`(既存 oklch トークンに合わせたガラスUI、聞き取り中のパルス等)。

## 検証

- `npm run build`(= `tsc -b` 型チェック + vite build)**成功**。出力は `backend/static/`(本番 Worker が ASSETS で配信するパス)。
- 静的サーバ + Playwright 煙テスト:
  - ページマウントに**音声コード由来のランタイムエラー無し**(コンソールエラーは全て backend 不在の `/api/*` 404/501 で、いずれも `.catch` 済み。警告は既存の THREE.Clock 非推奨のみ)。
  - マイクボタンがツールバーに描画(🎤 🔊 📔)。
  - 会話モード ON → `listening` 遷移・HUD 表示・マイク pulsing・エラー無しを確認。
- **未検証(自動では不能)**: 実マイクを使った STT→送信→TTS→自動再開のフルループ。headless Chromium には音声入力デバイスも音声認識サービスも無いため。**実ブラウザ(Chrome/Edge)+マイクでの実機確認が必要**。

## 落とし穴 / gotcha

- **Symptom**: 認識エンジンを `toggleVoiceMode` で1度だけ生成 → `onUtterance` が初回の `handleUtterance` クロージャを掴み続ける。`busy` が変わるたび `send`/`handleUtterance` の同一性が変わるので、放置すると**古い `send` を呼ぶ**。
  - **Cause**: React の useCallback 同一性 + コールバックを外部オブジェクト(recognizer)に渡す典型。
  - **Fix**: `handleUtteranceRef` を毎レンダ更新し、recognizer からは `(t) => handleUtteranceRef.current(t)` で最新を呼ぶ。
- **Symptom**: Chrome は `continuous=true` でも認識エンジンを周期的に止める(`onend` が突然来る)。
  - **Fix**: `shouldRun` フラグを見て `onend` で再開(`RESTART_DELAY_MS`)。`start()` の二重呼び出し(InvalidStateError)は try/catch で無視。
- **Symptom**: 発話を沈黙で確定する際、しきい値が短いと言い淀みで切れる。`SILENCE_MS=1400` に設定。要調整余地。
- マイク権限拒否(`not-allowed`/`service-not-allowed`)→ `onError('permission')` で会話モードを OFF に戻し `voiceError` 表示。

## 本番反映の手順(未実施)

**本機能はフロントエンドのみ**なので worker/src は無改修。だが配信は Worker 経由なので:

1. `cd frontend && npm run build`(済。`backend/static/` 更新済み)。
2. デプロイ時の既知の手順(落とし穴・要遵守): `frontend/public/models/realistic.vrm`(53MB)は Cloudflare 資産上限 25MB 超で `wrangler deploy` が `Asset too large` で失敗する。**一時退避 → deploy → 復元**が必要(`aikata-companion` メモリ参照)。
3. `cd worker && npx wrangler deploy`。D1 スキーマ変更は無いので `d1 execute` は不要。

→ outward-facing のため、**push/デプロイはユーザー確認後に実施**。

## フォローアップ / 次にやること

- [ ] 実ブラウザ+マイクでフルループ実機確認(沈黙しきい値・誤認識・割り込みの体感調整)。
- [ ] **iOS ネイティブSTT**: WKWebView は `SpeechRecognition` 非対応。iOS アプリ(`ios/`)で会話モードを使うには、`SFSpeechRecognizer` + `AVAudioEngine` で認識し、`WKScriptMessageHandler`(JS ↔ Swift ブリッジ)で `handleUtterance` 相当へ流す設計が要る。`recognition.ts` を差し替えるだけで本体ロジックは再利用可。
- [ ] 音響的バージイン(発話中もマイクを開けて、ユーザーが話し始めたら即中断)。今は発話中マイクOFF + 「とめて話す」ボタン方式(エコー回避優先)。`getUserMedia({ echoCancellation:true })` ベースの VAD を別途用意すれば可能。
- [ ] 研究計測: `voice_mode` イベントは記録済み。会話モードの利用率/ターン数を survey 文脈に追加検討。
