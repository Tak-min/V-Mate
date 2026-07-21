/** P3 の読み取り専用商品カタログ。価格と購入可否は StoreKit が正本となる P4 まで持たない。 */
export type CatalogItem = Readonly<{
  id: string;
  entitlementKey: string;
  kind: "subscription" | "voice" | "costume";
  name: string;
  description: string;
}>;

export const CATALOG: readonly CatalogItem[] = Object.freeze([
  Object.freeze({
    id: "vmate.pro",
    entitlementKey: "subscription:pro",
    kind: "subscription",
    name: "シロ Pro",
    description: "会話と声で、もっと長く一緒に過ごすためのプラン。",
  }),
]);

/** StoreKit の productId から商品を引く。未知の productId(詐称・カタログ外)は undefined。 */
export function catalogItemByProductId(productId: string): CatalogItem | undefined {
  return CATALOG.find((item) => item.id === productId);
}
