/** StoreKit 2 の signedTransaction(JWS, x5c 証明書チェーン)検証器。
 *
 * apple_auth.ts(Sign in with Apple)とは別モジュール: あちらは Apple の JWKS(RS256)を都度取得して
 * 検証するが、こちらは StoreKit2 の取引 JWS 自身が x5c ヘッダで証明書チェーンを運んでくる方式(ES256)
 * のため、固定した Apple Root CA を信頼アンカーとしてチェーン検証する。
 *
 * 失敗は必ず例外(AppleTransactionError)。呼び出し側は catch した時点で権利を一切付与しない
 * (fail-closed)。 */

import { BasicConstraints, Certificate, CryptoEngine, id_BasicConstraints, setEngine } from "pkijs";
import type { Store } from "./db";
import { catalogItemByProductId } from "./catalog";
import { jstIsoFromEpochMs } from "./util";

const decoder = new TextDecoder();

export class AppleTransactionError extends Error {}

export interface AppleTransaction {
  transactionId: string;
  originalTransactionId: string;
  productId: string;
  bundleId: string;
  purchaseDate: number;
  expiresDate: number | null;
  signedDate: number;
  type: string;
  environment: string;
  appAccountToken: string | null;
}

let pkijsEngineReady = false;
function ensurePkijsEngine(): void {
  if (pkijsEngineReady) return;
  // pkijs 3.4.0 の CryptoEngine の型定義は ICryptoEngine(timingSafeEqual 等)を完全には
  // 満たしていない(型定義側の不備、実行時には問題無い。動作は spike で workerd 上で確認済み)。
  setEngine("workerd", new CryptoEngine({ name: "workerd", crypto }) as unknown as Parameters<typeof setEngine>[1]);
  pkijsEngineReady = true;
}

/** JWS compact serialization の base64url セグメント(ヘッダ/ペイロード/署名)。 */
function b64urlBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  const raw = atob(padded);
  return Uint8Array.from(raw, (char) => char.charCodeAt(0));
}

/** x5c 配列の各要素は RFC 7515 により標準 base64(base64url ではない)。ここを誤ると証明書が壊れる。 */
function b64StdBytes(value: string): Uint8Array {
  const raw = atob(value);
  return Uint8Array.from(raw, (char) => char.charCodeAt(0));
}

function jsonPart(value: string): Record<string, unknown> {
  try {
    return JSON.parse(decoder.decode(b64urlBytes(value))) as Record<string, unknown>;
  } catch {
    throw new AppleTransactionError("署名の形式が不正です");
  }
}

function derBytesEqual(a: ArrayBuffer, b: ArrayBuffer): boolean {
  const av = new Uint8Array(a);
  const bv = new Uint8Array(b);
  if (av.length !== bv.length) return false;
  for (let i = 0; i < av.length; i++) if (av[i] !== bv[i]) return false;
  return true;
}

/**
 * BasicConstraints拡張(OID 2.5.29.19)の cA=true を持つか。中間証明書はこれを要求する:
 * 無いと、Apple Developer Program の一般会員が取得できる「非CA」なエンドエンティティ証明書
 * (その所有者は秘密鍵を持っている)を "中間証明書" として x5c に混入させ、それで自作の葉証明書へ
 * 署名するだけで、任意の取引を偽造できてしまう(攻撃者は正規に自分の証明書の秘密鍵を持つため、
 * これは総当たりや鍵の窃取を必要としない現実的な攻撃)。
 */
function isCertificateAuthority(cert: Certificate): boolean {
  const ext = cert.extensions?.find((e) => e.extnID === id_BasicConstraints);
  return ext?.parsedValue instanceof BasicConstraints && ext.parsedValue.cA === true;
}

