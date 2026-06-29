import SwiftUI

struct RootView: View {
    @StateObject private var viewModel = CompanionViewModel()
    @State private var diaryOpen = false
    @State private var nameDraft = ""
    /// 3D(WKWebView+three-vrm)読み込みに失敗したら v1 のシンプルアバターへ自動フォールバックする。
    @State private var vrmFailed = false
    @State private var showOnboarding = false

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
        .task {
            await viewModel.bootstrap()
            if viewModel.isFirstRun {
                showOnboarding = true
            }
        }
        .sheet(isPresented: $diaryOpen) { DiaryView() }
        .fullScreenCover(isPresented: $showOnboarding) {
            OnboardingView { name in
                if let name = name {
                    viewModel.saveName(name)
                }
                viewModel.markOnboarded()
                viewModel.fireGreeting()
                showOnboarding = false
            }
            .background(TransparentBackground())
        }
        .preferredColorScheme(.dark)
    }

    private var micIconName: String {
        switch viewModel.voiceMode {
        case .off: return "mic.slash.fill"
        case .listening: return "mic.fill"
        case .thinking: return "ellipsis.circle.fill"
        case .speaking: return "waveform"
        }
    }

    /// マイク(音声会話)ボタンのラベル。現在のモードが一目で分かるよう動的に変える。
    private var micLabel: String {
        switch viewModel.voiceMode {
        case .off: return "音声会話"
        case .listening: return "聞き取り中"
        case .thinking: return "考え中"
        case .speaking: return "お話し中"
        }
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
        VStack(spacing: 8) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("シロ")
                        .font(.headline)
                        .foregroundStyle(.white)
                    if let state = viewModel.state {
                        Text("\(state.stage) ・ 親密度 \(state.affinity)")
                            .font(.caption)
                            .foregroundStyle(.white.opacity(0.75))
                            .lineLimit(1)
                            .minimumScaleFactor(0.8)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                Spacer(minLength: 8)
                // 狭い画面(iPhone SE等 375pt)でも操作ボタン行が潰れないよう優先度を上げる。
                // タイトル側は lineLimit(1)+minimumScaleFactor で先に縮む。
                HStack(spacing: 8) {
                    HeaderControlButton(
                        icon: micIconName,
                        label: micLabel,
                        isActive: viewModel.voiceMode != .off,
                        accessibilityLabel: "音声会話。\(viewModel.voiceMode == .off ? "オフ。タップで開始" : "オン。\(micLabel)。タップで停止")"
                    ) {
                        Task { await viewModel.toggleHandsFree() }
                    }
                    HeaderControlButton(
                        icon: viewModel.voiceEnabled ? "speaker.wave.2.fill" : "speaker.slash.fill",
                        label: "シロの声",
                        isActive: viewModel.voiceEnabled,
                        accessibilityLabel: "シロの声。\(viewModel.voiceEnabled ? "オン。タップでミュート" : "ミュート中。タップでオン")"
                    ) {
                        viewModel.toggleVoice()
                    }
                    HeaderControlButton(
                        icon: "book.closed.fill",
                        label: "日記",
                        isActive: false,
                        accessibilityLabel: "シロの日記を開く"
                    ) {
                        diaryOpen = true
                    }
                }
                .layoutPriority(1)
            }
            if let voiceError = viewModel.voiceError {
                HStack(spacing: 6) {
                    Image(systemName: "exclamationmark.circle.fill")
                        .font(.caption2)
                    Text(voiceError)
                        .font(.caption2)
                        .lineLimit(2)
                    Spacer()
                }
                .foregroundStyle(.white.opacity(0.85))
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 10)
        .padding(.bottom, 8)
        .background(
            LinearGradient(colors: [.black.opacity(0.4), .clear], startPoint: .top, endPoint: .bottom)
                .ignoresSafeArea(edges: .top)
        )
    }
}

/// ヘッダーの操作ボタン。アイコン+ラベル+タップ可能な背景+状態色で「どこに何のボタンがあるか」を
/// 一目で分かるようにする(アイコンのみ・白一色で機能不明だった問題への対応)。
/// アクティブ時(音声会話ON/シロの声ON)はアクセントカラーで塗り、状態を可視化する。
private struct HeaderControlButton: View {
    let icon: String
    let label: String
    var isActive: Bool = false
    var accessibilityLabel: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(spacing: 3) {
                Image(systemName: icon)
                    .font(.system(size: 17, weight: .semibold))
                    .frame(height: 20)
                Text(label)
                    .font(.system(size: 10, weight: .medium))
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
            }
            .frame(minWidth: 58)
            .padding(.vertical, 8)
            .padding(.horizontal, 8)
            .foregroundStyle(isActive ? Color.white : Color.white.opacity(0.92))
            .background(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .fill(isActive ? Color.accentColor : Color.white.opacity(0.16))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .strokeBorder(Color.white.opacity(isActive ? 0.0 : 0.22), lineWidth: 1)
            )
            .shadow(color: .black.opacity(0.18), radius: 4, y: 2)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(accessibilityLabel)
    }
}

/// fullScreenCover のデフォルト背景色(白/黒)を透明にするヘルパー。
private struct TransparentBackground: UIViewRepresentable {
    func makeUIView(context: Context) -> UIView {
        let view = UIView()
        DispatchQueue.main.async {
            view.superview?.superview?.backgroundColor = .clear
        }
        return view
    }
    func updateUIView(_ uiView: UIView, context: Context) {}
}

#Preview {
    RootView()
}
