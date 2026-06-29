/** 初見ユーザー判定(端末ローカル)。初回の挨拶を「自己紹介+話しかけての誘い」に
 *  寄せるためだけに使う軽量フラグ。サーバ不要・localStorage のみ。
 *  プライベートモード等で localStorage が使えなくても会話自体は成立するよう安全に倒す。 */
const ONBOARDED_KEY = 'aikata_onboarded';
const ONBOARDING_STEP_KEY = 'aikata_onboarding_step';

/** オンボーディングの進行段階。0=未開始, 1=ウェルカム, 2=名前入力, 3=ヒント, 4=完了 */
export type OnboardingStep = 0 | 1 | 2 | 3 | 4;

/** この端末でまだオンボーディング挨拶を出していなければ true。 */
export function isFirstVisit(): boolean {
  try {
    return window.localStorage.getItem(ONBOARDED_KEY) !== '1';
  } catch {
    // localStorage 不可なら初回演出はスキップ(毎回「はじめまして」を出す過剰干渉を避ける)
    return false;
  }
}

/** オンボーディング挨拶を出し終えたことを記録する(以後は通常の挨拶に戻る)。 */
export function markOnboarded(): void {
  try {
    window.localStorage.setItem(ONBOARDED_KEY, '1');
  } catch {
    // 保存できなくても致命的でないため黙って続行
  }
}

/** 現在のオンボーディング段階を返す。
 *  既にオンボーディング済みなら 4 を返す。localStorage 不可なら 0。 */
export function getOnboardingStep(): OnboardingStep {
  try {
    if (!isFirstVisit()) return 4;
    const raw = window.localStorage.getItem(ONBOARDING_STEP_KEY);
    const step = raw !== null ? Number(raw) : 0;
    return (step >= 0 && step <= 4 ? step : 0) as OnboardingStep;
  } catch {
    return 0;
  }
}

/** オンボーディングの段階を保存する。 */
export function advanceOnboardingStep(step: OnboardingStep): void {
  try {
    window.localStorage.setItem(ONBOARDING_STEP_KEY, String(step));
  } catch {
    // 保存できなくても致命的でないため黙って続行
  }
}

/** オンボーディング完了処理。段階を 4 に設定し、旧フラグも書き込む。 */
export function completeOnboarding(): void {
  advanceOnboardingStep(4);
  markOnboarded();
}

/** オンボーディングが完了していれば true。 */
export function isOnboardingComplete(): boolean {
  try {
    return !isFirstVisit() || getOnboardingStep() >= 4;
  } catch {
    return false;
  }
}

/** 両キーを削除してオンボーディング状態をリセット(テスト/デバッグ用)。 */
export function resetOnboarding(): void {
  try {
    window.localStorage.removeItem(ONBOARDED_KEY);
    window.localStorage.removeItem(ONBOARDING_STEP_KEY);
  } catch {
    // 削除失敗も致命的でないため黙って続行
  }
}
