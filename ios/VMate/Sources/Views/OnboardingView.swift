import SwiftUI

struct OnboardingView: View {
    let onComplete: (String?) -> Void
    
    @State private var step = 0
    @State private var name = ""
    
    var body: some View {
        ZStack {
            // Semi-transparent backdrop
            Color.black.opacity(0.3)
                .ignoresSafeArea()
            
            // Glass card
            VStack(spacing: 20) {
                // Step dots
                HStack(spacing: 8) {
                    ForEach(0..<3, id: \.self) { i in
                        Circle()
                            .fill(i == step ? Color.accentColor : Color.white.opacity(0.4))
                            .frame(width: 9, height: 9)
                            .scaleEffect(i == step ? 1.2 : 1.0)
                    }
                }
                
                // Step content
                switch step {
                case 0:
                    welcomeStep
                case 1:
                    nameStep
                case 2:
                    hintStep
                default:
                    EmptyView()
                }
            }
            .padding(28)
            .background(
                RoundedRectangle(cornerRadius: 26, style: .continuous)
                    .fill(.ultraThinMaterial)
                    .overlay(
                        RoundedRectangle(cornerRadius: 26, style: .continuous)
                            .strokeBorder(Color.white.opacity(0.3), lineWidth: 1)
                    )
                    .shadow(color: .black.opacity(0.18), radius: 18, y: 8)
            )
            .padding(.horizontal, 24)
        }
        .transition(.opacity)
        .animation(.easeOut(duration: 0.3), value: step)
    }
    
    private var welcomeStep: some View {
        VStack(spacing: 16) {
            Text("はじめまして！")
                .font(.title2.bold())
                .foregroundStyle(Color.accentColor)
            Text("ぼくはシロ、あなたのAIコンパニオンだよ。")
                .font(.body)
                .foregroundStyle(.white.opacity(0.85))
                .multilineTextAlignment(.center)
            Button {
                withAnimation { step = 1 }
            } label: {
                Text("つぎへ")
                    .font(.body.bold())
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 12)
                    .background(Color.accentColor)
                    .foregroundStyle(.white)
                    .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            }
            Button {
                onComplete(nil)
            } label: {
                Text("スキップ")
                    .font(.footnote)
                    .foregroundStyle(.white.opacity(0.6))
                    .underline()
            }
        }
    }
    
    private var nameStep: some View {
        VStack(spacing: 16) {
            Text("おなまえは？")
                .font(.title2.bold())
                .foregroundStyle(Color.accentColor)
            TextField("なまえをいれてね", text: $name)
                .textFieldStyle(.roundedBorder)
                .multilineTextAlignment(.center)
                .submitLabel(.continue)
                .onSubmit {
                    withAnimation { step = 2 }
                }
            HStack(spacing: 12) {
                Button {
                    withAnimation { step = 2 }
                } label: {
                    Text("つぎへ")
                        .font(.body.bold())
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 12)
                        .background(Color.accentColor)
                        .foregroundStyle(.white)
                        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                }
            }
            Button {
                onComplete(nil)
            } label: {
                Text("スキップ")
                    .font(.footnote)
                    .foregroundStyle(.white.opacity(0.6))
                    .underline()
            }
        }
    }
    
    private var hintStep: some View {
        VStack(spacing: 16) {
            Text("話しかけてみて！")
                .font(.title2.bold())
                .foregroundStyle(Color.accentColor)
            
            VStack(spacing: 10) {
                HintRow(icon: "text.bubble", text: "テキストで話しかける")
                HintRow(icon: "mic.fill", text: "マイクで話しかける")
            }
            
            Button {
                onComplete(name.isEmpty ? nil : name)
            } label: {
                Text("はじめる！")
                    .font(.body.bold())
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 12)
                    .background(Color.accentColor)
                    .foregroundStyle(.white)
                    .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            }
        }
    }
}

private struct HintRow: View {
    let icon: String
    let text: String
    
    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: icon)
                .font(.body)
                .frame(width: 24)
                .foregroundStyle(Color.accentColor)
            Text(text)
                .font(.body)
                .foregroundStyle(.white.opacity(0.9))
            Spacer()
        }
        .padding(12)
        .background(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(Color.white.opacity(0.12))
        )
    }
}
