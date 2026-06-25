# VISION — シロに「人間性の細部」を宿す(HUMANNESS ループ)

> loop-engineer 自律ループ。起点: ユーザー指示「既存コンパニオンアプリや構築記事を批判的・懐疑的に
> 分析し、人間性を深く感じさせる細々とした工夫を見つけて v-mate に組み込むループを回す」。
> 本番 = `worker/`(TS)。メモリ [[aikata-companion]] / [[feedback-vmate-push-deploy-every-turn]] /
> [[feedback-autonomous-work-includes-commit]]。前ループ(NEARNESS)で初回オンボーディングは実装済。

## リサーチ結論(英語一次ソース2系統を批判的統合)
**エビデンス強**: 音声の不完全性(フィラー/ブレス/抑揚・MOS定量化)、相づち(言語学+実証)。
**文脈依存・cargo-cult寄り**: タイピング遅延/インジケータ(ベテランに逆効果・サポート文脈で有害)、絵文字(botで減衰)。
**商用バイアス/効果量不明**: 記憶コールバック、プロアクティブ頻度。
**倫理的に最警戒**: 感情ミラーリング/自己開示誘導(エンゲージは上がるが **well-being は下がる**実証あり/
Replika FTC=love-bombing 批判)。**メタ教訓**: 人間らしさ最大化は不気味の谷の罠=意図的に人工性を残す。

## 設計判断(批判的に「やらないこと」を先に確定)
- ❌ **人為的タイピング遅延を足さない**: v-mate は既にLLM由来の自然遅延 + `waitingCueFor` 相づちcue +
  3点ドットを持つ。研究は上乗せ遅延を「演技」として逆効果と警告。既存の有機的遅延で十分。
- ❌ **プロアクティブ通知の頻度を上げない**: 既に過干渉対策で `IDLE_NUDGE_MS=240s`/`GREETING_MIN_GAP=180s`
  に抑制済。研究(FTC/well-being)はこの保守性を**支持**。頻度でなく文脈品質のみ磨く余地。
- ❌ **テキストのフィラー/わざとのタイポを足さない**: 根拠薄く信頼性を毀損(critical調査)。
- ✅ **well-being の歯止めを明文化**: 依存を煽らない/過剰な深刻演出をしない/対等で軽やかに。

## ゴール(Definition of Done — 検証可能)
既存の作り込み(感情タグ→VRM表情/親密度5段階/facts・summary・diary/相づち/瞬き同期/TTS先読み)を
壊さず、エビデンスの強い「人間性の細部」を**最小・低リスク・検証可能**に組み込む:

- [ ] **A. トーン反応性(text/persona)**: ユーザーが「どう言ったか」(勢い/落ち込み/疲れ/そっけなさ/
      長い吐露)の**感情の温度を読んで先に受け止めてから**返す指示を persona に追加。
      検証 = 感情トーンの異なるメッセージを curl で送り、シロがまず温度に合わせて受け止めるか。
- [ ] **B. 節度ある脆弱性/素の内面(text/persona)**: シロが時おり素直な気持ち・小さな弱さ・自分の
      "状態"を見せる(相互開示の人間性)。**ただし依存誘発・過剰深刻を禁じる歯止めをプロンプトに明記**。
      検証 = curl で、完璧アシスタント的でない素の一言が自然に混じるか + 歯止めが効くか。
- [ ] **C. 音声の呼吸・間 + 感情連動プロソディ(voice)**: Aivis の対応範囲を確認し、感情に応じた
      自然な間/呼吸/抑揚を強化(不気味の谷回避のため過剰な流暢さは追わない)。
      検証 = TTS リクエストの変化を curl/コードで確認 + build緑。**最終的な音質判定はユーザーの耳が必須**(明記)。
- 全体: worker typecheck + frontend build 緑 + typescript-reviewer CRITICAL/HIGH ゼロ + 本番 curl 検証 + deploy。

## ビルド順(最小の検証可能ステップ)
1. IT-A+B — `worker/src/persona.ts buildSystemPrompt` にトーン反応性 + 節度ある脆弱性(歯止め付き)を
   追加(既存ルール1-9は温存・additive)。curl で感情トーン別に検証 → review → deploy。
2. IT-C — 音声の間/呼吸/プロソディ。Aivis 対応確認 → `tts.ts`(と必要なら frontend `speech.ts`)→
   検証(params/build)→ deploy。音質はユーザー耳に申し送り。
3. (任意・余力があれば) 相づちの自然さ精緻化 or idle nudge の文脈品質。

## ガードレール
- 最大イテレーション 20(現実的に ~3-4)。同一検証シグナル3連続で停止し `.loop/HUMANNESS_report.md` に報告。
- **既存ペルソナの均衡を壊さない**: 変更は additive、各回 curl で「短さ/感情タグ/「ユーザー」呼び禁止/
  訂正禁止」の既存挙動が回帰していないかも確認。
- review ゲートは別エージェント(typescript-reviewer)。CRITICAL/HIGH はブロッキング。
- shippable 単位で commit→push→worker deploy。秘密は触らない。

## 現状(把握済)
- `worker/src/persona.ts buildSystemPrompt`(性格+関係+ルール1-9)/ `nudgePrompt`(intro/通常)。
- `worker/src/chat.ts`: SSEストリーム、感情タグ早期フラッシュ、`CHAT_MAX_TOKENS=260`、facts/summary/affinity。
- `worker/src/tts.ts`: 感情→`speaking_rate`/`emotional_intensity`/`volume`、`leading_silence_seconds=0`。SSML有無は要確認。
- frontend: `waitingCueFor` 相づち、`blinkSoon` 文末瞬き、`SpeechQueue` 先読み(無音ギャップ排除済)。
