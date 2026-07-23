/** RevenueCat SDK 経由の課金を反映するサーバー側の受け口。
 *
 * 自前のApple StoreKit2 JWS/x5c検証(旧 apple_store.ts)を置き換える。署名検証自体はRevenueCatが
 * 肩代わりするため、このモジュールの責務は (1) webhook の認証・環境検証・app_user_id のアカウント
 * 束縛(2026-07-21に発見した2つの脆弱性クラスの教訓の引き継ぎ)、(2) RevenueCat REST API から取得した
 * 正規化済み状態を purchases(不変の台帳)と entitlements(唯一の真実の源)へ反映すること。 */

import type { Store } from "./db";
import { catalogItemByRevenueCatEntitlementId } from "./catalog";
import { jstIsoFromEpochMs } from "./util";

export interface RevenueCatWebhookEvent {
  type: string;
  id: string;
  appUserId: string;
  environment: string;
  eventTimestampMs: number;
}

/**
 * RevenueCat webhook の生JSONボディを検証する。型が不正/欠落しているフィールドが1つでもあれば
 * null を返す(fail-closed。呼び出し側は権利を一切付与しない)。
 */
export function parseRevenueCatWebhookEvent(body: Record<string, unknown>): RevenueCatWebhookEvent | null {
  const event = body.event;
  if (!event || typeof event !== "object") return null;
  const e = event as Record<string, unknown>;
  if (
    typeof e.type !== "string" ||
    typeof e.id !== "string" ||
    !e.id ||
    typeof e.app_user_id !== "string" ||
    !e.app_user_id ||
    typeof e.environment !== "string" ||
    typeof e.event_timestamp_ms !== "number"
  ) {
    return null;
  }
  return { type: e.type, id: e.id, appUserId: e.app_user_id, environment: e.environment, eventTimestampMs: e.event_timestamp_ms };
}

/** タイミング攻撃を避けるための定数時間文字列比較(webhook shared secret の照合用)。 */
export function timingSafeEqual(a: string, b: string): boolean {
  const aBytes = new TextEncoder().encode(a);
  const bBytes = new TextEncoder().encode(b);
  if (aBytes.length !== bBytes.length) return false;
  let diff = 0;
  for (let i = 0; i < aBytes.length; i++) diff |= aBytes[i] ^ bBytes[i];
  return diff === 0;
}

export interface RevenueCatEntitlementState {
  /** RevenueCat ダッシュボードで定義した entitlement identifier(例: "pro")。 */
  entitlementId: string;
  productId: string;
  isActive: boolean;
  expiresAtMs: number | null;
}

export interface NormalizedSubscriber {
  appUserId: string;
  entitlements: RevenueCatEntitlementState[];
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * RevenueCat REST API(GET /v1/subscribers/{app_user_id})から正規化済みの購読状態を取得する。
 * webhookペイロード自身のフィールドを直接信用せず、この呼び出しの結果を正とする
 * (RevenueCat公式推奨: 「webhookはトリガー、状態はsubscribers APIで都度取得」)。
 */
export async function fetchSubscriber(secretApiKey: string, appUserId: string, fetchImpl: FetchLike = fetch): Promise<NormalizedSubscriber> {
  const response = await fetchImpl(`https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(appUserId)}`, {
    headers: { Authorization: `Bearer ${secretApiKey}` },
  });
  if (!response.ok) throw new Error(`RevenueCat subscriber fetch failed: ${response.status}`);
  const data = (await response.json()) as {
    subscriber?: { entitlements?: Record<string, { product_identifier?: unknown; is_active?: unknown; expires_date?: unknown }> };
  };
  const raw = data.subscriber?.entitlements ?? {};
  const entitlements: RevenueCatEntitlementState[] = Object.entries(raw).map(([entitlementId, e]) => {
    const parsedExpiry = typeof e.expires_date === "string" ? Date.parse(e.expires_date) : NaN;
    return {
      entitlementId,
      productId: typeof e.product_identifier === "string" ? e.product_identifier : "",
      isActive: e.is_active === true,
      expiresAtMs: Number.isFinite(parsedExpiry) ? parsedExpiry : null,
    };
  });
  return { appUserId, entitlements };
}

export type ApplyRevenueCatResult = { ok: true } | { ok: false; reason: "unknown_entitlement" };

/**
 * 正規化済みの entitlement 状態を purchases/entitlements へ反映する。
 * 呼び出し側(index.ts の postRevenueCatWebhook)が既に webhook shared secret の検証・
 * environment の一致・app_user_id → userId の解決(=アカウント束縛)を済ませたことを前提とする
 * ―― このレイヤーの責務は DB 反映のみに絞る(2026-07-21 の apple_store.ts と同じ「crypto/束縛の検証」と
 * 「DB反映」を分離する設計を踏襲)。
 *
 * eventId は purchases の冪等キー(RevenueCat はwebhook配信をリトライするため、entitlement単位で
 * 一意な external_id が必要)。eventTimestampMs は entitlements.updated_at の monotonic guard に使う
 * (古い通知が新しい権利を巻き戻さないようにする、旧実装と同じ理由)。
 *
 * isActive=false(RevenueCatが失効・返金・キャンセル完了などで無効と判定)を status: "revoked" として
 * 即座に反映することで、旧実装の既知の限界(返金がexpires_atの残り期間だけ露出し続ける)を解消する。
 */
export async function applyRevenueCatEntitlements(
  store: Store,
  userId: string,
  eventId: string,
  eventTimestampMs: number,
  entitlements: readonly RevenueCatEntitlementState[],
): Promise<ApplyRevenueCatResult> {
  const updatedAt = jstIsoFromEpochMs(eventTimestampMs);
  let matchedAny = false;

  for (const ent of entitlements) {
    const item = catalogItemByRevenueCatEntitlementId(ent.entitlementId);
    if (!item) continue;
    matchedAny = true;

    const expiresAt = ent.expiresAtMs !== null ? jstIsoFromEpochMs(ent.expiresAtMs) : null;
    const status = ent.isActive ? "active" : "revoked";

    await store.recordPurchaseIfAbsent({
      userId,
      provider: "revenuecat",
      externalId: `${eventId}:${ent.entitlementId}`,
      productId: ent.productId,
      kind: item.kind,
      status,
      occurredAt: updatedAt,
      expiresAt,
    });
    await store.upsertEntitlement(userId, item.entitlementKey, status, "revenuecat", expiresAt, updatedAt);
  }

  return matchedAny ? { ok: true } : { ok: false, reason: "unknown_entitlement" };
}
