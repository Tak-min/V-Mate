# 毎ターンGitHub push + Cloudflare反映の運用開始、初回デプロイで本番障害 — 2026-06-18

## 背景 / なぜ

ユーザーから「開発を終えたら毎ターンGitHubにコミット・プッシュし、Cloudflareにも反映できる
ようにしてほしい(デバッグしやすくするため)」という指示を受けた。確認の上、
「今すぐデプロイし、以後も毎ターン自動デプロイする」運用に決定。

## 重要な前提: 本番は Python ではなく Cloudflare Worker(TypeScript)

[[cloudflare-migration_2026-06-17]] により、本番は `worker/`(TypeScript・Cloudflare Workers)
に全面移行済みで、`backend/`(Python/FastAPI)は**研究用のローカル参照実装として残置**されて
いるだけ。このセッションの前半で `backend/app/persona.py` 等に施した「人間性」修正は、
**`worker/src/*.ts` 側に手動で移植しないと本番には一切反映されない**。この移植を行った上で
コミットした(`persona.ts`, `tts.ts`, `llm.ts`, `chat.ts`, `index.ts`, `util.ts` に対応する修正)。

今後 `backend/app/` を直接修正した場合、**必ず対応する `worker/src/` の同等ファイルにも
同じ変更を入れること**。忘れると「ローカルでは直っているが本番は直っていない」という
ズレが静かに発生する。

## デプロイ前に発覚: realistic.vrm がアセットサイズ上限超過

`frontend/public/models/realistic.vrm`(53MB)が Cloudflare Workers の静的アセット上限
25MB を超えており、`wrangler dev` / `wrangler deploy` が `Asset too large` エラーで
即座に失敗する。git-lfs 未導入のため、巨大バイナリをそのまま commit するのもリポジトリの
肥大化を招く。

ユーザーに確認し、**今回は `frontend/public/models/realistic.vrm` を git commit 対象から
除外し、デプロイ時も `backend/static/models/realistic.vrm` を一時的に `/tmp` へ退避してから
`wrangler deploy` を実行**する方針にした(デプロイ後に元の場所へ復元)。

**フォローアップが必要**: 「realistic」提示条件(研究用の身体様式比較条件の1つ)は、
このファイルが本番アセットに存在しないため、本番で選択されると 404 になる。
次回、以下のいずれかで本格対応すること:
- gltf-transform 等でテクスチャ/メッシュを圧縮し 25MB 未満にする
- Cloudflare R2 にアップロードし、Worker の静的アセットではなく外部URLとして配信する

## 本番デプロイ直後に発生した障害(Symptom → Cause → Fix)

- **Symptom**: `wrangler deploy` 自体は成功し、`/`(200)・`/api/tts`(200、音声も正常生成)は
  動いたが、`/api/chat` にPOSTすると **HTTP 200 だが本文が完全に空(SSEイベント0件)** で
  返ってきて、チャットが一切機能しない状態になっていた。
- **Cause**: `npx wrangler tail` で実request中の例外ログを確認したところ、
  `D1_ERROR: no such table: research_events: SQLITE_ERROR`。今回のコミットに含めた
  `worker/schema.sql`(研究イベント記録用の `research_events` テーブル追加)が、
  **コードはデプロイされたがD1データベース本体には一度もマイグレーション適用されていなかった**。
  `addResearchEvent()` がチャット処理の最初のステップ付近で呼ばれており、ここで未捕捉の
  例外が発生 → ストリーミングが始まる前に Worker がクラッシュ → クライアントには空の
  200レスポンスだけが返る、という壊れ方だった。
- **Fix**: `cd worker && npx wrangler d1 execute aikata --remote --file=./schema.sql`
  で本番D1にスキーマを適用(`CREATE TABLE IF NOT EXISTS` のため冪等・安全)。実行後、
  `/api/chat` への実リクエストで正常応答(`[relaxed] 丁度復旧したところですね…`)を確認し復旧。

**今後の教訓**: `worker/schema.sql` を変更した回は、`wrangler deploy` だけでなく
**`npm run db:init:remote`(= `wrangler d1 execute aikata --remote --file=./schema.sql`)も
必ず一緒に実行すること**。コード(Worker)とスキーマ(D1)は別々にデプロイされるため、
片方だけ更新すると同じ壊れ方をする。

## 検証

- ローカル: `frontend` `tsc --noEmit` 通過、`worker` `tsc --noEmit` 通過。
- ローカル: `wrangler dev --local` で起動(realistic.vrm除外前は Asset too large で起動失敗
  → 除外後は正常起動を別途確認)。
- 本番: デプロイ後に `/`(200)、`/api/tts?emotion=happy`(200、実際にMP3 31KB生成を確認)、
  `/api/chat`(初回は空応答で障害発覚 → スキーマ適用後に正常な日本語応答・感情タグ・
  人間性修正の効果(質問1つ・自然な相づち)を確認)。

## 状態・フォローアップ

- [x] persona/tts/llm/chat の人間性修正を `worker/src/*.ts` に移植
- [x] GitHubへcommit・push(`678e155`)
- [x] 本番デプロイ実行、D1スキーマ障害を発見・復旧
- [ ] realistic.vrm の容量問題(25MB超過)を本格対応する(圧縮 or R2外部配信)
- [ ] 以後、毎ターンのデプロイ運用を継続する場合、`worker/schema.sql` を触った回は
      必ず `db:init:remote` も忘れずに実行するチェックリストを徹底すること
