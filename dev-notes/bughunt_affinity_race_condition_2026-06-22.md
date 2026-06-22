# バグハント Iter.4 — 親密度加算のread-modify-writeレース (2026-06-22)

## 症状(想定)
`worker/src/db.ts` の `addAffinity` は `getAffinity()`(SELECT)→`setKv()`(UPSERT)の2段階で
親密度を加算していた。同一ユーザーから2つのチャットリクエストがほぼ同時に処理される場合
(フロントの二重送信、複数タブ/デバイス、ネットワーク再送等)、両方が同じ古い値を読み込み、
両方が `古い値+delta` を書き込むと、片方の加算が静かに失われる(lost update)。
親密度はシロとの関係性の進行度を表す中核指標であり、ズレが蓄積するとstage(口調変化の
しきい値)判定にも影響する。

## 原因
D1(SQLite)はWorkers側で明示的にトランザクション/原子的更新を使わない限り、
read→writeの間に他のリクエストが割り込める。`addAffinity` がそれをやっていた。

## 修正
`INSERT ... ON CONFLICT(user_id, key) DO UPDATE SET value = CAST(CAST(kv.value AS INTEGER) + ? AS TEXT) RETURNING value`
の単一SQL文に統合し、加算をSQLエンジン側で原子的に行うようにした。アプリ側でのget→setの
往復を排除。

## 検証
- `cd worker && npx tsc --noEmit` → エラーなし。
- ローカルD1で直接SQLを実行して確認: 存在しないキーへの初回実行→`5`、既存値`5`に`+3`の
  2回目実行→`8`(原子的加算が正しく動作)。テスト用行は削除済み。

## 注記
他の `setKv` ベースのカウンタ(レート制限usage等)は別テーブル/別ロジックで、
`usage` テーブル側の増分処理を次イテレーションで確認する価値がある(未着手)。
