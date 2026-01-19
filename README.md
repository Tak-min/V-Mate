# AIWife-test

This application is a web app for users to interact with a 3D character via text.

## Application Features

- **3D Character Display**: A 3D character is displayed in the web browser.
- **Text Chat**: Users can send messages to the character through a text input field.
- **Character Responses**: The character responds to user's text input with animations.
- **Animation Synchronization**: The character performs animations that convey its response, and also displays emotion-based animations.

This application provides an interactive experience with a 3D character through text chat.

## 開発環境セットアップ

### 必要な環境
- Python 3.8以上
- Node.js 18以上
- npm または yarn

### インストール手順

1. **リポジトリをクローン**
```bash
git clone <repository-url>
cd AIWife-test
```

2. **Python依存関係をインストール**
```bash
pip install -r requirements.txt
```

3. **Node.js依存関係をインストール**
```bash
npm install
```

4. **環境変数の設定**
`.env`ファイルをプロジェクトルートに作成し、必要なAPIキーを設定:
```env
# Gemini AI
GEMINI_API_KEY=your_gemini_api_key
ELEVENLABS_API_KEY=your_elevenlabs_api_key
ASSEMBLYAI_API_KEY=your_assemblyai_api_key

# セキュリティ
SECRET_KEY=your_secret_key

# OAuth 2.0 (オプション)
GOOGLE_CLIENT_ID=your_google_client_id
GOOGLE_CLIENT_SECRET=your_google_client_secret
GITHUB_CLIENT_ID=your_github_client_id
GITHUB_CLIENT_SECRET=your_github_client_secret
```

**OAuth 2.0の設定方法**については、[OAUTH_SETUP.md](document/OAUTH_SETUP.md) を参照してください。

### 開発サーバの起動

フロントエンドとバックエンドを同時に起動:
```bash
npm run dev
```

このコマンドは以下を自動的に実行します:
1. バックエンドサーバー (Flask) を起動
2. バックエンドが完全に起動するまで待機 (wait-on)
3. フロントエンドサーバー (Vite) を起動してブラウザを開く

**注意**: バックエンドが `http://localhost:5000` で起動するまでフロントエンドは待機します。

または、個別に起動:

**バックエンド (Flask) - 先に起動**
```bash
npm run dev:backend
```
バックエンドは `http://localhost:5000` で起動します。

**フロントエンド (Vite) - バックエンド起動後**
```bash
npm run dev:frontend
```
フロントエンドは `http://localhost:3000` で起動します。  
このコマンドはバックエンドの起動を待ってから実行されます。

### ビルド

本番用ビルドを作成:
```bash
npm run build
```

ビルドされたファイルは `dist/` ディレクトリに出力されます。

### プレビュー

ビルドしたアプリをプレビュー:
```bash
npm run preview
```

## デプロイ

https://aiwife.vercel.app/

## 技術スタック

- **フロントエンド**: Vite, Three.js, @pixiv/three-vrm
- **バックエンド**: Flask, Socket.IO
- **認証**: JWT (JSON Web Tokens) + OAuth 2.0 (Google, GitHub)
- **AI**: Google Gemini API
- **音声合成**: ElevenLabs API
- **音声認識**: AssemblyAI API

## 認証機能

### Phase 1: JWT ローカル認証 ✅
- メールアドレス + パスワード認証
- JWT トークンベースのセキュアな認証
- リフレッシュトークンによる自動更新

### Phase 2: OAuth 2.0 統合 ✅
- **Google OAuth 2.0**: Googleアカウントでログイン
- **GitHub OAuth**: GitHubアカウントでログイン
- パスワード不要の安全な認証
- 複数プロバイダー対応

### セキュリティ機能
- アクセストークン (有効期限: 15分)
- リフレッシュトークン (有効期限: 30日)
- パスワードのbcryptハッシュ化
- 認証ガード: ログインなしではコンテンツ閲覧不可

詳細な設定方法は [OAUTH_SETUP.md](document/OAUTH_SETUP.md) を参照してください。
- **AI**: Google Gemini API
- **音声合成**: ElevenLabs API
- **音声認識**: AssemblyAI API


