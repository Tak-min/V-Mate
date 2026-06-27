# iOS Certificate Pinning 棚上げメモ — 2026-06-27

> ループ: TECHDEBT H7 (部分対応)
> 状態: 未解決・設計判断待ち

## 現状

`ios/VMate/Sources/Networking/APIClient.swift` は `URLSessionConfiguration.default` で標準 TLS 検証のみ。SPKI / Certificate Pinning 無し。

## Pinning を入れるべきでない/入れる際のジレンマ

1. **Cloudflare Workers の証明書は動的ローテ**: Workers の workers.dev ドメイン(本番 `aikata.taku810616.workers.dev`)は Cloudflare が管理する Let's Encrypt 系証明書を持つ。SPKI Pin を埋め込むと Cloudflare 側ロテで即座にiOSアプリが通信不能になる。
2. **アプリ再release の必須化**: Pin はアプリに硬結合されるため、証明書更新のたびに App Store審査→リリース labが走る。高校生プロジェクトの運用リソースに合わない。
3. **iOS の ATS(App Transport Security)** は iOS 9 以降デフォで TLS 1.2/1.3 強制+中間CAを信頼済リストで検証する。workers.dev は ATS で合格するため、SSL-TLSの「中間者攻撃」をATSが既に raining。
4. **Certificate Pinning の現実的 threat model**: `workers.dev` や `Cloudflare Workers` は worker エッジで TLS 終端。エンドユーザが企業プロキシ/被奪取CA 環境にいる場合のみ意味がある。

## 採用した方針(本ループ)

- `httpCookieAcceptPolicy` を `.always` → `.onlyFromMainDocumentDomain` に変更し、リダイレクト等で別オリジンからCookieが注入されるのを防ぐ(本ループで対応済)。
- Certificate Pinning は上記のトレードオフを考慮し、高校生プロジェクトの運用規模では採用しない方向で検討中。
- 将来、カスタムドメイン(`aikata.example.com` 等)へ移行し、自己的固定証明書運用が可能になったら SPKI Pin を見直す。

## 検討すべき代替策

1. **公開鍵 hash fallback**: 証明書の SPKI hash を複数埋め込み、ロテ時は次 hash へ移行。運用手順を docs に書く。
2. **ヘッダー `Public-Key-Pins`**: HTTP レスポンスヘッダで pin を指示。但しHPKPは2018年以降で非推奨(RFC 7469 廃止)。代替として `Expect-CT` も廃止済。ピン送付モデル自体が deprecated。
3. **Cloudflare for Teams + 自前CA**: 組織CAを pin にする。高校生プロジェクトでは overkill。
4. **何もしない(ATS依存)**: iOS 標準 ATS の TLS 強制+信頼済CAリスト検証に頼る。Apple が運用する CA store が信用の要。Workers 証明書は ATS 合格なので、実用上の TLS 安全性は確保される。

## 次のアクション

- [ ] iOS アプリを本番に配るか判定して(public/private testFlight)、運用リソースと天秤
- [ ] カスタムドメイン移行の有無を確認
- [ ] 上記を踏まえ Pin する/しないを決定

---

**関連**: `dev-notes/research_code_segregation_2026-06-25.md`, `.loop/TECHDEBT_VISION.md` H7