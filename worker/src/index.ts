/** シロ(Aikata)バックエンド — Cloudflare Worker エントリ。backend/app/main.py の移植。
 *
 * /api/* を処理し、それ以外は ASSETS(ビルド済みフロント)へ委譲する(単一オリジン)。
 * 訪問者ごとに匿名 user_id を Cookie で発行・維持する。JWT があればアカウントID を優先。 */

import type { Env } from "./env";
import { Store } from "./db";
import * as auth from "./auth";
import { AppleTokenError, verifyAppleIdentityToken } from "./apple_auth";
import { AppleTransactionError, applyAppleTransaction, appleRootCaG3, verifySignedTransaction } from "./apple_store";
import { synthesize } from "./tts";
import { complete } from "./llm";
import { nudgePrompt, diaryPrompt } from "./persona";
import { handleChat, statePayload } from "./chat";
import { computeAgeBand } from "./agegate";
import { assertPurchasable } from "./agegate";
import { CATALOG } from "./catalog";
import {
  json,
  errorDetail,
  readCookie,
  stripEmotion,
  timeContext,
  jstToday,
  jstNow,
  daysSince,
  secondsSince,
} from "./util";

const COOKIE_NAME = "aikata_uid";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365 * 2; // 2年
// AIが干渉しすぎる(リロードのたびに挨拶し直す等)との指摘を受けて追加。
// 直前の活動(last_seen)からこの秒数未満なら「戻ってきた」とみなさず挨拶を省略する。
const GREETING_MIN_GAP_SECONDS = 180;

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

async function authApple(c: Ctx, body: { identity_token?: unknown; nonce?: unknown }): Promise<Response> {
  if (typeof body.identity_token !== "string" || body.identity_token.length > 12_000 || typeof body.nonce !== "string" || body.nonce.length < 16 || body.nonce.length > 256) {
    return errorDetail("Apple の認証情報が不正です", 400);
  }
  const perIp = envInt(c.env.RATE_LOGIN_PER_IP_PER_DAY, 30);
  if ((await c.store.bumpUsage(`login:${clientIp(c.request)}`, jstToday())) > perIp) {
    return errorDetail("ログイン試行が多すぎます。時間をおいて再度お試しください。", 429);
  }
  try {
    const identity = await verifyAppleIdentityToken(body.identity_token, c.env.APPLE_BUNDLE_ID ?? "com.takmin.vmate", body.nonce);
    const token = await auth.loginWithApple(c.store, auth.jwtSecret(c.env.JWT_SECRET), identity, c.uid);
    return json({ token });
  } catch (error) {
    if (error instanceof AppleTokenError || error instanceof auth.ValueError) return errorDetail(error.message, 401);
    throw error;
  }
}

async function authDelete(c: Ctx): Promise<Response> {
  const header = c.request.headers.get("Authorization") ?? "";
  if (!header.startsWith("Bearer ")) return errorDetail("ログインが必要です", 401);
  const userId = await auth.decodeToken(header.slice("Bearer ".length), auth.jwtSecret(c.env.JWT_SECRET));
  if (!userId || !(await c.store.getUserById(userId))) return errorDetail("ログインが必要です", 401);
  await c.store.deleteAccount(userId);
  return json({ ok: true });
}

/** 匿名 Cookie では権利 API に到達させない。購入復元可能な P1 アカウントが必須。 */
async function requireAuthenticatedUid(c: Ctx): Promise<string | null> {
  const header = c.request.headers.get("Authorization") ?? "";
  if (!header.startsWith("Bearer ")) return null;
  const userId = await auth.decodeToken(header.slice("Bearer ".length), auth.jwtSecret(c.env.JWT_SECRET));
  return userId && (await c.store.getUserById(userId)) ? userId : null;
}

async function requirePurchasableAccount(c: Ctx): Promise<string | Response> {
  const userId = await requireAuthenticatedUid(c);
  if (!userId) return errorDetail("ログインが必要です", 403);
  return (await assertPurchasable(c.store, userId)) ?? userId;
}

async function getEntitlements(c: Ctx): Promise<Response> {
  const account = await requirePurchasableAccount(c);
  if (account instanceof Response) return account;
  return json({ entitlements: await c.store.getActiveEntitlements(account) });
}

async function getCatalog(c: Ctx): Promise<Response> {
  const account = await requirePurchasableAccount(c);
  if (account instanceof Response) return account;
  return json({ items: CATALOG.map(({ id, entitlementKey, kind, name, description }) => ({ id, entitlement_key: entitlementKey, kind, name, description })) });
}

function iapEnabled(c: Ctx): boolean {
  return ["1", "true", "yes", "on"].includes((c.env.IAP_ENABLED ?? "false").toLowerCase());
}

