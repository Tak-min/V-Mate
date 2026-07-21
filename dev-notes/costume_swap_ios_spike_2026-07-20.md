# 衣装差し替え iOS実装 スパイク調査 (2026-07-20)

`dev-notes/monetization_architecture_2026-07-19.md` §5「衣装(重い)」の未検証事項
(`ios/VMate/Sources/Avatar/VRMAvatarView.swift` の衣装差し替え可否)を検証した結果、
**当初の想定より大幅に低コストであることが判明**したため追記する。元の設計書は書き換えず、
このファイルを参照する形にする。

## わかったこと

`VRMAvatarView.swift`(66行)はネイティブSwiftのVRMレンダラーではなく、`WKWebView`で
本番Worker配信の `avatar.html`(= `frontend/src/ios-avatar/entry.ts` がビルドされたもの、
Web版と同じ `frontend/src/features/vrm/viewer.ts` の `CompanionViewer` を使用)を読み込み、
`evaluateJavaScript` で `window.vmate.setEmotion(...)` / `window.vmate.setMouthLevel(...)`
を呼ぶだけの薄いブリッジ。つまり **iOSはWeb版のVRMビューアをそのまま画面内WebViewとして
表示している**(ネイティブ3D実装ではない)。

`window.vmate` の型定義(`frontend/src/ios-avatar/entry.ts:14-21`)は既に
`setEmotion / setMouthLevel / notice / setAffinity / relax` を公開しており、この延長で
`setModel(url: string)` を1つ追加し、内部で `viewer.swapModel(url)`
(設計書§5で計画済みの `viewer.ts` 側メソッド)を呼ぶだけで **iOS側は自動的に衣装差し替えに
対応する**。

## 結論・設計書への修正

- 設計書§5「衣装ごとにコライダー再調整が必要」「iOSも同様(未検証)」の"iOS側は未検証"という
  留保は解消。**iOS用の追加ネイティブ実装は不要**、Web側 `viewer.ts` の `swapModel()` 実装
  ＋ `frontend/src/ios-avatar/entry.ts` に1メソッド追加するだけで両プラットフォーム対応完了。
- 変更が要る箇所(iOS側): `VRMAvatarView.swift` の `Coordinator.sync()` 相当の場所に
  `setModel` 呼び出しを追加する分だけ。ネイティブVRMパーサ/レンダラーの実装は一切不要。
- コスト構造(設計書のROI優先順位の前提)は変わらず「衣装ごとのコライダー再調整(髪/スカート
  貫通対策)」がボトルネックのまま — ここは今回のスパイクでは未検証(実際に複数衣装VRMを
  用意して `TORSO_COLLIDER_SPECS` の当たり判定を目視確認する必要がある、次のスパイクで)。

## 副次的に見つかったドキュメント不整合(未修正・要フォロー)

`frontend/src/ios-avatar/entry.ts:6` のコメントが「Swift側ブリッジ:
`ios/VMate/Sources/Avatar/VRMBridge.swift`」を参照しているが、**そのファイルは存在しない**
(実装は `VRMAvatarView.swift` 内の `Coordinator` にインライン)。実害はないが次にこのファイルを
触るときにコメントを実態に合わせて修正すること。
