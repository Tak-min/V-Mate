/** 認証 — email+password(PBKDF2-HMAC-SHA256)+ JWT(HS256)。backend/app/auth.py の移植。
 *
 * Workers 無料枠は 1リクエスト CPU 10ms 制限があるため、CPU を食う bcrypt は使えない。
 * 代わりに WebCrypto のネイティブ PBKDF2 を使う。反復回数は CPU 予算と強度の折衷で
 * PBKDF2_ITERATIONS に設定(ログイン/登録時のみ発生)。強度を上げたい場合は Workers 有料
 * プラン(CPU上限 30s)に上げてから反復回数を増やすこと。 */

import type { Store } from "./db";
import type { AuthProvider, FederatedIdentity } from "./federated";

const PROVIDER_LABEL: Record<AuthProvider, string> = {
  apple: "Apple ID",
  google: "Google アカウント",
  line: "LINE アカウント",
};

const JWT_ALG = "HS256";
const JWT_TTL = 60 * 60 * 24 * 30; // 30日
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const PBKDF2_ITERATIONS = 50_000; // 10ms CPU 制限に収まる範囲での妥協値
const PBKDF2_KEYLEN = 32; // bytes
// 旧実装はハードコードされた FALLBACK_SECRET に静默フォールバックしていた。
// ソースを知る攻撃者が任意 sub の JWT を偽造できる致命的弱点だったため、fail-fast に変更。

const enc = new TextEncoder();

// --- base64url ---

function bytesToB64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function strToB64url(s: string): string {
  return bytesToB64url(enc.encode(s));
}

/** 定数時間比較(タイミング攻撃対策)。 */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// --- パスワード(PBKDF2)---

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: salt as BufferSource, iterations, hash: "SHA-256" },
    key,
    PBKDF2_KEYLEN * 8,
  );
  return new Uint8Array(bits);
}

/** 保存形式: "pbkdf2$<iter>$<saltB64url>$<hashB64url>" */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${bytesToB64url(salt)}$${bytesToB64url(hash)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    const [scheme, iterStr, saltB64, hashB64] = stored.split("$");
    if (scheme !== "pbkdf2") return false;
    const iterations = parseInt(iterStr, 10);
    const salt = b64urlToBytes(saltB64);
    const expected = b64urlToBytes(hashB64);
    const actual = await pbkdf2(password, salt, iterations);
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

// --- JWT(HS256)---

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

export async function createToken(userId: string, secret: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = strToB64url(JSON.stringify({ alg: JWT_ALG, typ: "JWT" }));
  const payload = strToB64url(JSON.stringify({ sub: userId, iat: now, exp: now + JWT_TTL }));
  const data = `${header}.${payload}`;
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(data));
  return `${data}.${bytesToB64url(new Uint8Array(sig))}`;
}

/** 検証成功で user_id(sub)、失敗で null。 */
export async function decodeToken(token: string, secret: string): Promise<string | null> {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [header, payload, sig] = parts;
    // H12: 旧実装は header.alg / typ を検査せず、HMAC 検証だけに頼っていた。
    // 現状は alg=none 攻撃は成立しないが、HMAC 実装を差替えるような将来リファクタで
    // silent regression になり得る。深度防御として header を明示的に検証する。
    const headerObj = JSON.parse(new TextDecoder().decode(b64urlToBytes(header))) as {
      alg?: unknown;
      typ?: unknown;
    };
    if (headerObj.alg !== JWT_ALG) return null;
    if (headerObj.typ !== undefined && headerObj.typ !== "JWT") return null;
    const data = `${header}.${payload}`;
    const ok = await crypto.subtle.verify(
      "HMAC",
      await hmacKey(secret),
      b64urlToBytes(sig) as BufferSource,
      enc.encode(data),
    );
    if (!ok) return null;
    const claims = JSON.parse(new TextDecoder().decode(b64urlToBytes(payload))) as {
      sub?: unknown;
      exp?: unknown;
    };
    if (typeof claims.exp === "number" && claims.exp < Math.floor(Date.now() / 1000)) return null;
    return typeof claims.sub === "string" ? claims.sub : null;
  } catch {
    return null;
  }
}

export function jwtSecret(secret: string | undefined): string {
  // 未設定/32バイト未満では即座に throw する。
  // Workers は起動時チェックを持たないため、リクエスト時に評価して 500 由来の
  // error handler で包まれる。error message には直接出さない(H5で別途 sanit)。
  if (!secret || secret.length < 32) {
    throw new Error(
      "JWT_SECRET env var is missing or shorter than 32 bytes. Set a strong secret via `wrangler secret put JWT_SECRET`.",
    );
  }
  return secret;
}

// --- signup / login ---

export async function signup(
  store: Store,
  secret: string,
  email: string,
  password: string,
  anonUid: string | null,
): Promise<string> {
  email = email.trim().toLowerCase();
  if (!EMAIL_RE.test(email)) throw new ValueError("メールアドレスの形式が正しくありません");
  if (await store.getUserByEmail(email)) throw new ValueError("このメールアドレスは既に登録されています");
  const userId = crypto.randomUUID().replace(/-/g, "");
  await store.createUser(userId, email, await hashPassword(password));
  // 匿名で貯めた会話・記憶をアカウントへ引き継ぐ
  if (anonUid && anonUid !== userId && !(await store.getUserById(anonUid))) {
    await store.reassignUserData(anonUid, userId);
  }
  return createToken(userId, secret);
}

export async function login(store: Store, secret: string, email: string, password: string): Promise<string> {
  email = email.trim().toLowerCase();
  const user = await store.getUserByEmail(email);
  if (!user || !(await verifyPassword(password, user.password_hash))) {
    throw new ValueError("メールアドレスまたはパスワードが違います");
  }
  return createToken(user.id, secret);
}

/** プロバイダの subject にのみ紐付ける。既存 identity へのログインで匿名データを再移管しない。
 * email は識別子として使わず、既存アカウントとの自動リンクもしない(乗っ取り防止)。 */
export async function loginWithProvider(
  store: Store,
  secret: string,
  identity: FederatedIdentity,
  anonUid: string | null,
): Promise<string> {
  const existing = await store.getIdentity(identity.provider, identity.subject);
  if (existing) return createToken(existing.user_id, secret);

  const userId = crypto.randomUUID().replace(/-/g, "");
  try {
    await store.createFederatedUser(userId, identity.provider, identity.subject, identity.email);
  } catch {
    // email を既存アカウントと照合・自動統合しない。メール再利用による乗っ取りを防ぐ。
    throw new ValueError(`この${PROVIDER_LABEL[identity.provider]}は現在連携できません。別の方法でログインしてください`);
  }
  if (anonUid && anonUid !== userId && !(await store.getUserById(anonUid))) {
    await store.reassignUserData(anonUid, userId);
  }
  return createToken(userId, secret);
}

/** 入力検証エラー(呼び出し側で 400/401 に変換)。Python の ValueError 相当。 */
export class ValueError extends Error {}
