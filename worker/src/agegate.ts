/** 年齢ゲート — 自己申告DOBからのage_band判定とサーバ権威の購入可否ゲート。
 *
 * band はクライアント送信値を信頼せず必ずサーバがDOBから計算する(このファイルの責務)。
 * 未登録ユーザーは最も制限的に扱う(assertPurchasable側でのfail-safe)。
 * 詳細設計: dev-notes/monetization_auth_and_safety_2026-07-20.md §2.1 */

import { ValueError } from "./auth";
import { errorDetail } from "./util";
import type { Store } from "./db";

export type AgeBand = "under13" | "minor" | "adult";

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** "YYYY-MM-DD" をUTC日付として厳密パースする(暦として不正な日付は拒否)。 */
function parseStrictDate(value: string): Date {
  const m = DATE_RE.exec(value);
  if (!m) throw new ValueError("生年月日の形式が正しくありません(YYYY-MM-DD)");
  const [, y, mo, d] = m;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const date = new Date(Date.UTC(year, month - 1, day));
  // Date.UTCは範囲外(例: 2月30日)を繰り上げてしまうため、往復させて一致を確認する
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new ValueError("存在しない日付です");
  }
  return date;
}

/** 生年月日(JST基準)から age_band を計算する。today省略時はサーバ現在時刻(呼び出し側でjstNow()等を渡す)。 */
export function computeAgeBand(birthDate: string, today: Date): AgeBand {
  const birth = parseStrictDate(birthDate);
  if (birth.getTime() > today.getTime()) {
    throw new ValueError("生年月日が未来の日付です");
  }
  let age = today.getUTCFullYear() - birth.getUTCFullYear();
  const monthDiff = today.getUTCMonth() - birth.getUTCMonth();
  const dayDiff = today.getUTCDate() - birth.getUTCDate();
  if (monthDiff < 0 || (monthDiff === 0 && dayDiff < 0)) {
    age -= 1; // 今年の誕生日がまだ来ていない
  }
  if (age < 13) return "under13";
  if (age < 18) return "minor";
  return "adult";
}

/** 課金系エンドポイントの入口で必ず呼ぶサーバ権威ゲート。未登録/非adultは403。 */
export async function assertPurchasable(store: Store, uid: string): Promise<Response | null> {
  const age = await store.getUserAge(uid);
  if (!age || age.age_band !== "adult") {
    return errorDetail("age_restricted", 403);
  }
  return null;
}
