import SwiftUI
import AudioToolbox

struct OnboardingView: View {
    let onAgeVerified: (String) -> Void
    /// reveal画面(タップでキャラクターを迎える演出)に到達した瞬間に一度だけ呼ぶ。
    /// RootView側はこれを合図に裏でVRMの読み込みを開始する(タップ時点では手遅れなので先読みが必要)。
    let onReachReveal: () -> Void
    /// reveal画面をユーザーがタップした瞬間に呼ぶ。RootView側はこれでキャラクターをフェードインさせる。
    let onRevealCharacter: () -> Void
    /// RootView側のVRM読み込みが完了しているか。reveal画面のタップ操作の有効化に使う。
    let avatarReady: Bool
    /// RootView側のVRM読み込みが失敗しているか。失敗時は2Dフォールバックへ切り替わることが
    /// 確定しているので、成功を待たずタップを有効化してよい(無限に待たせない)。
    let avatarFailed: Bool
    /// 第2引数は「音声の初対面で既にシロが名前へ反応済み(=はじめましての挨拶は済んでいる)か」。
    /// trueならRootView側は独白挨拶(fireGreeting)を重ねて呼ばない。
    let onComplete: (String?, Bool) -> Void
    /// 音声の初対面ステップの間、RootView側の本物のアバターへ感情/リップシンクを転送する。
    let onIntroEmotion: (Emotion) -> Void
    let onIntroMouthLevel: (Double) -> Void

    // ステップ: 0=welcome, 1=年齢確認, 2=reveal(新規: タップでキャラクター登場),
    // 3=name(音声の初対面。失敗時は手入力), 4=hint
    @State private var step: Int
    @State private var name = ""
    @State private var goingForward = true
    @FocusState private var nameFieldFocused: Bool
    @StateObject private var firstMeeting = FirstMeetingViewModel()
    /// step3の見せ方。音声の初対面を既定とし、権限拒否・聞き取り失敗の繰り返し・通信エラー等で
    /// 自動的にtrueへ切り替わる(FirstMeetingStepのonTextFallback経由)。
    @State private var nameCaptureFallbackToText = false
    /// reveal画面: タップ後のカーテン/プロンプトのフェードアウト演出中フラグ(多重タップ防止も兼ねる)。
    @State private var isRevealing = false
    /// reveal画面: 読み込みが数秒経っても終わらない場合のフォールバック有効化(ハングでタップ不能にしない)。
    @State private var revealTapFallbackElapsed = false

    /// 音声の初対面中はウィザードのカード/ドット/暗幕を消し、RootViewの本物のアバターを
    /// 全画面で見せる(プロジェクトセカイ的な「キャラクターとの初対面」の没入感を優先)。
    /// それ以外のステップ(年齢確認・ヒント等)は従来通りカード型ウィザードのまま。
    private var isImmersiveFirstMeeting: Bool { step == 3 && !nameCaptureFallbackToText }

    // --- 年齢ゲート ---
    // 13歳未満/18歳ちょうどを挟んだ判定が誤らないよう、デフォルトは意図的に「12歳」寄りに
    // 倒さない中立値(16年前)にする。サーバ側(agegate.ts computeAgeBand)がband の唯一の権威。
    @State private var birthDate = Calendar.current.date(byAdding: .year, value: -16, to: Date()) ?? Date()
    @State private var ageCheckInFlight = false
    @State private var ageError: String?
    @State private var isAgeBlocked = false

