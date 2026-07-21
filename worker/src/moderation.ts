/** チャット入出力の一次防御モデレーション。
 *
 * Cloudflare Workers無料枠(1リクエストCPU 10ms、auth.ts冒頭コメント参照)では重い分類モデルを
 * 同期経路で呼べないため、正規表現ベースの一次防御 + システムプロンプト制約(persona.ts)を主軸にする。
 * 外部モデレーションAPIは使うとしても ctx.waitUntil の背景ジョブに限定する(index.ts側の責務)。
 *
 * 語彙リストはv1の最小実装。過剰ブロック/見逃しのバランスは実データで調整する前提。
 * 詳細設計: dev-notes/monetization_auth_and_safety_2026-07-20.md §2.2 */

export type ModerationAction = "allow" | "refuse" | "crisis";

export interface ModerationResult {
  action: ModerationAction;
  category?: string;
}

export interface ModerationOpts {
  minor: boolean;
}

// 自傷・希死念慮。冷たく拒否するのではなく、呼び出し側がキャラのまま寄り添う応答+相談窓口を返す
// 「crisis」として扱う(refuseとは別の特別対応)。
const CRISIS_RE =
  /死にたい|自殺し|消えたい|リストカット|リスカ|首を?吊|飛び降り自殺|オーバードーズ|OD(しよう|したい)|生きる意味がない/;

// 性的に露骨な要求。全年齢で拒否対象。
const EXPLICIT_SEXUAL_RE =
  /エッチな話|セックスし|性行為|裸(の写真|になって)|オナニー|射精|挿入して|下着(の写真|を見せ)/;

// 恋愛的な誘い。成人には許容するが、未成年には拒否する(推し活/相棒ポジショニングと未成年保護の両立)。
const MINOR_ROMANTIC_RE = /付き合って(ほしい|くれ)|彼女になって|彼氏になって|キスして|デートしよう/;

function classify(text: string, opts: ModerationOpts): ModerationResult {
  if (CRISIS_RE.test(text)) return { action: "crisis", category: "self_harm" };
  if (EXPLICIT_SEXUAL_RE.test(text)) return { action: "refuse", category: "sexual" };
  if (opts.minor && MINOR_ROMANTIC_RE.test(text)) return { action: "refuse", category: "romantic_minor" };
  return { action: "allow" };
}

/** ユーザー入力の事前スクリーニング。refuse/crisisはLLMへ送らず呼び出し側が即応答する。 */
export function screenUserInput(text: string, opts: ModerationOpts): ModerationResult {
  return classify(text, opts);
}

const SAFE_FALLBACK_REPLY = "……ごめん、その話はできないな。でも、ちゃんと聞いてるよ。";

// crisis(自傷/希死念慮)応答はLLM生成に任せず固定文にする ―― 内容の安全性(相談窓口の
// 掲載漏れ・不適切なトーン化)を確実に保証するため。電話番号は2026-07-20時点で確認済みの
// 公的相談窓口(いのちの電話・よりそいホットライン)。長期運用では定期的な実在確認が必要。
export function crisisSupportReply(): string {
  return (
    "……そっか、そんな気持ちになってるんだね。ちゃんと聞いてるよ、ひとりで抱えなくていい。\n" +
    "つらい時に話せるところがあるから、よかったら頼ってほしい。\n" +
    "いのちの電話: 0570-783-556(毎日16時〜21時)\n" +
    "よりそいホットライン: 0120-279-338(24時間無料・通話無料)"
  );
}

/** LLM出力の事後フィルタ。chat.tsの既存チャンク整形フック(sanitizeFourthWall等)に相乗りする。 */
export function redactDisallowed(text: string, opts: ModerationOpts): { clean: string; blocked: boolean } {
  const result = classify(text, opts);
  if (result.action === "refuse") {
    return { clean: SAFE_FALLBACK_REPLY, blocked: true };
  }
  return { clean: text, blocked: false };
}
