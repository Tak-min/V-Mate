# バグハント Iter.2 — 日記生成失敗時に生のエラー文字列がユーザーに露出 (2026-06-22)

## 症状
`POST /api/diary/generate` でLLM呼び出し(`complete()`)が失敗すると、`worker/src/index.ts`
の `generateDiary` は何もcatchせず例外を投げっぱなしにしていた。これは `fetch` ハンドラの
グローバルcatch(index.ts:406-410)で拾われ、`サーバーエラー: ${e.message}` という生の
内部エラー文字列がHTTP 500のJSON `detail` としてそのままクライアントに返っていた。

## 原因
他のLLM呼び出し箇所(`postNudge`, index.ts:271-274)は `try/catch` でラップしてキャラクター性を
保ったフォールバック(`{ text: "", emotion: "neutral" }`)を返しているのに、`generateDiary`
だけ素通しになっていた。実装漏れ。

## 影響
- ユーザー体験: 「シロが日記を書く」という親近感施策の最中に、いきなり英語/内部エラー文字列が
  出てキャラクター性が崩壊する(本ループのゴール=人間らしさに直接反する)。
- 軽微な情報露出: LLM APIのエラーメッセージ(レート制限詳細等)が内部実装の手がかりとして
  そのままクライアントに渡ってしまう。

## 修正
`generateDiary` の `complete()` 呼び出しを try/catch し、失敗時は
`{ ok: false, reason: "今は日記がうまく書けないみたい。少ししてからまた試してね。" }` を返す。
フロント側 `DiaryDrawer.tsx` は既に `result.reason` を表示する作りだったため、追加のフロント
修正は不要(自然に噛み合う)。

## 検証
`cd worker && npx tsc --noEmit` → エラーなし。

## デプロイ
`cd worker && npm run deploy` → 本番反映済み。