/**
 * pkiCerts[0](x5c[0]、JWS署名の検証に使った葉証明書そのもの)を起点に、線形に1本のチェーンとして
 * 検証する。pkiCerts[i] が pkiCerts[i+1] に署名されていることを順に確認し、チェーンの終端が
 * trustedRoot 自身であるか、trustedRoot によって署名されていることを要求する。
 *
 * pkijs の CertificateChainValidationEngine は使わない: そのエンジンは内部で
 * `[...trustedCerts, ...certs]` を連結した配列の**最後の要素**を「検証対象の葉」とみなして
 * チェーン構築を始める(pkijs 3.4.0 CertificateChainValidationEngine.sort() 実装を確認済み)。
 * これは x5c の並び順(leaf が先頭)と一致しない。もし x5c に正規の中間証明書が含まれていた場合、
 * 攻撃者が x5c[0] に自作の葉証明書(自分の秘密鍵で署名したJWS用)を、x5c[1] に本物のApple中間証明書を
 * 混入させると、エンジンは「中間証明書→正規Root」という別のチェーンだけを検証して true を返しうる
 * ため、JWS署名の検証に実際に使った葉証明書(pkiCerts[0])の真正性が一切確認されないまま通過して
 * しまう(fail-open)。この関数はその class of bug を避けるため、検証対象を pkiCerts[0] に固定した
 * 明示的な線形検証を行う。
 */
async function verifyLinearCertificateChain(pkiCerts: Certificate[], trustedRootDER: ArrayBuffer, now: Date): Promise<boolean> {
  if (pkiCerts.length === 0) return false;
  for (const cert of pkiCerts) {
    if (cert.notBefore.value > now || cert.notAfter.value < now) return false;
  }
  // 葉(index 0)より上は全て CA 証明書でなければならない。これが無いと、Apple Developer Program の
  // 一般会員が正規に取得できる非CAのエンドエンティティ証明書(=秘密鍵を本人が保持)を「中間証明書」に
  // 仕立てて、自作の葉証明書へ署名するだけで任意の取引を偽造できてしまう。
  for (let i = 1; i < pkiCerts.length; i++) {
    if (!isCertificateAuthority(pkiCerts[i])) return false;
  }
  for (let i = 0; i < pkiCerts.length - 1; i++) {
    if (!pkiCerts[i].issuer.isEqual(pkiCerts[i + 1].subject)) return false;
    const signedByNext = await pkiCerts[i].verify(pkiCerts[i + 1]);
    if (!signedByNext) return false;
  }
  const top = pkiCerts[pkiCerts.length - 1];
  const topDER = top.toSchema().toBER(false);
  if (derBytesEqual(topDER, trustedRootDER)) return true; // x5c が Root 自身を含んでいた
  // x5c が Root を含まない場合、チェーン最上位が trustedRoot によって署名されていることを要求する。
  const trustedRoot = Certificate.fromBER(trustedRootDER);
  if (!top.issuer.isEqual(trustedRoot.subject)) return false;
  return top.verify(trustedRoot);
}

/**
 * StoreKit2 の signedTransaction(JWS)を検証し、payload を返す。
 * - JWS 署名(ES256)を x5c[0](葉証明書)の公開鍵で検証する。
 * - x5c[0](署名検証に使った葉証明書そのもの)を起点に、`trustedRootDER` を信頼アンカーとして
 *   線形チェーン検証する(`verifyLinearCertificateChain`。署名連鎖・validity を検証。失敗は全て例外)。
 * - claims: bundleId が一致すること。transactionId/originalTransactionId/productId が揃っていること。
 * - environment が opts.expectedEnvironment と厳密一致すること(fail-closed)。Sandbox と Production は
 *   同一証明書チェーンで署名されるため、payload.environment が唯一の区別材料になる。これを検証しないと、
 *   誰でも無料で作れる Sandbox 取引の jwsRepresentation を本番エンドポイントへ投げるだけで有料権利を
 *   詐取できてしまう。environment が文字列でない/欠落している場合も拒否する(silently-missing 対策)。
 * - expiresDate が過去でも例外にはしない(呼び出し側が entitlements の失効として扱う。ここでの
 *   責務は「Apple が署名した事実の検証」であり、時点判定はビジネスロジック側に委ねる)。
 */
