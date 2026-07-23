/** P3 の読み取り専用商品カタログ。価格と購入可否は RevenueCat/StoreKit が正本。 */
export type CatalogItem = Readonly<{
  id: string;
  entitlementKey: string;
  /** RevenueCat ダッシュボードで定義する Entitlement の identifier(webhook/subscriber APIのキー)。 */
  revenueCatEntitlementId: string;
  kind: "subscription" | "voice" | "costume";
  name: string;
  description: string;
}>;

export const CATALOG: readonly CatalogItem[] = Object.freeze([
  Object.freeze({
    id: "vmate.pro",
    entitlementKey: "subscription:pro",
    revenueCatEntitlementId: "pro",
    kind: "subscription",
    name: "シロ Pro",
    description: "会話と声で、もっと長く一緒に過ごすためのプラン。",
  }),
]);

/** RevenueCat の entitlement identifier から商品を引く。未知の値(カタログ外)は undefined。 */
export function catalogItemByRevenueCatEntitlementId(entitlementId: string): CatalogItem | undefined {
  return CATALOG.find((item) => item.revenueCatEntitlementId === entitlementId);
}
