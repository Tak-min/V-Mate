/** Apple identity token (JWS) verifier.
 *
 * Apple の `sub` だけを信頼する。email は識別子として使わず、既存メールアカウントへの
 * 自動リンクはしない（アカウント乗っ取り防止）。 */

const APPLE_ISSUER = "https://appleid.apple.com";
const JWKS_URL = "https://appleid.apple.com/auth/keys";
const JWKS_TTL_MS = 60 * 60 * 1000;
const decoder = new TextDecoder();

type Jwk = JsonWebKey & { kid?: string; alg?: string; use?: string };
let jwksCache: { expiresAt: number; keys: Jwk[] } | null = null;

function b64urlBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  const raw = atob(padded);
  return Uint8Array.from(raw, (char) => char.charCodeAt(0));
}

function jsonPart(value: string): Record<string, unknown> {
  return JSON.parse(decoder.decode(b64urlBytes(value))) as Record<string, unknown>;
}

async function appleKeys(): Promise<Jwk[]> {
  if (jwksCache && jwksCache.expiresAt > Date.now()) return jwksCache.keys;
  const response = await fetch(JWKS_URL);
  if (!response.ok) throw new AppleTokenError("Apple の公開鍵を取得できませんでした");
  const data = (await response.json()) as { keys?: Jwk[] };
  if (!Array.isArray(data.keys)) throw new AppleTokenError("Apple の公開鍵形式が不正です");
  jwksCache = { keys: data.keys, expiresAt: Date.now() + JWKS_TTL_MS };
  return data.keys;
}

export interface AppleIdentity {
  subject: string;
  email: string | null;
}

export class AppleTokenError extends Error {}

/** nonce は iOS で生成した生 nonce ではなく SHA-256 の base64url 値を受け取る。 */
export async function verifyAppleIdentityToken(
  token: string,
  audience: string,
  expectedNonce: string,
): Promise<AppleIdentity> {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) throw new AppleTokenError("Apple トークン形式が不正です");
    const [encodedHeader, encodedPayload, encodedSignature] = parts;
    const header = jsonPart(encodedHeader);
    if (header.alg !== "RS256" || typeof header.kid !== "string") {
      throw new AppleTokenError("Apple トークンの署名方式が不正です");
    }
    const key = (await appleKeys()).find((candidate) => candidate.kid === header.kid && candidate.kty === "RSA");
    if (!key) throw new AppleTokenError("Apple トークンの公開鍵が見つかりません");
    const cryptoKey = await crypto.subtle.importKey(
      "jwk",
      key,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const validSignature = await crypto.subtle.verify(
      { name: "RSASSA-PKCS1-v1_5" },
      cryptoKey,
      b64urlBytes(encodedSignature) as BufferSource,
      new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`),
    );
    if (!validSignature) throw new AppleTokenError("Apple トークンの署名が不正です");

    const claims = jsonPart(encodedPayload);
    const now = Math.floor(Date.now() / 1000);
    if (claims.iss !== APPLE_ISSUER || claims.aud !== audience || typeof claims.sub !== "string" || !claims.sub) {
      throw new AppleTokenError("Apple トークンの発行者または対象が不正です");
    }
    if (typeof claims.exp !== "number" || claims.exp <= now) throw new AppleTokenError("Apple トークンの有効期限が切れています");
    if (typeof claims.nonce !== "string" || claims.nonce !== expectedNonce) {
      throw new AppleTokenError("Apple トークンの nonce が一致しません");
    }
    return { subject: claims.sub, email: typeof claims.email === "string" ? claims.email : null };
  } catch (error) {
    if (error instanceof AppleTokenError) throw error;
    throw new AppleTokenError("Apple トークンを検証できませんでした");
  }
}

/** テスト専用。プロダクションコードからは使わない。 */
export function clearAppleJwksCacheForTest(): void {
  jwksCache = null;
}
