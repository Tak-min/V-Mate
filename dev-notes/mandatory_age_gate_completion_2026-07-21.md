# 必須年齢ゲートの E2E 完成 (2026-07-21)

## 背景と根本原因

Phase 0 の年齢ゲートは Worker の DOB 保存と iOS の入力画面までは存在したが、公開経路全体では
必須になっていなかった。

- **Symptom**: Web 利用者は DOB を一度も入力せず会話でき、将来の購入判定では全員
  `age_required` になる。
- **Cause**: Web オンボーディングに年齢ステップがなく、Worker は年齢未登録を minor 扱いで
  チャット許可していた。iOS は Welcome のスキップと `isFirstRun == false` の既存利用者経路で
  DOB を回避できた。
- **Fix**: Worker の年齢状態を唯一の権威にし、Web/iOS の起動時に状態を取得する。未登録または
  13歳未満なら chat/nudge/TTS/diary generation を 403 で止め、クライアントは必須 DOB 画面または
  終端ブロック画面を表示する。

## 変更契約

- `GET /api/profile/age` は `{ age_band, required }` を返す。
- iOS の `required` は旧 Worker の POST 応答とも共存できるよう optional にしている。公開順は
  `schema_v3 -> Worker/Web -> iOS` とする。
- 年齢未登録の生成系 API は `403` + `code: "age_required"`、13歳未満は
  `403` + `code: "age_restricted"` を返す。
- DOB からの band 計算は引き続き Worker の `computeAgeBand()` だけが行う。
- Web の既存オンボーディング完了者と iOS の既存利用者にも、サーバに age 行がなければ一度だけ
  DOB を要求する。
- 13歳未満はクライアント UI だけでなく Worker 側でも生成処理へ到達できない。

## 影響と運用上の注意

- 本番デプロイ前に `npm run db:migrate-v3:remote` が必須。未適用だと age API が 500 になり、
  全利用者がオンボーディングで停止する。
- DOB はコンプライアンス属性として D1 に保存される。公開前にプライバシーポリシーへ利用目的、
  保持期間、削除方法を明記する。
- `worker/wrangler.jsonc` の未コミット変更では `ENABLE_TTS=true` になっているが、TTS 専用の
  利用量制限はまだない。公開前は `false` を推奨し、有効化は専用レート制限実装後に行う。
- Web の HttpOnly セッション認証不整合は未修正。次の優先順位は
  `必須年齢ゲート -> Webセッション認証/iOS安定ID -> entitlements -> Stripe/StoreKit`。

## 検証

- `cd worker && npm test`: 5 files / 40 tests passed。age GET/POST、未登録の
  chat/nudge/TTS/diary generate 拒否、13歳未満 chat 拒否を Worker 実リクエストで確認。
- `cd worker && npm run typecheck`: passed。
- `cd frontend && npm run build`: passed。
- `cd ios && xcodebuild ... build`: passed (iOS Simulator, code signing disabled)。
- `cd ios && xcodebuild ... test`: passed (iPhone 17 Simulator)。
- ブラウザ描画確認: Codex 内ブラウザへの接続時に sandbox metadata 不足で開始できず未実施。
  Web の見た目・DOB 入力操作は次回ブラウザ利用可能時に確認する。
