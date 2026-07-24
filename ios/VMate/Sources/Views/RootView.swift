import SwiftUI

// 親密度ステージの閾値と名前(Web版 StatusBar.tsx の STAGE_FLOORS/STAGE_NAMES と同一)
private let STAGE_FLOORS = [0, 20, 50, 100, 200]
private let STAGE_NAMES  = ["はじめまして", "顔なじみ", "友達", "親友", "相棒"]
private let STAGE_UP_DURATION: TimeInterval = 2.4

/// 現在のステージ内進捗(0.0〜1.0)を計算する。Web版 stageProgress() の移植。
private func stageProgress(affinity: Int, nextStageAt: Int?) -> Double {
    guard let next = nextStageAt else { return 1.0 }
    let floor = STAGE_FLOORS.reversed().first { affinity >= $0 } ?? 0
    let span = next - floor
    guard span > 0 else { return 1.0 }
    return min(max(Double(affinity - floor) / Double(span), 0), 1)
}

private func nextStageName(nextStageAt: Int?) -> String? {
    guard let next = nextStageAt,
          let idx = STAGE_FLOORS.firstIndex(of: next),
          idx < STAGE_NAMES.count else { return nil }
    return STAGE_NAMES[idx]
}

struct RootView: View {
    @StateObject private var viewModel = CompanionViewModel()
    @State private var diaryOpen = false
    @State private var nameDraft = ""
    /// 3D(WKWebView+three-vrm)読み込みに失敗したら v1 のシンプルアバターへ自動フォールバックする。
    @State private var vrmFailed = false
    @State private var showOnboarding = false
    /// `showOnboarding`はbootstrap()完了後まで決まらないため、その初期値(false)のまま
    /// 判定前のレンダリングが走ると「本来はオンボーディング行きの初回ユーザーなのに、
    /// 判定が終わるまでの一瞬だけヘッダー/会話UIとアバターが見えてしまう」チラつきが
    /// 起きていた(2026-07-24 reveal演出QAで発見)。判定完了までは`!viewModel.ready`と
    /// 同じ「起こしてる…」表示のまま待たせることでこれを防ぐ。
    @State private var onboardingDecided = false
    @State private var isStageUp = false
    @State private var previousStage: String? = nil
    @State private var accountOpen = false

    var body: some View {
        ZStack {
            AmbientBackground(emotion: viewModel.currentEmotion)

            if !viewModel.ready || !onboardingDecided {
                ProgressView("シロを起こしてる…")
                    .tint(.white)
                    .foregroundStyle(.white)
            } else {
                // アバターを画面いっぱいに配置し、キャラクターを「主役」にする
                // (2026-06-19: 会話履歴に押しつぶされて小さく見える問題への対応)。
                avatar
                    .ignoresSafeArea(edges: .bottom)

                // オンボーディング中はヘッダー(親密度バー等)とチャットUIを隠す。
                // まだ関係が始まっていない初回ユーザーに「空の実績」や会話の複雑さを
                // 先に見せてしまうと、オンボーディングカードが伝えたい「はじめまして」の
                // 純度が薄まるため(2026-07-22 FTUEレビュー)。
                if !showOnboarding {
                    VStack(spacing: 0) {
                        header
                        Spacer()
                        ConversationOverlay(viewModel: viewModel)
                    }
                }
            }
        }
        .task {
            await viewModel.bootstrap()
            showOnboarding = viewModel.isFirstRun || viewModel.ageBand == nil || viewModel.ageBand == "under13"
            onboardingDecided = true
            if showOnboarding { APIClient.shared.trackEvent("onboarding_started") }
        }
        .onChangeOf(viewModel.state?.stage) { newStage in
            guard let prev = previousStage, let next = newStage, prev != next else {
                previousStage = viewModel.state?.stage
                return
            }
            previousStage = next
            UIImpactFeedbackGenerator(style: .medium).impactOccurred()
            withAnimation(.spring(response: 0.4, dampingFraction: 0.7)) { isStageUp = true }
            Task { @MainActor in
                try? await Task.sleep(for: .seconds(STAGE_UP_DURATION))
                withAnimation { isStageUp = false }
            }
        }
        .sheet(isPresented: $diaryOpen) { DiaryView() }
        .sheet(isPresented: $accountOpen) { AccountView() }
        .fullScreenCover(isPresented: $showOnboarding) {
            if viewModel.ageBand == "under13" {
                AgeBlockedView()
            } else {
                OnboardingView(
                    initialStep: onboardingInitialStep,
                    onAgeVerified: { viewModel.updateAgeBand($0) },
                    onReachReveal: { viewModel.isReadyToReveal = true },
                    onRevealCharacter: { viewModel.isCharacterRevealed = true },
                    avatarReady: viewModel.isAvatarLoaded,
                    avatarFailed: vrmFailed,
                    onIntroEmotion: { viewModel.currentEmotion = $0 },
                    onIntroMouthLevel: { viewModel.avatarMouthLevel = $0 }
                ) { name, alreadyGreeted in
                    if let name = name {
                        viewModel.saveName(name)
                    }
                    viewModel.markOnboarded()
                    APIClient.shared.trackEvent("onboarding_completed")
                    // 音声の初対面で既にシロが名前へ反応済みなら、独白挨拶(fireGreeting)は
                    // 二重挨拶になるため呼ばない(2026-07-22)。
                    if alreadyGreeted {
                        viewModel.markGreeted()
                    } else {
                        viewModel.fireGreeting()
                    }
                    showOnboarding = false
                }
                .background(TransparentBackground())
            }
        }
        .preferredColorScheme(.dark)
    }