async function getAppStoreAccountToken(c: Ctx): Promise<Response> {
  if (!iapEnabled(c)) return errorDetail("アプリ内購入は準備中です", 503);
  const account = await requirePurchasableAccount(c);
  if (account instanceof Response) return account;
  return json({ app_account_token: await c.store.getOrCreateAppAccountToken(account) });
}

/**
 * StoreKit2 の signedTransaction(JWS)をApple Root CAまでのチェーン検証込みで検証し、
 * purchases(不変の台帳)とentitlements(唯一の真実の源)に反映する。検証失敗は必ず 400 で
 * fail-closed(権利は一切付与しない)。ASSN V2 webhook 実装までの失効は、クライアントが
 * 起動時に Transaction.currentEntitlements を再送する経路で expires_at を前進させることに委ねる
 * (StoreKitManager.prepare() 参照)。
 */
async function postApplePurchaseVerify(c: Ctx, body: { signed_transaction?: unknown }): Promise<Response> {
  if (!iapEnabled(c)) return errorDetail("アプリ内購入は準備中です", 503);
  const account = await requirePurchasableAccount(c);
  if (account instanceof Response) return account;

  if (typeof body.signed_transaction !== "string" || body.signed_transaction.length < 16 || body.signed_transaction.length > 20_000) {
    return errorDetail("不正なリクエストです", 400);
  }

  let tx;
  try {
    tx = await verifySignedTransaction(body.signed_transaction, {
      bundleId: c.env.APPLE_BUNDLE_ID ?? "com.takmin.vmate",
      trustedRootDER: appleRootCaG3(),
      expectedEnvironment: c.env.APPLE_ENVIRONMENT ?? "Production",
    });
  } catch (error) {
    if (error instanceof AppleTransactionError) return errorDetail("購入を確認できませんでした", 400);
    throw error;
  }

  const result = await applyAppleTransaction(c.store, account, tx);
  if (!result.ok) {
    if (result.reason === "account_mismatch") return errorDetail("この購入は別のアカウントに紐付いています", 403);
    if (result.reason === "missing_account_token") return errorDetail("購入者を確認できませんでした。アプリを最新版に更新して再度お試しください。", 400);
    return errorDetail("未対応の商品です", 400);
  }

  return json({ ok: true });
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

async function getAge(c: Ctx): Promise<Response> {
  const age = await c.store.getUserAge(await resolveUid(c));
  return json({ age_band: age?.age_band ?? null, required: age == null });
}

/** 年齢確認前または13歳未満の利用者を、生成系APIへ到達させない。 */
async function requireInteractionAge(c: Ctx, uid: string): Promise<Response | null> {
  const age = await c.store.getUserAge(uid);
  if (!age) {
    return json(
      { detail: "ご利用前に年齢確認を完了してください", code: "age_required" },
      403,
    );
  }
  if (age.age_band === "under13") {
    return json(
      { detail: "この年齢ではご利用いただけません", code: "age_restricted" },
      403,
    );
  }
  return null;
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

async function postChat(c: Ctx, body: { message?: unknown }): Promise<Response> {
  const message = body.message;
  if (typeof message !== "string" || message.length < 1 || message.length > 2000) {
    return errorDetail("メッセージは1〜2000文字で入力してください", 400);
  }
  const uid = await resolveUid(c);
  const ageBlocked = await requireInteractionAge(c, uid);
  if (ageBlocked) return ageBlocked;
  const limited = await enforceRateLimit(c, uid);
  if (limited) return limited;
  // 年齢帯: 13-17歳は minor 用モデレーション・system prompt を適用する。
  const age = await c.store.getUserAge(uid);
  const minor = age!.age_band !== "adult";
  // クライアント申告ではなく、サーバが最初の送信だけを集計する。
  if ((await c.store.userMessageCount(uid)) === 0) {
    c.execCtx.waitUntil(c.store.recordDailyMetric(jstToday(), "first_chat_sent", clientPlatform(c.request)).catch(() => undefined));
  }
  return handleChat(c.env, c.store, c.execCtx, uid, message, minor);
}

const ANALYTICS_EVENTS = new Set(["onboarding_started", "onboarding_age_verified", "onboarding_completed", "voice_mode_started", "diary_opened"]);

function clientPlatform(request: Request): string {
  const ua = request.headers.get("User-Agent") ?? "";
  return /iPhone|iPad|iPod/.test(ua) ? "ios" : "web";
}

async function postAnalyticsEvent(c: Ctx, body: { event?: unknown }): Promise<Response> {
  if (typeof body.event !== "string" || !ANALYTICS_EVENTS.has(body.event)) return errorDetail("未対応の計測イベントです", 400);
  if ((await c.store.bumpUsage(`analytics:${clientIp(c.request)}`, jstToday())) > 100) return errorDetail("計測回数が多すぎます", 429);
  // イベント名以外の payload を受け取らない。個人データを収集しないための境界。
  c.execCtx.waitUntil(c.store.recordDailyMetric(jstToday(), body.event, clientPlatform(c.request)).catch(() => undefined));
  return json({ ok: true });
}

async function postAge(c: Ctx, body: { birth_date?: unknown }): Promise<Response> {
  const birthDate = body.birth_date;
  if (typeof birthDate !== "string") {
    return errorDetail("生年月日を入力してください", 400);
  }
  const uid = await resolveUid(c);
  try {
    const band = computeAgeBand(birthDate, jstNow());
    await c.store.setUserAge(uid, birthDate, band, "self_declared");
    return json({ age_band: band, required: false });
  } catch (e) {
    if (e instanceof auth.ValueError) return errorDetail(e.message, 400);
    throw e;
  }
}

async function postReport(c: Ctx, body: { message_id?: unknown; reason?: unknown }): Promise<Response> {
  const messageId = typeof body.message_id === "number" ? body.message_id : null;
  const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 500) : "";
  if (!reason) return errorDetail("通報理由を入力してください", 400);
  const uid = await resolveUid(c);
  await c.store.createReport(uid, messageId, reason);
  return json({ ok: true });
}

async function postNudge(c: Ctx, body: { reason?: unknown; first_visit?: unknown }): Promise<Response> {
  const reason = body.reason === "greeting" ? "greeting" : "idle";
  const firstVisit = body.first_visit === true;
  const uid = await resolveUid(c);
  const ageBlocked = await requireInteractionAge(c, uid);
  if (ageBlocked) return ageBlocked;
  const lastSeen = await c.store.getKv(uid, "last_seen");
  const userName = await c.store.getKv(uid, "user_name");
  const nameNote = userName
    ? `相手の名前は「${userName}」。`
    : "相手の名前はまだ知らない(「ユーザーさん」のような呼び方はせず、名前を呼ばずに話す)。";

  let context: string;
  let daysAway: number | null = null;
  // 初見挨拶(intro)にするのは、端末(firstVisit)とサーバ活動履歴(!lastSeen)の両方が
  // 「初見」を示すときだけ(AND)。片方でも「既知」を示せば通常挨拶へフォールバックする安全側設計
  // ―― localStorage だけ消した復帰ユーザーに「はじめまして」を誤爆させないための二重ガード。
  // 注: 初見ユーザーが2タブ同時オープン等の同時リクエストを投げると intro が2回出る理論上の
  // レースは残るが、フロントの greeted.current ガードで通常経路では起きず、最悪でも挨拶重複=
  // 無害のため KV ロックは入れない(コスト対効果で見送り)。
  let isIntro = false;
  if (reason === "greeting") {
    if (lastSeen && secondsSince(lastSeen) < GREETING_MIN_GAP_SECONDS) {
      // ついさっき(リロード等)開いただけ。毎回挨拶し直すと干渉しすぎになるので省略する。
      await c.store.touchLastSeen(uid);
      return json({ text: "", emotion: "neutral", days_away: null });
    }
    isIntro = firstVisit && !lastSeen;
    let gap = "";
    if (lastSeen) {
      const days = daysSince(lastSeen);
      if (days >= 2) {
        gap = `ユーザーと会うのは約${days}日ぶり。`;
        daysAway = days;
      }
    }
    context = isIntro
      ? `${timeContext()}${nameNote}ユーザーがこのアプリを初めて開いて現れたところ。`
      : `${timeContext()}${nameNote}${gap}ユーザーがアプリを開いて現れたところ。挨拶する。`;
  } else {
    context = `${timeContext()}${nameNote}会話が途切れて少し時間が経った。`;
  }
  const facts = await c.store.listFacts(uid, 8);
  if (facts.length) context += "覚えていること: " + facts.join(" / ");

  let raw: string;
  try {
    raw = await complete(c.env, nudgePrompt(context, { intro: isIntro }));
  } catch {
    return json({ text: "", emotion: "neutral", days_away: null });
  }
  const [emotion, text] = stripEmotion(raw);
  if (text) await c.store.addMessage(uid, "assistant", text, emotion);
  await c.store.touchLastSeen(uid);
  return json({ text, emotion, days_away: daysAway });
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
  const ageBlocked = await requireInteractionAge(c, uid);
  if (ageBlocked) return ageBlocked;
  const today = jstToday();
  const msgs = await c.store.messagesOn(uid, today);
  if (msgs.length < 4) return json({ ok: false, reason: "今日はまだ会話が少ないみたい。" });
  const conversation = msgs
    .slice(-60)
    .map((m) => `${m.role === "user" ? "ユーザー" : "シロ"}: ${m.content}`)
    .join("\n");
  const userName = (await c.store.getKv(uid, "user_name")) || "ユーザー";
  let content: string;
  try {
    content = stripEmotion(await complete(c.env, diaryPrompt(userName, conversation)))[1];
  } catch {
    // LLM呼び出し失敗時、生のエラーをクライアントに露出させない(キャラクター性も壊れる)。
    c.execCtx.waitUntil(c.store.recordDailyMetric(today, "diary_generation_failed", clientPlatform(c.request)).catch(() => undefined));
    return json({ ok: false, reason: "今は日記がうまく書けないみたい。少ししてからまた試してね。" });
  }
  await c.store.addDiary(uid, today, content);
  c.execCtx.waitUntil(c.store.recordDailyMetric(today, "diary_generated", clientPlatform(c.request)).catch(() => undefined));
  return json({ ok: true, entry: { entry_date: today, content } });
}

async function getTts(c: Ctx): Promise<Response> {
  const uid = await resolveUid(c);
  const ageBlocked = await requireInteractionAge(c, uid);
  if (ageBlocked) return ageBlocked;
  const enabled = ["1", "true", "yes", "on"].includes((c.env.ENABLE_TTS ?? "false").toLowerCase());
  if (!enabled) {
    c.execCtx.waitUntil(c.store.recordDailyMetric(jstToday(), "tts_request", "disabled").catch(() => undefined));
    return new Response(null, { status: 204 });
  }
  const url = new URL(c.request.url);
  const text = url.searchParams.get("text") ?? "";
  const emotion = url.searchParams.get("emotion");
  const result = await synthesize(c.env, text.slice(0, 300), emotion);
  c.execCtx.waitUntil(
    c.store.recordDailyMetric(jstToday(), "tts_request", result.outcome, result.latencyMs, result.audio?.byteLength ?? 0).catch(() => undefined),
  );
  if (!result.audio) return new Response(null, { status: 204 });
  return new Response(result.audio, { headers: { "Content-Type": "audio/mpeg" } });
}

// --- ルーティング ---

async function route(c: Ctx): Promise<Response> {
  const url = new URL(c.request.url);
  const path = url.pathname;
  const method = c.request.method;

  // GET
  if (method === "GET") {
    if (path === "/api/auth/me") return authMe(c);
    if (path === "/api/entitlements") return getEntitlements(c);
    if (path === "/api/catalog") return getCatalog(c);
    if (path === "/api/store/account-token") return getAppStoreAccountToken(c);
    if (path === "/api/profile/age") return getAge(c);
    if (path === "/api/state") return getState(c);
    if (path === "/api/history") return getHistory(c);
    if (path === "/api/diary") return getDiary(c);
    if (path === "/api/tts") return getTts(c);
    return errorDetail("Not Found", 404);
  }

  // POST(JSON ボディ)
  if (method === "POST") {
    const body = await readJson(c.request);
    if (path === "/api/auth/signup") return authSignup(c, body);
    if (path === "/api/auth/login") return authLogin(c, body);
    if (path === "/api/auth/apple") return authApple(c, body);
    if (path === "/api/auth/delete") return authDelete(c);
    if (path === "/api/analytics/event") return postAnalyticsEvent(c, body);
    if (path === "/api/purchase/apple/verify") return postApplePurchaseVerify(c, body);
    if (path === "/api/profile") return setProfile(c, body);
    if (path === "/api/profile/age") return postAge(c, body);
    if (path === "/api/report") return postReport(c, body);
    if (path === "/api/chat") return postChat(c, body);
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

// Workers静的アセットは1ファイル25MiB上限。それを超えるVRM(realistic.vrm)はR2から配信する。
const R2_MODEL_KEYS: Record<string, string> = {
  "/models/realistic.vrm": "models/realistic.vrm",
};

async function serveR2Model(env: Env, request: Request, key: string): Promise<Response> {
  const object = await env.MODELS.get(key, { range: request.headers });
  if (!object) return new Response("Not Found", { status: 404 });
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("content-type", "model/gltf-binary");
  headers.set("cache-control", "public, max-age=31536000, immutable");
  const status = "range" in object && object.range ? 206 : 200;
  return new Response(object.body, { status, headers });
}

export default {
  async fetch(request: Request, env: Env, execCtx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    const r2Key = R2_MODEL_KEYS[url.pathname];
    if (r2Key) return serveR2Model(env, request, r2Key);

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
      // H5: e.message には D1/LLM 内部エラーや API キー不足の手がかりが含まれ、
      // そのまま返すと偵察起点になる。サーバ側で console.error 相当でログに残し、
      // クライアントには固定メッセージだけ返す。Worker には console が無い場合もあるが
      // 標準の console.error は tail worker 出力に行く(本番で --tail で観察可)。
      console.error("route handler threw", e?.toString?.() ?? e);
      response = errorDetail("サーバーエラーが発生しました。しばらくしてから再度お試しください。", 500);
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
