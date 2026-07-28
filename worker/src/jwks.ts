/** Apple / Google 共通の JWKS 検証器(JWS の RS256 / ES256 署名検証)。
 *
 * apple_auth.ts から抽出。JWKS キャッシュは provider ごとに分離する(cacheKey)。
 * 単一キャッシュにすると、後発の provider が先発の公開鍵で検証を試みて
 * 「公開鍵が見つかりません」を断続的に返す不具合になるため。 */

export type JwsAlg = "RS256" | "ES256";

type Jwk = JsonWebKey & { kid?: string };

interface JwksCacheEntry {
  expiresAt: number;
  keys: Jwk[];
}

const JWKS_TTL_MS = 60 * 60 * 1000;
const jwksCache = new Map<string, JwksCacheEntry>();
const decoder = new TextDecoder();

export class JwksVerifyError extends Error {}

function b64urlBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  const raw = atob(padded);
  return Uint8Array.from(raw, (char) => char.charCodeAt(0));
}

function jsonPart(value: string): Record<string, unknown> {
  return JSON.parse(decoder.decode(b64urlBytes(value))) as Record<string, unknown>;
}

async function fetchKeys(cacheKey: string, jwksUrl: string): Promise<Jwk[]> {
  const cached = jwksCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.keys;
  const response = await fetch(jwksUrl);
  if (!response.ok) throw new JwksVerifyError("公開鍵を取得できませんでした");
  const data = (await response.json()) as { keys?: Jwk[] };
  if (!Array.isArray(data.keys)) throw new JwksVerifyError("公開鍵の形式が不正です");
  jwksCache.set(cacheKey, { keys: data.keys, expiresAt: Date.now() + JWKS_TTL_MS });
  return data.keys;
}

interface CryptoAlgorithmParams {
  name: string;
  hash?: string;
  namedCurve?: string;
}

/** alg ごとの importKey/verify パラメータ。RS256=RSASSA-PKCS1-v1_5, ES256=ECDSA(P-256)。
 * JWS の ES256 署名は既に IEEE P1363 の r||s 64byte 形式なので DER 変換は不要。 */
function algParams(alg: JwsAlg): { importParams: CryptoAlgorithmParams; verifyParams: CryptoAlgorithmParams } {
  if (alg === "RS256") {
    return {
      importParams: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      verifyParams: { name: "RSASSA-PKCS1-v1_5" },
    };
  }
  return {
    importParams: { name: "ECDSA", namedCurve: "P-256" },
    verifyParams: { name: "ECDSA", hash: "SHA-256" },
  };
}

export interface VerifyIdTokenOptions {
  token: string;
  jwksUrl: string;
  /** provider ごとに分けるキャッシュキー(例: "apple" / "google")。 */
  cacheKey: string;
  allowedAlgs: readonly JwsAlg[];
  expectedIssuers: readonly string[];
  expectedAudiences: readonly string[];
  expectedNonce: string;
}

/** JWS(ID token)を検証し claims を返す。iss/aud/exp/nonce/署名を全て確認する。 */
export async function verifyIdToken(o: VerifyIdTokenOptions): Promise<Record<string, unknown>> {
  try {
    const parts = o.token.split(".");
    if (parts.length !== 3) throw new JwksVerifyError("トークン形式が不正です");
    const [encodedHeader, encodedPayload, encodedSignature] = parts;
    const header = jsonPart(encodedHeader);
    const alg = header.alg;
    if (typeof alg !== "string" || !o.allowedAlgs.includes(alg as JwsAlg) || typeof header.kid !== "string") {
      throw new JwksVerifyError("署名方式が不正です");
    }
    const key = (await fetchKeys(o.cacheKey, o.jwksUrl)).find((candidate) => candidate.kid === header.kid);
    if (!key) throw new JwksVerifyError("公開鍵が見つかりません");
    const { importParams, verifyParams } = algParams(alg as JwsAlg);
    const cryptoKey = await crypto.subtle.importKey("jwk", key, importParams, false, ["verify"]);
    const validSignature = await crypto.subtle.verify(
      verifyParams,
      cryptoKey,
      b64urlBytes(encodedSignature) as BufferSource,
      new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`),
    );
    if (!validSignature) throw new JwksVerifyError("署名が不正です");

    const claims = jsonPart(encodedPayload);
    const now = Math.floor(Date.now() / 1000);
    if (typeof claims.iss !== "string" || !o.expectedIssuers.includes(claims.iss)) {
      throw new JwksVerifyError("発行者が不正です");
    }
    if (typeof claims.aud !== "string" || !o.expectedAudiences.includes(claims.aud)) {
      throw new JwksVerifyError("対象が不正です");
    }
    if (typeof claims.sub !== "string" || !claims.sub) throw new JwksVerifyError("subject がありません");
    if (typeof claims.exp !== "number" || claims.exp <= now) throw new JwksVerifyError("有効期限が切れています");
    if (typeof claims.nonce !== "string" || claims.nonce !== o.expectedNonce) {
      throw new JwksVerifyError("nonce が一致しません");
    }
    return claims;
  } catch (error) {
    if (error instanceof JwksVerifyError) throw error;
    throw new JwksVerifyError("トークンを検証できませんでした");
  }
}

/** テスト専用。プロダクションコードからは使わない。 */
export function clearJwksCacheForTest(): void {
  jwksCache.clear();
}
