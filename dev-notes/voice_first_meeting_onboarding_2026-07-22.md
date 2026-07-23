# 音声駆動「初対面」オンボーディング + TTSジッタ (2026-07-22 Phase1)

> FTUEレビュー(`ftue_review_2026-07-22.md`)に続く同日の追加作業。ユーザー依頼:
> Shizuku AI(あき先生のAI VTuber)とプロジェクトセカイの初回オンボーディングを参考に、
> AIコンパニオンの反応挙動とオンボーディング体験を改善する。

## 背景・参考にした外部知見

- **Shizuku AI**: 音声を「キャラクターの魂」と位置づけ同じ台詞でも語調を揺らがせる設計、
  固定人格でなく対話で性格が育つ思想、逐次パイプライン(認識→生成→合成)のレイテンシを
  開発者自身が課題視している、という3点を確認(Wikipedia・PANORA・AICU note等の記事から。
  技術の内部実装は非公開で確認できず)。
- **プロジェクトセカイ**: 新規アカウント作成直後、初音ミクとの初対面対話→名前を尋ねる→
  世界観説明、という流れが実在することをFandom Wikiで確認。ただし正確なセリフ・「名前を
  褒める」反応の有無までは一次情報が取得できず、その部分はユーザー本人の指定仕様
  (「とっても素敵な名前だね」的な温かい反応)をそのまま採用した。

設計はcode-architect(Opus)のブループリントに基づく。実装はPhase1(コア体験)のみで、
Phase2(親密度の連続値化・語彙の揺らぎ等の深掘り)は本セッションの高コストを理由に
明示的に延期(架空の完成ではなく、優先順位判断としての先送り)。

## 実装した内容

### worker側

- `persona.ts`: `introNamePrompt(transcript)`を追加。音声認識結果(自由文)から名前を
  抽出し、[emotion]タグ付きの温かい返事を1〜2行で生成させるプロンプト。出力契約は
  「1行目=名前 or 「なし」、2行目以降=[emotion]反応文」。
- `onboarding.ts`(新規): `parseIntroNameResponse()`(パース、40字クランプ、フォールバック)
  + `generateIntroNameResponse()`(LLM呼び出し+パース)。**DBには書き込まない**(名前の永続化は
  既存`/api/profile`に一本化し、facts二重書き込みを防ぐ設計判断)。
- `index.ts`: `POST /api/onboarding/intro-name`を追加。`requireInteractionAge`でガード
  (年齢確認前は403、クライアント側の順序に頼らないサーバー側二重防御)。
- `tts.ts`: `applyJitter(base, rng)`を追加。感情別のTTSパラメータ(speaking_rate/
  emotional_intensity/volume)に±3〜6%程度のランダム揺らぎを加える(Shizukuの
  「声の揺らぎ」を最小コストで実現)。`synthesize()`内で自動適用。
- テスト: `onboarding.test.ts`(6件)、`tts.test.ts`(3件)を追加。worker全体で**72テストgreen**、
  typecheckクリーン。

### iOS側

- `FirstMeetingViewModel.swift`(新規): オンボーディングstep2専用の音声オーケストレーション。
  `CompanionViewModel`とは独立した`SpeechRecognizer`/`SpeechQueue`インスタンスを持つ
  (fullScreenCover内で完結し、完了時に必ず`teardown()`するため2つの`AVAudioEngine`が
  同時起動することはない)。フロー: 台詞(自己紹介)発話→名前を聞く発話→聞き取り→
  `/api/onboarding/intro-name`へ送信→反応発話→完了。認識失敗は最大2回まで聞き直し、
  それでもダメなら手入力フォールバックへ自動遷移。
- `FirstMeetingStep.swift`(新規): 上記のUI。シロのセリフを常にキャプション表示
  (TTS無効/ミュート環境でも内容が伝わるように)、聞き取り中インジケータ、部分認識結果表示、
  「名前を入力する」への明示的フォールバックボタン。
- `OnboardingView.swift`: step2を`FirstMeetingStep`に差し替え。**旧TextField版`nameStep`は
  削除せず、手入力フォールバックとして残置**。`onComplete`のシグネチャを
  `(String?) -> Void` → `(String?, Bool) -> Void`に変更(第2引数=音声で既に挨拶済みか)。
  welcomeStepに「このあと、声で挨拶するね」の一言を追加。
