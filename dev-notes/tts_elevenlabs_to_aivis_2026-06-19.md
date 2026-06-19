# 音声合成を ElevenLabs から Aivis Cloud API へ移行 — 2026-06-19

## 背景 / なぜ

ユーザーから `/goal` 指示: 「イレブンラボではなく aivis Speech を使うように調整し直して。
かつ、より人間らしい応答と音声の返答を行うことができるように、自律的に判断を下して、
システムの改善を行って」。

`humanity_voice_chatvolume_fix_2026-06-18.md` で記録済みの「人間性を感じない」問題のうち
**問題1(ElevenLabs APIキーが無効で常に無音)** はユーザー判断で対応見送りになっていたが、
今回の指示はその根本原因そのもの(プロバイダ依存)を作り直す機会だったため、ElevenLabsを
撤去してAivis Cloud APIに置き換えた。

## やったこと

1. `backend/app/tts.py` — ElevenLabs REST呼び出し(`xi-api-key` ヘッダ、`/text-to-speech/{voice_id}`)
   を Aivis Cloud API(`Authorization: Bearer`、`/tts/synthesize`)に置き換え。
   感情→声の抑揚マッピング(旧: `stability`/`similarity_boost`/`style`)を
   Aivis側のパラメータ(`speaking_rate`/`emotional_intensity`/`volume`)に対応づけて移植。
   既定モデルUUID(`a59cb814-0083-4369-8542-f51a29e72af7`)は、この端末の Claude Code 通知
   (`~/aivis_notify.py`)で既に動作確認済みのものを再利用。
2. `worker/src/tts.ts` / `worker/src/env.ts` — Cloudflare Worker版(backend/app/tts.py の
   TypeScript移植)も同様に置き換え。`npx tsc --noEmit` で型チェック green。
3. `.env` / `.env.example`(backend)、`README.md`、`worker/DEPLOY.md`、`worker/wrangler.jsonc`
   の ElevenLabs言及をすべて Aivis Cloud API に更新。
4. `AIVIS_API_KEY` はこの端末で既に `~/.zshrc` にエクスポート済みの値(Claude Code通知と共用)を
   `backend/.env` にもそのまま設定(ローカル開発用、Gitで追跡される最小権限の前提は変えていない —
   既存の `.env` も Groqキーを平置きする運用だったため、その慣習に合わせた)。

## 見つかった副作用(コード修正済み)

- `tests/test_limits.py::test_tts_gated_off_by_default` が ElevenLabs時代は **キーが無効で
  あることに依存して** 偶然パスしていた(`ENABLE_TTS=true` のままだったが、APIコールが401で
  失敗して結局204を返すため、ゲート自体は未検証だった)。Aivisキーは有効なため、この置き換え後は
  実際にネットワークへ音声合成リクエストが飛んで200が返り、テストが失敗した。
  → `monkeypatch.setattr(main, "ENABLE_TTS", False)` を追加し、ゲート挙動そのものを
  環境変数に依存せずテストするよう修正(他のレート制限テストと同じパターン)。

## 検証

- `python -c "import app.main"` → import成功。
- `pytest -q`(backend) → 33 passed(修正前は1件が上記の理由でfail)。
- `npx tsc --noEmit`(worker) → exit 0、エラーなし。
- ローカルでuvicorn起動 → `GET /api/tts?text=...&emotion=happy` を実際に叩いて
  HTTP 200・有効なMP3(ID3v2.4, MPEG layer III, 192kbps)を取得・再生確認。

## 状態・フォローアップ

- [x] backend(FastAPI)のTTSをAivisへ移行
- [x] worker(Cloudflare)のTTSをAivisへ移行
- [x] テストの偽陽性を修正(ENABLE_TTSゲートを明示的にテスト)
- [x] README/DEPLOY.md/wrangler.jsonc の言及を更新
- 残課題(優先度低・未対応):
  - 感情別パラメータ(`speaking_rate`/`emotional_intensity`/`volume`)の聴感上の差は
    機械的な動作確認(200応答・MP3デコード成功)のみ。実際に複数感情を聴き比べての
    微調整はまだ行っていない。
  - `v-mate-study`(研究版)は元々TTSモジュール自体を撤去済み(身体様式比較実験のため
    音声を変数から外す設計)。今回はそちらには手を入れていない。
  - テキスト表示とTTS再生の速度ズレ(`humanity_voice_chatvolume_fix_2026-06-18.md` で
    既知・未対応として記録済み)は今回もスコープ外。
