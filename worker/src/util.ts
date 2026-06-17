/** 時刻・SSE・HTTP の小さなヘルパ群。
 *
 * 時刻は JST(UTC+9)で扱う。元の Python 実装が naive な現地時刻(datetime.now())で
 * 「その日最初の会話」「日記の日付」「時間帯あいさつ」を判定していたため、
 * エッジ(UTC)でも同じ体感になるよう JST に固定する。 */

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** JST の「いま」を表す Date(getUTC* で各成分を読むと JST 値になる)。 */
export function jstNow(): Date {
  return new Date(Date.now() + JST_OFFSET_MS);
}

/** JST の今日 "YYYY-MM-DD"。 */
export function jstToday(): string {
  return jstNow().toISOString().slice(0, 10);
}

/** JST の現在時刻を秒精度の ISO ("YYYY-MM-DDTHH:MM:SS") で。created_at / last_seen 用。 */
export function jstIso(): string {
  return jstNow().toISOString().slice(0, 19);
}

/** ISO 文字列(秒精度)から日数差(おおよそ)を返す。last_seen の経過日数判定用。 */
export function daysSince(iso: string): number {
  const then = new Date(iso + (iso.length <= 19 ? "Z" : "")).getTime();
  const now = jstNow().getTime();
  return Math.floor((now - then) / (24 * 60 * 60 * 1000));
}

/** "YYYY-MM-DDTHH:MM:SS"(JST)を「現在は MM月DD日 HH:MM(時間帯)」に整形。 */
export function timeContext(): string {
  const d = jstNow();
  const mm = d.getUTCMonth() + 1;
  const dd = d.getUTCDate();
  const hh = d.getUTCHours();
  const min = String(d.getUTCMinutes()).padStart(2, "0");
  let period: string;
  if (hh < 5) period = "深夜";
  else if (hh < 11) period = "朝";
  else if (hh < 17) period = "昼";
  else if (hh < 22) period = "夜";
  else period = "夜遅く";
  return `現在は${mm}月${dd}日 ${hh}:${min}(${period})。`;
}

// --- 感情タグ ---

export const EMOTION_TAG_RE = /\[(neutral|happy|sad|angry|relaxed|shy)\]/;
const EMOTION_TAG_RE_G = /\[(neutral|happy|sad|angry|relaxed|shy)\]/g;

/** 先頭の感情タグを抽出し、本文からすべてのタグを除去する。[emotion, cleaned] を返す。 */
export function stripEmotion(text: string): [string, string] {
  const m = text.match(EMOTION_TAG_RE);
  const emotion = m ? m[1] : "neutral";
  return [emotion, text.replace(EMOTION_TAG_RE_G, "").trim()];
}

/** 感情タグをすべて除去(本文整形用)。 */
export function stripTags(text: string): string {
  return text.replace(EMOTION_TAG_RE_G, "");
}

// --- SSE ---

/** 1 つの SSE イベントを "data: {json}\n\n" 形式にエンコードする。 */
export function sse(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

// --- HTTP ---

export function json(data: unknown, status = 200, extraHeaders?: HeadersInit): Response {
  const headers = new Headers(extraHeaders);
  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(data), { status, headers });
}

/** FastAPI 互換のエラー本文 {"detail": "..."}。フロントは data.detail を読む。 */
export function errorDetail(detail: string, status: number): Response {
  return json({ detail }, status);
}

/** Cookie ヘッダから 1 つの値を取り出す。 */
export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.get("Cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=");
  }
  return undefined;
}
