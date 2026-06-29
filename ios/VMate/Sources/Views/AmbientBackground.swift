import SwiftUI

/// 感情に応じて揺らぐ背景グラデーション。
/// ペルソナ(22歳女性・可愛いもの好き)に合わせ、暗いトーンを避け
/// 温かく柔らかいパステルカラーで「心理的に安全で安心できる居場所」を演出。
struct AmbientBackground: View {
    let emotion: Emotion
    @State private var animate = false

    private var colors: [Color] {
        switch emotion {
        case .happy:
            // 明るいピーチ → ゴールド（嬉しい・温かい）
            return [
                Color(red: 1.0, green: 0.88, blue: 0.78),
                Color(red: 0.98, green: 0.75, blue: 0.65)
            ]
        case .sad:
            // 柔らかいラベンダー → ミントブルー（少し落ち込むけど優しい）
            return [
                Color(red: 0.78, green: 0.75, blue: 0.88),
                Color(red: 0.65, green: 0.7, blue: 0.85)
            ]
        case .angry:
            // ミューテッドローズ → ダストピンク（尖らない怒り）
            return [
                Color(red: 0.85, green: 0.6, blue: 0.65),
                Color(red: 0.75, green: 0.5, blue: 0.58)
            ]
        case .relaxed:
            // ソフトミント → セージグリーン（リラックス・癒やし）
            return [
                Color(red: 0.72, green: 0.85, blue: 0.78),
                Color(red: 0.6, green: 0.75, blue: 0.68)
            ]
        case .shy:
            // ブラッシュピンク → ローズ（照れ・可愛い）
            return [
                Color(red: 0.95, green: 0.78, blue: 0.82),
                Color(red: 0.88, green: 0.65, blue: 0.72)
            ]
        case .neutral:
            // ソフトラベンダー → ピーチピンク（デフォルト・夢見る雰囲気）
            return [
                Color(red: 0.85, green: 0.78, blue: 0.88),
                Color(red: 0.92, green: 0.78, blue: 0.75)
            ]
        }
    }

    var body: some View {
        ZStack {
            LinearGradient(colors: colors, startPoint: .top, endPoint: .bottom)
            RadialGradient(
                colors: [colors[0].opacity(0.5), .clear],
                center: animate ? .topTrailing : .topLeading,
                startRadius: 20, endRadius: 420
            )
            .blendMode(.plusLighter)
        }
        .ignoresSafeArea()
        .animation(.easeInOut(duration: 1.6), value: emotion)
        .onAppear {
            withAnimation(.easeInOut(duration: 9).repeatForever(autoreverses: true)) {
                animate = true
            }
        }
    }
}
