import "reflect-metadata";
import * as x509 from "@peculiar/x509";
import { beforeAll, describe, expect, it } from "vitest";
import { AppleTransactionError, verifySignedTransaction } from "../src/apple_store";

const BUNDLE_ID = "com.takmin.vmate";
// workers-types(lib: ES2022 のみ、DOM lib無し)は EcdsaParams/EcKeyGenParams を型名として
// 公開していないため、apple_auth.ts と同じくインライン構造体+アサーションで扱う。
const ALG = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" };

async function generateEcKeyPair(): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
}

function b64url(bytes: Uint8Array | ArrayBuffer): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let str = "";
  for (const b of arr) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64std(bytes: ArrayBuffer): string {
  const arr = new Uint8Array(bytes);
  let str = "";
  for (const b of arr) str += String.fromCharCode(b);
  return btoa(str);
}

async function buildTestChain() {
  x509.cryptoProvider.set(crypto);
  const rootKeys = await generateEcKeyPair();
  const root = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: "01",
    name: "CN=Test Root CA",
    notBefore: new Date("2020-01-01"),
    notAfter: new Date("2040-01-01"),
    signingAlgorithm: ALG,
    keys: rootKeys,
    extensions: [new x509.BasicConstraintsExtension(true, undefined, true)],
  });
  const leafKeys = await generateEcKeyPair();
  const leaf = await x509.X509CertificateGenerator.create({
    serialNumber: "02",
    subject: "CN=Test StoreKit Leaf",
    issuer: root.subject,
    notBefore: new Date("2024-01-01"),
    notAfter: new Date("2030-01-01"),
    signingAlgorithm: ALG,
    publicKey: leafKeys.publicKey,
    signingKey: rootKeys.privateKey,
    extensions: [new x509.BasicConstraintsExtension(false)],
  });
  return { root, rootKeys, leaf, leafKeys };
}

