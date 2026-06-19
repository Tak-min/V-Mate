import SwiftUI

struct RootView: View {
    @StateObject private var viewModel = CompanionViewModel()
    @State private var diaryOpen = false
    @State private var nameDraft = ""
    /// 3D(WKWebView+three-vrm)読み込みに失敗したら v1 のシンプルアバターへ自動フォールバックする。
    @State private var vrmFailed = false

    var body: some View {
        ZStack {
            AmbientBackground(emotion: viewModel.currentEmotion)

            if !viewModel.ready {
                ProgressView("シロを起こしてる…")
                    .tint(.white)
                    .foregroundStyle(.white)
            } else {
                // アバターを画面いっぱいに配置し、キャラクターを「主役」にする
                // (2026-06-19: 会話履歴に押しつぶされて小さく見える問題への対応)。
                avatar
                    .ignoresSafeArea(edges: .bottom)

                VStack(spacing: 0) {
                    header
                    Spacer()
                    ConversationOverlay(viewModel: viewModel)
                }
            }
        }
        .task { await viewModel.bootstrap() }
        .sheet(isPresented: $diaryOpen) { DiaryView() }
        .preferredColorScheme(.dark)
    }

    @ViewBuilder
    private var avatar: some View {
        if vrmFailed {
            AvatarView(emotion: viewModel.currentEmotion, mouthLevel: viewModel.avatarMouthLevel)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            VRMAvatarView(viewModel: viewModel, failed: $vrmFailed)
        }
    }

    private var header: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text("シロ")
                    .font(.headline)
                    .foregroundStyle(.white)
                if let state = viewModel.state {
                    Text("\(state.stage) ・ 親密度 \(state.affinity)")
                        .font(.caption)
                        .foregroundStyle(.white.opacity(0.75))
                }
            }
            Spacer()
            Button {
                viewModel.toggleVoice()
            } label: {
                Image(systemName: viewModel.voiceEnabled ? "speaker.wave.2.fill" : "speaker.slash.fill")
                    .foregroundStyle(.white)
            }
            Button {
                diaryOpen = true
            } label: {
                Image(systemName: "book.closed.fill")
                    .foregroundStyle(.white)
            }
        }
        .padding(.horizontal, 18)
        .padding(.top, 10)
        .padding(.bottom, 6)
        .background(
            LinearGradient(colors: [.black.opacity(0.35), .clear], startPoint: .top, endPoint: .bottom)
                .ignoresSafeArea(edges: .top)
        )
    }
}

#Preview {
    RootView()
}
