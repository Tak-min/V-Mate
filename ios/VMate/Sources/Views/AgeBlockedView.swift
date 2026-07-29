import SwiftUI

/// 年齢ゲートで13歳未満と判定されたユーザー向けのブロック画面。
/// アプリ本体への導線は一切持たない終端ビュー(COPPA/Apple 1.3対応、
/// dev-notes/monetization_auth_and_safety_2026-07-20.md §2.1)。
struct AgeBlockedView: View {
    var body: some View {
        ZStack {
            Color.black.opacity(0.25)
                .ignoresSafeArea()

            VStack(spacing: 18) {
                // BrandMark(肉球アイコン)はここでは使わない: 年齢制限で弾く画面に
                // 可愛らしいマスコットマークは文脈的に不適切(お断りの画面はまだ
                // 「歓迎」のトーンを出すべきではない)。hand.raised.fill(手のひら=
                // 「ここまで」のジェスチャー)を維持しつつ、warmBrown(コントラスト不足で
                // 読みにくかった)だけをテーマの標準トークンに差し替える。
                ZStack {
                    Circle()
                        .fill(Color.white.opacity(0.08))
                        .frame(width: 72, height: 72)
                    Image(systemName: "hand.raised.fill")
                        .font(.system(size: 30))
                        .foregroundStyle(.textSecondary)
                }

                VStack(spacing: 8) {
                    Text("ごめんね")
                        .font(.title2.bold())
                        .foregroundStyle(Color.accentPink)
                    Text("このアプリは13歳未満の方はご利用いただけません。\n大きくなったら、また会えるのを楽しみにしてるね。")
                        .font(.callout)
                        .foregroundStyle(.textSecondary)
                        .multilineTextAlignment(.center)
                        .lineSpacing(3)
                }
            }
            .padding(28)
            .background(
                RoundedRectangle(cornerRadius: 26, style: .continuous)
                    .fill(.ultraThinMaterial)
                    .overlay(
                        RoundedRectangle(cornerRadius: 26, style: .continuous)
                            .strokeBorder(Color.accentPink.opacity(0.3), lineWidth: 1)
                    )
                    .shadow(color: Color.accentPink.opacity(0.15), radius: 20, y: 8)
            )
            .padding(.horizontal, 24)
        }
        .interactiveDismissDisabled()
    }
}