    init(
        initialStep: Int = 0,
        onAgeVerified: @escaping (String) -> Void = { _ in },
        onReachReveal: @escaping () -> Void = {},
        onRevealCharacter: @escaping () -> Void = {},
        avatarReady: Bool = false,
        avatarFailed: Bool = false,
        onIntroEmotion: @escaping (Emotion) -> Void = { _ in },
        onIntroMouthLevel: @escaping (Double) -> Void = { _ in },
        onComplete: @escaping (String?, Bool) -> Void
    ) {
        self.onAgeVerified = onAgeVerified
        self.onReachReveal = onReachReveal
        self.onRevealCharacter = onRevealCharacter
        self.avatarReady = avatarReady
        self.avatarFailed = avatarFailed
        self.onIntroEmotion = onIntroEmotion
        self.onIntroMouthLevel = onIntroMouthLevel
        self.onComplete = onComplete
        #if DEBUG
        // UX目視レビュー用: 実機/シミュレータでタップ操作なしに任意ステップへ直接ジャンプする。
        // 通常起動時はこの環境変数は存在しないため本番挙動に影響しない。
        if let forced = ProcessInfo.processInfo.environment["UITEST_ONBOARDING_STEP"].flatMap(Int.init) {
            _step = State(initialValue: forced)
        } else {
            _step = State(initialValue: initialStep)
        }
        #else
        _step = State(initialValue: initialStep)
        #endif
    }

    var body: some View {
        if isAgeBlocked {
            // 13歳未満と判定された場合、以降のオンボーディングには一切進めない
            // (onComplete も呼ばない。COPPA/Apple 1.3対応)。
            AgeBlockedView()
        } else if isImmersiveFirstMeeting {
            // 音声の初対面: ウィザードの暗幕/カード/ドットを一切出さず、RootViewが裏で
            // 描画し続けている本物のアバターをそのまま全画面で見せる。
            FirstMeetingStep(
                viewModel: firstMeeting,
                onTextFallback: {
                    withAnimation(.easeInOut(duration: 0.4)) { nameCaptureFallbackToText = true }
                },
                onDone: { resolvedName in
                    name = resolvedName
                    advance()
                },
                onEmotionChange: onIntroEmotion,
                onMouthLevelChange: onIntroMouthLevel
            )
            .transition(.opacity)
        } else if step == 2 {
            // reveal: 年齢確認直後、キャラクターはまだ一切マウントされていない(RootView側でゲート済み)。
            // タップされた瞬間に先読み済みのVRMをフェードインさせつつ次のstepへ進む。
            revealStep
                .transition(.opacity)
        } else {
            ZStack {
                // RootView側でヘッダー/チャットUIは隠しているため、ここではアバターの気配を
                // 覆いすぎない程度に暗くする(2026-07-22: 0.25では背後のUIが読めてしまっていた)。
                Color.black.opacity(0.45)
                    .ignoresSafeArea()

                VStack(spacing: 20) {
                    stepDots

                    ZStack {
                        if step == 0 {
                            welcomeStep
                                .transition(slideTransition)
                        } else if step == 1 {
                            ageStep
                                .transition(slideTransition)
                        } else if step == 3 {
                            // 音声が使えず手入力へ切り替わった場合のみここに来る。
                            nameStep
                                .transition(slideTransition)
                        } else if step == 4 {
                            hintStep
                                .transition(slideTransition)
                        }
                    }
                    .clipped()
                    .animation(.spring(response: 0.35, dampingFraction: 0.7), value: step)
                }
                .padding(28)
                .background(
                    RoundedRectangle(cornerRadius: 26, style: .continuous)
                        .fill(.ultraThinMaterial)
                        .overlay(
                            RoundedRectangle(cornerRadius: 26, style: .continuous)
                                .strokeBorder(Color.accentPink.opacity(0.3), lineWidth: 1)
                        )
                        .shadow(color: Color.accentPink.opacity(0.15), radius: 20, y: 8)
                )
                .padding(.horizontal, 24)
            }
            .transition(.opacity)
        }
    }

    // MARK: - Navigation

    private func advance() {
        goingForward = true
        withAnimation(.spring(response: 0.35, dampingFraction: 0.7)) { step += 1 }
    }

    private func retreat() {
        goingForward = false
        withAnimation(.spring(response: 0.35, dampingFraction: 0.7)) { step -= 1 }
    }

    private var slideTransition: AnyTransition {
        .asymmetric(
            insertion: .move(edge: goingForward ? .trailing : .leading).combined(with: .opacity),
            removal: .move(edge: goingForward ? .leading : .trailing).combined(with: .opacity)
        )
    }

