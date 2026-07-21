# 新規Swiftファイル追加時はxcodegen再生成が必要 — 2026-07-20

## 症状

`AgeBlockedView.swift` を新規作成し `OnboardingView.swift` から参照したところ、
`build_sim` で `cannot find 'AgeBlockedView' in scope` が発生。SourceKitの生きた診断
(エディタ上のインライン警告)は逆にこのファイルには反応せず、無関係な既存シンボル
(`Color.accentPink`等、実際には正しく定義済み)を大量に誤検知していた
(インデックスの一時的な不整合、ビルド成功後は解消)。

## 原因

`ios/project.yml`(XcodeGen設定)は `sources: path: VMate/Sources` でフォルダ全体を
指定しているが、実体のビルド対象は**コミットされた生成済み `VMate.xcodeproj`**
(project.pbxproj)であり、これはXcodeGen実行時点のファイル一覧のスナップショット。
新規ファイルをフォルダに置いただけでは pbxproj のsources listに載らず、ビルドから
除外される(SPMのような自動フォルダ同期ではない)。

## 修正

```bash
cd ios && xcodegen generate
```

を実行して `.xcodeproj` を再生成してから `build_sim` する。

## 教訓(次にこの状況に遭遇するAIエージェント/人間へ)

- **iOS側で新規`.swift`ファイルを追加した直後は、ビルド前に必ず `cd ios && xcodegen generate` を実行する。**
- `xcodegen` コマンドは `/opt/homebrew/bin/xcodegen` に存在確認済み(2026-07-20時点)。
- 既存ファイルの編集のみ(新規ファイル追加なし)なら再生成は不要。
- ライブのSourceKit診断(エディタのインライン警告)は同一モジュール内の他ファイルで定義された
  シンボルについて誤検知することがある(インデックス未更新)。**実際のビルドエラーかどうかは
  `build_sim` の結果を信頼する**のが確実(既存メモリ「iOS開発ではシミュレータ起動なしで
  コードベース検証する」と整合)。
