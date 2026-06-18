/** シロ(Aikata)バックエンド — Cloudflare Worker エントリ。backend/app/main.py の移植。
 *
 * /api/* を処理し、それ以外は ASSETS(ビルド済みフロント)へ委譲する(単一オリジン)。
 * 訪問者ごとに匿名 user_id を Cookie で発行・維持する。JWT があればアカウントID を優先。 */

import type { Env } from "./env";
import { Store } from "./db";
import * as auth from "./auth";
import { synthesize } from "./tts";
import { complete } from "./llm";
import { nudgePrompt, diaryPrompt } from "./persona";
import { handleChat, statePayload } from "./chat";
import {
  json,
  errorDetail,
  readCookie,
  stripEmotion,
  timeContext,
  jstToday,
  daysSince,
  secondsSince,
} from "./util";

const COOKIE_NAME = "aikata_uid";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365 * 2; // 2年
// AIが干渉しすぎる(リロードのたびに挨拶し直す等)との指摘を受けて追加。
// 直前の活動(last_seen)からこの秒数未満なら「戻ってきた」とみなさず挨拶を省略する。
const GREETING_MIN_GAP_SECONDS = 180;
const RESEARCH_CONDITIONS = ["text", "stylized", "realistic"] as const;
const RESEARCH_METRICS_VERSION = "2026-06-18-v1";
type ResearchCondition = (typeof RESEARCH_CONDITIONS)[number];

interface Ctx {
  env: Env;
  store: Store;
  execCtx: ExecutionContext;
  request: Request;
  uid: string; // 匿名Cookie ID(アカウントとは別。引き継ぎ判定に使う)
  isNewUid: boolean;
  secure: boolean;
}

/** 有効な JWT があればそのアカウントID、無ければ匿名Cookie ID を返す。 */
async function resolveUid(c: Ctx): Promise<string> {
  const header = c.request.headers.get("Authorization") ?? "";
  if (header.startsWith("Bearer ")) {
    const sub = await auth.decodeToken(header.slice("Bearer ".length), auth.jwtSecret(c.env.JWT_SECRET));
    if (sub) return sub;
  }
  return c.uid;
}

function clientIp(request: Request): string {
  return request.headers.get("CF-Connecting-IP") ?? "unknown";
}

function envInt(value: string | undefined, fallback: number): number {
  const n = parseInt(value ?? "", 10);
  return Number.isFinite(n) ? n : fallback;
}

