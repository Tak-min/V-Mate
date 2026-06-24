import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import {
  VRM,
  VRMLoaderPlugin,
  VRMUtils,
  VRMSpringBoneCollider,
  VRMSpringBoneColliderShapeCapsule,
} from '@pixiv/three-vrm';
import type {
  VRMHumanBoneName,
  VRMSpringBoneColliderGroup,
  VRMSpringBoneJoint,
} from '@pixiv/three-vrm';
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

// トラックC: 髪・スカートの胴体貫通対策。shiro.vrm はスプリングボーンに胴体コライダーを十分
// 持たないため、実行時に胴体ボーンへカプセルコライダーを生成して髪/スカート関節に割り当てる。
// 値は shiro.vrm 専用の採寸(ボーンの local 空間。検証ハーネス frontend/src/harness/ で
// コライダー可視化しながら調整)。radius=半径, offset=カプセル始点, tail=カプセル終点(共にlocal)。
interface TorsoColliderSpec {
  bone: VRMHumanBoneName;
  radius: number;
  offset: [number, number, number];
  tail: [number, number, number];
}
// shiro.vrm の胴体ボーン実測(world Y): hips 0.90 / spine 0.95 / chest 1.07 / upperChest 1.18 /
// 肩 1.29。各カプセルで1区間を橋渡しして hips〜肩(髪が最も貫通する範囲)を連続被覆する。
const TORSO_COLLIDER_SPECS: TorsoColliderSpec[] = [
  { bone: 'hips', radius: 0.11, offset: [0, 0, 0.01], tail: [0, 0.07, 0.01] },
  { bone: 'spine', radius: 0.11, offset: [0, 0, 0.015], tail: [0, 0.12, 0.015] },
  { bone: 'chest', radius: 0.105, offset: [0, 0, 0.02], tail: [0, 0.11, 0.015] },
  { bone: 'upperChest', radius: 0.1, offset: [0, 0, 0.015], tail: [0, 0.11, -0.01] },
];
// 髪/服(フード等)関節の剛性・ドラッグを底上げして、貫通が目立つ大揺れ自体を抑える(根治ではないが軽減)。
const HAIR_MIN_STIFFNESS = 1.1;
const HAIR_MIN_DRAG = 0.45;
// 胴体を貫通しうる「垂れ下がる」スプリングボーンだけを対象にする(VRoid命名 J_Sec_Hair* / J_Sec_*Hood*)。
// Bust(胸)は胴体コライダーで押し出されるのを避けるため除外。CatEar/FoxTail(J_Opt_*・頭/尻尾)も対象外。
const SPRING_BONE_NAME_RE = /hair|髪|hood|skirt|スカート/i;

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

