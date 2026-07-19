# 研究分析パイプライン リハーサル (2026-06-19)

## 何をしたか

`docs/01_学習・研究/技術調査/V-Mate実験_運営マニュアルと発信文言_2026-06-19.md` §8の
残タスクのうち「JASPまたはPython分析環境を実際に手元で動かし、ダミーデータで分析パイプ
ラインを一度通しておく」を実施。`backend/scripts/research_analysis/` に以下を実装。

- `generate_dummy_data.py` — 3条件(text/stylized/realistic)×12名分のダミー回答を
  `V-Mate_身体様式比較_研究実装計画_2026-06-18.md` の仮説H1-H4に沿った平均値で生成。
- `analyze.py` — 記述統計 → マニピュレーションチェック正答率 → Kruskal-Wallis(全体差)
  → 有意だった指標のみMann-Whitney + Bonferroni事後検定、という運営マニュアル§6の手順。

実行確認済み: `cd backend && source .venv/bin/activate && python scripts/research_analysis/analyze.py`

## 残った3項目(AIの手元作業では完了できない)

§8の他3項目は人間・組織側のアクションが必須なので未実施のまま:

1. CR-15正式15項目の入手 — 指導教員経由 or 論文購入が必要
2. 指導教員による同意書ひな形チェック — 本人が依頼する必要あり
3. 参加者募集用Googleフォーム等の作成・公開 — 実際のGoogleアカウントでの公開操作が必要。
   本人の確認が要る外部公開アクションなので、AIが無断で代行すべきでない

## 次にやること(本番実験前)

- 実データが集まったら、`research_events` をCSV化して `analyze.py` の `load()` の
  読み込みパスを実データCSVに向けるだけで同じ分析が走る(列名: participant_id,
  condition, social_presence, trust, self_disclosure, continuance_intention,
  usability, creepiness, manipulation_check)。
- ダミーCSV (`dummy_research_events.csv`) は `.gitignore` 済み。

## ハマりポイント

- Symptom: `backend/.venv` に `pandas`/`scipy` が入っていなかった(通常のapp依存には
  不要なため)。
  Cause: 分析はapp本体の依存範囲外。
  Fix: `backend/scripts/research_analysis/requirements.txt` を別途用意し、
  `pip install -r scripts/research_analysis/requirements.txt` で都度入れる方針にした
  (app本体の `requirements*.txt` は汚さない)。
