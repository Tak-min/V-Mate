import SwiftUI

/// オンボーディングの「初対面」ステップ。シロが声で自己紹介し、流れの中で名前を尋ね、
/// 受け取った名前を優しく肯定する(2026-07-22: プロジェクトセカイの初回対話演出・
/// Shizuku AIの「声はキャラクターの魂」という設計思想を参考に、タップ+TextField型の
/// 名前入力から音声会話型の初対面体験へ変更。2026-07-23: ウィザードのカード/ドットに
/// 埋め込む代わりに全画面のVN風会話に作り替え。RootView側の本物のアバター(VRM/2D)は
/// このステップの間も裏で描画され続けているため、ここでは何も描画せずtransparentのまま
/// 見せる — emotion/mouthLevelをRootViewへ転送して本物のシロを喋らせる。
struct FirstMeetingStep: View {
    @ObservedObject var viewModel: FirstMeetingViewModel
    let onTextFallback: () -> Void
    let onDone: (String) -> Void
    let onEmotionChange: (Emotion) -> Void
    let onMouthLevelChange: (Double) -> Void

    var body: some View {
        ZStack(alignment: .bottom) {
            Color.clear

            LinearGradient(
                colors: [.clear, .black.opacity(0.55)],
                startPoint: .top,
                endPoint: .bottom
            )
            .frame(maxHeight: .infinity, alignment: .bottom)
            .allowsHitTesting(false)

            VStack(spacing: 12) {
                dialogueBox

                if viewModel.phase != .done && viewModel.phase != .textFallback {
                    Button("名前を入力する") { onTextFallback() }
                        .font(.footnote)
                        .foregroundStyle(.white.opacity(0.6))
                }
            }
            .padding(.horizontal, 20)
            .padding(.bottom, 24)
        }
        .ignoresSafeArea()
        .task { await viewModel.start() }
        .onDisappear { viewModel.teardown() }
        .onChangeOf(viewModel.phase) { phase in
            if phase == .textFallback { onTextFallback() }
            if phase == .done, let name = viewModel.resolvedName { onDone(name) }
        }
        .onChangeOf(viewModel.currentEmotion) { onEmotionChange($0) }
        .onChangeOf(viewModel.mouthLevel) { onMouthLevelChange($0) }
    }

    private var dialogueBox: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("シロ")
                .font(.caption.bold())
                .padding(.horizontal, 10)
                .padding(.vertical, 4)
                .background(LinearGradient.pinkLavender)
                .foregroundStyle(.white)
                .clipShape(Capsule())

            // シロのセリフ。TTSが無音/ミュートでも内容が必ず伝わるよう常に表示する。
            Text(viewModel.caption)
                .font(.title3.weight(.medium))
                .foregroundStyle(.white)
                .multilineTextAlignment(.leading)
                .lineSpacing(4)
                .frame(minHeight: 60, alignment: .top)
                .animation(.easeInOut(duration: 0.2), value: viewModel.caption)

            statusIndicator
                .frame(minHeight: 20)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(18)
        .background(
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .fill(.ultraThinMaterial)
                .overlay(
                    RoundedRectangle(cornerRadius: 22, style: .continuous)
                        .strokeBorder(Color.accentPink.opacity(0.35), lineWidth: 1)
                )
        )
    }

    @ViewBuilder
    private var statusIndicator: some View {
        switch viewModel.phase {
        case .listening:
            VStack(alignment: .leading, spacing: 6) {
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
                        .multilineTextAlignment(.leading)
                }
            }
        case .thinking:
            ProgressView()
                .tint(.white)
        case .speakingIntro, .speakingAskName, .speakingReaction:
            Image(systemName: "waveform")
                .foregroundStyle(Color.accentPink.opacity(0.7))
        default:
            EmptyView()
        }
    }
}