function envBool(value: string | undefined, fallback: boolean): boolean {
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function isResearchCondition(value: unknown): value is ResearchCondition {
  return typeof value === "string" && (RESEARCH_CONDITIONS as readonly string[]).includes(value);
}

function defaultResearchCondition(uid: string): ResearchCondition {
  const n = parseInt(uid.slice(0, 2), 16);
  return RESEARCH_CONDITIONS[(Number.isFinite(n) ? n : uid.length) % RESEARCH_CONDITIONS.length];
}

async function researchCondition(c: Ctx, uid: string, requested?: unknown): Promise<ResearchCondition> {
  const allowOverride = envBool(c.env.RESEARCH_ALLOW_CONDITION_OVERRIDE, true);
  if (isResearchCondition(requested) && allowOverride) {
    await c.store.setKv(uid, "research_condition", requested);
    return requested;
  }
  const stored = await c.store.getKv(uid, "research_condition");
  if (isResearchCondition(stored)) return stored;
  const condition = defaultResearchCondition(uid);
  await c.store.setKv(uid, "research_condition", condition);
  return condition;
}

async function logResearchEvent(
  c: Ctx,
  uid: string,
  condition: string,
  eventType: string,
  payload: Record<string, unknown> = {},
): Promise<void> {
  const safeCondition = isResearchCondition(condition) ? condition : await researchCondition(c, uid);
  const body = { metrics_version: RESEARCH_METRICS_VERSION, ...payload };
  await c.store.addResearchEvent(uid, safeCondition, eventType, JSON.stringify(body));
}

// --- レート制限(チャット)---
async function enforceRateLimit(c: Ctx, uid: string): Promise<Response | null> {
  const day = jstToday();
  const perUser = envInt(c.env.RATE_PER_USER_PER_DAY, 50);
  const perGlobal = envInt(c.env.RATE_GLOBAL_PER_DAY, 800);
  if ((await c.store.bumpUsage(`user:${uid}`, day)) > perUser) {
    return errorDetail("今日はたくさん話したね。また明日ゆっくり話そう。", 429);
  }
  if ((await c.store.bumpUsage("global", day)) > perGlobal) {
    return errorDetail("今いろんな人がシロと話していて混み合ってるみたい。少し時間をおいてね。", 429);
  }
  return null;
}

// --- ハンドラ群 ---

async function authSignup(c: Ctx, body: { email?: unknown; password?: unknown }): Promise<Response> {
  const v = validateAuth(body);
  if (v) return v;
  try {
    const token = await auth.signup(
      c.store,
      auth.jwtSecret(c.env.JWT_SECRET),
      body.email as string,
      body.password as string,
      c.uid,
    );
    return json({ token });
  } catch (e) {
    if (e instanceof auth.ValueError) return errorDetail(e.message, 400);
    throw e;
  }
}

async function authLogin(c: Ctx, body: { email?: unknown; password?: unknown }): Promise<Response> {
  const v = validateAuth(body);
  if (v) return v;
  const perIp = envInt(c.env.RATE_LOGIN_PER_IP_PER_DAY, 30);
  if ((await c.store.bumpUsage(`login:${clientIp(c.request)}`, jstToday())) > perIp) {
    return errorDetail("ログイン試行が多すぎます。時間をおいて再度お試しください。", 429);
  }
  try {
    const token = await auth.login(
      c.store,
      auth.jwtSecret(c.env.JWT_SECRET),
      body.email as string,
      body.password as string,
    );
    return json({ token });
  } catch (e) {
    if (e instanceof auth.ValueError) return errorDetail(e.message, 401);
    throw e;
  }
}

function validateAuth(body: { email?: unknown; password?: unknown }): Response | null {
  const email = body.email;
  const password = body.password;
  if (typeof email !== "string" || email.length < 3 || email.length > 255) {
    return errorDetail("メールアドレスを正しく入力してください", 400);
  }
  if (typeof password !== "string" || password.length < 6 || password.length > 200) {
    return errorDetail("パスワードは6文字以上で入力してください", 400);
  }
  return null;
}

async function authMe(c: Ctx): Promise<Response> {
  const uid = await resolveUid(c);
  const user = await c.store.getUserById(uid);
  return json({ authenticated: user != null, email: user ? user.email : null });
}

async function getState(c: Ctx): Promise<Response> {
  return json(await statePayload(c.store, c.env, await resolveUid(c)));
}

async function setProfile(c: Ctx, body: { user_name?: unknown }): Promise<Response> {
  const name = typeof body.user_name === "string" ? body.user_name.trim() : "";
  if (!name || name.length > 40) return errorDetail("名前は1〜40文字で入力してください", 400);
  const uid = await resolveUid(c);
  await c.store.setKv(uid, "user_name", name);
  await c.store.addFact(uid, `名前(呼び方)は「${name}」`);
  return json(await statePayload(c.store, c.env, uid));
}

async function getHistory(c: Ctx): Promise<Response> {
  const limit = envInt(new URL(c.request.url).searchParams.get("limit") ?? "30", 30);
  const rows = await c.store.recentMessages(await resolveUid(c), Math.min(limit, 100));
  return json(rows);
}

async function postChat(c: Ctx, body: { message?: unknown; condition?: unknown }): Promise<Response> {
  const message = body.message;
  if (typeof message !== "string" || message.length < 1 || message.length > 2000) {
    return errorDetail("メッセージは1〜2000文字で入力してください", 400);
  }
  const uid = await resolveUid(c);
  const limited = await enforceRateLimit(c, uid);
  if (limited) return limited;
  const condition = await researchCondition(c, uid, body.condition);
  return handleChat(c.env, c.store, c.execCtx, uid, message, condition);
}

async function researchSession(c: Ctx, body: { condition?: unknown; source?: unknown }): Promise<Response> {
  const uid = await resolveUid(c);
  const condition = await researchCondition(c, uid, body.condition);
  await logResearchEvent(c, uid, condition, "session_start", {
    source: typeof body.source === "string" ? body.source.slice(0, 64) : "app",
    override_requested: isResearchCondition(body.condition) ? body.condition : null,
    override_allowed: envBool(c.env.RESEARCH_ALLOW_CONDITION_OVERRIDE, true),
  });
  return json({
    condition,
    conditions: RESEARCH_CONDITIONS,
    metrics_version: RESEARCH_METRICS_VERSION,
  });
}

async function researchEvent(
  c: Ctx,
  body: { condition?: unknown; event_type?: unknown; payload?: unknown },
): Promise<Response> {
  const uid = await resolveUid(c);
  const condition = await researchCondition(c, uid, body.condition);
  const eventType =
    typeof body.event_type === "string" && body.event_type.length <= 64
      ? body.event_type
      : "client_event";
  const payload = body.payload && typeof body.payload === "object" ? (body.payload as Record<string, unknown>) : {};
  await logResearchEvent(c, uid, condition, eventType, payload);
  return json({ ok: true });
}

async function researchExport(c: Ctx): Promise<Response> {
  const token = c.request.headers.get("X-Research-Export-Token") ?? "";
  if (!c.env.RESEARCH_EXPORT_TOKEN || token !== c.env.RESEARCH_EXPORT_TOKEN) {
    return errorDetail("research export disabled", 403);
  }
  const limit = Math.min(Math.max(envInt(new URL(c.request.url).searchParams.get("limit") ?? "500", 500), 1), 5000);
  return json(await c.store.listResearchEvents(await resolveUid(c), limit));
}

async function postNudge(c: Ctx, body: { reason?: unknown }): Promise<Response> {
  const reason = body.reason === "greeting" ? "greeting" : "idle";
  const uid = await resolveUid(c);
  const lastSeen = await c.store.getKv(uid, "last_seen");
  const userName = await c.store.getKv(uid, "user_name");
  const nameNote = userName
    ? `相手の名前は「${userName}」。`
    : "相手の名前はまだ知らない(「ユーザーさん」のような呼び方はせず、名前を呼ばずに話す)。";

  let context: string;
  if (reason === "greeting") {
    if (lastSeen && secondsSince(lastSeen) < GREETING_MIN_GAP_SECONDS) {
      // ついさっき(リロード等)開いただけ。毎回挨拶し直すと干渉しすぎになるので省略する。
      await c.store.touchLastSeen(uid);
      return json({ text: "", emotion: "neutral" });
    }
    let gap = "";
    if (lastSeen) {
      const days = daysSince(lastSeen);
      if (days >= 2) gap = `ユーザーと会うのは約${days}日ぶり。`;
    }
    context = `${timeContext()}${nameNote}${gap}ユーザーがアプリを開いて現れたところ。挨拶する。`;
  } else {
    context = `${timeContext()}${nameNote}会話が途切れて少し時間が経った。`;
  }
  const facts = await c.store.listFacts(uid, 8);
  if (facts.length) context += "覚えていること: " + facts.join(" / ");

  let raw: string;
  try {
    raw = await complete(c.env, nudgePrompt(context));
  } catch {
    return json({ text: "", emotion: "neutral" });
  }
  const [emotion, text] = stripEmotion(raw);
  if (text) await c.store.addMessage(uid, "assistant", text, emotion);
  await c.store.touchLastSeen(uid);
  return json({ text, emotion });
}

async function getDiary(c: Ctx): Promise<Response> {
  const uid = await resolveUid(c);
  const today = jstToday();
  const canGenerate =
    !(await c.store.hasDiary(uid, today)) && (await c.store.messagesOn(uid, today)).length >= 4;
  return json({ entries: await c.store.listDiary(uid), can_generate_today: canGenerate });
}

async function generateDiary(c: Ctx): Promise<Response> {
  const uid = await resolveUid(c);
  const today = jstToday();
  const msgs = await c.store.messagesOn(uid, today);
  if (msgs.length < 4) return json({ ok: false, reason: "今日はまだ会話が少ないみたい。" });
  const conversation = msgs
    .slice(-60)
    .map((m) => `${m.role === "user" ? "ユーザー" : "シロ"}: ${m.content}`)
    .join("\n");
  const userName = (await c.store.getKv(uid, "user_name")) || "ユーザー";
  const content = stripEmotion(await complete(c.env, diaryPrompt(userName, conversation)))[1];
  await c.store.addDiary(uid, today, content);
  return json({ ok: true, entry: { entry_date: today, content } });
}

async function getTts(c: Ctx): Promise<Response> {
  const enabled = ["1", "true", "yes", "on"].includes((c.env.ENABLE_TTS ?? "false").toLowerCase());
  if (!enabled) return new Response(null, { status: 204 });
  const url = new URL(c.request.url);
  const text = url.searchParams.get("text") ?? "";
  const emotion = url.searchParams.get("emotion");
  const audio = await synthesize(c.env, text.slice(0, 300), emotion);
  if (!audio) return new Response(null, { status: 204 });
  return new Response(audio, { headers: { "Content-Type": "audio/mpeg" } });
}

// --- ルーティング ---

async function route(c: Ctx): Promise<Response> {
  const url = new URL(c.request.url);
  const path = url.pathname;
  const method = c.request.method;

  // GET
  if (method === "GET") {
    if (path === "/api/auth/me") return authMe(c);
    if (path === "/api/state") return getState(c);
    if (path === "/api/history") return getHistory(c);
    if (path === "/api/diary") return getDiary(c);
    if (path === "/api/tts") return getTts(c);
    if (path === "/api/research/export") return researchExport(c);
    return errorDetail("Not Found", 404);
  }

  // POST(JSON ボディ)
  if (method === "POST") {
    const body = await readJson(c.request);
    if (path === "/api/auth/signup") return authSignup(c, body);
    if (path === "/api/auth/login") return authLogin(c, body);
    if (path === "/api/profile") return setProfile(c, body);
    if (path === "/api/chat") return postChat(c, body);
    if (path === "/api/research/session") return researchSession(c, body);
    if (path === "/api/research/event") return researchEvent(c, body);
    if (path === "/api/nudge") return postNudge(c, body);
    if (path === "/api/diary/generate") return generateDiary(c);
    return errorDetail("Not Found", 404);
  }

  return errorDetail("Method Not Allowed", 405);
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const data = await request.json();
    return data && typeof data === "object" ? (data as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export default {
  async fetch(request: Request, env: Env, execCtx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // /api 以外は静的アセット(ビルド済みフロント)へ。run_worker_first で /api/* のみ Worker が先行。
    if (!url.pathname.startsWith("/api/")) {
      return env.ASSETS.fetch(request);
    }

    // 訪問者ごとに匿名 user_id を Cookie で発行・維持(各ブラウザ=別シロ)
    let uid = readCookie(request, COOKIE_NAME);
    const isNewUid = !uid;
    if (!uid) uid = crypto.randomUUID().replace(/-/g, "");

    const c: Ctx = {
      env,
      store: new Store(env.DB),
      execCtx,
      request,
      uid,
      isNewUid,
      secure: url.protocol === "https:",
    };

    let response: Response;
    try {
      response = await route(c);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "internal error";
      response = errorDetail(`サーバーエラー: ${msg}`, 500);
    }

    // 新規 uid なら Set-Cookie を付与(ストリーミング応答でもヘッダを引き継ぐ)
    if (isNewUid) {
      const headers = new Headers(response.headers);
      const secure = c.secure ? "; Secure" : "";
      headers.append(
        "Set-Cookie",
        `${COOKIE_NAME}=${uid}; Max-Age=${COOKIE_MAX_AGE}; Path=/; HttpOnly; SameSite=Lax${secure}`,
      );
      response = new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }
    return response;
  },
} satisfies ExportedHandler<Env>;