    // MARK: - Step indicator

    private var stepDots: some View {
        HStack(spacing: 8) {
            ForEach(0..<5, id: \.self) { i in
                Capsule()
                    .fill(i == step ? Color.accentPink : Color.white.opacity(0.35))
                    .frame(width: i == step ? 20 : 9, height: 9)
                    .animation(.spring(response: 0.3, dampingFraction: 0.6), value: step)
            }
        }
        .accessibilityElement()
        .accessibilityLabel("オンボーディングの進み具合")
        .accessibilityValue("ステップ \(step + 1) / 5")
    }

    // MARK: - Step 0: Welcome

    private var welcomeStep: some View {
        VStack(spacing: 18) {
            // シロのアイコン
            ZStack {
                Circle()
                    .fill(LinearGradient.pinkLavender)
                    .frame(width: 72, height: 72)
                    .shadow(color: Color.accentPink.opacity(0.4), radius: 10, y: 4)
                Text("🐾")
                    .font(.system(size: 34))
            }

            VStack(spacing: 8) {
                Text("はじめまして！")
                    .font(.title2.bold())
                    .foregroundStyle(Color.accentPink)
                Text("ぼくはシロ。\n話すほどあなたのことを覚えて、\n毎日をいっしょに振り返る相棒だよ。")
                    .font(.callout)
                    .foregroundStyle(Color.white.opacity(0.85))
                    .multilineTextAlignment(.center)
                    .lineSpacing(3)
                Text("このあと、声で挨拶するね")
                    .font(.caption)
                    .foregroundStyle(.white.opacity(0.5))
            }

            nextButton("つぎへ") { advance() }

        }
    }

    // MARK: - Step 1: 年齢確認

    private var ageStep: some View {
        VStack(spacing: 16) {
            VStack(spacing: 6) {
                Text("うまれた日をおしえてね")
                    .font(.title2.bold())
                    .foregroundStyle(Color.accentPink)
                Text("安心して使ってもらうための確認だよ。\n入力した内容は他の人には見えないよ。")
                    .font(.callout)
                    .foregroundStyle(Color.white.opacity(0.8))
                    .multilineTextAlignment(.center)
                    .lineSpacing(3)
            }

            DatePicker("", selection: $birthDate, displayedComponents: .date)
                .datePickerStyle(.wheel)
                .labelsHidden()
                .frame(maxHeight: 160)
                // 端末のシステム地域設定に関わらず月名等を日本語で表示する。アプリ全体が日本語
                // 固定UIのため、DatePickerだけ端末ロケール依存で"July"等の英語表記になり
                // 浮いてしまう問題への対応(2026-07-24 reveal演出QAで発見)。
                .environment(\.locale, Locale(identifier: "ja_JP"))

            if let ageError {
                Text(ageError)
                    .font(.caption)
                    .foregroundStyle(.red.opacity(0.8))
            }

            nextButton(ageCheckInFlight ? "確認中…" : "つぎへ") { submitAge() }
                .disabled(ageCheckInFlight)

            backButton()
        }
    }

    private func submitAge() {
        ageError = nil
        ageCheckInFlight = true
        Task {
            defer { ageCheckInFlight = false }
            do {
                let response = try await APIClient.shared.setAge(birthDate: Self.isoDateFormatter.string(from: birthDate))
                guard let band = response.age_band else {
                    ageError = "確認できなかったよ。もう一度試してみてね。"
                    return
                }
                onAgeVerified(band)
                APIClient.shared.trackEvent("onboarding_age_verified")
                if band == "under13" {
                    withAnimation { isAgeBlocked = true }
                } else {
                    advance()
                }
            } catch {
                ageError = "確認できなかったよ。もう一度試してみてね。"
            }
        }
    }

