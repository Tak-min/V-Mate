# AI Wife プロジェクト - ハイブリッド構成セットアップガイド

## 🎯 アーキテクチャ概要

```
┌─────────────────────────────────────────┐
│  Frontend (Render)                      │
│  - 3D UI (Three.js + VRM)               │
│  - ユーザーインターフェース              │
│  - Socket.IO Client                     │
└──────────────┬──────────────────────────┘
               │
               │ WebSocket + REST API
               │
               ↓
┌─────────────────────────────────────────┐
│  Cloudflare Tunnel                      │
│  - 自宅サーバーを公開                    │
│  - HTTPS対応                             │
└──────────────┬──────────────────────────┘
               │
               ↓
┌─────────────────────────────────────────┐
│  Backend (自宅PC)                       │
│  - Flask + Socket.IO Server             │
│  - Gemini AI (会話生成)                 │
│  - ElevenLabs TTS (音声合成)            │
│  - SQLite (会話履歴)                    │
└─────────────────────────────────────────┘
```

---

## ✅ 変更内容まとめ

### 1. **音声合成エンジンの変更**
- ❌ **削除**: VITS / Hugging Face Spaces (不安定・低品質)
- ✅ **追加**: ElevenLabs API (高品質・低遅延)

### 2. **アーキテクチャの変更**
- **Frontend**: Render上にデプロイ（変更なし）
- **Backend**: ローカルPC → Cloudflare Tunnel経由で公開

### 3. **主な変更ファイル**
- `requirements.txt`: `elevenlabs` 追加、`gradio_client` 削除
- `src/services/voice_service.py`: 完全リライト（ElevenLabs対応）
- `src/app.py`: `/audio/<filename>` ルート追加（静的ファイル配信）
- `frontend/js/app.js`: バックエンドURL設定追加、音声URL修正
- `.env`: ElevenLabs APIキー設定

---

## 🚀 セットアップ手順

### **ステップ1: 依存関係のインストール**

```bash
# 仮想環境を作成（推奨）
python -m venv venv

# 仮想環境を有効化
# Windows:
venv\Scripts\activate
# macOS/Linux:
source venv/bin/activate

# 依存関係をインストール
pip install -r requirements.txt
```

---

### **ステップ2: 環境変数の設定**

`.env` ファイルが既に設定されていますが、以下を確認してください：

```bash
# ElevenLabs API キー（必須）
ELEVENLABS_API_KEY="your_elevenlabs_api_key_here"

# Gemini AI キー（必須）
GEMINI_API_KEY="your_gemini_api_key_here"

# その他の設定
SECRET_KEY="your_secret_key_here"
DATABASE_PATH="./config/memory.db"
```

**ElevenLabs APIキーの取得方法:**
1. https://elevenlabs.io/ でアカウント作成
2. ダッシュボードから API Key を取得
3. `.env` の `ELEVENLABS_API_KEY` に設定

---

### **ステップ3: Cloudflare Tunnel のセットアップ**

#### 3.1 Cloudflare Tunnel のインストール

```bash
# Windows (PowerShell管理者権限)
winget install Cloudflare.cloudflared

# macOS
brew install cloudflare/cloudflare/cloudflared

# Linux
wget -q https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
sudo dpkg -i cloudflared-linux-amd64.deb
```

#### 3.2 Cloudflare認証

```bash
cloudflared tunnel login
```

ブラウザが開くので、Cloudflareアカウントでログインしてドメインを選択します。

#### 3.3 Tunnelの作成

```bash
# Tunnelを作成（名前は任意、例: aiwife-backend）
cloudflared tunnel create aiwife-backend
```

実行後、Tunnel IDが表示されます。メモしておいてください。

#### 3.4 設定ファイルの作成

`~/.cloudflared/config.yml` を作成します（Windows: `C:\Users\<ユーザー名>\.cloudflared\config.yml`）：

```yaml
tunnel: <Tunnel ID>
credentials-file: C:\Users\<ユーザー名>\.cloudflared\<Tunnel ID>.json

ingress:
  - hostname: your-tunnel-name.your-domain.com
    service: http://localhost:5000
  - service: http_status:404
```

#### 3.5 DNSレコードの設定

```bash
cloudflared tunnel route dns aiwife-backend your-tunnel-name.your-domain.com
```

#### 3.6 Tunnelの起動

```bash
cloudflared tunnel run aiwife-backend
```

または、バックグラウンドで常時起動（Windowsサービスとして登録）：

```bash
cloudflared service install
cloudflared service start
```

---

### **ステップ4: バックエンドの起動**

```bash
# プロジェクトディレクトリに移動
cd c:\Users\taku8\Desktop\to practice\webpage\3DCharacter系\AIWife-test

# Flaskサーバーを起動
python src/app.py
```

サーバーが `http://localhost:5000` で起動します。

---

### **ステップ5: フロントエンドの設定**

`frontend/js/app.js` の先頭にある `BACKEND_URL` を、Cloudflare TunnelのURLに変更します：

```javascript
// ========== BACKEND CONFIGURATION ==========
// TODO: Cloudflare TunnelのURLを設定してください
const BACKEND_URL = 'https://your-tunnel-name.your-domain.com';
```

