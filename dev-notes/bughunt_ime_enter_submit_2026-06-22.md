# バグハント Iter.1 — IME変換中Enterでフォーム送信される不具合 (2026-06-22)

## 症状
日本語入力中、変換候補を確定するためにEnterキーを押すと、確定前の入力(変換途中の文字列、または前回確定した文字列)がそのままチャット送信されてしまう場合がある。`ChatPanel.tsx` の `<form onSubmit={submit}>` は素のEnterキー押下で送信されるため、IME変換確定のEnterと送信トリガーのEnterをブラウザ側が区別してくれない場合がある。

## 原因
`ChatPanel.tsx` の `<input>` に `onKeyDown` ハンドラがなく、`event.nativeEvent.isComposing` を見ていなかった。日本語IMEで変換中にEnterを押すと一部ブラウザ/環境で `compositionend` の発火タイミングと無関係にネイティブのform submitが先に走ることがある(Reactの既知の問題。例: facebook/react#9744 系)。日本語UIのアプリ(本プロダクトの主要言語)ではほぼ確実に踏む不具合。

## 修正
`src/components/ChatPanel.tsx` の入力欄に `onKeyDown` を追加し、`event.key === 'Enter' && event.nativeEvent.isComposing` の場合は `preventDefault()` でネイティブ送信を止める。最小スライス、ロジック変更なし。

## 検証
`cd frontend && npx tsc --noEmit` → エラーなし。

## 関連
- 観点チェックリスト: `.loop/BUGHUNT_VISION.md` の「IME変換中Enterキー処理」項目
- 同根の状態管理粒度の問題(busy/abortRef/idleTimer周り)は次のイテレーションで継続調査。
