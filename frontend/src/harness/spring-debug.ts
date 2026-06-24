/**
 * トラックC(髪・スカートの胴体貫通)検証用の dev 専用ハーネス。本番には含めない。
 * CompanionViewer を debugFreeCamera で起動し、OrbitControls で多角度に回しながら、
 * スプリングボーンの関節(VRMSpringBoneJointHelper)と実行時生成した胴体カプセルコライダー
 * (VRMSpringBoneColliderHelper)を可視化して、コライダーの配置・採寸と貫通の軽減を確認する。
 *
 * 使い方: `npm run build:harness` → `cd public && python3 -m http.server 8099` →
 *   http://localhost:8099/harness/spring-debug.html を開く(or Playwright で操作)。
 * Playwright/コンソールからは window.__harness.* で角度・モーション・ヘルパー表示を制御できる。
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { VRMSpringBoneColliderHelper, VRMSpringBoneJointHelper } from '@pixiv/three-vrm';
import { CompanionViewer } from '../features/vrm/viewer';
import type { Emotion } from '../features/chat/types';

interface HarnessApi {
  ready: boolean;
  /** 方位角(度)。0=正面、90=右真横、180=背面。仰角・距離は維持。 */
  setAzimuth(deg: number): void;
  /** 待機モーションを切り替えて髪/スカートを揺らす(emotion→.vrma マッピング)。 */
  playEmotion(emotion: Emotion): void;
  /** Helper表示切替。kind未指定で両方。'collider'=胴体カプセル, 'joint'=髪関節。 */
  toggleHelpers(visible: boolean, kind?: 'collider' | 'joint'): void;
  /** 検出された髪/スカート関節のボーン名(採寸・命名検証のため)。 */
  jointBoneNames: string[];
  /** 生成された胴体コライダー名。 */
  colliderNames: string[];
  /** コライダーのワールド座標とモデルのbounding boxを返す(数値で採寸を確認するため)。 */
  measure(): {
    modelBox: { min: number[]; max: number[] };
    colliders: Array<{ name: string; world: number[]; radius: number }>;
  };
  /** 現在のフレームを PNG data URL で返す(MCPスクショが不安定なため確実な取得手段)。 */
  snapshot(): string;
}

declare global {
  interface Window {
    __harness?: HarnessApi;
    __viewer?: CompanionViewer;
  }
}

const TARGET = new THREE.Vector3(0, 0.9, 0);

function boot(): void {
  const canvas = document.getElementById('avatar-canvas') as HTMLCanvasElement | null;
  if (!canvas) throw new Error('avatar-canvas not found');

  const viewer = new CompanionViewer(canvas, {
    modelUrl: '/models/shiro.vrm',
    fallbackModelUrl: '/models/shiro.vrm',
    debugFreeCamera: true,
    // 全身が入る引き構図(OrbitControls の初期位置)。
    cameraPosition: { x: 0, y: 1.0, z: 2.7 },
    cameraLookAt: { x: 0, y: 0.9, z: 0 },
  });
  window.__viewer = viewer;

  viewer
    .load()
    .then(() => {
      const h = viewer.getDebugHandles();

      const controls = new OrbitControls(h.camera, h.renderer.domElement);
      controls.target.copy(TARGET);
      controls.update();

      // コライダーHelperは不透明ボディの内側にあるため、深度テストを無効化して前面に描画し、
      // ボディのシルエットに重ねて位置・半径を確認できるようにする(緑)。
      const drawThrough = (obj: THREE.Object3D, color: number): void => {
        obj.renderOrder = 999;
        obj.traverse((child) => {
          const mat = (child as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
          const mats = Array.isArray(mat) ? mat : mat ? [mat] : [];
          for (const m of mats) {
            (m as THREE.LineBasicMaterial).depthTest = false;
            m.depthWrite = false;
            const colored = m as unknown as { color?: THREE.Color };
            if (colored.color) colored.color.setHex(color);
          }
        });
      };

      const colliderHelpers: THREE.Object3D[] = [];
      for (const collider of h.torsoColliders) {
        const helper = new VRMSpringBoneColliderHelper(collider);
        drawThrough(helper, 0x33ff88);
        h.scene.add(helper);
        colliderHelpers.push(helper);
      }
      const jointHelpers: THREE.Object3D[] = [];
      for (const joint of h.hairJoints) {
        const helper = new VRMSpringBoneJointHelper(joint);
        drawThrough(helper, 0xff5577);
        h.scene.add(helper);
        jointHelpers.push(helper);
      }
      // 既定は関節Helperを隠し、コライダーだけ表示(採寸が見やすい)。
      for (const helper of jointHelpers) helper.visible = false;

      const setAzimuth = (deg: number): void => {
        const radius = h.camera.position.distanceTo(controls.target);
        const rad = (deg * Math.PI) / 180;
        const y = h.camera.position.y;
        h.camera.position.set(
          controls.target.x + radius * Math.sin(rad),
          y,
          controls.target.z + radius * Math.cos(rad),
        );
        h.camera.lookAt(controls.target);
        controls.update();
      };

      window.__harness = {
        ready: true,
        setAzimuth,
        playEmotion: (emotion) => viewer.setEmotion(emotion),
        toggleHelpers: (visible, kind) => {
          if (kind !== 'joint') for (const helper of colliderHelpers) helper.visible = visible;
          if (kind !== 'collider') for (const helper of jointHelpers) helper.visible = visible;
        },
        jointBoneNames: h.hairJoints.map((joint) => joint.bone.name),
        colliderNames: h.torsoColliders.map((collider) => collider.name),
        snapshot: () => (h.renderer.domElement as HTMLCanvasElement).toDataURL('image/png'),
        measure: () => {
          const box = new THREE.Box3().setFromObject(h.vrm!.scene);
          const v = new THREE.Vector3();
          return {
            modelBox: { min: box.min.toArray(), max: box.max.toArray() },
            colliders: h.torsoColliders.map((collider) => {
              collider.updateWorldMatrix(true, false);
              v.setFromMatrixPosition(collider.matrixWorld);
              const shape = collider.shape as unknown as { radius: number };
              return { name: collider.name, world: v.toArray(), radius: shape.radius };
            }),
          };
        },
      };
      document.title = 'harness-ready';
    })
    .catch((error) => {
      document.title = `harness-error:${String(error)}`;
    });
}

if (document.readyState === 'complete' || document.readyState === 'interactive') {
  boot();
} else {
  document.addEventListener('DOMContentLoaded', boot);
}
