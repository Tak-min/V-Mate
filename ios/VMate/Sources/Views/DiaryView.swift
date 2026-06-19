import SwiftUI

/// Web版 DiaryDrawer.tsx の移植。シロの日記一覧 + 今日分の生成。
struct DiaryView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var entries: [DiaryEntry] = []
    @State private var canGenerateToday = false
    @State private var loading = true
    @State private var generating = false
    @State private var message: String?

    var body: some View {
        NavigationStack {
            List {
                if let message {
                    Text(message).foregroundStyle(.secondary)
                }
                ForEach(entries) { entry in
                    VStack(alignment: .leading, spacing: 6) {
                        Text(entry.entry_date).font(.caption).foregroundStyle(.secondary)
                        Text(entry.content)
                    }
                    .padding(.vertical, 4)
                }
            }
            .overlay {
                if loading { ProgressView() }
                else if entries.isEmpty && message == nil {
                    Text("まだ日記はないみたい。").foregroundStyle(.secondary)
                }
            }
            .navigationTitle("シロの日記")
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button("閉じる") { dismiss() }
                }
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button(generating ? "書いてる…" : "今日の分を書く") { Task { await generate() } }
                        .disabled(!canGenerateToday || generating)
                }
            }
            .task { await load() }
        }
    }

    private func load() async {
        loading = true
        if let response = try? await APIClient.shared.fetchDiary() {
            entries = response.entries.reversed()
            canGenerateToday = response.can_generate_today
        }
        loading = false
    }

    private func generate() async {
        generating = true
        if let response = try? await APIClient.shared.generateDiary() {
            if response.ok, let entry = response.entry {
                entries.insert(entry, at: 0)
                canGenerateToday = false
            } else {
                message = response.reason ?? "今日はまだ書けないみたい。"
            }
        }
        generating = false
    }
}
