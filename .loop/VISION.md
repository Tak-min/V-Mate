# VISION — シロ(Aikata)を不特定多数向け公開Webサービス化

## ゴール(Definition of Done)

誰でもアクセスできる**公開URL**で、訪問者が**アカウント登録**して**自分専用のシロ**(記憶・親密度・日記が他人と分離)と会話できる。LLMは**Groq(OpenAI互換・無料)**、キーは**サーバ保持**、**レート制限**で費用暴走を防止、**ホスティングは原則 $0**。

満たすべき検証可能な条件:
- [ ] 公開URLにアクセスでき、サインアップ/ログインできる
- [ ] 別アカウント間で会話・記憶・親密度・日記が完全に分離している
- [ ] ログイン中ユーザーはGroq経由でシロと会話できる(ストリーミング)
- [ ] 1ユーザー/日 と 全体/日 のレート上限が効く(超過時は明確なメッセージ)
- [ ] 公開時 TTS は既定オフ(無料枠保護)。env で切替可能
- [ ] APIキー等の秘密情報がクライアントに露出していない
- [ ] ホスティング費用が原則 $0(無料枠内)

## 採用スタック(自律判断・無料/学生最適)

| 層 | 採用 | 理由 |
|----|------|------|
| LLM | **Groq**(OpenAI互換, `llama-3.3-70b-versatile` / 日本語は `qwen/qwen3-32b`) | 無料・高速・非学習・乗換容易(Part1で実装済) |
| ホスト | **Render** 無料Webサービス(Docker, 単一サービスでAPI+ビルド済フロント配信) | 無料・Docker・最小構成。コールドスタートは許容 |
| DB | **Neon** 無料Postgres(`DATABASE_URL`)。未設定時はSQLite(ローカル開発) | 無料・永続・サーバーレス。Renderの揮発FSでも記憶が残る |
| 認証 | email+password(bcrypt/passlib)+ **JWT** | OAuthアプリ登録不要で最小。将来Google OAuth追加可 |
| TTS | ElevenLabs(既定オフ in 公開) | 無料枠が極小のため費用保護。env `PUBLIC_TTS=off` |
| 費用対策 | per-user/日 + 全体/日 のDBカウンタ制限 | Groq無料1000req/日(全体共有)を守る |

## ビルド順(各フェーズは単体で動く=shippable)

- **Phase 0** ✅ アンカー(本ファイル, PROMPT.md, state.json)
- **Phase A** ユーザー分離データ層 + 匿名Cookie ID(各ブラウザ=別シロ。アプリは常に動く)
- **Phase B** `DATABASE_URL` でPostgres対応(Neon)。SQLiteフォールバック維持
- **Phase C** アカウント(signup/login, JWT)。Cookie匿名IDをログイン時にアカウントへ昇格/紐付け ※security-reviewer(opus)
- **Phase D** レート制限(per-user+全体)+ 公開TTSゲート + 本番CORS/PORT
- **Phase E** フロント認証UI(ログイン/登録, トークン付与, 401処理)
- **Phase F** デプロイ構成(Dockerfile, render.yaml, ビルド)+ 公開

## 外部準備(ユーザー側で必要)

1. **Groq APIキー** → `LLM_API_KEY`(https://console.groq.com)
2. **Neon アカウント** → `DATABASE_URL`(Phase B以降)
3. **Render アカウント** → デプロイ+環境変数設定(Phase F)
4. JWT用 `SECRET_KEY`(Phase Cで自動生成手順を用意)
5. TTSを公開で使うなら ElevenLabs 有料(既定は公開オフ)

## ガードレール(loop)

- 最大イテレーション 20 / 同一エラー3連続で停止し報告
- 認証・DBはレビューを通す(security-reviewer / database-reviewer = opus)
- 各フェーズ後に `git commit` でチェックポイント
- 秘密情報はコミットしない(.env はgitignore済を確認)
- 各フェーズ完了で `verify`(import + pytest + tsc)を緑にしてから次へ
