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

    var body: some View {
        VStack(spacing: 10) {
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
                                .foregroundStyle(.white.opacity(0.6))
                        }
                    }
                    .padding(14)
                    .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 22))
                }
                .buttonStyle(.plain)
            }

            HStack(spacing: 10) {
                TextField("メッセージを書く…", text: $draft)
                    .textFieldStyle(.plain)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .background(.ultraThinMaterial, in: Capsule())
                    .foregroundStyle(.white)
                    .onChange(of: draft) { _ in viewModel.noticeInputActivity() }
                    .onSubmit(send)
                Button(action: send) {
                    Image(systemName: "paperplane.fill")
                        .foregroundStyle(.white)
                        .padding(12)
                        .background(Color.white.opacity(0.22), in: Circle())
                }
                .disabled(draft.trimmingCharacters(in: .whitespaces).isEmpty || viewModel.busy)
            }
        }
        .padding(.horizontal, 16)
        .padding(.bottom, 10)
        .sheet(isPresented: $expanded) {
            ChatHistorySheet(viewModel: viewModel)
        }
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
                    Text(cue)
                } else {
                    Text(message.content)
                }
            }
            .font(.callout)
            .foregroundStyle(.white)
            .multilineTextAlignment(isUser ? .trailing : .leading)
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
            Text(message.content)
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(isUser ? Color.accentColor.opacity(0.18) : Color(.secondarySystemBackground))
                .clipShape(RoundedRectangle(cornerRadius: 16))
            if !isUser { Spacer(minLength: 40) }
        }
    }
}
