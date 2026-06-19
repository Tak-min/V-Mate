/**
 * iOSネイティブアプリ(ios/)が WKWebView に読み込む最小エントリポイント。
 * フル SPA (App.tsx) は使わず、調整済みの CompanionViewer だけを window.vmate.* として公開する。
 * これにより視線/まばたき/リップシンクのチューニングを Web と iOS で一本化し、二重管理を避ける。
 *
 * Swift側ブリッジ: ios/VMate/Sources/Avatar/VRMBridge.swift が evaluateJavaScript で
 * window.vmate.setEmotion / setMouthLevel / notice / setAffinity / relax を呼ぶ。
 */
import { CompanionViewer } from '../features/vrm/viewer';
import type { Emotion } from '../features/chat/types';

declare global {
  interface Window {
    vmate: {
      setEmotion(emotion: Emotion): void;
      setMouthLevel(level: number): void;
      notice(mode: 'idle' | 'typing' | 'listening' | 'thinking' | 'speaking', seconds?: number): void;
      setAffinity(affinity: number): void;
      relax(): void;
    };
  }
}

function boot(): void {
  const canvas = document.getElementById('avatar-canvas') as HTMLCanvasElement | null;
  if (!canvas) throw new Error('avatar-canvas not found');

  // この avatar.html は本番Worker自身から配信される(frontend/public/ios-avatar/ → backend/static/
  // にビルドコピーされ、/models/*.vrm と同一オリジン)。iOS の WKWebView はこのURLをそのまま
  // 読み込むため、ローカル file:// ではなく相対パスで CORS を回避できる。
  const viewer = new CompanionViewer(canvas, {
    modelUrl: '/models/shiro.vrm',
    fallbackModelUrl: '/models/shiro.vrm',
  });

  let mouthLevel = 0;
  viewer.getMouthLevel = () => mouthLevel;

  window.vmate = {
    setEmotion: (emotion) => viewer.setEmotion(emotion),
    setMouthLevel: (level) => {
      mouthLevel = Math.min(Math.max(level, 0), 1);
    },
    notice: (mode, seconds) => viewer.notice(mode, seconds),
    setAffinity: (affinity) => viewer.setAffinity(affinity),
    relax: () => viewer.relax(),
  };

  viewer.load().then(() => {
    document.dispatchEvent(new Event('vmate-ready'));
  }).catch((error) => {
    document.title = `load-error:${String(error)}`;
  });
}

if (document.readyState === 'complete' || document.readyState === 'interactive') {
  boot();
} else {
  document.addEventListener('DOMContentLoaded', boot);
}
