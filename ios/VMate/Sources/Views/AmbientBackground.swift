import SwiftUI

/// 感情に応じて揺らぐ背景グラデーション。Replika等の「柔らかい光・夢見るような雰囲気」の
/// 調査結果(2026-06-19 UI改善ループ)を踏まえ、フラットな白背景をやめて空間に奥行きと
/// 温度感を出す。キャラクターが「ここに存在している」感覚を強める役割。
struct AmbientBackground: View {
    let emotion: Emotion
    @State private var animate = false

    private var colors: [Color] {
        switch emotion {
        case .happy: return [Color(red: 1.0, green: 0.86, blue: 0.62), Color(red: 1.0, green: 0.66, blue: 0.55)]
        case .sad: return [Color(red: 0.36, green: 0.42, blue: 0.62), Color(red: 0.18, green: 0.2, blue: 0.32)]
        case .angry: return [Color(red: 0.62, green: 0.24, blue: 0.3), Color(red: 0.32, green: 0.12, blue: 0.18)]
        case .relaxed: return [Color(red: 0.55, green: 0.78, blue: 0.7), Color(red: 0.24, green: 0.4, blue: 0.42)]
        case .shy: return [Color(red: 0.95, green: 0.72, blue: 0.8), Color(red: 0.62, green: 0.42, blue: 0.55)]
        case .neutral: return [Color(red: 0.45, green: 0.52, blue: 0.72), Color(red: 0.18, green: 0.2, blue: 0.34)]
        }
    }

    var body: some View {
        ZStack {
            LinearGradient(colors: colors, startPoint: .top, endPoint: .bottom)
            RadialGradient(
                colors: [colors[0].opacity(0.55), .clear],
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