    private static let isoDateFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "Asia/Tokyo")
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter
    }()

    // MARK: - Step 2: Reveal(タップでキャラクター登場)

    /// 年齢確認直後の「タップして会う」画面。この時点でRootView側は裏でVRMの先読みを開始しているが、
    /// 画面上には一切キャラクターを出さない(暗幕で完全に覆う)。タップでSE+ハプティクスを鳴らし、
    /// 暗幕をフェードアウトさせながらキャラクターの登場をRootViewへ伝える。
    /// 3Dモデルの読み込みが「決着」した(成功 or 失敗のどちらかが判明した)か。
    /// 失敗時はどのみち2Dフォールバックへ切り替わることが確定しているので、成功を待たずタップを
    /// 有効化してよい(=いつまでもぐるぐる待たせない)。
    private var avatarSettled: Bool { avatarReady || avatarFailed }

    private var revealStep: some View {
        ZStack {
            Color.black.opacity(isRevealing ? 0 : 0.92)
                .ignoresSafeArea()
                .animation(.easeOut(duration: 0.6), value: isRevealing)

            VStack(spacing: 14) {
                Text("シロに会いにいく")
                    .font(.title2.bold())
                    .foregroundStyle(Color.accentPink)
                Text("画面をタップしてね")
                    .font(.callout)
                    .foregroundStyle(.white.opacity(0.75))

                if !avatarSettled && !revealTapFallbackElapsed {
                    ProgressView()
                        .tint(.white)
                        .padding(.top, 4)
                } else {
                    Image(systemName: "hand.tap.fill")
                        .font(.system(size: 28))
                        .foregroundStyle(.white.opacity(0.6))
                        .padding(.top, 4)
                }
            }
            .opacity(isRevealing ? 0 : 1)
            .animation(.easeOut(duration: 0.6), value: isRevealing)
            // アイコン/スピナーは装飾でありテキストと意味が重複するため、まとめて1つの
            // アクセシビリティ要素にしてVoiceOverが要素ごとにバラバラ読み上げないようにする
            // (2026-07-24 reveal演出QAで発見: stepDots等の既存インタラクティブ要素には
            // ラベルがあるのに、この新設タップ領域にだけ何も無かった)。
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("シロに会いにいく")
            .accessibilityHint("ダブルタップして進む")
            .accessibilityAddTraits(.isButton)
        }
        .contentShape(Rectangle())
        .onAppear {
            // nameStepの「もどる」で一度タップ済みのこの画面へ再訪した場合も、暗幕が晴れたままの
            // 空白画面にならないよう毎回フレッシュな状態から始める(RootView側のisCharacterRevealedは
            // 意図的にリセットしない — 既に登場済みのキャラクターを再び隠す必要はない)。
            isRevealing = false
            revealTapFallbackElapsed = false
            onReachReveal()
            // 通常は数秒以内に vmate-ready(成功) か load-error(失敗) のどちらかが届く。
            // 万一どちらも届かない(ブリッジ自体の異常等)場合の最終セーフティネットとして、
            // 少し長めに待ってからタップを解放する(このパス自体は「決着」を待てていないので、
            // タップ後にまだ見えていない可能性は残るが、無限に足止めするよりはよい)。
            DispatchQueue.main.asyncAfter(deadline: .now() + 6.0) { revealTapFallbackElapsed = true }
        }
        .onTapGesture {
            guard avatarSettled || revealTapFallbackElapsed else { return }
            performReveal()
        }
    }

    private func performReveal() {
        guard !isRevealing else { return }
        isRevealing = true
        AudioServicesPlaySystemSound(1519)
        UIImpactFeedbackGenerator(style: .soft).impactOccurred()
        onRevealCharacter()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { advance() }
    }

    // MARK: - Step 3: Name

    private var nameStep: some View {
        VStack(spacing: 16) {
            VStack(spacing: 6) {
                Text("おなまえは？")
                    .font(.title2.bold())
                    .foregroundStyle(Color.accentPink)
                Text("シロがあなたを呼ぶ名前を教えてね。\n後から変えることもできるよ。")
                    .font(.callout)
                    .foregroundStyle(Color.white.opacity(0.8))
                    .multilineTextAlignment(.center)
                    .lineSpacing(3)
            }

            // 標準の.roundedBorderは.preferredColorScheme(.dark)下で無地の黒い箱になり、
            // このウィザードの他要素(ガラス調カード・ピンク系グラデーション)から浮いていた
            // (2026-07-24 reveal演出QAで発見)。ConversationOverlayの入力欄と同じガラス調
            // スタイルに統一する。
            TextField("なまえをいれてね", text: $name)
                .textFieldStyle(.plain)
                .multilineTextAlignment(.center)
                .padding(.vertical, 12)
                .background {
                    Capsule()
                        .fill(Color.black.opacity(0.2))
                        .overlay(Capsule().fill(.ultraThinMaterial.opacity(0.5)))
                        .overlay(Capsule().strokeBorder(Color.white.opacity(0.15), lineWidth: 1))
                }
                .foregroundStyle(.white)
                .submitLabel(.continue)
                .focused($nameFieldFocused)
                .onSubmit { advance() }
                .onAppear { nameFieldFocused = true }

            nextButton("つぎへ") { advance() }

            backButton()
        }
    }

    // MARK: - Step 4: Hint

    private var hintStep: some View {
        VStack(spacing: 16) {
            VStack(spacing: 6) {
                if !name.isEmpty {
                    Text("\(name)、よろしくね！")
                        .font(.callout.bold())
                        .foregroundStyle(Color.accentPink.opacity(0.9))
                }
                Text("こんなふうに話しかけてね")
                    .font(.title2.bold())
                    .foregroundStyle(Color.accentPink)
            }

            VStack(spacing: 10) {
                // 音声会話 — 目立つカードで差別化を強調
                HStack(spacing: 12) {
                    ZStack {
                        Circle()
                            .fill(Color.white.opacity(0.25))
                            .frame(width: 36, height: 36)
                        Image(systemName: "mic.fill")
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(.white)
                    }
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(spacing: 6) {
                            Text("声で話しかける")
                                .font(.callout.bold())
                                .foregroundStyle(.white)
                            Text("おすすめ")
                                .font(.caption2.bold())
                                .padding(.horizontal, 6)
                                .padding(.vertical, 3)
                                .background(Color.white.opacity(0.3))
                                .foregroundStyle(.white)
                                .clipShape(Capsule())
                        }
                        Text("マイクボタンを押してスタート")
                            .font(.caption)
                            .foregroundStyle(.white.opacity(0.85))
                    }
                    Spacer()
                }
                .padding(14)
                .background(LinearGradient.pinkLavender)
                .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                .shadow(color: Color.accentPink.opacity(0.3), radius: 8, y: 3)

                HintRow(icon: "keyboard", text: "テキストで話しかける")
                HintRow(icon: "brain.head.profile", text: "好きなことを覚えてくれる")
                HintRow(icon: "book.closed", text: "今日のことが日記になる")
            }

            let startLabel = name.isEmpty ? "最初のひとことを話す" : "\(name)、最初のひとことを話す"
            nextButton(startLabel) {
                onComplete(name.isEmpty ? nil : name, !nameCaptureFallbackToText)
            }

            backButton()
        }
    }

    // MARK: - Shared sub-views

    private func nextButton(_ label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(label)
                .font(.body.bold())
                .frame(maxWidth: .infinity)
                .padding(.vertical, 12)
                .background(LinearGradient.pinkLavender)
                .foregroundStyle(.white)
                .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        }
    }

    private func backButton() -> some View {
        Button { retreat() } label: {
            HStack(spacing: 4) {
                Image(systemName: "chevron.left")
                    .font(.caption.bold())
                Text("もどる")
                    .font(.footnote)
            }
            .foregroundStyle(Color.white.opacity(0.5))
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
                .foregroundStyle(Color.accentPink)
            Text(text)
                .font(.body)
                .foregroundStyle(Color.white.opacity(0.85))
            Spacer()
        }
        .padding(12)
        .background(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(Color.white.opacity(0.08))
        )
    }
}
