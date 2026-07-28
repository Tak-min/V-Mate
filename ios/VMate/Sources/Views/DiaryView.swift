import SwiftUI

/// Web版 DiaryDrawer.tsx の移植。シロの日記一覧 + 今日分の生成。
struct DiaryView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var entries: [DiaryEntry] = []
    @State private var canGenerateToday = false
    @State private var loading = true
    @State private var generating = false
    @State private var errorMessage: String?

    var body: some View {
        BrandScreen(title: "シロの日記") {
            Group {
                if loading {
                    loadingView
                } else if entries.isEmpty {
                    emptyView
                } else {
                    entryList
                }
            }
            .padding(.bottom, Space.xl)
        }
        .overlay(alignment: .topTrailing) {
            if canGenerateToday {
                Button {
                    Task { await generate() }
                } label: {
                    if generating {
                        HStack(spacing: 4) {
                            ProgressView().scaleEffect(0.8).tint(.white)
                            Text("書いてる…")
                        }
                    } else {
                        Label("今日の日記", systemImage: "pencil.and.scribble")
                    }
                }
                .font(.brandCaption.weight(.semibold))
                .foregroundStyle(Color.accentPink)
                .disabled(generating)
                .padding(.top, 54)
                .padding(.trailing, Space.lg)
            }
        }
        .task {
            APIClient.shared.trackEvent("diary_opened")
            await load()
        }
    }

    // MARK: - Sub-views

    private var loadingView: some View {
        VStack(spacing: Space.md) {
            ProgressView().tint(.white)
            Text("シロの日記を読んでるよ…")
                .font(.brandBody)
                .foregroundStyle(.textSecondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, Space.xxl)
    }

    private var emptyView: some View {
        VStack(spacing: Space.lg) {
            Text("📓")
                .font(.system(size: 52))
            Text("まだ日記はないみたい")
                .font(.brandHeading)
                .foregroundStyle(.textPrimary)
            Text("シロともっとたくさん話すと、\nシロが日記を書いてくれるよ。")
                .font(.brandBody)
                .foregroundStyle(.textSecondary)
                .multilineTextAlignment(.center)
                .lineSpacing(4)
            if canGenerateToday {
                Button {
                    Task { await generate() }
                } label: {
                    Label("今日の日記を書いてもらう", systemImage: "pencil.and.scribble")
                }
                .buttonStyle(BrandPrimaryButtonStyle())
                .disabled(generating)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.top, Space.xxl)
    }

    private var entryList: some View {
        LazyVStack(spacing: Space.md) {
            if let error = errorMessage {
                HStack(spacing: Space.sm) {
                    Image(systemName: "exclamationmark.circle")
                    Text(error)
                }
                .font(.brandBody)
                .foregroundStyle(.textSecondary)
            }

            ForEach(entries) { entry in
                DiaryEntryCard(entry: entry)
            }
        }
    }

    // MARK: - Data

    private func load() async {
        loading = true
        errorMessage = nil
        do {
            let response = try await APIClient.shared.fetchDiary()
            entries = response.entries.reversed()
            canGenerateToday = response.can_generate_today
        } catch {
            errorMessage = "日記を読み込めなかったよ。もう一度試してね。"
        }
        loading = false
    }

    private func generate() async {
        generating = true
        errorMessage = nil
        do {
            let response = try await APIClient.shared.generateDiary()
            if response.ok, let entry = response.entry {
                withAnimation { entries.insert(entry, at: 0) }
                canGenerateToday = false
            } else {
                errorMessage = response.reason ?? "今日はまだ書けないみたい。"
            }
        } catch {
            errorMessage = "日記の生成に失敗したよ。"
        }
        generating = false
    }
}

// MARK: - Entry card

private struct DiaryEntryCard: View {
    let entry: DiaryEntry

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .center, spacing: 8) {
                Text("🐾")
                    .font(.system(size: 14))
                Text(formattedDate)
                    .font(.brandCaption.weight(.bold))
                    .foregroundStyle(Color.accentPink)
                Spacer()
            }

            Text(entry.content)
                .font(.brandBody)
                .foregroundStyle(.textPrimary)
                .lineSpacing(5)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(Space.lg)
        .glassCard()
    }

    /// "2026-07-02" → "2026年7月2日" に変換
    private var formattedDate: String {
        let iso = DateFormatter()
        iso.dateFormat = "yyyy-MM-dd"
        iso.locale = Locale(identifier: "en_US_POSIX")
        guard let date = iso.date(from: entry.entry_date) else { return entry.entry_date }
        let display = DateFormatter()
        display.dateStyle = .long
        display.locale = Locale(identifier: "ja_JP")
        return display.string(from: date)
    }
}
