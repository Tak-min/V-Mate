import SwiftUI

/// Web版 ChatPanel.tsx の移植。チャット履歴 + 入力欄。
struct ChatView: View {
    @ObservedObject var viewModel: CompanionViewModel
    @State private var draft = ""

    var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 10) {
                        ForEach(Array(viewModel.messages.enumerated()), id: \.offset) { index, message in
                            bubble(for: message).id(index)
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.top, 12)
                }
                .onChange(of: viewModel.messages.count) { _ in
                    withAnimation {
                        proxy.scrollTo(viewModel.messages.count - 1, anchor: .bottom)
                    }
                }
            }

            Divider()

            HStack(spacing: 10) {
                TextField("メッセージを書く…", text: $draft)
                    .textFieldStyle(.roundedBorder)
                    .onChange(of: draft) { _ in viewModel.noticeInputActivity() }
                    .onSubmit(send)
                Button(action: send) {
                    Image(systemName: "paperplane.fill")
                }
                .disabled(draft.trimmingCharacters(in: .whitespaces).isEmpty || viewModel.busy)
            }
            .padding(12)
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
            if isUser { Spacer(minLength: 40) }
            VStack(alignment: .leading, spacing: 4) {
                if !isUser, message.content.isEmpty {
                    HStack(spacing: 6) {
                        if let cue = message.cue {
                            Text(cue).font(.callout).foregroundStyle(.secondary)
                        }
                        TypingDots()
                    }
                } else {
                    Text(message.content)
                        .font(.body)
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background(isUser ? Color.accentColor.opacity(0.18) : Color(.secondarySystemBackground))
            .clipShape(RoundedRectangle(cornerRadius: 16))
            if !isUser { Spacer(minLength: 40) }
        }
    }
}

private struct TypingDots: View {
    @State private var phase = 0
    var body: some View {
        HStack(spacing: 3) {
            ForEach(0..<3, id: \.self) { i in
                Circle()
                    .frame(width: 5, height: 5)
                    .opacity(phase == i ? 1 : 0.3)
            }
        }
        .onAppear {
            Timer.scheduledTimer(withTimeInterval: 0.35, repeats: true) { _ in
                phase = (phase + 1) % 3
            }
        }
    }
}
