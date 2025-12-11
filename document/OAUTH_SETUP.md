# OAuth 2.0 セットアップガイド

このガイドでは、Google OAuth 2.0 と GitHub OAuth の設定方法を説明します。

## 📋 前提条件

- Google アカウント
- GitHub アカウント
- アプリケーションの公開URL（ローカル開発の場合は `http://localhost:5000`）

---

## 🔑 1. Google OAuth 2.0 の設定

### ステップ 1: Google Cloud Console でプロジェクトを作成

1. [Google Cloud Console](https://console.cloud.google.com/) にアクセス
2. 新しいプロジェクトを作成（または既存のプロジェクトを選択）
3. プロジェクト名: `AIWife` (任意)

### ステップ 2: OAuth 同意画面を設定

1. 左側のメニューから「APIとサービス」→「OAuth 同意画面」を選択
2. **User Type**: 「外部」を選択（個人開発の場合）
3. 必須項目を入力:
   - **アプリ名**: AIWife
   - **ユーザーサポートメール**: あなたのメールアドレス
   - **デベロッパーの連絡先情報**: あなたのメールアドレス
4. 「保存して次へ」をクリック
5. スコープは追加せず「保存して次へ」
6. テストユーザーを追加（開発中は自分のメールアドレス）
7. 「保存して次へ」で完了

### ステップ 3: OAuth 2.0 クライアント ID を作成

1. 「APIとサービス」→「認証情報」を選択
2. 「認証情報を作成」→「OAuth クライアント ID」をクリック
3. **アプリケーションの種類**: 「ウェブ アプリケーション」
4. **名前**: AIWife Web Client
5. **承認済みのリダイレクト URI** に以下を追加:
   ```
   http://localhost:5000/api/auth/google/callback
   ```
   （本番環境の場合）
   ```
   https://yourdomain.com/api/auth/google/callback
   ```
6. 「作成」をクリック
7. **クライアント ID** と **クライアント シークレット** をコピー

### ステップ 4: 環境変数を設定

`.env` ファイルに以下を追加:

```env
GOOGLE_CLIENT_ID=your-google-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-google-client-secret
```

---


## 🚀 3. アプリケーションの起動

### ステップ 1: 依存関係のインストール

```bash
pip install -r requirements.txt
```

### ステップ 2: 環境変数の確認

`.env` ファイルに以下が設定されていることを確認:

```env
# 基本設定
SECRET_KEY=your-secret-key-here
DATABASE_PATH=./config/memory.db

# Google OAuth
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...

# その他のAPI設定
GEMINI_API_KEY=...
ELEVENLABS_API_KEY=...
```

### ステップ 3: アプリケーションの起動

```bash
cd src
python app.py
```

### ステップ 4: ブラウザでアクセス

```
http://localhost:5000
```

---

## ✅ 4. 動作確認

1. `http://localhost:5000/auth/login.html` にアクセス
2. 「Googleでログイン」または「GitHubでログイン」ボタンをクリック
3. OAuth プロバイダーの認証画面が表示される
4. 認証を許可すると、メインページにリダイレクトされる
5. ログイン状態が維持されていることを確認

---

## 🔒 5. セキュリティのベストプラクティス

### 本番環境へのデプロイ時

1. **強力な SECRET_KEY を使用**
   ```bash
   python -c "import secrets; print(secrets.token_hex(32))"
   ```

2. **HTTPS を必須にする**
   - OAuth リダイレクト URI は `https://` を使用
   - HTTP は開発環境のみ

3. **環境変数を安全に管理**
   - `.env` ファイルを `.gitignore` に追加
   - Vercel/Render などの環境変数機能を使用

4. **CORS設定を適切に行う**
   ```python
   CORS(app, origins=["https://yourdomain.com"])
   ```

5. **トークンの有効期限を適切に設定**
   - アクセストークン: 15分
   - リフレッシュトークン: 30日

---

## 🐛 トラブルシューティング

### Google OAuth のエラー

**エラー**: `redirect_uri_mismatch`
- **原因**: リダイレクト URI が一致していない
- **解決**: Google Cloud Console の「承認済みのリダイレクト URI」に正確な URI を追加

**エラー**: `access_denied`
- **原因**: ユーザーが認証を拒否した
- **解決**: ユーザーに再度ログインを試みるよう促す

### GitHub OAuth のエラー

**エラー**: `bad_verification_code`
- **原因**: 認証コードが無効または期限切れ
- **解決**: ユーザーに再度ログインを試みるよう促す

**エラー**: `Could not retrieve email`
- **原因**: GitHubアカウントのメールアドレスがプライベート設定
- **解決**: GitHub で公開メールアドレスを設定するようユーザーに案内

### データベースエラー

**エラー**: `no such table: oauth_accounts`
- **原因**: データベーステーブルが作成されていない
- **解決**: アプリケーションを再起動してテーブルを自動作成

---

## 📚 参考リンク

- [Google OAuth 2.0 ドキュメント](https://developers.google.com/identity/protocols/oauth2)
- [GitHub OAuth ドキュメント](https://docs.github.com/ja/apps/oauth-apps/building-oauth-apps)
- [Authlib ドキュメント](https://docs.authlib.org/en/latest/)

---

## 📞 サポート

問題が発生した場合は、以下を確認してください:

1. `.env` ファイルの設定
2. OAuth プロバイダーの設定
3. リダイレクト URI の一致
4. ネットワーク接続
5. ブラウザのコンソールエラー

それでも解決しない場合は、GitHub Issues でお問い合わせください。
