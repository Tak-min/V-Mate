import SwiftUI

// MARK: - Constants (Web版 ChatPanel.tsx からポート)

private let EMOTION_EMOJI: [Emotion: String] = [
    .happy: "😊", .sad: "🥺", .angry: "😤", .relaxed: "😌", .shy: "😳",
]

private let TIME_OF_DAY_PROMPTS: [String: [String]] = [
    "morning": ["おはよう、今日はどんな一日にする?", "朝ごはん食べた?"],
    "daytime": ["今日あったことを話したいな", "いま何してるの?"],
    "evening": ["今日も一日お疲れさま。何があった?", "夕方になると少し落ち着くね。今の気分は?"],
    "night": ["もう遅い時間だね。眠れてる?", "今日のこと、寝る前に少し話そうか"],
]
private let NEW_VISITOR_PROMPTS = ["好きな食べ物は?", "はじめまして、よろしくね。何て呼んだらいい?"]
private let FAMILIAR_PROMPTS = ["少し元気がないの聞いてほしいな", "前に話してたこと、また聞きたいな"]

private let FOLLOW_UP_PROMPTS: [Emotion: [String]] = [
    .neutral:  ["もう少し詳しく聞かせて", "他にはどんなことがあった?"],
    .happy:    ["それいいね、もっと聞きたいな", "どんなところが楽しかった?"],
    .sad:      ["つらかったね、もう少し話してもいいよ", "いま気分はどう?"],
    .angry:    ["それは大変だったね、何があったの?", "もう少し聞かせてくれる?"],
    .relaxed:  ["いい感じだね、他には何かあった?", "のんびりできてよかったね"],
    .shy:      ["恥ずかしがらなくて大丈夫だよ", "ゆっくり話してくれていいよ"],
]

private let VOICE_STATUS_LABEL: [VoiceMode: String] = [
    .listening: "聞いてるよ",
    .thinking:  "考えてる…",
    .speaking:  "話してる",
]

private func currentTimeBucket() -> String {
    let hour = Calendar.current.component(.hour, from: Date())
    if hour >= 5  && hour < 10 { return "morning" }
    if hour >= 10 && hour < 17 { return "daytime" }
    if hour >= 17 && hour < 21 { return "evening" }
    return "night"
}

// MARK: - ConversationOverlay

/// アバターを画面の主役にするための会話オーバーレイ。
/// 2026-06-19 UI改善ループ: フルスクリーンのチャットログを廃止し、
/// 直近の発言だけを半透明カードでアバターの上に重ねる設計に変更した。
/// 2026-07-03 Web同期: スターター/フォローアップ chip・感情絵文字・
/// 音声HUD・バージインボタンを追加してWeb版 ChatPanel.tsx と体験を統一。
struct ConversationOverlay: View {
    @ObservedObject var viewModel: CompanionViewModel
    @State private var draft = ""
    @State private var expanded = false
    @State private var latestDiary: DiaryEntry? = nil

    private var latestMessages: [ChatMessage] {
        Array(viewModel.messages.suffix(2))
    }

    private var canSend: Bool {
        !draft.trimmingCharacters(in: .whitespaces).isEmpty && !viewModel.busy
    }

    private var starterChips: [String] {
        let timePrompts = TIME_OF_DAY_PROMPTS[currentTimeBucket()] ?? []
        let isNew = viewModel.state?.stage == "はじめまして" || viewModel.state == nil
        return timePrompts + (isNew ? NEW_VISITOR_PROMPTS : FAMILIAR_PROMPTS)
    }

    private var followUpChips: [String] {
        guard !viewModel.messages.isEmpty, !viewModel.busy, viewModel.voiceMode == .off else { return [] }
        let last = viewModel.messages.last(where: { $0.role == "assistant" && !$0.content.isEmpty })
        return FOLLOW_UP_PROMPTS[last?.emotion ?? .neutral] ?? []
    }

