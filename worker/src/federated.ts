/** フェデレーション認証(Apple / Google / LINE)の共通型。
 *
 * providerごとの検証実装(apple_auth.ts / google_auth.ts / line_auth.ts)はこの型を返す。
 * email は表示用のみとして扱い、アカウントの識別・リンクキーには使わない
 * (Apple の private relay や、providerごとに検証保証レベルが異なるメールを
 *  結合キーにすると、最弱の環にシステム全体の強度が引きずられるため)。 */

export type AuthProvider = "apple" | "google" | "line";

export interface FederatedIdentity {
  provider: AuthProvider;
  subject: string;
  email: string | null;
}

export class FederatedTokenError extends Error {}
