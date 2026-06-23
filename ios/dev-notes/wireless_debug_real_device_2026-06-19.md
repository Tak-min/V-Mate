# 実機ワイヤレスデバッグ設定 — 2026-06-19

## 背景

ユーザー指示「iPhone 15 Pro Max をターゲットに、ワイヤレスデバッグで実機テストできるように」。
実際にペアリング履歴のある実機は marketingName が **iPhone 15 Pro**(`iPhone16,1`、Pro Maxではない)
だったが、ユーザー確認の上この実機で進行。

## 対象デバイス

- 識別子: `FF649B7E-F19F-5E73-9AA2-797C297B8916` / UDID `00008130-00144DE10061401C`
- ホスト名: `annoGALAXY-Pro-Max.coredevice.local`
- `xcrun devicectl list devices` で確認・操作する。

## ハマりどころ

1. **`devicectl` が `unavailable` のまま** → Xcode の Window > Devices and Simulators で対象デバイスを
   選択し「Connect via network」チェックボックスが有効か確認する。有効化後、`xcrun devicectl list
   devices` の State が `connected` になる。チェック済みでも `unavailable` の場合は一度デバイス側の
   画面ロックを解除し同一Wi-Fiにいることを再確認すると復帰した。

2. **`error: No Account for Team "32ZRVW6HP8"`** → `project.yml` に手動で書いていた
   `DEVELOPMENT_TEAM: 32ZRVW6HP8` が、現在ログイン中のApple ID (`taku810616@icloud.com`) の
   Personal Team の実際のチームIDと**食い違っていた**(keychainに古いチームの証明書が残っていたため
   `security find-identity -v -p codesigning` ではそれっぽく見えるが、Xcode側ではそのチームを
   "Unknown Name" として認識せずビルド不可)。
   - 確認方法: Xcode で対象 `.xcodeproj` を開き、ターゲット → **Signing & Capabilities** タブで
     Team ドロップダウンを見る。誤った値は赤字で `Unknown Name (xxxxxxxxxx)` と表示される。
   - 修正: ドロップダウンから正しい `Personal Team` を選び直すと、Xcodeが正しい
     `DEVELOPMENT_TEAM`(このケースでは `NVZB82UK53`)を解決してプロファイルを自動生成する。
     `xcodebuild -showBuildSettings` で `DEVELOPMENT_TEAM` の実際値を確認できる。
   - **CLIだけでは直せない**: `xcodebuild -allowProvisioningUpdates` を渡しても、IDEが一度も
     正しいチームでこのbundle IDのプロファイルを発行していない状態だと同じエラーで失敗し続ける。
     一度Xcode GUIでSigning & Capabilitiesタブを開き、正しいTeamを選択させる必要がある
     (このGUI操作だけは自動化できない・コマンドラインに同等のAPIが無い)。
   - 修正後は `project.yml` の `DEVELOPMENT_TEAM` を正しい値に書き換えて `xcodegen generate` し直し、
     `pbxproj` を再生成して固定する(コミット対象なので再現性を保つため)。

3. **Apple ID再ログインが必要だった**: `AKAuthenticationError -7045` が出てXcode上のApple Accountsが
   再認証を要求した。パスワード/2FA入力はユーザー本人にしか行えない操作(エージェントは代行不可、
   セキュリティ上も代行すべきでない)。

4. **インストール後、起動が `FBSOpenApplicationErrorDomain error 3` で失敗**
   (`invalid code signature, inadequate entitlements or its profile has not been explicitly trusted`)
   → iOSの標準動作。`xcrun devicectl device install app` 自体は成功するが、初回は
   **端末側で「設定 > 一般 > VPNとデバイス管理」から該当の Developer App を「信頼」する**操作が
   必須。信頼後に `xcrun devicectl device process launch` で起動成功した。

## 実行コマンド一覧(再現用)

```bash
# 1. ワイヤレス接続確認
xcrun devicectl list devices --timeout 10

# 2. ビルド(チームID解決後)
cd ~/Desktop/v-mate/ios
xcodebuild -project VMate.xcodeproj -scheme VMate -configuration Debug \
  -destination 'platform=iOS,id=<UDID>' -allowProvisioningUpdates build

# 3. インストール
APP_PATH=$(find ~/Library/Developer/Xcode/DerivedData/VMate-*/Build/Products/Debug-iphoneos -maxdepth 1 -name "VMate.app")
xcrun devicectl device install app --device <識別子> "$APP_PATH"

# 4. 起動(端末側で「信頼」済みであること)
xcrun devicectl device process launch --device <識別子> com.takmin.vmate
```

## 状態

- [x] ワイヤレスデバッグでの実機接続(Connect via network)
- [x] `project.yml` の `DEVELOPMENT_TEAM` を正しいチームID (`NVZB82UK53`) に修正・xcodegen再生成
- [x] 実機ビルド・インストール・起動・動作確認(アバター/チャット正常表示、ユーザー確認済み)
- [ ] 今後 USB接続無しでも `xcodebuild ... build` → `devicectl install/launch` の一連がワイヤレスのみで
      通る再現性は未検証(今回はXcode GUIでのチーム再選択を一度通す必要があった)

## 関連

- `ios/project.yml` — `DEVELOPMENT_TEAM: NVZB82UK53`
- [[aikata-companion]] (~/.claude memory)
- `ios/dev-notes/ios_app_v1_2026-06-19.md` — iOSアプリ本体の設計判断