    var body: some View {
        VStack(spacing: 10) {

            // 空のチャット: ヒント + スターターチップ + recent_facts + 日記コールバック
            if viewModel.messages.isEmpty && viewModel.voiceMode == .off {
                emptyStateView
            }

            // 直近メッセージカード
            if !latestMessages.isEmpty {
                Button { expanded = true } label: {
                    VStack(alignment: .leading, spacing: 8) {
                        ForEach(Array(latestMessages.enumerated()), id: \.offset) { _, message in
                            bubble(for: message)
                        }
                        HStack {
                            Spacer()
                            Image(systemName: "chevron.compact.up")
                                .foregroundStyle(.white.opacity(0.5))
                            Text("会話履歴")
                                .font(.caption2)
                                .foregroundStyle(.white.opacity(0.4))
                        }
                    }
                    .padding(14)
                    .background { messageCardBackground }
                }
                .buttonStyle(.plain)
            }

            // フォローアップチップ（会話後、テキストモードのみ）
            if !followUpChips.isEmpty {
                chipScroll(followUpChips)
            }

            // 音声認識中間結果
            if viewModel.voiceMode == .listening, !viewModel.partialTranscript.isEmpty {
                partialTranscriptBar
            }

            // 音声会話ステータス HUD + バージインボタン
            if viewModel.voiceMode != .off {
                voiceHUD
            }

            // テキスト入力 + 送信ボタン
            HStack(spacing: 10) {
                TextField(inputPlaceholder, text: $draft)
                    .textFieldStyle(.plain)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .background {
                        Capsule()
                            .fill(Color.black.opacity(0.2))
                            .overlay(Capsule().fill(.ultraThinMaterial.opacity(0.5)))
                            .overlay(Capsule().strokeBorder(Color.white.opacity(inputBorderOpacity), lineWidth: 1))
                    }
                    .foregroundStyle(.white)
                    .disabled(viewModel.busy)
                    .onChange(of: draft) { _ in viewModel.noticeInputActivity() }
                    .onSubmit(send)

                Button(action: send) {
                    Image(systemName: "paperplane.fill")
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(.white)
                        .padding(12)
                        .background {
                            Circle()
                                .fill(canSend ? AnyShapeStyle(LinearGradient.pinkLavender) : AnyShapeStyle(Color.white.opacity(0.18)))
                        }
                        .shadow(color: canSend ? Color.accentPink.opacity(0.5) : .clear, radius: 6, y: 2)
                }
                .disabled(!canSend)
                .accessibilityLabel("メッセージを送信")
            }
        }
        .padding(.horizontal, 16)
        .padding(.bottom, 10)
        .sheet(isPresented: $expanded) {
            ChatHistorySheet(viewModel: viewModel)
        }
        .task {
            latestDiary = try? await APIClient.shared.fetchDiary().entries.first
        }
    }

    // MARK: - Sub-views

    @ViewBuilder
    private var emptyStateView: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("シロに話しかけてみよう。\n今日あったこと、好きなもの、なんでも。")
                .font(.callout)
                .foregroundStyle(.white.opacity(0.65))
                .multilineTextAlignment(.leading)
                .padding(.horizontal, 4)

