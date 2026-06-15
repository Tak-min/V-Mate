# LOOP PROMPT — シロ公開サービス化

あなたは loop-engineer。`.loop/VISION.md`(ゴール・スタック・ビルド順・DoD)と
`.loop/state.json`(現在地)を読み、**次の最小の検証可能な一歩**だけ実装する。

手順(毎回):
1. `.loop/state.json` と `git status/diff`、前回の verify 出力を読む。
2. VISION.md のビルド順から「次のフェーズの最小スライス」を1つ決める。
3. 実装する(認証・DBは security-reviewer / database-reviewer=opus のレビューを通す)。
4. verify を緑にする: `cd backend && .venv/bin/python -m pytest -q && .venv/bin/python -c "import app.main"` と
   `cd frontend && npx tsc --noEmit`。赤なら次の一歩はその修正。
5. `git add -A && git commit` でチェックポイント。`.loop/state.json` を更新。
6. 停止条件(VISION.md ガードレール)を確認。DoD達成 or 上限 or 3連続停滞 で停止し報告。

原則: 各スライスは単体でアプリが動く状態を保つ。秘密情報はコミットしない。