**例:**
```javascript
const BACKEND_URL = 'https://aiwife-backend.example.com';
```

---

### **ステップ6: フロントエンドのデプロイ（Render）**

1. **Renderダッシュボード**にログイン: https://dashboard.render.com/
2. **Static Site** を選択
3. GitHubリポジトリを接続
4. **Build Settings**:
   - **Build Command**: `npm install`
   - **Publish Directory**: `frontend`
5. **Deploy**をクリック

デプロイ完了後、RenderのURLでフロントエンドにアクセスできます。

---

## 🧪 動作確認

### 1. **バックエンドの確認**

```bash
# ヘルスチェック
curl http://localhost:5000/api/health

# または
curl https://your-tunnel-name.your-domain.com/api/health
```

**期待されるレスポンス:**
```json
{
  "status": "healthy",
  "timestamp": "2026-01-29T..."
}
```

### 2. **音声生成のテスト**

Pythonコンソールで直接テスト：

```python
from src.services.voice_service import get_voice_service

voice_service = get_voice_service()
audio_path = voice_service.generate_audio("こんにちは、テストです。", character_id="shiro")
print(f"Audio saved at: {audio_path}")
```

### 3. **フロントエンドの確認**

ブラウザで Render のURLにアクセスし、以下を確認：
- ✅ 3Dキャラクターが表示される
- ✅ メッセージ送信後、音声が再生される
- ✅ コンソールに `Socket.IO connected successfully` が表示される

---

## 🛠️ トラブルシューティング

### **問題1: ElevenLabs API エラー**

**エラー:** `ELEVENLABS_API_KEY not found`

**解決策:**
```bash
# .envファイルを確認
cat .env | grep ELEVENLABS

# APIキーが設定されているか確認
echo $ELEVENLABS_API_KEY  # Linux/macOS
echo %ELEVENLABS_API_KEY% # Windows CMD
```

---

### **問題2: 音声ファイルが再生されない**

**症状:** フロントエンドで404エラー

**原因:** `BACKEND_URL` が正しく設定されていない

**解決策:**
1. `frontend/js/app.js` の `BACKEND_URL` を確認
2. ブラウザの開発者ツール（F12）→ Networkタブで、音声ファイルのリクエストURLを確認
3. 正しいCloudflare TunnelのURLが使われているか確認

---

### **問題3: Socket.IO接続エラー**

**症状:** `Socket.IO connection failed`

**原因:** CORSエラー、またはバックエンドが起動していない

**解決策:**
1. バックエンドが起動しているか確認: `curl http://localhost:5000/api/health`
2. `src/app.py` のCORS設定を確認:
   ```python
   socketio = SocketIO(app, cors_allowed_origins="*")
   CORS(app)
   ```
3. Cloudflare Tunnelが正しく動作しているか確認:
   ```bash
   cloudflared tunnel list
   cloudflared tunnel info aiwife-backend
   ```

---

### **問題4: 音声ファイルが溜まりすぎる**

**症状:** `frontend/audio/` ディレクトリに大量の `.mp3` ファイル

**解決策:**
古いファイルを自動削除する定期タスクを追加（オプション）：

```python
# src/app.py に追加
import atexit
from apscheduler.schedulers.background import BackgroundScheduler

# クリーンアップスケジューラー
def cleanup_audio_files():
    voice_service.cleanup_old_files(max_age_hours=24)

scheduler = BackgroundScheduler()
scheduler.add_job(func=cleanup_audio_files, trigger="interval", hours=6)
scheduler.start()

# アプリ終了時にスケジューラーを停止
atexit.register(lambda: scheduler.shutdown())
```

---

## 📊 パフォーマンス最適化

### **ElevenLabs モデルの選択**

`src/services/voice_service.py` で以下を変更可能：

```python
# 低遅延優先（現在の設定）
self.model = "eleven_turbo_v2_5"

# 高品質優先
self.model = "eleven_multilingual_v2"
```

**推奨:** 低遅延を重視する場合は `eleven_turbo_v2_5` を使用

---

## 📝 今後の拡張

- [ ] 音声ファイルのキャッシュ機構（同じテキストの再利用）
- [ ] 複数キャラクターの音声対応（Voice IDマッピング拡張）
- [ ] Cloudflare Tunnel の自動起動設定（Windowsサービス化）
- [ ] モニタリング・ログ収集（Cloudflare Analytics連携）

---

## 🔗 関連リンク

- **ElevenLabs API**: https://elevenlabs.io/docs/api-reference/text-to-speech
- **Cloudflare Tunnel**: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/
- **Render**: https://docs.render.com/

---

## ✅ セットアップ完了チェックリスト

- [ ] Python依存関係がインストールされている
- [ ] `.env` ファイルにElevenLabs APIキーが設定されている
- [ ] Cloudflare Tunnelが起動している
- [ ] バックエンドが `localhost:5000` で起動している
- [ ] `frontend/js/app.js` の `BACKEND_URL` が設定されている
- [ ] フロントエンドがRenderにデプロイされている
- [ ] ブラウザでアプリにアクセスでき、音声が再生される

---

**以上で、AI Wifeプロジェクトのハイブリッド構成への移行が完了しました！🎉**