            // recent_facts chips
            if let facts = viewModel.state?.recent_facts, !facts.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    Text("覚えていること")
                        .font(.caption2)
                        .foregroundStyle(.white.opacity(0.45))
                        .padding(.horizontal, 4)
                    chipScroll(Array(facts.prefix(2)))
                }
            }

            // 最新の日記エントリへのコールバック
            if let diary = latestDiary {
                diaryCallbackButton(diary)
            }

            // 時間帯別 + 新規/リピーター スターターチップ
            chipScroll(starterChips)
        }
        .padding(14)
        .background { messageCardBackground }
        .transition(.opacity.combined(with: .move(edge: .bottom)))
    }

    @ViewBuilder
    private var partialTranscriptBar: some View {
        HStack(spacing: 8) {
            Image(systemName: "mic.fill")
                .font(.caption2)
                .foregroundStyle(Color.accentPink)
            Text(viewModel.partialTranscript)
                .font(.callout)
                .italic()
                .foregroundStyle(.white.opacity(0.75))
                .lineLimit(2)
            Spacer()
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .background {
            Capsule()
                .fill(Color.accentPink.opacity(0.12))
                .overlay(Capsule().strokeBorder(Color.accentPink.opacity(0.25), lineWidth: 1))
        }
        .transition(.opacity.combined(with: .move(edge: .bottom)))
        .animation(.spring(response: 0.3, dampingFraction: 0.7), value: viewModel.partialTranscript.isEmpty)
    }

    @ViewBuilder
    private var voiceHUD: some View {
        HStack(spacing: 12) {
            // ステータスドット + ラベル
            HStack(spacing: 6) {
                Circle()
                    .fill(voiceStatusColor)
                    .frame(width: 6, height: 6)
                    .opacity(viewModel.voiceMode == .listening ? 1 : 0.7)
                Text(VOICE_STATUS_LABEL[viewModel.voiceMode] ?? "")
                    .font(.caption.weight(.medium))
                    .foregroundStyle(.white.opacity(0.8))
            }

            Spacer()

            // バージインボタン (thinking / speaking 時のみ)
            if viewModel.voiceMode == .thinking || viewModel.voiceMode == .speaking {
                Button {
                    viewModel.interrupt()
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: "hand.raised.fill")
                            .font(.caption2)
                        Text("とめて話す")
                            .font(.caption.weight(.medium))
                    }
                    .foregroundStyle(.white)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
                    .background {
                        Capsule()
                            .fill(Color.accentPink.opacity(0.25))
                            .overlay(Capsule().strokeBorder(Color.accentPink.opacity(0.5), lineWidth: 1))
                    }
                }
                .buttonStyle(.plain)
                .transition(.opacity.combined(with: .scale(scale: 0.9)))
            }

            // 聞き取り中のヒント
            if viewModel.voiceMode == .listening && viewModel.partialTranscript.isEmpty {
                Text("そのまま話しかけてね")
                    .font(.caption)
                    .foregroundStyle(.white.opacity(0.5))
                    .transition(.opacity)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .animation(.spring(response: 0.3, dampingFraction: 0.8), value: viewModel.voiceMode)
    }

    @ViewBuilder
    private func diaryCallbackButton(_ entry: DiaryEntry) -> some View {
        let preview = String(entry.content.prefix(36)) + (entry.content.count > 36 ? "…" : "")
        VStack(alignment: .leading, spacing: 3) {
            Text("\(entry.entry_date)の日記にこう書いたよ")
                .font(.caption2)
                .foregroundStyle(.white.opacity(0.45))
            Text("「\(preview)」")
                .font(.caption)
                .foregroundStyle(.white.opacity(0.7))
                .lineLimit(2)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background {
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(Color.white.opacity(0.06))
                .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Color.white.opacity(0.1), lineWidth: 1))
        }
    }

    @ViewBuilder
    private func chipScroll(_ chips: [String]) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(chips, id: \.self) { chip in
                    Button {
                        viewModel.noticeInputActivity()
                        viewModel.send(chip)
                    } label: {
                        Text(chip)
                            .font(.caption)
                            .foregroundStyle(.white.opacity(0.85))
                            .padding(.horizontal, 12)
                            .padding(.vertical, 6)
                            .background {
                                Capsule()
                                    .fill(Color.white.opacity(0.1))
                                    .overlay(Capsule().strokeBorder(Color.white.opacity(0.18), lineWidth: 1))
                            }
                    }
                    .buttonStyle(.plain)
                    .disabled(viewModel.busy)
                }
            }
            .padding(.horizontal, 4)
        }
    }

    // MARK: - Helpers

    private var messageCardBackground: some View {
        RoundedRectangle(cornerRadius: 22, style: .continuous)
            .fill(Color.black.opacity(0.2))
            .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous).fill(.ultraThinMaterial.opacity(0.5)))
            .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous).strokeBorder(Color.white.opacity(0.12), lineWidth: 1))
    }

    private var voiceStatusColor: Color {
        switch viewModel.voiceMode {
        case .listening: return Color.accentPink
        case .thinking:  return Color.yellow.opacity(0.8)
        case .speaking:  return Color.mint.opacity(0.8)
        case .off:       return .clear
        }
    }

    private var inputPlaceholder: String {
        switch viewModel.voiceMode {
        case .off:       return viewModel.busy ? "シロが考えてるよ…" : "シロに話しかける…"
        case .listening: return "声で話しかけてね…"
        case .thinking:  return "シロが考えてるよ…"
        case .speaking:  return "シロがお話し中…"
        }
    }

    private var inputBorderOpacity: Double {
        viewModel.busy ? 0.06 : 0.12
    }

    private func send() {
        let text = draft
        draft = ""
        viewModel.send(text)
    }

    @ViewBuilder
    private func bubble(for message: ChatMessage) -> some View {
        let isUser = message.role == "user"
        HStack {
            if isUser { Spacer(minLength: 30) }
            Group {
                if !isUser, message.content.isEmpty, let cue = message.cue {
                    HStack(spacing: 6) {
                        ProgressView()
                            .scaleEffect(0.7)
                            .tint(.white.opacity(0.6))
                        Text(cue)
                    }
                } else {
                    HStack(alignment: .bottom, spacing: 4) {
                        Text(message.content)
                        // 感情絵文字 (Web版 EMOTION_EMOJI と同一マッピング)
                        if !isUser, let emoji = EMOTION_EMOJI[message.emotion ?? .neutral] {
                            Text(emoji)
                                .font(.caption)
                        }
                    }
                }
            }
            .font(.callout)
            .foregroundStyle(.white)
            .multilineTextAlignment(isUser ? .trailing : .leading)
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background {
                if isUser {
                    RoundedRectangle(cornerRadius: 18, style: .continuous)
                        .fill(LinearGradient.pinkLavender)
                } else {
                    RoundedRectangle(cornerRadius: 18, style: .continuous)
                        .fill(Color.black.opacity(0.25))
                        .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).fill(.ultraThinMaterial.opacity(0.6)))
                        .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).strokeBorder(Color.white.opacity(0.15), lineWidth: 1))
                }
            }
            .shadow(color: .black.opacity(0.15), radius: 6, y: 2)
            if !isUser { Spacer(minLength: 30) }
        }
    }
}

