# デプロイ — シロ(Aikata)

**本番デプロイ先は Cloudflare(全Cloudflare・無料・DB永続)に移行した。**

➡ 手順は **[`worker/DEPLOY.md`](worker/DEPLOY.md)** を参照。

構成: Cloudflare Workers(`worker/` の TypeScript 実装。API + 静的フロント同居)
+ D1(SQLite・無料・無期限)+ Groq(無料LLM)。

## どのバックエンドが本番?

| 実装 | 役割 |
|------|------|
| `worker/`(TypeScript / Cloudflare Workers + D1) | **本番。これをデプロイする。** |
| `backend/`(Python / FastAPI + SQLite/Postgres) | ローカル開発・研究用の参照実装。`worker/` は機能等価。 |

`worker/` は `backend/app/*.py` をエンドポイント単位で忠実移植したもの(SSE のワイヤ形式・Cookie 方式・
親密度/記憶/日記/レート制限の挙動が一致)。設計判断と移植時の落とし穴は
[`dev-notes/cloudflare-migration_2026-06-17.md`](dev-notes/cloudflare-migration_2026-06-17.md) に記録。

## 旧構成について

以前の Render + Neon 構成(`render.yaml`)は、Render 無料 Postgres が一定期間で失効するため廃止した。
Cloudflare D1 は無料・無期限・無操作でも消えないため、その問題は発生しない。
