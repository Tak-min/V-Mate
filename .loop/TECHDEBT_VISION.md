# VISION — VMate 技術的負債 自律改善ループ

> 起点指示: 「実際の技術スタック・ワークフロー・コードベースを詳細分析し、構成を批判的分析→問題特定→自律改善を繰り返す」。  
> DoD 採択: **C（広範技術的負債ループ）** — 最も影響の大きい技術問題を1イテレーションに1つ潰す。

## Definition of Done（停止条件）

- **成功終了**: コードベース全体の **Critical / High** 問題が全部解消され、当該カテゴリが残存ゼロになったら成功退出。
- **硬上限**: 最大 20 イテレーション。
- **No-progress**: verify シグナルが3回連続同一（停滞）なら停止して報告。
- バudget: 特になし（監視下で実行）。
- 失敗時: `.loop/TECHDEBT_report.md` に symptom → cause → tried を書いてユーザーに報告。

## 優先順位（毎回）
1. Critical / High を最優先（code-reviewer / security-reviewer 出力を信頼）
2. 同一カテゴリ内では「ユーザー体験 or データ整合 or 秘密露出」に関わる順
3. 低負債（doc/style/low）は DoD 外で本ループでは扱わない（別ループまたは手動）

## 検証コマンド（赤信号は次イテレの入力）
- `cd backend && .venv/bin/python -m pytest -q` （Pythonテスト）
- `cd backend && .venv/bin/python -c "import app.main"` （import）
- `cd frontend && npx tsc --noEmit` （TS型チェック）
- iOS: `cd ios && xcodebuild -scheme VMate -destination 'generic/platform=iOS Simulator' build` は重いので、必要時に実行
- Worker: `cd worker && npx tsc --noEmit`

## ガードレール
- 各イテレーションは最小の検証可能な1変更。
- verify 赤の時は次の一歩がその修正になる。
- 秘密はコミットしない(.env, secrets)。
- `git add -A && git commit` でチェックポイント。
- AGENTS.md / 既有 repo 規約に従う。

## TODO リスト（Phase 1 Recon 完了 — 2026-06-27）

> code-reviewer subagent による体系的レビューで抽出。4 CRITICAL + 8 HIGH。

### CRITICAL
- [x] **C1. JWT_SECRET ハードコードデフォルト** — `auth.py:20` / `worker/src/auth.ts` — env 未設定で公開定数稼働→任意JWT偽造可能。FAIL-FAST化(未設定/32B未満で RuntimeError)。✅ iter1: backend `_get_jwt_secret()` 関数化+conftest setenv、worker `jwtSecret()` で throw。pytest67 / tsc×2 green。
- [x] **C2. 研究コード+センシティブ自己開示指標が本番backendで稼働中** — `main.py:88-91,128-135,263-289,324-360,433-441,516-524` + `memory.py:94-102,419-428` — Workerは済、未同期。`/api/chat` 毎に `SENSITIVE_SELF_DISCLOSURE_RE` で自殺/自傷/恋愛関連語を `research_events.payload` へ平文保存。本番撤去。✅ iter2: research_events table、`/api/research/*` ルート、`_log_research_event`/`_message_metrics`/`_research_condition`/`SENSITIVE_SELF_DISCLOSURE_RE`、ChatRequest.condition を完全削除。`/api/research/*` は 404 確認済。
- [x] **C3. 撤去阻害連鎖** — `tests/test_research.py` + `memory.reassign_user_data` が `research_events` に依存。C2 撤去と同時に cleanup。✅ iter2: test_research.py 削除 / test_utils.py の `_message_metrics` テスト除去 / `reassign_user_data` を `(messages, facts, diary, kv)` に縮約★ Worker(db.ts:226-231) と完全整合。
- [ ] **C4. JWT を localStorage 保存** — `frontend/src/features/chat/api.ts:4-8` — XSS で即座乗っ取り。匿名 uid は httpOnly Cookie。JWT も HttpOnly Cookie 化、前端 removeToken/credentials:include。

### HIGH
- [ ] **H5. Worker 500 応答に未 sanit のエラーメッセージ** — `worker/src/index.ts:345-347` — D1/LLM エラー本文が露出。固定メッセージ化+console.error。Python event_stream も type(exc).__name__ を除去。
- [ ] **H6. `bump_usage` レース条件 + 同期 I/O がイベントループをブロック** — `memory.py:394-416` — Postgres で INSERT..ON CONFLICT..DO UPDATE..RETURNING 化・非同期化。
- [ ] **H7. iOS Certificate Pinning なし + Cookie `.always`** — `APIClient.swift:10,14-20` — SPKI pin / `.onlyFromMainDocumentDomain`。
- [ ] **H8. iOS に signup/login 未実装** — `APIClient.swift:58-105` — 認証経路全欠、Cookie 1端末限り。
- [ ] **H9. CORS `allow_methods/headers=["*"]` + credentials** — `main.py:66-72` — `["GET","POST"]` / `["Authorization","Content-Type"]` に限定。
- [ ] **H10. iOS micLog が RMS/音声情報を release でも info 出力** — `SpeechRecognizer.swift:144,194,224,231,404` — `#if DEBUG` gate。
- [ ] **H11. `reassign_user_data` の Worker/Backend テーブル非対称** — C2 解消で worker と整合。
- [ ] **H12. Worker `decodeToken` が `header.alg` 未検証** — `worker/src/auth.ts:99-121` — alg === "HS256" 検査 or `jose` 導入。

### 検証コマンド（毎回）
- `cd backend && .venv/bin/python -m pytest -q`
- `cd backend && .venv/bin/python -c "import app.main"`
- `cd frontend && npx tsc --noEmit`
- `cd worker && npx tsc --noEmit`