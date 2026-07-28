/**
 * タップ反応・ステージアップ演出・お帰り演出が共有する「反応プリセット」の定義と、
 * それを選ぶ/時間で減衰させるための純粋関数。CompanionViewer(viewer.ts)は既存の
 * 単一責務な update*() 群(表情/カメラ/姿勢)へこのモジュールの出力を加算値として
 * 供給するだけで、状態の書き込み元は従来どおり viewer.ts 側に一本化する。
 */

export type ReactionRegion = 'head' | 'body';
export type ReactionPoolKey = 'head' | 'body' | 'celebrate' | 'welcome';
type ExpressionName = 'happy' | 'sad' | 'angry' | 'relaxed';

export interface ReactionPreset {
  id: string;
  /** 表情ウェイトへの加算量(ピーク時)。既存の targetWeights とは別経路で加算する。 */
  expr: Partial<Record<ExpressionName, number>>;
  /** カメラを寄せる距離(m)。負値は逆に遠ざかる("びっくりして少し引く"等)。 */
  cameraDolly: number;
  /** 上下バウンス量(m)。 */
  bounceY: number;
  /** カメラ側への前傾量(rad)。 */
  leanX: number;
  /** 反応の継続時間(秒)。 */
  duration: number;
  /** true の場合、反応開始と同時に二重瞬きクラスタを予約する。 */
  blinkCluster: boolean;
}

const HEAD_REACTIONS: ReactionPreset[] = [
  {
    id: 'head-blink-surprise',
    expr: { happy: 0.28, relaxed: 0.06 },
    cameraDolly: 0.05,
    bounceY: 0.012,
    leanX: -0.02,
    duration: 0.9,
    blinkCluster: true,
  },
  {
    id: 'head-shy-smile',
    expr: { happy: 0.22, sad: 0.15, relaxed: 0.08 },
    cameraDolly: 0.03,
    bounceY: 0.008,
    leanX: -0.015,
    duration: 1.1,
    blinkCluster: true,
  },
  {
    id: 'head-happy-nuzzle',
    expr: { happy: 0.42, relaxed: 0.1 },
    cameraDolly: 0.06,
    bounceY: 0.014,
    leanX: -0.01,
    duration: 1.0,
    blinkCluster: false,
  },
];

const BODY_REACTIONS: ReactionPreset[] = [
  {
    id: 'body-giggle',
    expr: { happy: 0.5 },
    cameraDolly: 0.04,
    bounceY: 0.03,
    leanX: 0.012,
    duration: 0.85,
    blinkCluster: false,
  },
  {
    id: 'body-startle',
    expr: { angry: 0.05, relaxed: 0.04 },
    cameraDolly: -0.035,
    bounceY: 0.02,
    leanX: 0.02,
    duration: 0.75,
    blinkCluster: true,
  },
  {
    id: 'body-content-sway',
    expr: { relaxed: 0.3, happy: 0.12 },
    cameraDolly: 0.02,
    bounceY: 0.01,
    leanX: 0.008,
    duration: 1.2,
    blinkCluster: false,
  },
];

const CELEBRATE_REACTIONS: ReactionPreset[] = [
  {
    id: 'celebrate-warm',
    expr: { happy: 0.9, relaxed: 0.15 },
    cameraDolly: 0.18,
    bounceY: 0.05,
    leanX: 0.022,
    duration: 2.2,
    blinkCluster: true,
  },
  {
    id: 'celebrate-bright',
    expr: { happy: 0.95, relaxed: 0.08 },
    cameraDolly: 0.16,
    bounceY: 0.06,
    leanX: 0.018,
    duration: 2.0,
    blinkCluster: true,
  },
];

const WELCOME_REACTIONS: ReactionPreset[] = [
  {
    id: 'welcome-soft',
    expr: { happy: 0.3, relaxed: 0.2 },
    cameraDolly: 0.08,
    bounceY: 0.02,
    leanX: 0.01,
    duration: 2.0,
    blinkCluster: true,
  },
  {
    id: 'welcome-bright',
    expr: { happy: 0.38, relaxed: 0.12 },
    cameraDolly: 0.09,
    bounceY: 0.024,
    leanX: 0.012,
    duration: 1.8,
    blinkCluster: true,
  },
];

export const REACTION_PRESETS: Record<ReactionPoolKey, ReactionPreset[]> = {
  head: HEAD_REACTIONS,
  body: BODY_REACTIONS,
  celebrate: CELEBRATE_REACTIONS,
  welcome: WELCOME_REACTIONS,
};

export function poolForRegion(region: ReactionRegion): ReactionPreset[] {
  return REACTION_PRESETS[region];
}

/** 直前と同じ反応が連続しないよう、候補が2つ以上あれば lastId を除外して選ぶ。 */
export function chooseReaction(pool: readonly ReactionPreset[], lastId: string | null): ReactionPreset {
  const candidates = pool.length > 1 ? pool.filter((preset) => preset.id !== lastId) : pool;
  const source = candidates.length > 0 ? candidates : pool;
  return source[Math.floor(Math.random() * source.length)];
}

/** 元プリセットを変更せず、強度だけをスケールした新しいプリセットを返す(不変更新)。 */
export function scalePreset(preset: ReactionPreset, scale: number): ReactionPreset {
  const clampedScale = Math.min(Math.max(scale, 0), 1.4);
  const scaledExpr = Object.fromEntries(
    Object.entries(preset.expr).map(([name, weight]) => [name, (weight ?? 0) * clampedScale]),
  ) as ReactionPreset['expr'];
  return {
    ...preset,
    expr: scaledExpr,
    cameraDolly: preset.cameraDolly * clampedScale,
    bounceY: preset.bounceY * clampedScale,
    leanX: preset.leanX * clampedScale,
  };
}

const ATTACK_FRACTION = 0.22;

function easeOutCubic(t: number): number {
  return 1 - (1 - t) ** 3;
}

function easeInOutSine(t: number): number {
  return -(Math.cos(Math.PI * t) - 1) / 2;
}

/**
 * 反応の進行度(0..1)を「立ち上がりは速く、収まりはゆっくり」な強度(0..1)に変換する。
 * 瞬きの開閉カーブ(viewer.ts の updateBlink)と同じ非対称エンベロープの考え方を踏襲。
 */
export function reactionEnvelope(progress01: number): number {
  const p = Math.min(Math.max(progress01, 0), 1);
  if (p < ATTACK_FRACTION) return easeOutCubic(p / ATTACK_FRACTION);
  return 1 - easeInOutSine((p - ATTACK_FRACTION) / (1 - ATTACK_FRACTION));
}