async function signTransaction(
  leafPrivateKey: CryptoKey,
  x5cCerts: x509.X509Certificate[],
  payload: Record<string, unknown>,
  headerOverrides: Record<string, unknown> = {},
): Promise<string> {
  const header = {
    alg: "ES256",
    x5c: x5cCerts.map((c) => b64std(c.rawData)),
    ...headerOverrides,
  };
  const encodedHeader = b64url(new TextEncoder().encode(JSON.stringify(header)));
  const encodedPayload = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  const signingInput = new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`);
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, leafPrivateKey, signingInput);
  const encodedSignature = b64url(signature);
  return `${encodedHeader}.${encodedPayload}.${encodedSignature}`;
}

function basePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Date.now();
  return {
    transactionId: "2000000123456789",
    originalTransactionId: "2000000123456789",
    bundleId: BUNDLE_ID,
    productId: "vmate.pro",
    purchaseDate: now,
    expiresDate: now + 30 * 24 * 60 * 60 * 1000,
    signedDate: now,
    type: "Auto-Renewable Subscription",
    environment: "Sandbox",
    appAccountToken: "11111111-1111-1111-1111-111111111111",
    ...overrides,
  };
}

describe("verifySignedTransaction", () => {
  let chain: Awaited<ReturnType<typeof buildTestChain>>;

  beforeAll(async () => {
    chain = await buildTestChain();
  });

  it("accepts a validly chained, validly signed transaction", async () => {
    const jws = await signTransaction(chain.leafKeys.privateKey, [chain.leaf, chain.root], basePayload());
    const tx = await verifySignedTransaction(jws, { bundleId: BUNDLE_ID, trustedRootDER: chain.root.rawData, expectedEnvironment: "Sandbox" });
    expect(tx.transactionId).toBe("2000000123456789");
    expect(tx.productId).toBe("vmate.pro");
    expect(tx.appAccountToken).toBe("11111111-1111-1111-1111-111111111111");
    expect(tx.expiresDate).not.toBeNull();
  });

  it("rejects when the leaf chains to a root that is not the trusted anchor (forged chain)", async () => {
    const attacker = await buildTestChain(); // 別の自己完結チェーン(攻撃者が自前で用意したroot+leaf)
    const jws = await signTransaction(attacker.leafKeys.privateKey, [attacker.leaf, attacker.root], basePayload());
    // trustedRootDER には正規(chain.root)を渡す。攻撃者のchainは信頼されないはず。
    await expect(verifySignedTransaction(jws, { bundleId: BUNDLE_ID, trustedRootDER: chain.root.rawData, expectedEnvironment: "Sandbox" })).rejects.toThrow(AppleTransactionError);
  });

  it("rejects a tampered payload (signature no longer matches)", async () => {
    const jws = await signTransaction(chain.leafKeys.privateKey, [chain.leaf, chain.root], basePayload());
    const [h, , s] = jws.split(".");
    const tamperedPayload = b64url(new TextEncoder().encode(JSON.stringify(basePayload({ productId: "vmate.pro.FREE_UPGRADE" }))));
    await expect(verifySignedTransaction(`${h}.${tamperedPayload}.${s}`, { bundleId: BUNDLE_ID, trustedRootDER: chain.root.rawData, expectedEnvironment: "Sandbox" })).rejects.toThrow(
      AppleTransactionError,
    );
  });

  it("rejects alg confusion (non-ES256 header)", async () => {
    const jws = await signTransaction(chain.leafKeys.privateKey, [chain.leaf, chain.root], basePayload(), { alg: "none" });
    await expect(verifySignedTransaction(jws, { bundleId: BUNDLE_ID, trustedRootDER: chain.root.rawData, expectedEnvironment: "Sandbox" })).rejects.toThrow(AppleTransactionError);
  });

  it("rejects missing x5c header", async () => {
    const header = { alg: "ES256" };
    const encodedHeader = b64url(new TextEncoder().encode(JSON.stringify(header)));
    const encodedPayload = b64url(new TextEncoder().encode(JSON.stringify(basePayload())));
    const jws = `${encodedHeader}.${encodedPayload}.deadbeef`;
    await expect(verifySignedTransaction(jws, { bundleId: BUNDLE_ID, trustedRootDER: chain.root.rawData, expectedEnvironment: "Sandbox" })).rejects.toThrow(AppleTransactionError);
  });

  it("rejects a bundleId mismatch (transaction issued for a different app)", async () => {
    const jws = await signTransaction(chain.leafKeys.privateKey, [chain.leaf, chain.root], basePayload({ bundleId: "com.evil.other" }));
    await expect(verifySignedTransaction(jws, { bundleId: BUNDLE_ID, trustedRootDER: chain.root.rawData, expectedEnvironment: "Sandbox" })).rejects.toThrow(AppleTransactionError);
  });

  it("rejects malformed compact JWS (wrong segment count)", async () => {
    await expect(verifySignedTransaction("not.a.valid.jws.token", { bundleId: BUNDLE_ID, trustedRootDER: chain.root.rawData, expectedEnvironment: "Sandbox" })).rejects.toThrow(
      AppleTransactionError,
    );
  });

  it("returns expiresDate=null when the payload has no expiresDate (non-subscription purchase)", async () => {
    const payload = basePayload({ type: "Non-Consumable" });
    delete payload.expiresDate;
    const jws = await signTransaction(chain.leafKeys.privateKey, [chain.leaf, chain.root], payload);
    const tx = await verifySignedTransaction(jws, { bundleId: BUNDLE_ID, trustedRootDER: chain.root.rawData, expectedEnvironment: "Sandbox" });
    expect(tx.expiresDate).toBeNull();
  });

  it("REGRESSION: rejects an attacker-controlled leaf smuggled alongside a genuinely-trusted-but-unrelated intermediate", async () => {
    // このテストは「pkiCerts のうちどれかが trustedRoot に届けば合格」という誤ったチェーン検証
    // (かつて pkijs の CertificateChainValidationEngine を機械的に使っていた際に混入していたバグ)
    // を再発させないためのもの。x5c[1] は trustedRoot に正しく連なる本物の中間証明書だが、
    // x5c[0](JWS署名に実際使った鍵の証明書)はそれとは無関係に攻撃者が自分で用意したもの。
    // 「どこかにtrustedRootへ届く経路がある」だけでなく、「x5c[0]自身がtrustedRootまで
    // 連なっている」ことを要求しなければならない。
    const realIntermediateKeys = await generateEcKeyPair();
    const realIntermediate = await x509.X509CertificateGenerator.create({
      serialNumber: "10",
      subject: "CN=Real Apple-issued Intermediate",
      issuer: chain.root.subject,
      notBefore: new Date("2024-01-01"),
      notAfter: new Date("2030-01-01"),
      signingAlgorithm: ALG,
      publicKey: realIntermediateKeys.publicKey,
      signingKey: chain.rootKeys.privateKey,
      extensions: [new x509.BasicConstraintsExtension(true, undefined, true)],
    });

    const attackerLeafKeys = await generateEcKeyPair();
    const attackerLeaf = await x509.X509CertificateGenerator.createSelfSigned({
      serialNumber: "11",
      name: "CN=Attacker Self-Signed Leaf",
      notBefore: new Date("2024-01-01"),
      notAfter: new Date("2030-01-01"),
      signingAlgorithm: ALG,
      keys: attackerLeafKeys,
      extensions: [new x509.BasicConstraintsExtension(false)],
    });

    // x5c = [攻撃者の葉(署名に使った鍵), 本物の中間証明書]。攻撃者の葉は中間証明書に一切署名されていない。
    const jws = await signTransaction(attackerLeafKeys.privateKey, [attackerLeaf, realIntermediate], basePayload());
    await expect(verifySignedTransaction(jws, { bundleId: BUNDLE_ID, trustedRootDER: chain.root.rawData, expectedEnvironment: "Sandbox" })).rejects.toThrow(AppleTransactionError);
  });

  it("rejects an intermediate that lacks the CA BasicConstraints flag (non-CA cert can't vouch for a leaf)", async () => {
    // 秘密鍵の所有者が正規に取得した「非CA」の証明書を中間証明書として悪用しようとするケース。
    const nonCaIntermediateKeys = await generateEcKeyPair();
    const nonCaIntermediate = await x509.X509CertificateGenerator.create({
      serialNumber: "20",
      subject: "CN=Non-CA End-Entity Cert",
      issuer: chain.root.subject,
      notBefore: new Date("2024-01-01"),
      notAfter: new Date("2030-01-01"),
      signingAlgorithm: ALG,
      publicKey: nonCaIntermediateKeys.publicKey,
      signingKey: chain.rootKeys.privateKey,
      extensions: [new x509.BasicConstraintsExtension(false)], // cA: false
    });
    const leafKeys = await generateEcKeyPair();
    const leaf = await x509.X509CertificateGenerator.create({
      serialNumber: "21",
      subject: "CN=Leaf Under Non-CA Intermediate",
      issuer: nonCaIntermediate.subject,
      notBefore: new Date("2024-01-01"),
      notAfter: new Date("2030-01-01"),
      signingAlgorithm: ALG,
      publicKey: leafKeys.publicKey,
      signingKey: nonCaIntermediateKeys.privateKey,
      extensions: [new x509.BasicConstraintsExtension(false)],
    });
    const jws = await signTransaction(leafKeys.privateKey, [leaf, nonCaIntermediate], basePayload());
    await expect(verifySignedTransaction(jws, { bundleId: BUNDLE_ID, trustedRootDER: chain.root.rawData, expectedEnvironment: "Sandbox" })).rejects.toThrow(AppleTransactionError);
  });

  it("REGRESSION: rejects a validly-signed Sandbox transaction when Production is expected (free Sandbox purchase can't buy Pro)", async () => {
    // Sandbox 購入は誰でも無料で作れる。Apple は Sandbox と Production を同一証明書チェーンで署名するため、
    // チェーン検証も署名検証も通ってしまう。本番Worker(expectedEnvironment: "Production")は payload の
    // environment を見て拒否しなければならない。これが無いと、無料 Sandbox 取引の jwsRepresentation を
    // /api/purchase/apple/verify へ投げるだけで有料権利を詐取できる。
    const jws = await signTransaction(chain.leafKeys.privateKey, [chain.leaf, chain.root], basePayload({ environment: "Sandbox" }));
    await expect(
      verifySignedTransaction(jws, { bundleId: BUNDLE_ID, trustedRootDER: chain.root.rawData, expectedEnvironment: "Production" }),
    ).rejects.toThrow(AppleTransactionError);
    // 対になる正の確認: 同じ取引でも環境が一致すれば受理される(拒否理由が environment だと確定させる)。
    const tx = await verifySignedTransaction(jws, { bundleId: BUNDLE_ID, trustedRootDER: chain.root.rawData, expectedEnvironment: "Sandbox" });
    expect(tx.environment).toBe("Sandbox");
  });
});
