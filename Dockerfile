# --- フロントエンドをビルド(出力は ../backend/static)---
FROM node:20-slim AS frontend
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build   # vite outDir = ../backend/static → /app/backend/static

# --- バックエンド(FastAPI)。ビルド済みフロントを同居配信 ---
FROM python:3.12-slim AS backend
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
WORKDIR /app/backend
COPY backend/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY backend/ ./
# 念のためローカルの static / data / .env を除外(.dockerignore でも除外)
RUN rm -rf static data .env
COPY --from=frontend /app/backend/static ./static

EXPOSE 8080
# Render 等は $PORT を注入する。無ければ 8080。
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8080}"]
