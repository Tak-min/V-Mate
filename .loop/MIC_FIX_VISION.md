# VISION — iOSマイク音声取得 根因特定ループ Round2 (2026-06-26)

## 問題
ユーザー報告: 直近の修正後も「マイクが正常に動作しない」(主にiOS実機)。
クラッシュ(プロセス即死)は fddc33d で解消済み。残るのは「話しても音声が取り込まれない/
文字起こしされない」という機能不全。

## 批判的分析(recon結果)

### 確定事実
- 動作版(d69c8e4の親 77a8874 = 06-22実機較正済み)は **tapスレッドで同期的に request生成+append** していた。
- d69c8e4 が「非同期生成 + pendingCaptureキュー + generationトークン + メインキューpublish」へ
  **実機検証ゼロで**書き換えた。これが最有力容疑。
- VADしきい値(minThreshold=0.0006 等)は実機較正値が保たれている。
- 呼び出し側(configureForConversation→beginSession の順、権限ゲート)は正しい。

### 最大の問題: 観測性ゼロ
- パイプラインに `os.Logger` が一切無い(`import os` はあるのに未使用)。
- tap発火/RMS値/VADイベント/armedRequest publish/認識結果・エラー が実機で何も見えない。
- 06-22の根治は「実機ログでRMS較正」で達成された。ログ無しの推測修正は同じ轍。

### 容疑リスト(優先度順、ログで切り分ける)
1. 非同期publishがメインスレッド輻輳(SwiftUI/VRM描画)で遅延 → pendingCapture滞留 →
   発話終了までにflushされず認識ゼロ。
2. on-device認識(requiresOnDeviceRecognition=true)でja-JPモデル未DL → 初回発話が即エラーで失われる。
3. tap formatがfloat非対応 → rms()が常に0 → VAD発火せず。
4. VADしきい値がこの個体の実RMSと不一致(06-22とは別個体/別環境)。

## Definition of Done(停止条件)
- [ ] iteration1: パイプライン全段に os.Logger 計測を追加(tap format/RMS/VADイベント/
      publish/flush件数/認識result・error)。build+test緑。実機デプロイ。
- [ ] 実機ログ取得: ユーザーが発話 → ログで「どの段で詰まるか」を特定(human-in-the-loop必須)。
- [ ] iteration2+: ログが示した真因のみをピンポイント修正(推測修正禁止)。
- [ ] 修正後、実機ログで speechStarted→認識result→onUtterance の全鎖が発火することを確認。
- [ ] build緑・test緑・commit・push。

## ガードレール
- 最大イテレーション 20 / 同一症状3連続で停止・報告。
- **実機ログ無しにVADしきい値・音声ロジックを変更しない**(06-22の最重要教訓)。
- レンダースレッドのLoggerはスロットル(8バッファ毎≈0.5s)。重い同期APIは追加しない。
- 自動検証の限界: 物理マイクへの発話はエージェントに不可能 → 検証はhuman-in-the-loop。
  ログ取得・解析・修正はエージェントが担う。
