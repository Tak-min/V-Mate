import SwiftUI

struct RootView: View {
    @StateObject private var viewModel = CompanionViewModel()
    @State private var diaryOpen = false
    @State private var nameDraft = ""
    /// 3D(WKWebView+three-vrm)読み込みに失敗したら v1 のシンプルアバターへ自動フォールバックする。
    @State private var vrmFailed = false

    var body: some View {
        VStack(spacing: 0) {
            header
            if !viewModel.ready {
                Spacer()
                ProgressView("シロを起こしてる…")
                Spacer()
            } else {
                avatar
                    .frame(height: 220)
                    .padding(.top, 4)
                ChatView(viewModel: viewModel)
            }
        }
        .task { await viewModel.bootstrap() }
        .sheet(isPresented: $diaryOpen) { DiaryView() }
    }

    @ViewBuilder
    private var avatar: some View {
        if vrmFailed {
            AvatarView(emotion: viewModel.currentEmotion, mouthLevel: viewModel.avatarMouthLevel)
        } else {
            VRMAvatarView(viewModel: viewModel, failed: $vrmFailed)
        }
    }

    private var header: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text("シロ").font(.headline)
                if let state = viewModel.state {
                    Text("\(state.stage) ・ 親密度 \(state.affinity)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            Spacer()
            Button {
                viewModel.toggleVoice()
            } label: {
                Image(systemName: viewModel.voiceEnabled ? "speaker.wave.2.fill" : "speaker.slash.fill")
            }
            Button {
                diaryOpen = true
            } label: {
                Image(systemName: "book.closed.fill")
            }
        }
        .padding()
    }
}

#Preview {
    RootView()
}