// MARK: - ChatHistorySheet

private struct ChatHistorySheet: View {
    @ObservedObject var viewModel: CompanionViewModel
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ChatLogList(messages: viewModel.messages)
                .navigationTitle("シロとの会話")
                .toolbar {
                    ToolbarItem(placement: .navigationBarTrailing) {
                        Button("閉じる") { dismiss() }
                    }
                }
        }
        .presentationDetents([.medium, .large])
    }
}

private struct ChatLogList: View {
    let messages: [ChatMessage]

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 10) {
                    ForEach(Array(messages.enumerated()), id: \.offset) { index, message in
                        logBubble(for: message).id(index)
                    }
                }
                .padding(16)
            }
            .onChange(of: messages.count) { _ in
                withAnimation { proxy.scrollTo(messages.count - 1, anchor: .bottom) }
            }
        }
    }

    @ViewBuilder
    private func logBubble(for message: ChatMessage) -> some View {
        let isUser = message.role == "user"
        HStack {
            if isUser { Spacer(minLength: 40) }
            HStack(alignment: .bottom, spacing: 4) {
                Text(message.content.isEmpty ? (message.cue ?? "") : message.content)
                    .font(.callout)
                    .foregroundStyle(.white)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .background {
                        if isUser {
                            RoundedRectangle(cornerRadius: 16, style: .continuous)
                                .fill(LinearGradient.pinkLavender)
                        } else {
                            RoundedRectangle(cornerRadius: 16, style: .continuous)
                                .fill(Color.black.opacity(0.25))
                                .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(.ultraThinMaterial.opacity(0.6)))
                                .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(Color.white.opacity(0.12), lineWidth: 1))
                        }
                    }
                if !isUser, let emoji = EMOTION_EMOJI[message.emotion ?? .neutral] {
                    Text(emoji)
                        .font(.caption)
                        .padding(.bottom, 4)
                }
            }
            if !isUser { Spacer(minLength: 40) }
        }
    }
}
