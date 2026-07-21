# Web版のメール/パスワードログインが機能していない(未修正・要フォロー) — 2026-07-20

`monetization_auth_and_safety_2026-07-20.md` §0.1 でarchitectが「推測」としていた不整合を実測で確認した。

## 事実

- `frontend/src/features/chat/api.ts` 冒頭コメント(C4)は「JWTはhttpOnly Cookieでサーバ側が保持、
  `credentials: 'include'` だけで送る」設計だと主張しているが、実装(`signup`/`login`)は
  `AuthResult { ok, error }` のみを返し、レスポンスbodyの`token`フィールドを一切読んでいない。
- サーバ側(`worker/src/index.ts` `authSignup`/`authLogin`)は `json({ token })` を**bodyで返す**のみで
  `Set-Cookie` は一切送っていない(`Set-Cookie`はl.359の匿名uid用のみ)。
- `resolveUid()`(`index.ts` 41-48)は `Authorization: Bearer` ヘッダーのみを見る。Cookie由来のJWT読み取りは
  存在しない。`/api/auth/logout` ルートも存在しない(frontend側は呼んでいるが404になるはず)。

## 結果として起きていること

`AuthBar.tsx` でユーザーがsignup/loginすると、サーバ側ではアカウント作成/認証は成功し
`users`テーブルに行が作られ匿名データも引き継がれる。しかし**発行されたJWTがどこにも保存されない**ため、
直後の `window.location.reload()` → `fetchMe()` → `/api/auth/me` は依然として匿名Cookieしか送らず、
`authenticated: false` が返る。ユーザー視点では「登録/ログインしたのに反映されない」ように見える
既知バグ(未報告)。

## 対応方針(今回は着手しない)

このバグは今回のSIWA/年齢ゲート/収益化実装のスコープ外(iOS側はKeychain+Authorization Bearerの
別経路を新規に作るため無関係)。「C4」コメントが意図するhttpOnly Cookie方式をサーバ側で正しく実装するのは
認証のセキュリティ設計変更にあたり、別途エスカレーション(architect)が必要な規模の変更。frontend側だけで
`localStorage`にtoken保存して誤魔化すのはXSS耐性を失わせる後退になるため不採用。

**次にWeb課金(Stripeサブスク)に着手する際、Web側のアカウント永続化が必要になった時点で
この修正に着手すること。** それまでは匿名Cookieベースでも(端末をまたがない前提で)Stripe決済自体は
動作しうるため、収益化実装のブロッカーではない。
