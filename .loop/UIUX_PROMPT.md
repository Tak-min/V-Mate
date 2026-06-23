あなたはv-mate(3Dコンパニオン「シロ」)のUI/UX人間性改善ループの、ヘッドレス自律実行の1反復です。
作業ディレクトリ: /Users/taku8/Desktop/v-mate

# 毎回必ず最初にやること
1. `.loop/UIUX_VISION.md` を読み、Goal/制約/バックログ(9タスク, 優先順位・依存関係つき)を確認する。
2. `.loop/UIUX_state.json` を読み、`completed_tasks` を確認する。
3. `git log --oneline -5` と `git status` で直前の反復が何をしたかを確認する。

# 今回やること(1反復 = 1個のsmallest verifiable step)
- バックログのうち `completed_tasks` に入っていない最小番号のタスクを1つ選ぶ。
  - 依存関係: タスク2はタスク1完了後のみ着手可。タスク3はタスク1の`lastInteractionAt`を再利用する
    ため1完了後が望ましい。タスク4,5,6は独立。タスク7,8,9はCSSのみで独立。
  - そのタスクが何らかの理由で実装不能と判明したら(例: 該当コードが既に存在/前提が崩れている)、
    `.loop/UIUX_state.json`の`completed_tasks`に入れて「スキップ理由」を`last_action`に記録し、
    次のタスクへ進む(同じタスクで何度も詰まらない)。
- `.loop/UIUX_VISION.md`のブループリント記述に従って、そのタスクだけを実装する。
  欲を出して複数タスクを同時に進めない(差分は小さく、レビュー・検証しやすい範囲に留める)。
- `viewer.ts`/`useCompanion.ts`(ロジック)を触った場合は、実装後に
  Agent(Task)ツールで `typescript-reviewer` または `react-reviewer`(model: sonnet)を1つ
  ディスパッチし、CRITICAL/HIGH指摘が無いか確認する。指摘があれば自分で直す。
  `global.css`のみを触るタスク(7,8,9)はこのレビューを省略してよい。
- 実装後、必ず以下を実行してbuildがgreenであることを確認する:
  ```
  cd frontend && npx tsc --noEmit -p . && npx vite build
  ```
  失敗したら、そのタスクの範囲内で原因を直す。直せない場合はタスクを完了扱いにせず、
  `last_action`に失敗内容を記録して終了する(次反復で再挑戦できるようにする)。
- 成功したら `.loop/UIUX_state.json` を更新する: `completed_tasks`に番号を追加し、
  `last_task`/`last_action`/`iteration`(+1)を更新する。
- `.loop/UIUX_VISION.md`の「進捗ログ」セクションに1行、何をしたかを追記する。
- git add/commitはloop-engine.sh側が自動で行うので、あなた自身でcommitしなくてよい
  (した場合も害はない)。

# やってはいけないこと
- バックログにない新機能や大規模リライトを始めない(viewer.tsの既存ロジックを壊さない)。
- 新規.vrmaモーションキャプチャファイルを「作る」ことを試みない(ツールが無く不可能)。
- realistic.vrm/research-condition関連やiOS VADなど、このVISIONのスコープ外のファイルを触らない。
- ビルドが壊れた状態でcompleted_tasksに番号を追加しない。

# 完了条件(このプロンプト自体の終了条件ではなく、ループ全体のDoD)
9タスク全てが`completed_tasks`に入り、buildがgreenであること。ループのオーケストレーター
(loop-engine.sh)がこの状態を検知して自動停止する。あなたは1反復分だけ進めればよい。