/** 視線オフセットが不自然(人間離れした角度)にならないよう範囲を制限する。 */
function clampGaze(value: number, limit: number): number {
  return Math.min(Math.max(value, -limit), limit);
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
  /** ユーザー操作(発話/入力/応答)が最後にあった時刻。45秒超の無操作で「まどろみ」瞬きに移行する。 */
  private lastInteractionAt = this.elapsed;
  /** ワイドグランス(視線を大きく外す)直後に強制二重瞬きを行うためのフラグ。 */
  private pendingBlinkCluster = false;
  private modelBaseY = 0;
  private modelBaseRotationX = 0;
  private modelBaseRotationY = 0;
  private modelBaseRotationZ = 0;
  /** アイドル中、時々体重を片側へゆっくり預け直す「佇まいの変化」用のオフセットと予定時刻。 */
  private settleOffset = { z: 0, y: 0 };
  private settleTargetOffset = { z: 0, y: 0 };
  private nextSettle = rand(8, 16);
  /** アイドル時にローテーションさせる待機クリップの候補(既存5クリップ、重複除去)。 */
  private idleClipUrls = [...new Set(Object.values(MOTIONS))];
  private currentIdleClipUrl: string = MOTIONS.neutral;
  private nextIdleSwitch = rand(14, 26);
  /** setEmotion()がクリップを強制した直後、idleローテーションが横取りしないようにする猶予。 */
  private emotionLockUntil = 0;
  /** リップシンク中の口の開き(0..1)を毎フレーム取得する関数 */
  getMouthLevel: (() => number) | null = null;

  private contactShadow: THREE.Mesh | null = null;
  private disposed = false;

  // トラックC(髪貫通対策)で割り当てた髪/スカート関節と、実行時生成した胴体コライダー。
  // 検証ハーネスが getDebugHandles() 経由でヘルパー可視化に使う。
  private hairJoints: VRMSpringBoneJoint[] = [];
  private torsoColliders: VRMSpringBoneCollider[] = [];
  /** デバッグ検証ハーネス用: true のとき updateRelationship がカメラを上書きせず、外部の
   *  OrbitControls がカメラを所有できるようにする(多角度から貫通/コライダー配置を確認するため)。 */
  private debugFreeCamera: boolean;

  constructor(
    private canvas: HTMLCanvasElement,
    private options: {
      modelUrl?: string;
      fallbackModelUrl?: string;
      // iOS版(縦長フルブリードの専用エントリ frontend/src/ios-avatar/)が、顔周りを大きく
      // 見せる近め framing を指定するために追加。未指定なら従来のWeb版の値のまま。
      cameraPosition?: { x: number; y: number; z: number };
      cameraLookAt?: { x: number; y: number; z: number };
      // 検証ハーネス専用: カメラを外部(OrbitControls)に委ねる。本番では未指定=false。
      debugFreeCamera?: boolean;
    } = {},
  ) {
    this.debugFreeCamera = options.debugFreeCamera ?? false;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: true,
      // 検証ハーネスでは canvas.toDataURL() で確実にフレームを取り出せるよう描画バッファを保持する
      // (本番では未指定=既定でクリアされ、わずかに高速)。
      preserveDrawingBuffer: this.debugFreeCamera,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    // ACESフィルミックトーンマッピングで、トーンマッピング無し(NoToneMapping)の「のっぺり・
    // 白飛び」を解消し、ハイライトを自然にロールオフ・階調を豊かにして実写寄りの立体感を出す。
    // ACESは中間調を暗めにするため、露出を少し上げて補正する(MToonの白飛び/黒潰れはスクショで確認済み)。
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;

    this.camera = new THREE.PerspectiveCamera(24, 1, 0.1, 20);
    const camPos = this.options.cameraPosition ?? { x: 0, y: 1.32, z: 2.2 };
    const camLookAt = this.options.cameraLookAt ?? { x: 0, y: 1.12, z: 0 };
    this.camera.position.set(camPos.x, camPos.y, camPos.z);
    this.camera.lookAt(camLookAt.x, camLookAt.y, camLookAt.z);

    const key = new THREE.DirectionalLight(0xfff2e3, 1.5);
    key.position.set(1.2, 1.8, 1.5);
    const fill = new THREE.DirectionalLight(0xdde8ff, 0.65);
    fill.position.set(-1.5, 1.2, 0.8);
    // リムライト(バックライト): キャラ後方やや上の寒色光で髪・肩の輪郭を起こし、背景から
    // 浮かび上がらせる(以前は輪郭が背景に溶けて立体感・存在感が弱かった)。カメラは+z側に
    // あるので、-z(背後)から当てて縁取りを作る。
    const rim = new THREE.DirectionalLight(0xbcd2ff, 1.1);
    rim.position.set(-0.9, 2.3, -2.0);
    const ambient = new THREE.HemisphereLight(0xfff6ec, 0xd9c8c0, 0.85);
    this.scene.add(key, fill, rim, ambient);
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

    const modelUrl = this.options.modelUrl ?? MODEL_URL;
    let gltf;
    try {
      gltf = await loader.loadAsync(modelUrl, (e) => {
        if (e.total > 0) onProgress?.(e.loaded / e.total);
      });
    } catch (error) {
      const fallback = this.options.fallbackModelUrl ?? MODEL_URL;
      if (fallback === modelUrl) throw error;
      gltf = await loader.loadAsync(fallback, (e) => {
        if (e.total > 0) onProgress?.(e.loaded / e.total);
      });
    }
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
    this.setupHairPhysics(vrm);
    this.addContactShadow(vrm.scene);
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

  /**
   * 足元に柔らかいコンタクトシャドウ(疑似接地影)を1枚敷く。影が無いとキャラが床から
   * 浮いて見え非現実感の一因になるため。背景は透過でアプリ側に合成されるので、全面の床は
   * 置かず「足元の楕円の影」だけを置く。放射状グラデのキャンバステクスチャを地面に寝かせる。
   */
  private addContactShadow(modelScene: THREE.Object3D): void {
    const box = new THREE.Box3().setFromObject(modelScene);
    const footY = Number.isFinite(box.min.y) ? box.min.y : 0;
    const width = Math.max(box.max.x - box.min.x, 0.3);

    const size = 256;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grad.addColorStop(0, 'rgba(0,0,0,0.55)');
    grad.addColorStop(0.55, 'rgba(0,0,0,0.28)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const geometry = new THREE.PlaneGeometry(width * 1.7, width * 1.0);
    const material = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
      toneMapped: false,
    });
    const shadow = new THREE.Mesh(geometry, material);
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.set(0, footY + 0.005, 0);
    shadow.renderOrder = -1;
    this.scene.add(shadow);
    this.contactShadow = shadow;
  }

  /**
   * トラックC: 髪・スカートのスプリングボーンが胴体を貫通する問題への対処。
   * shiro.vrm は胴体コライダーを十分に持たないため、(1)髪/スカート関節の剛性・ドラッグを底上げして
   * 大揺れを抑え、(2)胸/腰に実行時カプセルコライダーを生成して各関節の colliderGroups に割り当て、
   * 貫通を物理的に防ぐ。値は shiro.vrm 専用採寸(検証ハーネスでコライダー可視化しながら調整)。
   * realistic.vrm 等を復活させる場合は別採寸が必要。
   */
  private setupHairPhysics(vrm: VRM): void {
    const manager = vrm.springBoneManager;
    if (!manager) return;

    const targetJoints = [...manager.joints].filter((joint) =>
      this.boneChainMatches(joint.bone, SPRING_BONE_NAME_RE),
    );
    if (targetJoints.length === 0) return;

    // (1) 剛性・ドラッグの底上げ。settings は immutable に作り直して反映する(gravityDir は据え置き)。
    for (const joint of targetJoints) {
      const s = joint.settings;
      joint.settings = {
        ...s,
        stiffness: Math.max(s.stiffness, HAIR_MIN_STIFFNESS),
        dragForce: Math.max(s.dragForce, HAIR_MIN_DRAG),
      };
    }

    // (2) 胴体カプセルコライダーを生成し、対象関節の colliderGroups に追加する。
    const torsoColliders = this.buildTorsoColliders(vrm);
    if (torsoColliders.length > 0) {
      const group: VRMSpringBoneColliderGroup = { name: 'vmate-torso', colliders: torsoColliders };
      for (const joint of targetJoints) {
        joint.colliderGroups = [...joint.colliderGroups, group];
      }
    }

    this.hairJoints = targetJoints;
    this.torsoColliders = torsoColliders;
  }

  /** ボーン自身から祖先を辿り、いずれかの名前が正規表現にマッチするか(VRoidの髪/スカート命名対策)。 */
  private boneChainMatches(bone: THREE.Object3D, re: RegExp): boolean {
    let node: THREE.Object3D | null = bone;
    for (let depth = 0; node && depth < 16; depth += 1) {
      if (re.test(node.name)) return true;
      node = node.parent;
    }
    return false;
  }

  /** 胴体ボーンに追従するカプセルコライダーを生成する(bone node の子に add してワールド追従させる)。 */
  private buildTorsoColliders(vrm: VRM): VRMSpringBoneCollider[] {
    const humanoid = vrm.humanoid;
    if (!humanoid) return [];
    const colliders: VRMSpringBoneCollider[] = [];
    for (const spec of TORSO_COLLIDER_SPECS) {
      const node =
        humanoid.getRawBoneNode(spec.bone) ?? humanoid.getNormalizedBoneNode(spec.bone);
      if (!node) continue;
      const shape = new VRMSpringBoneColliderShapeCapsule({
        radius: spec.radius,
        offset: new THREE.Vector3(...spec.offset),
        tail: new THREE.Vector3(...spec.tail),
      });
      const collider = new VRMSpringBoneCollider(shape);
      collider.name = `vmate-torso-${spec.bone}`;
      node.add(collider);
      colliders.push(collider);
    }
    return colliders;
  }

  /**
   * 検証ハーネス専用: シーン/カメラ/レンダラ/VRMと、トラックCで割り当てた関節・コライダーを返す。
   * ハーネス側が OrbitControls とスプリングボーンHelperを取り付けて多角度確認するために使う。
   */
  getDebugHandles(): {
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    renderer: THREE.WebGLRenderer;
    vrm: VRM | null;
    hairJoints: VRMSpringBoneJoint[];
    torsoColliders: VRMSpringBoneCollider[];
  } {
    return {
      scene: this.scene,
      camera: this.camera,
      renderer: this.renderer,
      vrm: this.vrm,
      hairJoints: this.hairJoints,
      torsoColliders: this.torsoColliders,
    };
  }

  setEmotion(emotion: Emotion): void {
    this.currentEmotion = emotion;
    this.targetWeights = EXPRESSIONS[emotion] ?? {};
    this.playMotion(MOTIONS[emotion] ?? MOTIONS.neutral);
    this.notice('speaking', 3.2);
    // setEmotionが直接クリップを切り替えるので、直後しばらくはidleローテーションが
    // 横取りして二重クロスフェードしないようロックする。
    this.emotionLockUntil = this.elapsed + 4.5;
    this.nextIdleSwitch = rand(14, 26);
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
    this.lastInteractionAt = this.elapsed;
  }

  /**
   * 発話の文末(句点など)で呼ぶと、近いうちに瞬きが来るように予定を早める。
   * 実際の話し手は文の切れ目で瞬きしがちなので、その癖を再現する。進行中の瞬きは妨げない。
   */
  blinkSoon(maxDelay = 0.5): void {
    if (this.blinkDuration > 0) return;
    this.nextBlink = Math.min(this.nextBlink, rand(0.1, maxDelay));
  }

  private playMotion(url: string): void {
    const action = this.actions.get(url);
    if (!action || action === this.currentAction) return;
    action.reset().setEffectiveWeight(1).play();
    if (this.currentAction) {
      this.currentAction.crossFadeTo(action, CROSSFADE_SECONDS, false);
    }
    this.currentAction = action;
    if (this.idleClipUrls.includes(url)) this.currentIdleClipUrl = url;
  }

  /**
   * アイドル中(attentionMode==='idle'かつ感情がneutral/relaxed)だけ、既存の待機クリップを
   * 文脈重み付きでローテーションする。単一クリップの永久ループだと「止まっている」印象が
   * 強くなるため、直前と違うクリップへ時間経過(relationshipWarmthで延長)に応じて
   * クロスフェードし、「実際に呼吸・佇まいを変えている」ような意図性を出す。
   */
  private updateIdleMotion(delta: number): void {
    const isIdleEmotion = this.currentEmotion === 'neutral' || this.currentEmotion === 'relaxed';
    if (this.attentionMode !== 'idle' || !isIdleEmotion) return;
    if (this.elapsed < this.emotionLockUntil) return;

    this.nextIdleSwitch -= delta;
    if (this.nextIdleSwitch > 0) return;

    this.playMotion(this.chooseNextIdleClip());
    this.nextIdleSwitch = rand(14, 26) * (1 + this.relationshipWarmth * 0.3);
  }

  /** 直前と違うクリップを、neutral(mujaki)寄りの重みで選ぶ。完全な毎回ランダムにはしない。 */
  private chooseNextIdleClip(): string {
    const weights: Record<string, number> = { [MOTIONS.neutral]: 2.2 };
    const candidates = this.idleClipUrls.filter((url) => url !== this.currentIdleClipUrl);
    if (candidates.length === 0) return this.currentIdleClipUrl;

    const total = candidates.reduce((sum, url) => sum + (weights[url] ?? 1), 0);
    let pick = rand(0, total);
    for (const url of candidates) {
      pick -= weights[url] ?? 1;
      if (pick <= 0) return url;
    }
    return candidates[candidates.length - 1];
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

    // リップシンク。TTS音声があれば実音量、無ければ(無音/TTSオフ)
    // 「speaking」中だけテキストの代わりに口パクの代替動作で喋っているように見せる。
    const audioLevel = this.getMouthLevel?.() ?? 0;
    const proceduralLevel =
      this.attentionMode === 'speaking' && audioLevel <= 0.02 ? this.proceduralMouthLevel() : 0;
    const level = Math.max(audioLevel, proceduralLevel);
    const targetMouth = level > 0.02 ? Math.min(0.16 + level * 0.92, 1) : 0;
    const mouthLambda = targetMouth > this.mouthOpen ? 18 : 10;
    this.mouthOpen = damp(this.mouthOpen, targetMouth, mouthLambda, delta);
    manager.setValue('aa', Math.min(this.mouthOpen, 1));
  }

  /** 実音声(TTS)が無いときの口パク代替。複数周波数の合成で人の発話に近い不規則さを出す。 */
  private proceduralMouthLevel(): number {
    const t = this.elapsed;
    const chatter =
      Math.sin(t * 16.5) * 0.4 + Math.sin(t * 23.7 + 1.1) * 0.3 + Math.sin(t * 9.3 + 2.4) * 0.3;
    const pause = Math.sin(t * 2.6 + 0.6) * 0.5 + 0.5; // 文の合間に時々口を閉じる緩い波
    return Math.max(0, chatter) * (0.35 + pause * 0.4);
  }

  private updateBlink(delta: number, manager: NonNullable<VRM['expressionManager']>): void {
    if (this.doubleBlinkDelay > 0) {
      this.doubleBlinkDelay -= delta;
      if (this.doubleBlinkDelay <= 0) this.startBlink(false);
    }

    // ワイドグランス直後は、まばたきの自然タイマーを待たずに強制的に二重瞬きを差し込み、
    // 「視線を外した拍子に瞬きが出る」人間の癖を再現する。
    if (this.pendingBlinkCluster && this.blinkDuration <= 0 && this.doubleBlinkDelay <= 0) {
      this.pendingBlinkCluster = false;
      this.startBlink(true);
      this.queueDoubleBlink = true;
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
    // 45秒超ユーザー操作が無いと、瞬きがわずかに長く・ゆっくりになる「まどろみ」を表現する。
    const isDrowsy = this.elapsed - this.lastInteractionAt > 45;
    this.blinkElapsed = 0;
    this.blinkDuration = rand(0.105, 0.19) * (isDrowsy ? rand(1.1, 1.3) : 1);
    this.blinkCloseRatio = rand(0.24, 0.38);
    this.blinkStrength = rand(0.84, 1);

    // ダブルまばたき(連続まばたき)の確率。会話への集中度が高いほど、緊張や反応で
    // まばたきが連続しやすくなる人間の癖を少し強めに再現する(以前より全体的に頻度を上げた)。
    const doubleChance =
      this.currentEmotion === 'shy' ? 0.3 : this.currentEmotion === 'happy' ? 0.18 : 0.11;
    this.queueDoubleBlink = allowDouble && Math.random() < doubleChance;
  }

  private randomBlinkInterval(): number {
    const attentionScale =
      this.attentionMode === 'speaking'
        ? 0.72
        : this.attentionMode === 'listening'
          ? 0.85
          : this.attentionMode === 'typing'
            ? 0.82
            : this.attentionMode === 'thinking'
              ? 0.9
              : 1;
    const warmthScale =
      this.currentEmotion === 'neutral' || this.currentEmotion === 'relaxed'
        ? 1 + this.relationshipWarmth * 0.12
        : 1;
    // 長時間ユーザー操作が無いと、まばたきの間隔を伸ばして「まどろみ」始めた印象にする。
    const drowsyScale = this.elapsed - this.lastInteractionAt > 45 ? rand(1.4, 1.9) : 1;
    switch (this.currentEmotion) {
      case 'happy':
        return rand(1.6, 4.2) * attentionScale * warmthScale * drowsyScale;
      case 'sad':
        return rand(3.2, 6.8) * attentionScale * warmthScale * drowsyScale;
      case 'angry':
        return rand(1.4, 3.1) * attentionScale * warmthScale * drowsyScale;
      case 'relaxed':
        return rand(2.6, 5.8) * attentionScale * warmthScale * drowsyScale;
      case 'shy':
        return rand(1.1, 3.0) * attentionScale * warmthScale * drowsyScale;
      case 'neutral':
      default:
        return rand(2.0, 5.2) * attentionScale * warmthScale * drowsyScale;
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

      // 時々、ちょっと視線を大きく外して部屋のあちこちを見るような「ワイドグランス」を挟む。
      // 人と話していてもずっと真っ直ぐ見つめ続けることはないので、その自然さを再現する。
      // 会話中(listening/speaking/typing)も一定の頻度で外すことで、相手と話している最中でも
      // 視線がふっと逸れる自然な人間の癖を再現する(以前は会話中だけ極端に低く、結果的に
      // 「会話中だけ一点を凝視しているように見える」原因になっていた)。
      const wideGlanceChance =
        this.attentionMode === 'idle'
          ? 0.26
          : this.attentionMode === 'listening'
            ? 0.22
            : this.attentionMode === 'speaking'
              ? 0.2
              : this.attentionMode === 'typing'
                ? 0.16
                : 0.1;
      const isWideGlance = Math.random() < wideGlanceChance;
      const wideScale = isWideGlance ? rand(1.8, 3.0) : 1;
      // ワイドグランス(視線を大きく外す)に合わせて、次のまばたきタイミングで強制二重瞬きを誘発する。
      if (isWideGlance) this.pendingBlinkCluster = true;

      this.gazeOffset.set(
        clampGaze(rand(-0.34, 0.34) * focus * settled * wideScale, 0.58),
        clampGaze(rand(-0.16, 0.13) * focus * settled * wideScale, 0.3),
      );

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
      this.nextGazeShift = isWideGlance ? baseDelay * rand(1.3, 1.9) : baseDelay;
    }

    const pointerAge = this.elapsed - this.lastPointerAt;
    const pointerWeight =
      this.pointerActive || pointerAge < 3.2 ? Math.max(0, 1 - Math.max(pointerAge, 0) / 3.2) : 0;
    const breath = Math.sin(this.elapsed * 1.15) * 0.009 * this.breathDepth();
    const microX = Math.sin(this.elapsed * 0.73 + 1.7) * 0.03 + Math.sin(this.elapsed * 1.9) * 0.01;
    const microY = Math.sin(this.elapsed * 0.61 + 0.4) * 0.02;
    const baseDirectness =
      this.attentionMode === 'typing'
        ? 0.74
        : this.attentionMode === 'listening'
          ? 0.7
          : this.attentionMode === 'thinking'
            ? 0.38
            : this.attentionMode === 'speaking'
              ? 0.62
              : 0.5;
    // 上限を抑える(以前は0.94まで上がり、(1-directness)で後段の視線オフセットを
    // ほぼゼロまで潰していた → 会話中だけ一点を凝視しているように見える原因だった)。
    const directness = Math.min(baseDirectness + this.relationshipWarmth * 0.1, 0.78);
    // 視線オフセットの可視性には必ず下限を設け、どんなにdirectnessが高くても
    // 「完全固定」にはならないようにする(人間は集中していても眼球はわずかに動き続ける)。
    const gazeVisibility = Math.max(1 - directness, 0.4);
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
    target.x += this.gazeOffset.x * gazeVisibility + microX + modeX;
    target.y += this.gazeOffset.y * gazeVisibility + microY + breath + modeY;
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

  /** 呼吸の深さをゆっくり波で変える係数(0.7〜1.0)。一定振幅だと機械的に見えるため。 */
  private breathDepth(): number {
    return 0.7 + 0.3 * Math.sin(this.elapsed * 0.18);
  }

  /**
   * アイドル中だけ、8〜16秒おきに体重を預け直すような極小の佇まい変化を起こす。
   * 会話中(typing/listening/speaking/thinking)は割り込まない。
   */
  private updateSettle(delta: number): void {
    if (this.attentionMode !== 'idle') {
      this.settleTargetOffset = { z: 0, y: 0 };
    } else {
      this.nextSettle -= delta;
      if (this.nextSettle <= 0) {
        this.settleTargetOffset = {
          z: rand(-0.012, 0.012),
          y: rand(-0.004, 0.004),
        };
        this.nextSettle = rand(8, 16);
      }
    }
    this.settleOffset.z = damp(this.settleOffset.z, this.settleTargetOffset.z, 1.6, delta);
    this.settleOffset.y = damp(this.settleOffset.y, this.settleTargetOffset.y, 1.6, delta);
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
    this.updateSettle(delta);
    const breathDepth = this.breathDepth();
    scene.position.y =
      this.modelBaseY + Math.sin(this.elapsed * 1.05) * 0.004 * breathDepth + this.settleOffset.y;
    scene.rotation.x = damp(scene.rotation.x, this.modelBaseRotationX + lean, 3.2, delta);
    scene.rotation.y =
      this.modelBaseRotationY + Math.sin(this.elapsed * 0.42 + 0.5) * 0.012 + this.gazeCurrent.x * 0.01;
    scene.rotation.z =
      this.modelBaseRotationZ + Math.sin(this.elapsed * 0.37) * 0.004 + this.settleOffset.z;
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

    // 検証ハーネスでは外部のOrbitControlsがカメラを所有するため、ここでは上書きしない。
    if (!this.debugFreeCamera) {
      this.camera.position.set(
        0,
        cameraY - this.relationshipWarmth * 0.025,
        baseZ - this.relationshipWarmth * closeOffset,
      );
      this.camera.lookAt(0, lookY + this.relationshipWarmth * 0.025, 0);
    }
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
    this.updateIdleMotion(delta);
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
    if (this.contactShadow) {
      this.scene.remove(this.contactShadow);
      this.contactShadow.geometry.dispose();
      const mat = this.contactShadow.material as THREE.MeshBasicMaterial;
      mat.map?.dispose(); // Material.dispose() はテクスチャを破棄しないので明示的に
      mat.dispose();
      this.contactShadow = null;
    }
    this.renderer.dispose();
  }
}