export async function verifySignedTransaction(
  jws: string,
  opts: { bundleId: string; trustedRootDER: ArrayBuffer; expectedEnvironment: string },
): Promise<AppleTransaction> {
  try {
    ensurePkijsEngine();

    const parts = jws.split(".");
    if (parts.length !== 3) throw new AppleTransactionError("署名の形式が不正です");
    const [encodedHeader, encodedPayload, encodedSignature] = parts;

    const header = jsonPart(encodedHeader) as { alg?: string; x5c?: string[] };
    if (header.alg !== "ES256") throw new AppleTransactionError("署名方式が不正です");
    if (!Array.isArray(header.x5c) || header.x5c.length < 1) throw new AppleTransactionError("証明書チェーンがありません");

    let certDERs: ArrayBuffer[];
    try {
      certDERs = header.x5c.map((c) => b64StdBytes(c).buffer as ArrayBuffer);
    } catch {
      throw new AppleTransactionError("証明書の形式が不正です");
    }

    const pkiCerts = certDERs.map((der) => Certificate.fromBER(der));

    const chainValid = await verifyLinearCertificateChain(pkiCerts, opts.trustedRootDER, new Date());
    if (!chainValid) throw new AppleTransactionError("証明書チェーンを検証できませんでした");

    const leafCert = pkiCerts[0];
    const leafKey = await leafCert.getPublicKey();
    const signatureBytes = b64urlBytes(encodedSignature);
    const signedData = new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`);
    const validSignature = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      leafKey,
      signatureBytes as BufferSource,
      signedData,
    );
    if (!validSignature) throw new AppleTransactionError("署名が不正です");

    const payload = jsonPart(encodedPayload);
    if (payload.bundleId !== opts.bundleId) throw new AppleTransactionError("bundleIdが一致しません");
    // Sandbox/Production は同一証明書チェーンで署名されるため、環境の区別は payload.environment だけ。
    // 文字列でない/欠落を含めて、期待環境と厳密一致しない取引は fail-closed で拒否する。
    if (typeof payload.environment !== "string" || payload.environment !== opts.expectedEnvironment) {
      throw new AppleTransactionError("購入環境が一致しません");
    }
    if (
      typeof payload.transactionId !== "string" ||
      !payload.transactionId ||
      typeof payload.originalTransactionId !== "string" ||
      !payload.originalTransactionId ||
      typeof payload.productId !== "string" ||
      !payload.productId ||
      typeof payload.signedDate !== "number"
    ) {
      throw new AppleTransactionError("取引情報が不完全です");
    }

    return {
      transactionId: payload.transactionId,
      originalTransactionId: payload.originalTransactionId,
      productId: payload.productId,
      bundleId: payload.bundleId,
      purchaseDate: typeof payload.purchaseDate === "number" ? payload.purchaseDate : payload.signedDate,
      expiresDate: typeof payload.expiresDate === "number" ? payload.expiresDate : null,
      signedDate: payload.signedDate,
      type: typeof payload.type === "string" ? payload.type : "Unknown",
      environment: typeof payload.environment === "string" ? payload.environment : "Unknown",
      appAccountToken: typeof payload.appAccountToken === "string" ? payload.appAccountToken : null,
    };
  } catch (error) {
    if (error instanceof AppleTransactionError) throw error;
    throw new AppleTransactionError("購入情報を検証できませんでした");
  }
}

export type ApplyAppleTransactionResult =
  | { ok: true }
  | { ok: false; reason: "unknown_product" | "account_mismatch" | "missing_account_token" };

/**
 * 検証済み(verifySignedTransaction 通過済み)の取引を purchases(不変の台帳)と
 * entitlements(唯一の真実の源)へ反映する。crypto検証とDB反映を分離しているのは、
 * ルートレベルの結合テストが実 Apple 署名を用意できない一方、DB反映ロジック(冪等性・
 * 巻き戻し防止・商品allowlist・アカウント紐付け)は合成 AppleTransaction で直接検証できる
 * ようにするため。
 *
 * appAccountToken は必須。取引がこのアカウント宛に発行したトークンを載せていない限り権利を付与しない:
 * トークン無しの取引は「どのアカウントの購入か」を Apple の署名で束縛できず、1つの取引 JWS を
 * 無数の別アカウントへ横流しして各々が無料で権利を得られる(recordPurchaseIfAbsent の冪等性は
 * purchases 台帳のみをガードし、権利付与はガードしない)。これは新規機能で実在の旧経路呼び出し元は
 * 無いため、束縛されていない取引を受け入れる理由が存在しない。missing_account_token(トークン欠落)と
 * account_mismatch(別アカウントのトークン)は異なる失敗モードとして区別する。
 */
export async function applyAppleTransaction(store: Store, userId: string, tx: AppleTransaction): Promise<ApplyAppleTransactionResult> {
  // トークン欠落は拒否(束縛できない取引は誰の購入か証明できず、横流し replay の温床になる)。
  if (!tx.appAccountToken) return { ok: false, reason: "missing_account_token" };
  // このアカウント宛に発行したトークンと一致することを要求する(他アカウントの取引を横流しできない
  // ようにする)。crypto.randomUUID() と Apple 返却トークンは現状どちらも小文字だが、大小文字の差だけで
  // 正規購入を誤って拒否しないよう比較は case-insensitive にする。
  const boundToken = await store.getOrCreateAppAccountToken(userId);
  if (tx.appAccountToken.toLowerCase() !== boundToken.toLowerCase()) return { ok: false, reason: "account_mismatch" };

  const item = catalogItemByProductId(tx.productId);
  if (!item) return { ok: false, reason: "unknown_product" };

  // signedDate/purchaseDate/expiresDate(epoch ms)を jstIso() と同じ文字列書式へ変換する。
  // upsertEntitlement の巻き戻し防止ガードが updated_at の文字列比較のため、書式を統一しないと
  // 古い通知が新しい権利を上書きしうる。
  const updatedAt = jstIsoFromEpochMs(tx.signedDate);
  const expiresAt = tx.expiresDate !== null ? jstIsoFromEpochMs(tx.expiresDate) : null;

  await store.recordPurchaseIfAbsent({
    userId,
    provider: "apple",
    externalId: tx.transactionId,
    originalExternalId: tx.originalTransactionId,
    productId: tx.productId,
    kind: item.kind,
    status: "active",
    occurredAt: jstIsoFromEpochMs(tx.purchaseDate),
    expiresAt,
  });
  await store.upsertEntitlement(userId, item.entitlementKey, "active", "apple", expiresAt, updatedAt);
  return { ok: true };
}

// Apple Root CA - G3。https://www.apple.com/certificateauthority/AppleRootCA-G3.cer から取得(2026-07-21)。
// SHA-256 fingerprint: 63:34:3A:BF:B8:9A:6A:03:EB:B5:7E:9B:3F:5F:A7:BE:7C:4F:5C:75:6F:30:17:B3:A8:C4:88:C3:65:3E:91:79
// (https://www.apple.com/certificateauthority/ 掲載値と一致確認済み)。有効期限 2039-04-30。
const APPLE_ROOT_CA_G3_B64 =
  "MIICQzCCAcmgAwIBAgIILcX8iNLFS5UwCgYIKoZIzj0EAwMwZzEbMBkGA1UEAwwSQXBwbGUgUm9vdCBDQSAtIEczMSYwJAYDVQQLDB1BcHBsZSBDZXJ0aWZpY2F0aW9uIEF1dGhvcml0eTETMBEGA1UECgwKQXBwbGUgSW5jLjELMAkGA1UEBhMCVVMwHhcNMTQwNDMwMTgxOTA2WhcNMzkwNDMwMTgxOTA2WjBnMRswGQYDVQQDDBJBcHBsZSBSb290IENBIC0gRzMxJjAkBgNVBAsMHUFwcGxlIENlcnRpZmljYXRpb24gQXV0aG9yaXR5MRMwEQYDVQQKDApBcHBsZSBJbmMuMQswCQYDVQQGEwJVUzB2MBAGByqGSM49AgEGBSuBBAAiA2IABJjpLz1AcqTtkyJygRMc3RCV8cWjTnHcFBbZDuWmBSp3ZHtfTjjTuxxEtX/1H7YyYl3J6YRbTzBPEVoA/VhYDKX1DyxNB0cTddqXl5dvMVztK517IDvYuVTZXpmkOlEKMaNCMEAwHQYDVR0OBBYEFLuw3qFYM4iapIqZ3r6966/ayySrMA8GA1UdEwEB/wQFMAMBAf8wDgYDVR0PAQH/BAQDAgEGMAoGCCqGSM49BAMDA2gAMGUCMQCD6cHEFl4aXTQY2e3v9GwOAEZLuN+yRhHFD/3meoyhpmvOwgPUnPWTxnS4at+qIxUCMG1mihDK1A3UT82NQz60imOlM27jbdoXt2QfyFMm+YhidDkLF1vLUagM6BgD56KyKA==";

/** production で使う唯一の信頼アンカー。テストは独自の trustedRootDER を注入して差し替える。 */
export function appleRootCaG3(): ArrayBuffer {
  const raw = atob(APPLE_ROOT_CA_G3_B64);
  const bytes = Uint8Array.from(raw, (char) => char.charCodeAt(0));
  return bytes.buffer;
}
