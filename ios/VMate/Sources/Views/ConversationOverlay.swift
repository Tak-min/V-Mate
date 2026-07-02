import SwiftUI

/// アバターを画面の主役にするための会話オーバーレイ。
/// 2026-06-19 UI改善ループ: 「キャラクターが会話履歴に押しつぶされて小さい」「ミニマルすぎて
/// 逆に人間味が薄い」というフィードバックを受け、フルスクリーンのチャットログを廃止し、
/// 直近の発言だけを半透明カードでアバターの上に重ねる設計に変更した。全履歴は
/// `expanded` で展開するボトムシートに退避する(履歴を消したわけではなく、既定で隠すだけ)。
struct ConversationOverlay: View {
    @ObservedObject var viewModel: CompanionViewModel
    @State private var draft = ""
    @State private var expanded = false

    private var latestMessages: [ChatMessage] {
        Array(viewModel.messages.suffix(2))
    }

    private var canSend: Bool {
        !draft.trimmingCharacters(in: .whitespaces).isEmpty && !viewModel.busy
    }

    var body: some View {
        VStack(spacing: 10) {
            // 直近メッセージカード
            if !latestMessages.isEmpty {
                Button {
                    expanded = true
                } label: {
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
                    .background {
                        RoundedRectangle(cornerRadius: 22, style: .continuous)
                            .fill(Color.black.opacity(0.2))
                            .overlay(
                                RoundedRectangle(cornerRadius: 22, style: .continuous)
                                    .fill(.ultraThinMaterial.opacity(0.5))
                            )
                            .overlay(
                                RoundedRectangle(cornerRadius: 22, style: .continuous)
                                    .strokeBorder(Color.white.opacity(0.12), lineWidth: 1)
                            )
                    }
                }
                .buttonStyle(.plain)
            }

            // 音声認識中間結果(声で話しかけている最中のリアルタイム表示)
            if viewModel.voiceMode == .listening, !viewModel.partialTranscript.isEmpty {
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
                        .overlay(
                            Capsule()
                                .strokeBorder(Color.accentPink.opacity(0.25), lineWidth: 1)
                        )
                }
                .transition(.opacity.combined(with: .move(edge: .bottom)))
                .animation(.spring(response: 0.3, dampingFraction: 0.7), value: viewModel.partialTranscript.isEmpty)
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
                            .overlay(
                                Capsule()
                                    .fill(.ultraThinMaterial.opacity(0.5))
                            )
                            .overlay(
                                Capsule()
                                    .strokeBorder(Color.white.opacity(inputBorderOpacity), lineWidth: 1)
                            )
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
    }

    /// 現在の状態に応じたプレースホルダー文言
    private var inputPlaceholder: String {
        switch viewModel.voiceMode {
        case .off:
            return viewModel.busy ? "シロが考えてるよ…" : "シロに話しかける…"
        case .listening:
            return "声で話しかけてね…"
        case .thinking:
            return "シロが考えてるよ…"
        case .speaking:
            return "シロがお話し中…"
        }
    }

    /// busy中はテキストフィールドのボーダーを薄くして非アクティブを示す
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
                    Text(message.content)
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
                        .overlay(
                            RoundedRectangle(cornerRadius: 18, style: .continuous)
                                .fill(.ultraThinMaterial.opacity(0.6))
                        )
                        .overlay(
                            RoundedRectangle(cornerRadius: 18, style: .continuous)
                                .strokeBorder(Color.white.opacity(0.15), lineWidth: 1)
                        )
                }
            }
            .shadow(color: .black.opacity(0.15), radius: 6, y: 2)
            if !isUser { Spacer(minLength: 30) }
        }
    }
}

/// 全会話履歴(従来のChatPanel相当)。既定では隠れていて、オーバーレイの矢印タップで開く。
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
                            .overlay(
                                RoundedRectangle(cornerRadius: 16, style: .continuous)
                                    .fill(.ultraThinMaterial.opacity(0.6))
                            )
                            .overlay(
                                RoundedRectangle(cornerRadius: 16, style: .continuous)
                                    .strokeBorder(Color.white.opacity(0.12), lineWidth: 1)
                            )
                    }
                }
            if !isUser { Spacer(minLength: 40) }
        }
    }
}
