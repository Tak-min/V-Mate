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
