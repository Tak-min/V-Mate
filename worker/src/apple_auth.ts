/** Apple identity token(JWS)検証。jwks.ts の薄いラッパ。
 *
 * Apple の `sub` だけを信頼する。email は識別子として使わず、既存メールアカウントへの
 * 自動リンクはしない(アカウント乗っ取り防止)。 */

import type { FederatedIdentity } from "./federated";
import { verifyIdToken } from "./jwks";

const APPLE_ISSUER = "https://appleid.apple.com";
const APPLE_JWKS_URL = "https://appleid.apple.com/auth/keys";

/** nonce は iOS で生成した生 nonce ではなく SHA-256 の base64url 値を受け取る。 */
export async function verifyAppleIdentityToken(
  token: string,
  audience: string,
  expectedNonce: string,
): Promise<FederatedIdentity> {
  const claims = await verifyIdToken({
    token,
    jwksUrl: APPLE_JWKS_URL,
    cacheKey: "apple",
    allowedAlgs: ["RS256"],
    expectedIssuers: [APPLE_ISSUER],
    expectedAudiences: [audience],
    expectedNonce,
  });
  return {
    provider: "apple",
    subject: claims.sub as string,
    email: typeof claims.email === "string" ? claims.email : null,
  };
}