# 🚀 AIWife アプリケーション - 簡単セットアップガイド

プログラミング初心者の方でも簡単に始められるように、わかりやすく説明します！

## 📋 必要なもの

このアプリケーションを使うには、以下の2つだけが必要です：

1. **Docker Desktop** - アプリを動かすための環境（無料）
2. **Gemini APIキー** - AIと会話するための鍵（無料で取得可能）

---

## 🎯 ステップ1: Docker Desktopのインストール

### 1-1. Docker Desktopをダウンロード

1. [Docker Desktop公式サイト](https://www.docker.com/products/docker-desktop/)にアクセス
2. 「Download for Windows」ボタンをクリック
3. ダウンロードした `Docker Desktop Installer.exe` を実行

### 1-2. インストール

1. インストーラーが起動したら「OK」をクリック
2. インストールが完了したら「Close and restart」をクリック
3. パソコンが再起動されます

### 1-3. Docker Desktopの初回起動

1. デスクトップの「Docker Desktop」アイコンをダブルクリック
2. 利用規約に同意（「Accept」をクリック）
3. アカウント作成画面が表示されますが、「Skip」で問題ありません
4. Docker Desktopが起動し、画面下部に「Engine running」と表示されればOK！

> 💡 **ポイント**: Docker Desktopは毎回アプリを起動する前に立ち上げておく必要があります。

---

## 🔑 ステップ2: Gemini APIキーの取得

### 2-1. Google AI Studioにアクセス

1. [Google AI Studio](https://makersuite.google.com/app/apikey)にアクセス
2. Googleアカウントでログイン（Gmailのアカウント）

### 2-2. APIキーを作成

1. 「Create API Key」または「APIキーを作成」ボタンをクリック
2. プロジェクトを選択（「Create API key in new project」でOK）
3. 生成されたAPIキーをコピー（`AIza...`で始まる長い文字列）

> ⚠️ **重要**: このAPIキーは秘密情報です。誰にも教えないでください！

---

## ⚙️ ステップ3: 環境設定ファイルの作成

### 3-1. .envファイルを確認

プロジェクトフォルダ内に `.env` というファイルがあるか確認してください。

- **ある場合**: そのまま次のステップへ
- **ない場合**: メモ帳で新規作成し、`.env` という名前で保存

### 3-2. APIキーを設定

`.env` ファイルを開いて、以下の行を探します：

```env
GEMINI_API_KEY=your_gemini_api_key_here
```

`your_gemini_api_key_here` の部分を、先ほどコピーしたAPIキーに書き換えます：

```env
GEMINI_API_KEY=AIzaSyDbhA2GuAFoYUzREJDy6gq6bwuSnwC8T7Y
```

> 💡 **ヒント**: 既に設定されている場合は、そのままで大丈夫です！

### 3-3. ファイルを保存

- メモ帳なら: ファイル → 上書き保存
- VS Codeなら: Ctrl+S

---

## 🎮 ステップ4: アプリケーションの起動

### 4-1. Docker Desktopを起動

1. デスクトップの「Docker Desktop」をダブルクリック
2. 画面下部に「Engine running」と表示されるまで待つ（1-2分）

### 4-2. アプリケーションを起動

1. プロジェクトフォルダ内の **`起動.bat`** をダブルクリック
2. 黒い画面（コマンドプロンプト）が開きます
3. 初回起動時は数分かかります（必要なファイルをダウンロードしています）
4. 「🎉 起動完了！」と表示されたら成功です！

### 4-3. ブラウザでアクセス

自動的にブラウザが開き、アプリケーションが表示されます。

開かない場合は、以下のURLを手動で入力してください：

```
http://localhost:3000
```

---

## 🛑 アプリケーションの停止

使い終わったら、必ず停止してください：

1. **`停止.bat`** をダブルクリック
2. 「✓ 正常に停止しました」と表示されればOK

---

## 🔧 トラブルシューティング

### ❌ 「Dockerが起動していません」と表示される

**原因**: Docker Desktopが起動していない

**解決方法**:
1. Docker Desktopを起動
2. 「Engine running」と表示されるまで待つ
3. もう一度 `起動.bat` を実行

---

### ❌ 「.envファイルが見つかりません」と表示される

**原因**: 環境設定ファイルがない

**解決方法**:
1. プロジェクトフォルダに `.env` ファイルを作成
2. ステップ3の内容を参考に設定

---

### ❌ ブラウザに「接続できません」と表示される

**原因**: アプリの起動に時間がかかっている

**解決方法**:
1. 1-2分待ってからページを再読み込み（F5キー）
2. それでもダメなら `ログ表示.bat` でエラーを確認

---

### ❌ AIが応答しない

**原因**: APIキーが正しく設定されていない

**解決方法**:
1. `.env` ファイルの `GEMINI_API_KEY` を確認
2. APIキーが正しいか確認
3. アプリを再起動（`停止.bat` → `起動.bat`）

---

## 📝 便利なファイル一覧

プロジェクトフォルダ内にある便利なファイル：

| ファイル名 | 説明 |
|-----------|------|
| **起動.bat** | アプリを起動する |
| **停止.bat** | アプリを停止する |
| **ログ表示.bat** | エラーログを表示する（トラブル時に使用） |
| **.env** | APIキーなどの設定ファイル |

---

## 🎓 よくある質問

### Q1: お金はかかりますか？

**A**: Docker Desktopとgemini APIは基本的に無料で使えます。ただし、Gemini APIには無料枠があり、それを超えると課金される場合があります。

### Q2: インターネット接続は必要ですか？

**A**: はい、AIとの会話にはインターネット接続が必要です。

### Q3: パソコンのスペックは？

**推奨スペック**:
- CPU: 4コア以上
- メモリ: 8GB以上
- 空き容量: 10GB以上

### Q4: Dockerって何ですか？

**A**: アプリを動かすための「仮想の箱」のようなものです。この箱の中で全てが完結するので、パソコンの環境を汚さずに使えます。

### Q5: 起動に時間がかかるのはなぜ？

**A**: 初回起動時は、必要なファイルをインターネットからダウンロードするため時間がかかります。2回目以降は速くなります。

---

## 💡 便利な使い方

### 自動起動の設定（上級者向け）

毎回Docker Desktopを手動で起動するのが面倒な場合：

1. Docker Desktop を起動
2. 設定（歯車アイコン）→ General
3. 「Start Docker Desktop when you log in」にチェック

これでパソコン起動時に自動的にDockerが立ち上がります。

---

## 📞 サポート

それでも問題が解決しない場合は、以下の情報を添えてお問い合わせください：

1. エラーメッセージの内容
2. `ログ表示.bat` で表示される内容
3. お使いのWindowsバージョン

---

## 🎉 準備完了！

これでセットアップは完了です！

**起動手順（まとめ）**:
1. Docker Desktopを起動
2. `起動.bat` をダブルクリック
3. ブラウザで http://localhost:3000 を開く
4. AIキャラクターと会話を楽しむ！

**楽しいAIライフを！** 🤖💕


# 背景画像フォルダ

このフォルダには、3Dシーンの背景として使用する画像ファイルを配置します。

## 対応画像形式
- JPG (.jpg, .jpeg)
- PNG (.png)
- WebP (.webp)

## 推奨仕様
- **解像度**: 1920x1080 以上
- **アスペクト比**: 16:9 または 4:3
- **ファイルサイズ**: 5MB以下（パフォーマンス向上のため）

## 使用方法
1. 画像ファイルを `frontend/backgrounds/` フォルダに配置
2. HTMLファイル（`frontend/index.html`）の背景選択オプションに新しい選択肢を追加
3. アプリケーションを再読み込み

## サンプル画像
以下の名前で画像を配置すると、デフォルトで選択肢に表示されます：
- `sky.jpg` - 空の背景
- `room.jpg` - 部屋の背景  
- `garden.jpg` - 庭園の背景

## パノラマ画像について
360度パノラマ画像（Equirectangular形式）を使用すると、より没入感のある背景を作成できます。

## 注意事項
- 著作権フリーまたは適切なライセンスを持つ画像のみ使用してください
- 大きすぎるファイルはローディング時間が長くなる可能性があります