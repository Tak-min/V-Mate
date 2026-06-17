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
  happy: { happy: 0.82, relaxed: 0.1 },
  sad: { sad: 0.48, relaxed: 0.08 },
  angry: { angry: 0.26, relaxed: 0.08 },
  relaxed: { relaxed: 0.62, happy: 0.08 },
  shy: { happy: 0.24, sad: 0.22, relaxed: 0.08 },
};

const EXPRESSION_NAMES = ['happy', 'sad', 'angry', 'relaxed'] as const;
const EXPRESSION_FADE = 8; // 表情の補間速度(1秒あたり)
const CROSSFADE_SECONDS = 0.6;
const LOOK_TARGET_BASE = new THREE.Vector3(0, 1.28, 2.15);

type AttentionMode = 'idle' | 'typing' | 'listening' | 'thinking' | 'speaking';

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function damp(current: number, target: number, lambda: number, delta: number): number {
  return current + (target - current) * (1 - Math.exp(-lambda * delta));
}

function easeOutCubic(t: number): number {
  return 1 - (1 - t) ** 3;
}

function easeInOutSine(t: number): number {
  return -(Math.cos(Math.PI * t) - 1) / 2;
}

function clamp01(value: number): number {
  return Math.min(Math.max(value, 0), 1);
}

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
  private currentEmotion: Emotion = 'neutral';
  private elapsed = rand(0, 20);
  private nextBlink = 2.4;
  private blinkElapsed = 0;
  private blinkDuration = 0;
  private blinkCloseRatio = 0.32;
  private blinkStrength = 1;
  private doubleBlinkDelay = 0;
  private queueDoubleBlink = false;
  private mouthOpen = 0;
  private attentionMode: AttentionMode = 'idle';
  private attentionUntil = 0;
  private relationshipWarmth = 0;
  private targetRelationshipWarmth = 0;
  private compactViewport = false;
  private lookTargetBase = LOOK_TARGET_BASE.clone();
  private lookTarget = new THREE.Object3D();
  private gazeCurrent = LOOK_TARGET_BASE.clone();
  private gazeOffset = new THREE.Vector2();
  private nextGazeShift = 0;
  private pointer = new THREE.Vector2();
  private pointerActive = false;
  private lastPointerAt = -Infinity;
  private modelBaseY = 0;
  private modelBaseRotationX = 0;
  private modelBaseRotationY = 0;
  private modelBaseRotationZ = 0;
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
    this.lookTarget.position.copy(this.gazeCurrent);
    this.scene.add(this.lookTarget);

    this.resize();
    window.addEventListener('resize', this.resize);
    this.canvas.addEventListener('pointermove', this.onPointerMove);
    this.canvas.addEventListener('pointerleave', this.onPointerLeave);
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
      vrm.lookAt.target = this.lookTarget;
    }

    this.scene.add(vrm.scene);
    this.vrm = vrm;
    this.mixer = new THREE.AnimationMixer(vrm.scene);
    this.modelBaseY = vrm.scene.position.y;
    this.modelBaseRotationX = vrm.scene.rotation.x;
    this.modelBaseRotationY = vrm.scene.rotation.y;
    this.modelBaseRotationZ = vrm.scene.rotation.z;

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
    this.currentEmotion = emotion;
    this.targetWeights = EXPRESSIONS[emotion] ?? {};
    this.playMotion(MOTIONS[emotion] ?? MOTIONS.neutral);
    this.notice('speaking', 3.2);
  }

  /** 発話終了などで素の表情へ戻す */
  relax(): void {
    this.targetWeights = {};
  }

  /** 親密度に応じて距離感・視線・素の表情をゆっくり近づける。 */
  setAffinity(affinity: number): void {
    this.targetRelationshipWarmth = clamp01(affinity / 200);
  }

  /** ユーザーの発話やシロの返答に合わせて、視線の集中度を短く変える。 */
  notice(mode: AttentionMode, seconds = 2.4): void {
    this.attentionMode = mode;
    this.attentionUntil = Math.max(this.attentionUntil, this.elapsed + seconds);
    this.nextGazeShift = Math.min(this.nextGazeShift, 0.12);
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

    const baselineWeights: Record<(typeof EXPRESSION_NAMES)[number], number> = {
      happy: this.relationshipWarmth * 0.055,
      sad: 0,
      angry: 0,
      relaxed: this.relationshipWarmth * 0.16,
    };

    for (const name of EXPRESSION_NAMES) {
      const target = Math.max(this.targetWeights[name] ?? 0, baselineWeights[name]);
      const current = this.currentWeights[name] ?? 0;
      const value = damp(current, target, EXPRESSION_FADE, delta);
      this.currentWeights[name] = value;
      manager.setValue(name, value);
    }

    this.updateBlink(delta, manager);

    // リップシンク
    const level = this.getMouthLevel?.() ?? 0;
    const targetMouth = level > 0.02 ? Math.min(0.16 + level * 0.92, 1) : 0;
    const mouthLambda = targetMouth > this.mouthOpen ? 18 : 10;
    this.mouthOpen = damp(this.mouthOpen, targetMouth, mouthLambda, delta);
    manager.setValue('aa', Math.min(this.mouthOpen, 1));
  }

  private updateBlink(delta: number, manager: NonNullable<VRM['expressionManager']>): void {
    if (this.doubleBlinkDelay > 0) {
      this.doubleBlinkDelay -= delta;
      if (this.doubleBlinkDelay <= 0) this.startBlink(false);
    }

    if (this.blinkDuration <= 0 && this.doubleBlinkDelay <= 0) {
      this.nextBlink -= delta;
      if (this.nextBlink <= 0) this.startBlink(true);
    }

    if (this.blinkDuration <= 0) {
      manager.setValue('blink', 0);
      return;
    }

    this.blinkElapsed += delta;
    const progress = Math.min(this.blinkElapsed / this.blinkDuration, 1);
    const closed =
      progress < this.blinkCloseRatio
        ? easeOutCubic(progress / this.blinkCloseRatio)
        : 1 - easeInOutSine((progress - this.blinkCloseRatio) / (1 - this.blinkCloseRatio));
    manager.setValue('blink', Math.max(0, closed) * this.blinkStrength);

    if (progress >= 1) {
      this.blinkDuration = 0;
      manager.setValue('blink', 0);
      if (this.queueDoubleBlink) {
        this.queueDoubleBlink = false;
        this.doubleBlinkDelay = rand(0.08, 0.16);
      } else {
        this.nextBlink = this.randomBlinkInterval();
      }
    }
  }

  private startBlink(allowDouble: boolean): void {
    this.blinkElapsed = 0;
    this.blinkDuration = rand(0.105, 0.19);
    this.blinkCloseRatio = rand(0.24, 0.38);
    this.blinkStrength = rand(0.84, 1);

    const doubleChance =
      this.currentEmotion === 'shy' ? 0.24 : this.currentEmotion === 'happy' ? 0.12 : 0.07;
    this.queueDoubleBlink = allowDouble && Math.random() < doubleChance;
  }

  private randomBlinkInterval(): number {
    const attentionScale =
      this.attentionMode === 'speaking'
        ? 0.78
        : this.attentionMode === 'typing'
          ? 0.86
          : this.attentionMode === 'thinking'
          ? 0.9
            : 1;
    const warmthScale =
      this.currentEmotion === 'neutral' || this.currentEmotion === 'relaxed'
        ? 1 + this.relationshipWarmth * 0.12
        : 1;
    switch (this.currentEmotion) {
      case 'happy':
        return rand(1.6, 4.2) * attentionScale * warmthScale;
      case 'sad':
        return rand(3.2, 6.8) * attentionScale * warmthScale;
      case 'angry':
        return rand(1.4, 3.1) * attentionScale * warmthScale;
      case 'relaxed':
        return rand(2.6, 5.8) * attentionScale * warmthScale;
      case 'shy':
        return rand(1.1, 3.0) * attentionScale * warmthScale;
      case 'neutral':
      default:
        return rand(2.0, 5.2) * attentionScale * warmthScale;
    }
  }

  private updateGaze(delta: number): void {
    if (this.elapsed > this.attentionUntil) this.attentionMode = 'idle';

    this.nextGazeShift -= delta;
    if (this.nextGazeShift <= 0) {
      const focus =
        this.attentionMode === 'typing'
          ? 0.5
          : this.attentionMode === 'listening'
            ? 0.55
            : this.attentionMode === 'speaking'
              ? 0.7
              : 1;
      const settled = 1 - this.relationshipWarmth * 0.28;
      this.gazeOffset.set(rand(-0.34, 0.34) * focus * settled, rand(-0.16, 0.13) * focus * settled);

      if (
        (this.currentEmotion === 'shy' || this.currentEmotion === 'sad') &&
        Math.random() < 0.26 * (1 - this.relationshipWarmth * 0.45)
      ) {
        this.gazeOffset.y -= rand(0.09, 0.18);
        this.gazeOffset.x += rand(-0.08, 0.08);
      }

      const baseDelay =
        this.attentionMode === 'typing'
          ? rand(0.45, 1.15)
          : this.attentionMode === 'listening'
            ? rand(0.75, 1.8)
            : this.attentionMode === 'thinking'
              ? rand(0.85, 1.9)
              : this.attentionMode === 'speaking'
                ? rand(1.1, 2.4)
                : rand(1.5, 4.4);
      this.nextGazeShift = baseDelay;
    }

    const pointerAge = this.elapsed - this.lastPointerAt;
    const pointerWeight =
      this.pointerActive || pointerAge < 3.2 ? Math.max(0, 1 - Math.max(pointerAge, 0) / 3.2) : 0;
    const breath = Math.sin(this.elapsed * 1.15) * 0.009;
    const microX = Math.sin(this.elapsed * 0.73 + 1.7) * 0.03 + Math.sin(this.elapsed * 1.9) * 0.01;
    const microY = Math.sin(this.elapsed * 0.61 + 0.4) * 0.02;
    const baseDirectness =
      this.attentionMode === 'typing'
        ? 0.9
        : this.attentionMode === 'listening'
          ? 0.88
          : this.attentionMode === 'thinking'
            ? 0.38
            : this.attentionMode === 'speaking'
              ? 0.78
              : 0.62;
    const directness = Math.min(baseDirectness + this.relationshipWarmth * 0.16, 0.94);
    const thinkingSide = Math.sin(this.elapsed * 0.53 + 0.8) > 0 ? 1 : -1;
    const modeX = this.attentionMode === 'thinking' ? 0.05 * thinkingSide : 0;
    const modeY =
      this.attentionMode === 'typing'
        ? -0.018
        : this.attentionMode === 'thinking'
          ? -0.055
          : this.attentionMode === 'listening'
            ? 0.012
            : 0;

    const target = this.lookTargetBase.clone();
    target.x += this.gazeOffset.x * (1 - directness) + microX + modeX;
    target.y += this.gazeOffset.y * (1 - directness) + microY + breath + modeY;
    target.x += this.pointer.x * 0.18 * pointerWeight;
    target.y -= this.pointer.y * 0.08 * pointerWeight;

    const speed =
      this.attentionMode === 'typing'
        ? 4.8
        : this.attentionMode === 'listening'
          ? 5.2
          : this.attentionMode === 'thinking'
            ? 2.7
            : this.attentionMode === 'speaking'
              ? 3.5
              : 2.4;
    this.gazeCurrent.lerp(target, 1 - Math.exp(-speed * delta));
    this.lookTarget.position.copy(this.gazeCurrent);
  }

  private updatePresence(delta: number): void {
    if (!this.vrm) return;
    const scene = this.vrm.scene;
    const lean =
      this.attentionMode === 'typing' || this.attentionMode === 'listening'
        ? -0.01
        : this.attentionMode === 'thinking'
          ? 0.006
          : 0;
    scene.position.y = this.modelBaseY + Math.sin(this.elapsed * 1.05) * 0.004;
    scene.rotation.x = damp(scene.rotation.x, this.modelBaseRotationX + lean, 3.2, delta);
    scene.rotation.y =
      this.modelBaseRotationY + Math.sin(this.elapsed * 0.42 + 0.5) * 0.012 + this.gazeCurrent.x * 0.01;
    scene.rotation.z = this.modelBaseRotationZ + Math.sin(this.elapsed * 0.37) * 0.004;
  }

  private updateRelationship(delta: number): void {
    this.relationshipWarmth = damp(
      this.relationshipWarmth,
      this.targetRelationshipWarmth,
      1.35,
      delta,
    );

    const baseZ = this.compactViewport ? 3.05 : 2.36;
    const closeOffset = this.compactViewport ? 0.1 : 0.08;
    const cameraY = this.compactViewport ? 1.34 : 1.32;
    const lookY = this.compactViewport ? 1.08 : 1.1;
    const lookTargetY = this.compactViewport ? 1.26 : 1.28;
    const lookTargetZ = this.compactViewport ? 2.98 : 2.3;

    this.camera.position.set(
      0,
      cameraY - this.relationshipWarmth * 0.025,
      baseZ - this.relationshipWarmth * closeOffset,
    );
    this.camera.lookAt(0, lookY + this.relationshipWarmth * 0.025, 0);
    this.lookTargetBase.set(
      0,
      lookTargetY + this.relationshipWarmth * 0.02,
      lookTargetZ - this.relationshipWarmth * closeOffset,
    );
  }

  private renderLoop = (): void => {
    if (this.disposed) return;
    requestAnimationFrame(this.renderLoop);
    const delta = this.clock.getDelta();
    this.elapsed += delta;
    this.mixer?.update(delta);
    this.updateRelationship(delta);
    this.updateGaze(delta);
    this.updatePresence(delta);
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
    this.compactViewport = clientWidth <= 700 || this.camera.aspect < 0.72;
    if (this.compactViewport) {
      this.camera.fov = 27;
    } else {
      this.camera.fov = 24;
    }
    this.updateRelationship(1);
    this.camera.updateProjectionMatrix();
  };

  private onPointerMove = (event: PointerEvent): void => {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    this.pointer.set(
      ((event.clientX - rect.left) / rect.width - 0.5) * 2,
      ((event.clientY - rect.top) / rect.height - 0.5) * 2,
    );
    this.pointerActive = true;
    this.lastPointerAt = this.elapsed;
  };

  private onPointerLeave = (): void => {
    this.pointerActive = false;
  };

  dispose(): void {
    this.disposed = true;
    window.removeEventListener('resize', this.resize);
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerleave', this.onPointerLeave);
    if (this.vrm) {
      this.scene.remove(this.vrm.scene);
      VRMUtils.deepDispose(this.vrm.scene);
    }
    this.renderer.dispose();
  }
}
