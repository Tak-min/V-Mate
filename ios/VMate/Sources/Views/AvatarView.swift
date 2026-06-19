import SwiftUI

/// v1のアバター表現。本格的なVRM 3Dレンダリングはフォローアップ課題
/// (dev-notes/ios_app_plan_2026-06-19.md 参照)とし、まずは感情(色・表情)と
/// 発話中の口の動き(mouthLevel)を再現したシンプルな表現で「会話している実感」を出す。
struct AvatarView: View {
    let emotion: Emotion
    let mouthLevel: Double

    private var color: Color {
        switch emotion {
        case .happy: return Color(red: 1.0, green: 0.75, blue: 0.35)
        case .sad: return Color(red: 0.45, green: 0.55, blue: 0.85)
        case .angry: return Color(red: 0.95, green: 0.4, blue: 0.4)
        case .relaxed: return Color(red: 0.55, green: 0.85, blue: 0.7)
        case .shy: return Color(red: 0.95, green: 0.6, blue: 0.75)
        case .neutral: return Color(red: 0.7, green: 0.78, blue: 0.95)
        }
    }

    var body: some View {
        ZStack {
            Circle()
                .fill(
                    RadialGradient(
                        colors: [color.opacity(0.9), color.opacity(0.5)],
                        center: .center, startRadius: 4, endRadius: 110
                    )
                )
                .frame(width: 200, height: 200)
                .shadow(color: color.opacity(0.4), radius: 24, y: 8)

            VStack(spacing: 18) {
                HStack(spacing: 36) {
                    eye
                    eye
                }
                mouth
            }
        }
        .animation(.easeInOut(duration: 0.4), value: emotion)
        .animation(.easeOut(duration: 0.08), value: mouthLevel)
    }

    private var eye: some View {
        Capsule()
            .fill(Color.black.opacity(0.75))
            .frame(width: 10, height: emotion == .shy ? 4 : 14)
    }

    private var mouth: some View {
        let openness = max(0.12, mouthLevel)
        return RoundedRectangle(cornerRadius: 10)
            .fill(Color.black.opacity(0.7))
            .frame(width: 46, height: 6 + CGFloat(openness) * 22)
    }
}

#Preview {
    AvatarView(emotion: .happy, mouthLevel: 0.4)
}
