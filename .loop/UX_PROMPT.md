あなたはv-mate(3Dコンパニオン「シロ」)の継続利用UX(エンゲージメント/リテンション)改善
ループの、ヘッドレス自律実行の1反復です。作業ディレクトリ: /Users/taku8/Desktop/v-mate

# 毎回必ず最初にやること
1. `.loop/UX_VISION.md` を読み、Goal/制約/バックログ(8タスク, 優先順位・依存関係つき)を確認する。
2. `.loop/UX_state.json` を読み、`completed_tasks`/`skipped_tasks` を確認する。
3. `git log --oneline -5` と `git status` で直前の反復が何をしたかを確認する。

# 今回やること(1反復 = 1個のsmallest verifiable step)
- バックログのうち `completed_tasks`/`skipped_tasks` に入っていない最小番号のタスクを1つ選ぶ。
  - 依存関係: タスク3はタスク2のSTAGE_FLOORS/STAGE_NAMESを再利用するため2完了後に着手。
    タスク1,6,7,8は独立。タスク4,5(バックエンド変更)は独立だが難易度が高ければ後回しでよい。
  - そのタスクが実装不能/リスクが高すぎると判明したら(例: バックエンドのデータ構造が
    想定と違う)、`.loop/UX_state.json`の`skipped_tasks`に入れて理由を`last_action`に記録し、
    次のタスクへ進む(同じタスクで何度も詰まらない)。
- `.loop/UX_VISION.md`のバックログ記述に従って、そのタスクだけを実装する。
  複数タスクを同時に進めない。
- **このタスクが「純フロント」(1,2,3,6,7,8)かバックエンド変更を伴う(4,5)かを必ず意識する。**
  バックエンド変更タスクでは、新規DBテーブル/新規エンドポイントを作らない、既存store
  method(`listFacts`/`daysSince`/`touchLastSeen`等)の読み取りのみ、追加フィールドは
  必ずoptionalにして既存クライアントとの後方互換を保つ、というVISIONの制約を厳守する。
- LLM/ユーザー由来の文字列(日記本文・facts・名前等)を表示する箇所では、必ずプレーン
  テキストとして表示し、`dangerouslySetInnerHTML`を使わない(セキュリティ上必須)。
- タスク2(バグ修正)とタスク4,5(バックエンドAPI変更)を実装した反復では、実装後に
  Agent(Task)ツールで `typescript-reviewer` または `react-reviewer`(model: sonnet)を1つ
  ディスパッチし、CRITICAL/HIGH指摘が無いか確認する(VISIONのDoDで必須)。指摘があれば直す。
  それ以外の純フロントタスク(1,3,6,7,8)は省略してよい。
- 実装後、必ず以下を実行してbuildがgreenであることを確認する:
  ```
  bash .loop/ux_verify.sh
  ```
  (これは内部で `cd frontend && npx tsc --noEmit -p . && npx vite build` と
  `cd worker && npx tsc --noEmit -p .` を実行し、ビルド出力は`.loop/ux/build.log`に
  保存され、標準出力には安定した状態行のみを出す。失敗時は`.loop/ux/build.log`を見て
  そのタスクの範囲内で原因を直す。直せない場合はタスクを完了扱いにせず、
  `last_action`に失敗内容を記録して終了する。)
- 成功したら `.loop/UX_state.json` を更新する: `completed_tasks`に番号を追加し、
  `last_task`/`last_action`/`iteration`(+1)を更新する。
- `.loop/UX_VISION.md`の「進捗ログ」セクションに1行、何をしたかを追記する。
- git add/commitはloop-engine.sh側が自動で行うので、あなた自身でcommitしなくてよい。

# やってはいけないこと
- バックログにない新機能や大規模リライトを始めない。
- 新規DBテーブル・新規エンドポイントを作らない。push通知機能を作らない。
- `.loop/UIUX_VISION.md`(第1ラウンド、3Dアバターのモーション)のスコープを再度触らない。
- LLM/ユーザー由来文字列を`dangerouslySetInnerHTML`で出力しない。
- ビルドが壊れた状態でcompleted_tasksに番号を追加しない。
- realistic.vrm/research-condition/iOS VAD関連のファイルを触らない(無関係なスコープ)。

# 完了条件(このプロンプト自体の終了条件ではなく、ループ全体のDoD)
純フロントの6タスク(1,2,3,6,7,8)が全て`completed_tasks`に入り、buildがgreenであること。
バックエンド変更を伴うタスク(4,5)は実装できた範囲でよい(スキップも許容)。
ループのオーケストレーター(loop-engine.sh)がこの状態を検知して自動停止する。
あなたは1反復分だけ進めればよい。
