import { defineConfig } from 'vite';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default defineConfig({
  root: './frontend',
  publicDir: false, // publicDirを無効化して手動で設定
  server: {
    port: 3000,
    open: false, // 自動的にブラウザを開かないように変更
    strictPort: true, // ポートが使用中の場合はエラーを出す
    proxy: {
      // FlaskバックエンドへのAPI呼び出しをプロキシ
      '/api': {
        target: 'http://localhost:5000',
        changeOrigin: true,
        secure: false
      },
      // Socket.IO通信をプロキシ
      '/socket.io': {
        target: 'http://localhost:5000',
        changeOrigin: true,
        ws: true
      },
      // モデルファイルをプロキシ
      '/models': {
        target: 'http://localhost:5000',
        changeOrigin: true,
        secure: false
      },
      // 背景画像をプロキシ
      '/backgrounds': {
        target: 'http://localhost:5000',
        changeOrigin: true,
        secure: false
      }
    }
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, 'frontend/index.html')
      }
    }
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './frontend'),
      '@models': path.resolve(__dirname, './models')
    }
  }
});
