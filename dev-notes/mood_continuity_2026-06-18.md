# シロの感情に慣性を持たせる(直近の感情トレイルを注入) — 2026-06-18

## 背景 / なぜ

[[diary_self_continuity_2026-06-18]] に続く改善。応答ごとに付与される `[emotion]` タグは、
LLM がその時その時の本文だけから単発で決めているため、何の連続性チェックもなかった。
たとえば直前の応答が `sad` でも、次が唐突に `happy` へ飛ぶことがあり得る — 人間なら
気分はそう簡単に正反対へ切り替わらない。これはキャラクターの一貫性・人間らしさを損なう。

## 変更内容

- `backend/app/persona.py`: `build_system_prompt(..., recent_emotions: list[str] | None = None)` を追加。
  非空の感情のみ `→` で連結し「## 直近の自分の感情の流れ」節として注入。
  指示は「気持ちは急に正反対へ飛ばない。今の気分を引き継ぎつつ、会話の内容に応じて自然に変化させる」。
- `backend/app/main.py` `chat()`: `memory.recent_messages` の戻り値(既に `emotion` 列を含む)を
  そのまま使い、新しい DB クエリを追加せずに直近 assistant 発言の感情(最大3件)を抽出。
  従来は `history` を作る際に `emotion` を読み捨てていたので、そこから流用する形に変更
  (`raw_history` を一度だけ取得 → `history` と `recent_emotions` の両方を導出)。

## ハマりどころ

- テストで「3通目を送った直後」に captured した system prompt に3通目自身の感情が
  乗っているかと一瞬期待したが、**system prompt はその応答を生成する前に組まれる**ため、
  乗るのは「それ以前」の応答の感情だけ。テストは4通送って1〜3通目分(happy, happy, sad)が
  4通目の system prompt に乗ることを確認する形にした。これは実装上自然な挙動(未来の感情は
  知り得ない)であり、バグではない。

## 検証

- `pytest -q`(backend) → **33 passed**(既存29 + 新規4: mood trail 注入あり/空配列省略/Noneでも省略/
  空文字・None混在のフィルタ/`/api/chat` 経由で実際に3件の trail が渡る)。
- `npx tsc --noEmit`(frontend、無変更) → exit 0。
- 新規DBクエリは追加していない(既存の `recent_messages` 戻り値を再利用しただけ)ので、
  パフォーマンスへの影響なし。
