import SwiftUI

/// ペルソナ(22歳女性・可愛いもの好き)に合わせたカラー定義。
/// Web版の oklch 値を SwiftUI の Color に変換。
extension Color {
    /// 淡いピンク — Web版 oklch(75% 0.12 350)
    static let accentPink = Color(red: 0.93, green: 0.55, blue: 0.68)
    /// ラベンダー — Web版 oklch(72% 0.12 300)
    static let accentLavender = Color(red: 0.62, green: 0.55, blue: 0.85)
    /// ウォームアイボリー(アシスタントバブル) — Web版 oklch(97% 0.015 80 / 0.78)
    static let warmIvory = Color(red: 0.98, green: 0.96, blue: 0.93).opacity(0.78)
    /// ウォームブラウン(テキスト) — Web版 oklch(32% 0.04 50)
    static let warmBrown = Color(red: 0.35, green: 0.28, blue: 0.22)
}

extension LinearGradient {
    /// ピンク→ラベンダーのグラデーション(送信ボタン・ユーザーバブル等)
    static let pinkLavender = LinearGradient(
        colors: [.accentPink, .accentLavender],
        startPoint: .topLeading,
        endPoint: .bottomTrailing
    )
}
