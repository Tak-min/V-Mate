/** 初見ユーザー判定(端末ローカル)。初回の挨拶を「自己紹介+話しかけての誘い」に
 *  寄せるためだけに使う軽量フラグ。サーバ不要・localStorage のみ。
 *  プライベートモード等で localStorage が使えなくても会話自体は成立するよう安全に倒す。 */
const ONBOARDED_KEY = 'aikata_onboarded';

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
