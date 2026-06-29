# VISION — 初回オンボーディング強化 (Web + iOS)

## Goal
v-mate(Aikata)に初回訪問時のオンボーディング体験を追加し、初見ユーザーが「何ができるか・どう話しかけるか」を迷わず理解できるようにする。Web(frontend)とiOSの両方で強化する。

## 現状(Phase 1 Recon)
- `onboarding.ts` (23行): localStorage flag `aikata_onboarded` のみ。`isFirstVisit()` / `markOnboarded()`。
- `useCompanion.ts:387-399`: ready 後 useEffect → `isFirstVisit()` → `requestNudge('greeting', {firstVisit})` → `markOnboarded()`。greeted ref で重複防止。
- `useCompanion.ts:365-379`: AudioContext 解锁需要用户手势（pointerdown/keydown），与 greeting 并行。
- `saveName` は `StatusBar` にある（useCompanion から StatusBar に渡される）。
- VoiceControl.tsx は独自の `vmate.voiceOnboardingSeen` フラグを持つ（既存パターン参考）。
- CSS は単一 `global.css`。App.tsx は `<div.app>` の最初の子にオーバーレイ挿入が自然。
- iOS: `CompanionViewModel.swift` に初回判定なし。`bootstrap()` L64-79 で直接 `requestNudge("greeting")`。
- iOS Views: `RootView.swift`, `ConversationOverlay.swift`, `AvatarView.swift` 等。
- `?condition=` 研究条件は製品版で撤去済み（コードに残存しない）。
- verify: `cd frontend && npx tsc --noEmit -p .` + `npx vite build`。backend: `cd backend && pytest`。

## Definition of Done (verifiable stop condition)
1. **Web**: 初回訪問時にガイド付きオンボーディングUI（ウェルカムカード + 2ステップ: 自己紹介入力 / 話しかけ方の案内）が表示される。完了後は2回目以降非表示（localStorage で制御）。
2. **iOS**: 初回判定（UserDefaults）と初回ガイド（最低: 初回挨拶の明確化 + 使い方ヒント）を追加。
3. **Verify gate green**:
   - `cd frontend && npx tsc --noEmit -p .` → 0 errors
   - `cd frontend && npx vite build` → success
4. 既存機能（チャット・挨拶・音声・日記）の回帰なし。

## Constraints
- localStorage/UserDefaults のみで状態管理（サーバ不要・プライバシー配慮）。
- localStorage 不可環境でも会話成立（既存の安全倒しを継承）。
- AudioContext 解ロック（ユーザー初回ジェスチャ）に干渉しない。
- 最小の verifiable step で進める。

## Refined backlog (smallest verifiable steps)
- [ ] B1: onboarding.ts 拡張 — step 管理 + isFirstVisit → isFirstOnboardingComplete へ拡張
- [ ] B2: OnboardingOverlay.tsx 新規 — ステップUI（Welcome→Name→Hint→Done）+ global.css
- [ ] B3: App.tsx 統合 — オーバーレイ表示 + useCompanion の greeting を onboarding 完了後にゲート
- [ ] B4: iOS 初回判定 + 初回ガイド（CompanionViewModel + RootView）
- [ ] B5: verify gate green + 回帰確認
