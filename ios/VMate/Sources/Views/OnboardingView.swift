import SwiftUI

struct OnboardingView: View {
    let onAgeVerified: (String) -> Void
    /// 第2引数は「音声の初対面で既にシロが名前へ反応済み(=はじめましての挨拶は済んでいる)か」。
    /// trueならRootView側は独白挨拶(fireGreeting)を重ねて呼ばない。
    let onComplete: (String?, Bool) -> Void

    // ステップ: 0=welcome, 1=年齢確認(新規), 2=name(音声の初対面。失敗時は手入力), 3=hint
    @State private var step: Int
    @State private var name = ""
    @State private var goingForward = true
    @FocusState private var nameFieldFocused: Bool
    @StateObject private var firstMeeting = FirstMeetingViewModel()
    /// step2の見せ方。音声の初対面を既定とし、権限拒否・聞き取り失敗の繰り返し・通信エラー等で
    /// 自動的にtrueへ切り替わる(FirstMeetingStepのonTextFallback経由)。
    @State private var nameCaptureFallbackToText = false

    // --- 年齢ゲート ---
    // 13歳未満/18歳ちょうどを挟んだ判定が誤らないよう、デフォルトは意図的に「12歳」寄りに
    // 倒さない中立値(16年前)にする。サーバ側(agegate.ts computeAgeBand)がband の唯一の権威。
    @State private var birthDate = Calendar.current.date(byAdding: .year, value: -16, to: Date()) ?? Date()
    @State private var ageCheckInFlight = false
    @State private var ageError: String?
    @State private var isAgeBlocked = false

    init(
        startAtAge: Bool = false,
        onAgeVerified: @escaping (String) -> Void = { _ in },
        onComplete: @escaping (String?, Bool) -> Void
    ) {
        self.onAgeVerified = onAgeVerified
        self.onComplete = onComplete
        #if DEBUG
        // UX目視レビュー用: 実機/シミュレータでタップ操作なしに任意ステップへ直接ジャンプする。
        // 通常起動時はこの環境変数は存在しないため本番挙動に影響しない。
        if let forced = ProcessInfo.processInfo.environment["UITEST_ONBOARDING_STEP"].flatMap(Int.init) {
            _step = State(initialValue: forced)
        } else {
            _step = State(initialValue: startAtAge ? 1 : 0)
        }
        #else
        _step = State(initialValue: startAtAge ? 1 : 0)
        #endif
    }

    var body: some View {
        if isAgeBlocked {
            // 13歳未満と判定された場合、以降のオンボーディングには一切進めない
            // (onComplete も呼ばない。COPPA/Apple 1.3対応)。
            AgeBlockedView()
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
                        } else if step == 2 {
                            Group {
                                if nameCaptureFallbackToText {
                                    nameStep
                                } else {
                                    FirstMeetingStep(
                                        viewModel: firstMeeting,
                                        onTextFallback: { nameCaptureFallbackToText = true },
                                        onDone: { resolvedName in
                                            name = resolvedName
                                            advance()
                                        }
                                    )
                                }
                            }
                            .transition(slideTransition)
                        } else if step == 3 {
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
            ForEach(0..<4, id: \.self) { i in
                Capsule()
                    .fill(i == step ? Color.accentPink : Color.white.opacity(0.35))
                    .frame(width: i == step ? 20 : 9, height: 9)
                    .animation(.spring(response: 0.3, dampingFraction: 0.6), value: step)
            }
        }
        .accessibilityElement()
        .accessibilityLabel("オンボーディングの進み具合")
        .accessibilityValue("ステップ \(step + 1) / 4")
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

    // MARK: - Step 2: Name

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

            TextField("なまえをいれてね", text: $name)
                .textFieldStyle(.roundedBorder)
                .multilineTextAlignment(.center)
                .submitLabel(.continue)
                .focused($nameFieldFocused)
                .onSubmit { advance() }
                .onAppear { nameFieldFocused = true }

            nextButton("つぎへ") { advance() }

            backButton()
        }
    }

    // MARK: - Step 3: Hint

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