    /// アプリがオンボーディング途中(年齢確認後〜reveal演出前)で強制終了→再起動された場合に、
    /// 最初(welcome)からやり直させず正しい位置から再開させる。ageBandはサーバ側に永続化済みなので、
    /// これが minor/adult ということは(showOnboardingがtrueの時点で)年齢確認は既に完了している。
    private var onboardingInitialStep: Int {
        if viewModel.ageBand == "minor" || viewModel.ageBand == "adult" {
            return 2
        }
        return viewModel.isFirstRun ? 0 : 1
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

    /// オンボーディング中はreveal画面(年齢確認後のタップ演出)に到達するまでアバターを一切マウントしない
    /// (=読み込みも開始しない)。完了済みユーザーはshowOnboardingが最初からfalseなので即座にtrueになる。
    private var avatarMounted: Bool { !showOnboarding || viewModel.isReadyToReveal }
    /// タップでreveal演出が発火するまでキャラクターを不可視にする(マウント自体は先読みのため先に行う)。
    private var characterVisible: Bool { !showOnboarding || viewModel.isCharacterRevealed }

    @ViewBuilder
    private var avatar: some View {
        if !avatarMounted {
            Color.clear
        } else if vrmFailed {
            // 実際のVRM読み込み失敗(通信断・パースエラー等)時のみ v1 アバターへフォールバックする。
            // reveal演出の可視状態とは無関係の、独立したエラー救済経路。
            AvatarView(emotion: viewModel.currentEmotion, mouthLevel: viewModel.avatarMouthLevel)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            VRMAvatarView(
                viewModel: viewModel,
                failed: $vrmFailed,
                onLoadFinished: { viewModel.isAvatarLoaded = true }
            )
            .opacity(characterVisible ? 1 : 0)
            .scaleEffect(characterVisible ? 1 : 0.92)
            .animation(.easeOut(duration: 0.6), value: characterVisible)
        }
    }

    private var header: some View {
        VStack(spacing: 8) {
            // おかえりバナー (Web版 ChatPanel の daysAway バナーに相当)
            if let days = viewModel.daysAway {
                HStack {
                    Text("おかえり。\(days)日ぶりだね。")
                        .font(.caption.weight(.medium))
                        .foregroundStyle(.white.opacity(0.85))
                        .padding(.horizontal, 12)
                        .padding(.vertical, 5)
                        .background {
                            Capsule()
                                .fill(Color.accentPink.opacity(0.2))
                                .overlay(Capsule().strokeBorder(Color.accentPink.opacity(0.4), lineWidth: 1))
                        }
                    Spacer()
                }
                .transition(.opacity.combined(with: .move(edge: .top)))
            }

            // Row 1: 操作ボタン(右寄せ・独立行)。身元情報と幅を奪い合わないよう別行にする
            // (2026-07-23: 同じHStack内で.layoutPriority(1)を与えていたため、画面幅に関わらず
            // 身元VStackが実質幅ゼロまで潰れ「はじめまして」が1文字ずつ縦に折り返されるバグがあった)。
            HStack(spacing: Space.sm) {
                Spacer(minLength: 0)
                controlCluster
            }
            // Row 2: 身元+親密度(フル幅)
            identityColumn
                .frame(maxWidth: .infinity, alignment: .leading)
            if let voiceError = viewModel.voiceError {
                HStack(spacing: 6) {
                    Image(systemName: "exclamationmark.circle.fill")
                        .font(.caption2)
                    Text(voiceError)
                        .font(.caption2)
                        .lineLimit(2)
                    Spacer()
                    Button {
                        withAnimation { viewModel.voiceError = nil }
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .font(.caption)
                            .foregroundStyle(.white.opacity(0.55))
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("エラーを閉じる")
                }
                .foregroundStyle(.white.opacity(0.85))
                .transition(.opacity.combined(with: .move(edge: .top)))
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

    private var identityColumn: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("シロ")
                .font(.brandHeading)
                .foregroundStyle(Color.accentPink)
            if let state = viewModel.state {
                // ステージアップ通知 or 通常の親密度表示
                if isStageUp {
                    Text("『\(state.stage)』になったよ ✨")
                        .font(.brandCaption.weight(.semibold))
                        .foregroundStyle(Color.accentPink)
                        .transition(.opacity.combined(with: .scale(scale: 0.9)))
                } else {
                    VStack(alignment: .leading, spacing: 3) {
                        HStack(spacing: 6) {
                            Text(state.stage)
                                .font(.brandCaption)
                                .foregroundStyle(.textSecondary)
                            Text("♡ \(state.affinity)")
                                .font(.brandCaption)
                                .foregroundStyle(Color.accentPink.opacity(0.9))
                            if let next = nextStageName(nextStageAt: state.next_stage_at),
                               let remain = state.next_stage_at.map({ max($0 - state.affinity, 0) }) {
                                Text("あと\(remain)で『\(next)』")
                                    .font(.caption2)
                                    .foregroundStyle(.textTertiary)
                                    .lineLimit(1)
                                    .minimumScaleFactor(0.8)
                            }
                        }
                        // 親密度プログレスバー
                        GeometryReader { geo in
                            ZStack(alignment: .leading) {
                                RoundedRectangle(cornerRadius: 2)
                                    .fill(Color.white.opacity(0.12))
                                RoundedRectangle(cornerRadius: 2)
                                    .fill(LinearGradient.pinkLavender)
                                    .frame(width: geo.size.width * stageProgress(affinity: state.affinity, nextStageAt: state.next_stage_at))
                                    .animation(.spring(response: 0.6, dampingFraction: 0.8), value: state.affinity)
                            }
                        }
                        .frame(height: 4)
                    }
                }
            }
        }
        .animation(.easeInOut(duration: 0.3), value: isStageUp)
    }

    private var controlCluster: some View {
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
            HeaderControlButton(
                icon: "person.crop.circle",
                label: "アカウント",
                isActive: APIClient.shared.isAuthenticated,
                accessibilityLabel: "アカウントを開く"
            ) {
                accountOpen = true
            }
        }
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
            .background {
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .fill(isActive ? AnyShapeStyle(LinearGradient.pinkLavender) : AnyShapeStyle(Color.white.opacity(0.16)))
            }
            .overlay(
                RoundedRectangle(cornerRadius: 16, style: .continuous)
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
