import SwiftUI

/// オンボーディングの「初対面」ステップ。シロが声で自己紹介し、流れの中で名前を尋ね、
/// 受け取った名前を優しく肯定する(2026-07-22: プロジェクトセカイの初回対話演出・
/// Shizuku AIの「声はキャラクターの魂」という設計思想を参考に、タップ+TextField型の
/// 名前入力から音声会話型の初対面体験へ変更)。
struct FirstMeetingStep: View {
    @ObservedObject var viewModel: FirstMeetingViewModel
    let onTextFallback: () -> Void
    let onDone: (String) -> Void

    var body: some View {
        VStack(spacing: 18) {
            ZStack {
                Circle()
                    .fill(LinearGradient.pinkLavender)
                    .frame(width: 64, height: 64)
                    .shadow(color: Color.accentPink.opacity(0.4), radius: 10, y: 4)
                Text("🐾")
                    .font(.system(size: 30))
            }

            // シロのセリフ(吹き出し)。TTSが無音/ミュートでも内容が必ず伝わるよう常に表示する。
            Text(viewModel.caption)
                .font(.callout)
                .foregroundStyle(.white.opacity(0.9))
                .multilineTextAlignment(.center)
                .lineSpacing(3)
                .frame(minHeight: 54)
                .animation(.easeInOut(duration: 0.2), value: viewModel.caption)

            statusIndicator
                .frame(minHeight: 22)

            if viewModel.phase != .done && viewModel.phase != .textFallback {
                Button("名前を入力する") { onTextFallback() }
                    .font(.footnote)
                    .foregroundStyle(.white.opacity(0.5))
            }
        }
        .task { await viewModel.start() }
        .onDisappear { viewModel.teardown() }
        .onChangeOf(viewModel.phase) { phase in
            if phase == .textFallback { onTextFallback() }
            if phase == .done, let name = viewModel.resolvedName { onDone(name) }
        }
    }

    @ViewBuilder
    private var statusIndicator: some View {
        switch viewModel.phase {
        case .listening:
            VStack(spacing: 6) {
                HStack(spacing: 8) {
                    Image(systemName: "mic.fill")
                        .foregroundStyle(Color.accentPink)
                    Text("聞いてるよ…")
                        .font(.footnote)
                        .foregroundStyle(.white.opacity(0.7))
                }
                if !viewModel.partialTranscript.isEmpty {
                    Text(viewModel.partialTranscript)
                        .font(.footnote.italic())
                        .foregroundStyle(Color.accentPink.opacity(0.85))
                        .multilineTextAlignment(.center)
                }
            }
        case .thinking:
            ProgressView()
        case .speakingIntro, .speakingAskName, .speakingReaction:
            Image(systemName: "waveform")
                .foregroundStyle(Color.accentPink.opacity(0.7))
        default:
            EmptyView()
        }
    }
}
