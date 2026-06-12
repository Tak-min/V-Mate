#!/bin/bash
# Aikata 起動スクリプト — ビルド済みフロントを :8080 で配信
set -e
cd "$(dirname "$0")/backend"

if [ ! -d .venv ]; then
  echo "初回セットアップ: Python venv を作成します..."
  python3 -m venv .venv
  .venv/bin/pip install -r requirements.txt
fi

if [ ! -d static ]; then
  echo "初回セットアップ: フロントエンドをビルドします..."
  (cd ../frontend && npm install && npm run build)
fi

echo "Aikata を起動: http://localhost:8080"
exec .venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8080
