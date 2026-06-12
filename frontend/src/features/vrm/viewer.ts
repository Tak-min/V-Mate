import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRM, VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import {
  VRMAnimationLoaderPlugin,
  VRMLookAtQuaternionProxy,
  createVRMAnimationClip,
} from '@pixiv/three-vrm-animation';
import type { Emotion } from '../chat/types';

const MODEL_URL = '/models/shiro.vrm';

// 感情 → (待機モーション, VRM表情ウェイト) のマッピング
const MOTIONS: Record<string, string> = {
  neutral: '/animations/mujaki.vrma',
  happy: '/animations/genki.vrma',
  sad: '/animations/oshitoyaka.vrma',
  angry: '/animations/cool.vrma',
  relaxed: '/animations/oshitoyaka.vrma',
  shy: '/animations/shy.vrma',
};

const EXPRESSIONS: Record<Emotion, Record<string, number>> = {
  neutral: {},
  happy: { happy: 1.0 },
  sad: { sad: 0.8 },
  angry: { angry: 0.7 },
  relaxed: { relaxed: 0.7 },
  shy: { happy: 0.35, sad: 0.35 },
};

const EXPRESSION_FADE = 0.08; // 表情の補間速度(フレーム毎の係数)
const CROSSFADE_SECONDS = 0.6;

export class CompanionViewer {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private clock = new THREE.Clock();
  private vrm: VRM | null = null;
  private mixer: THREE.AnimationMixer | null = null;
  private actions = new Map<string, THREE.AnimationAction>();
  private currentAction: THREE.AnimationAction | null = null;

  private targetWeights: Record<string, number> = {};
  private currentWeights: Record<string, number> = {};
  private nextBlink = 2;
  private blinkPhase = 0;
  private mouthOpen = 0;
  /** リップシンク中の口の開き(0..1)を毎フレーム取得する関数 */
  getMouthLevel: (() => number) | null = null;

  private disposed = false;

  constructor(private canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: true,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.camera = new THREE.PerspectiveCamera(24, 1, 0.1, 20);
    this.camera.position.set(0, 1.32, 2.2);
    this.camera.lookAt(0, 1.12, 0);

    const key = new THREE.DirectionalLight(0xfff2e3, 1.6);
    key.position.set(1.2, 1.8, 1.5);
    const fill = new THREE.DirectionalLight(0xdde8ff, 0.7);
    fill.position.set(-1.5, 1.2, 0.8);
    const ambient = new THREE.HemisphereLight(0xfff6ec, 0xd9c8c0, 0.9);
    this.scene.add(key, fill, ambient);

    this.resize();
    window.addEventListener('resize', this.resize);
  }

  async load(onProgress?: (ratio: number) => void): Promise<void> {
    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));
    loader.register((parser) => new VRMAnimationLoaderPlugin(parser));

    const gltf = await loader.loadAsync(MODEL_URL, (e) => {
      if (e.total > 0) onProgress?.(e.loaded / e.total);
    });
    const vrm = gltf.userData.vrm as VRM;
    VRMUtils.removeUnnecessaryVertices(vrm.scene);
    VRMUtils.combineSkeletons(vrm.scene);
    VRMUtils.rotateVRM0(vrm);
    vrm.scene.traverse((obj) => (obj.frustumCulled = false));

    if (vrm.lookAt) {
      const proxy = new VRMLookAtQuaternionProxy(vrm.lookAt);
      proxy.name = 'VRMLookAtQuaternionProxy';
      vrm.scene.add(proxy);
      vrm.lookAt.target = this.camera;
    }

    this.scene.add(vrm.scene);
    this.vrm = vrm;
    this.mixer = new THREE.AnimationMixer(vrm.scene);

    // 待機モーション(.vrma)をすべて読み込む
    const motionUrls = [...new Set(Object.values(MOTIONS))];
    await Promise.all(
      motionUrls.map(async (url) => {
        try {
          const animGltf = await loader.loadAsync(url);
          const animation = animGltf.userData.vrmAnimations?.[0];
          if (!animation || !this.mixer || !this.vrm) return;
          const clip = createVRMAnimationClip(animation, this.vrm);
          const action = this.mixer.clipAction(clip);
          action.setLoop(THREE.LoopRepeat, Infinity);
          this.actions.set(url, action);
        } catch {
          // モーション1つの失敗は致命的ではない
        }
      }),
    );
    this.playMotion(MOTIONS.neutral);
    this.renderLoop();
  }

  setEmotion(emotion: Emotion): void {
    this.targetWeights = EXPRESSIONS[emotion] ?? {};
    this.playMotion(MOTIONS[emotion] ?? MOTIONS.neutral);
  }

  /** 発話終了などで素の表情へ戻す */
  relax(): void {
    this.targetWeights = {};
  }

  private playMotion(url: string): void {
    const action = this.actions.get(url);
    if (!action || action === this.currentAction) return;
    action.reset().setEffectiveWeight(1).play();
    if (this.currentAction) {
      this.currentAction.crossFadeTo(action, CROSSFADE_SECONDS, false);
    }
    this.currentAction = action;
  }

  private updateExpressions(delta: number): void {
    const manager = this.vrm?.expressionManager;
    if (!manager) return;

    for (const name of ['happy', 'sad', 'angry', 'relaxed']) {
      const target = this.targetWeights[name] ?? 0;
      const current = this.currentWeights[name] ?? 0;
      const value = current + (target - current) * EXPRESSION_FADE;
      this.currentWeights[name] = value;
      manager.setValue(name, value);
    }

    // まばたき(表情が強いときは抑える)
    this.nextBlink -= delta;
    if (this.nextBlink <= 0 && this.blinkPhase <= 0) {
      this.blinkPhase = 0.18;
      this.nextBlink = 1.5 + Math.random() * 4;
    }
    if (this.blinkPhase > 0) {
      this.blinkPhase -= delta;
      const t = Math.max(this.blinkPhase, 0) / 0.18;
      manager.setValue('blink', Math.sin(t * Math.PI));
    } else {
      manager.setValue('blink', 0);
    }

    // リップシンク
    const level = this.getMouthLevel?.() ?? 0;
    this.mouthOpen += (level - this.mouthOpen) * 0.45;
    manager.setValue('aa', Math.min(this.mouthOpen, 1));
  }

  private renderLoop = (): void => {
    if (this.disposed) return;
    requestAnimationFrame(this.renderLoop);
    const delta = this.clock.getDelta();
    this.mixer?.update(delta);
    this.updateExpressions(delta);
    this.vrm?.update(delta);
    this.renderer.render(this.scene, this.camera);
  };

  private resize = (): void => {
    const { clientWidth, clientHeight } = this.canvas.parentElement ?? {
      clientWidth: window.innerWidth,
      clientHeight: window.innerHeight,
    };
    this.renderer.setSize(clientWidth, clientHeight, false);
    this.camera.aspect = clientWidth / clientHeight;
    this.camera.updateProjectionMatrix();
  };

  dispose(): void {
    this.disposed = true;
    window.removeEventListener('resize', this.resize);
    if (this.vrm) {
      this.scene.remove(this.vrm.scene);
      VRMUtils.deepDispose(this.vrm.scene);
    }
    this.renderer.dispose();
  }
}