- `RootView.swift`: `onComplete`の第2引数に応じて、音声で既に挨拶済みなら
  `viewModel.markGreeted()`のみ、そうでなければ従来通り`viewModel.fireGreeting()`を呼ぶ
  (二重挨拶防止)。
- `CompanionViewModel.swift`: `markGreeted()`を追加(既存の`greeted`フラグを外部から
  一度だけ真にするための最小限のAPI)。
- `Models.swift` / `APIClient.swift`: `IntroNameResponse`構造体と`requestIntroName(transcript:)`
  を追加。

## 設計判断の理由(抜粋)

- **音声初対面はstep1(年齢確認)の後に固定**: `requireInteractionAge()`がサーバーTTS/LLM
  エンドポイント全てをガードしており、年齢確認前はそもそもシロが声で応答できない
  (技術的制約とCOPPA対応が同じ結論を指した)。
- **名前抽出+反応生成を1往復のLLM呼び出しにまとめた**: `factExtractionPrompt`と同じ
  「LLMに抽出させて行パース」パターンを踏襲。自由発話からの名前抽出はクライアント側の
  正規表現では脆いためサーバーLLMに寄せた。
- **名前の永続化は`/api/profile`(setProfile)に一本化**: 音声パス・手入力パス両方が
  最終的に同じ1箇所でしか書き込まないようにし、facts二重登録を防いだ。

## 検証状況

- worker: `npm test`(72 passed)、`npm run typecheck`クリーン。
- iOS: `build_sim`エラー0、`test_sim`既存24テスト全green(回帰無し)。
- シミュレータでの目視確認: クリーンインストール→`UITEST_ONBOARDING_STEP=2`起動で、
  マイク権限リクエストのシステムダイアログが正しく表示されクラッシュしないことを確認。
  **ここから先(実際に声で自己紹介→名前を聞く→反応する、というフルの音声E2Eフロー)は
  タップ操作の自動化ができないため、また一般にシミュレータのマイク入力は不安定なため、
  検証できていない。実機での手動確認が必須。**

## 未検証・未実装(次回への引き継ぎ)

- **フルの音声E2Eフロー(最重要)**: 実機(俺のGALAXY Pro Max)でのワイヤレスデバッグ経由の
  手動テストが必要。特に: (1)自己紹介→名前質問の発話ペーシングが不自然でないか、
  (2)聞き取り→サーバー往復→反応発話までの体感レイテンシ、(3)`FirstMeetingViewModel`の
  `teardown()`後にメインの`CompanionViewModel.toggleHandsFree()`が正常にエンジンを
  起動できるか(2つのAVAudioEngineのハンドオフが設計通り機能するか)。
- **FirstMeetingReducerの単体テスト**: code-architectのブループリントでは状態遷移を
  純関数リデューサへ切り出してテストすることを推奨していたが、コスト意識により
  Phase1では見送り、状態機械は`FirstMeetingViewModel`内に直接実装した。将来テスト
  カバレッジを上げたい場合はここを切り出す。
- **Phase2(明示的に延期)**: 親密度を5段階の階段でなく連続値でなめらかにスケールさせる
  改善、`persona.ts`への「同じ言い回しを繰り返さない」指示の追加、レイテンシの追加最適化。
  いずれも「重い新規抽象を作らない」方針で、次回セッションで着手する場合も最小の増分に
  留めることを推奨(YAGNI)。
- **hintStepの名前echo(`"\(name)、よろしくね！"`)**: 音声パス経由で実際に名前が正しく
  echoされるか、実機での目視確認が未実施。

## 変更ファイル一覧

worker: `src/persona.ts`, `src/onboarding.ts`(新規), `src/index.ts`, `src/tts.ts`,
`test/onboarding.test.ts`(新規), `test/tts.test.ts`(新規)

iOS: `Sources/ViewModels/FirstMeetingViewModel.swift`(新規), `Sources/Views/FirstMeetingStep.swift`
(新規), `Sources/Views/OnboardingView.swift`, `Sources/Views/RootView.swift`,
`Sources/ViewModels/CompanionViewModel.swift`, `Sources/Models/Models.swift`,
`Sources/Networking/APIClient.swift`, `project.yml`/`VMate.xcodeproj`(xcodegen再生成)

---

**文書作成:** 2026-07-22
**関連:** `ftue_review_2026-07-22.md`(同日前段の作業)、`.loop/FTUE_VISION.md`/`.loop/FTUE_state.json`
