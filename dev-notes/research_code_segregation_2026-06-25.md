# 研究コードの棲み分け(本番クリーン化 + study現行TS刷新)— 2026-06-25

> loop-engineer「SEGREGATE」。起点指示: 「本番に残る研究用コードを批判的に分析し、study に棲み分け、
> プロダクトコードと同期するループを回す」。ユーザー判断で「本番の研究データ収集は終了」「study を現行TS
> 構成へ刷新(大規模)」を選択。関連 [[aikata-companion]]。

## 批判的分析で判明した事実(着手前の前提が現実と食い違っていた)
1. **研究コードは本番で「死蔵」ではなく能動稼働していた**: 本番 worker は全チャットで研究条件を
   uidハッシュ割付(`researchCondition`)し、`chat_sent`/`assistant_done` を D1 `research_events` に記録、
   `/api/research/{session,event,export}` を公開していた。2026-06-23 の「完全撤去」は **frontend/iOS の UI 層だけ**で、
   worker バックエンドの研究配管は丸ごと残存=ユーザーの懸念は的中。
2. **v-mate-study は worker を持たない死蔵 Python フォーク**: コミット単発(`4d51544`)、2026-06-17 の
   Cloudflare 移行で置き去り、Render前提(無料DB失効で未稼働)。**研究データは実際には「本番 production D1」で
   収集されており、study では収集していなかった**。よって「研究コードを study に棲み分け、プロダクトと同期」は、
   study が TS worker を持たないため**そのままでは成立しない**(着手前にこの乖離をユーザーへ surface し、方針を確認)。

## 実施(2リポジトリ)
### 本番 v-mate: 研究スキャフォールド完全撤去(commit `69e7321`・本番Version `08219618`)
- `index.ts`: `RESEARCH_CONDITIONS`/`researchCondition`/`logResearchEvent`/`/api/research/*` 群とルーティング削除、
  `postChat` から condition 撤去。`envBool`(研究のみ使用)も削除。
- `chat.ts`: `addResearchEvent`/`messageMetrics`/`RESEARCH_METRICS_VERSION`/`SENSITIVE_SELF_DISCLOSURE_RE` 削除、
  `handleChat` の condition 引数撤去(全チャットの研究イベント記録を停止)。親密度加点/facts/summary は温存。
- `db.ts`: `addResearchEvent`/`listResearchEvents` 削除、`reassignUserData` の対象から research_events 除外。
- `env.ts`: `RESEARCH_ALLOW_CONDITION_OVERRIDE`/`RESEARCH_EXPORT_TOKEN` 削除。
- `schema.sql`: `research_events` テーブル定義削除。`wrangler.jsonc`: 研究env削除。
- **検証(本番)**: `/api/research/{session,event,export}` 全て **404**(対照 `/api/state`=200)、チャット SSE は
  emotion/token×26/done・error0 で正常。worker typecheck 緑、worker/src に research 参照ゼロ。

### 研究版 v-mate-study: 現行TS構成へ刷新(commit `6eeeafa`)
- 死蔵の旧Python版を、本番 v-mate の HEAD 追跡ツリーで置換(`git archive HEAD | tar -x`)。
  → study = 現行製品(worker/frontend/ios)+ 研究層(worker の研究コードごと取り込み)。製品ベースラインは本番と同一=同期確立。
- `worker/wrangler.jsonc` を**研究版専用識別子**へ変更(name=`aikata-study`、専用D1プレースホルダ)=本番上書き防止。
- `STUDY.md` に位置づけ・同期手順・デプロイ手順・残作業を明記。

## 落とし穴 / 判断(Symptom → Cause → Fix)
- **クロスリポ同期に rsync は不適**: study の `backend/venv` の .pyc 等3174件が差分に混入。
  **Fix**: `git archive HEAD | tar -x` で**追跡ファイルだけ**を同期(venv/node_modules/未追跡モデルを自動除外)。クリーン。
- **study の wrangler が本番と同じ name/D1 を指す危険**: archive 直後は `name:aikata`・本番D1 id のまま=
  そのままデプロイすると**本番を上書き**。**Fix**: 先に `aikata-study`+専用D1プレースホルダへ変更してから commit。
- **D1 マイグレーション**: schema から research_events を**削除**しても既存リモートD1のテーブルは残る(無害)。
  今回は table を drop しない(コードが参照しなくなるだけ=未使用テーブルが残るのみ。drop はマイグレ事故リスクのため見送り)。
- 本番curl の `%{http_code}` が一時 `000`(接続レベル失敗の表示)になることがある→個別 curl -i で 404 を確実に確認。

## 残作業(handoff・study 側)
- **研究版の Cloudflare 実プロビジョニング**(`wrangler d1 create aikata-study` → id 差し替え → db:init:remote →
  secret put → deploy)=オーナーのアカウント操作が必要。
- **frontend の身体様式条件分岐(text/stylized/realistic 出し分け)の再付与**: 本番では撤去済みのため、研究版で
  比較実験するには frontend に condition 駆動のアバター/UI 切替を再実装する必要(worker 側 `/api/research/*` と
  `?condition=` override は study に揃っている)。
- 保守性向上(任意): 研究層を `worker/src/research.ts` 等の独立モジュール+最小フックに切り出すと、今後の製品同期が
  単純コピーで済む(現状はインライン)。詳細は `v-mate-study/STUDY.md`。
- 本番 production D1 に残る未使用 `research_events` テーブル: 無害だが、完全に消すなら別途 `wrangler d1 execute` で drop。
