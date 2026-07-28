import RevenueCat
import StoreKit
import SwiftUI

/// 課金(RevenueCat SDK)専用のシート。AccountView(身元管理)から開く。
/// 未成年/年齢未確認には購入導線を一切出さない(サーバ権威ゲートは worker/src/agegate.ts が別途強制するが、
/// クライアント側も「買えない購入を煽らない」ための多層防御として同じ方針を守る)。
struct StoreView: View {
    @Environment(\.dismiss) private var dismiss
    @ObservedObject private var authState = AuthState.shared
    @StateObject private var store = RevenueCatManager.shared
    @State private var ageBand: String?
    @State private var loadingAge = true
    @State private var busyPackageID: String?
    @State private var message: String?
    @State private var showManageSubscriptions = false

    private var isAdult: Bool { ageBand == "adult" }

    private var availablePackages: [Package] {
        store.offerings?.current?.availablePackages ?? []
    }

    // 実際にサーバ側(worker/wrangler.jsonc の RATE_*)で強制している上限に合わせた文言。
    // 数値を変える場合は worker 側のクォータ設定も必ず揃えること(訴求と実装の乖離を防ぐ)。
    private let benefits: [ProBenefit] = [
        ProBenefit(icon: "text.bubble.fill", title: "たっぷりおしゃべり", subtitle: "1日500回まで会話できる(無料は50回)"),
        ProBenefit(icon: "waveform", title: "音声でもたくさん", subtitle: "1日300回まで声で話せる(無料は30回)"),
        ProBenefit(icon: "book.closed.fill", title: "毎日の日記", subtitle: "無料は週2回、Proは毎日シロが綴る"),
    ]

    var body: some View {
        BrandScreen(title: "シロ Pro") {
            Group {
                if !authState.isAuthenticated {
                    signInRequiredNotice
                } else if loadingAge {
                    ProgressView().tint(.white).padding(.top, 80)
                } else if !isAdult {
                    notAdultNotice
                } else {
                    paywall
                }
            }
            .padding(.bottom, Space.xl)
        }
        .task {
            async let age: APIClient.AgeResponse? = try? APIClient.shared.fetchAge()
            async let _offerings: Void = store.loadOfferings()
            async let _info: Void = store.refreshCustomerInfo()
            ageBand = await age?.age_band
            _ = await _offerings
            _ = await _info
            loadingAge = false
        }
        .manageSubscriptionsSheet(isPresented: $showManageSubscriptions)
    }

    private var signInRequiredNotice: some View {
        VStack(spacing: Space.md) {
            notice(icon: "person.crop.circle.badge.questionmark", title: "サインインが必要です", description: "購入と復元には、アカウントとの連携が必要です。")
            Button("閉じてサインインする") { dismiss() }
                .buttonStyle(BrandPrimaryButtonStyle())
                .padding(.horizontal, Space.xxl)
        }
    }

    private var notAdultNotice: some View {
        notice(icon: "hand.raised.fill", title: "ご利用いただけません", description: "この機能は年齢確認が完了した成人の方のみご利用いただけます。")
    }

    /// ContentUnavailableView(iOS 17+)相当の簡易版。deploymentTarget が iOS 16 のため自前実装。
    private func notice(icon: String, title: String, description: String) -> some View {
        VStack(spacing: Space.md) {
            Image(systemName: icon).font(.system(size: 40)).foregroundStyle(Color.accentPink)
            Text(title).font(.brandHeading).foregroundStyle(.textPrimary)
            Text(description).font(.brandBody).foregroundStyle(.textSecondary).multilineTextAlignment(.center)
        }
        .padding(Space.xxl)
        .frame(maxWidth: .infinity)
        .padding(.top, Space.xxl)
    }

    // MARK: - Paywall

    private var paywall: some View {
        VStack(spacing: Space.xl) {
            heroSection
            benefitList

            if availablePackages.isEmpty {
                Text("現在ご購入いただける商品がありません。時間をおいて再度お試しください。")
                    .font(.brandBody)
                    .foregroundStyle(.textSecondary)
                    .multilineTextAlignment(.center)
            } else {
                ForEach(availablePackages, id: \.identifier) { package in
                    packageCard(package)
                }
            }

            legalFooter
        }
        .padding(.top, Space.md)
    }

    private var heroSection: some View {
        VStack(spacing: Space.md) {
            ZStack {
                Circle()
                    .fill(LinearGradient.pinkLavender)
                    .frame(width: 72, height: 72)
                    .shadow(color: Color.accentPink.opacity(0.4), radius: 10, y: 4)
                Image(systemName: "sparkles")
                    .font(.system(size: 30))
                    .foregroundStyle(.white)
            }
            Text("シロと、もっと。")
                .font(.brandDisplay)
                .foregroundStyle(.textPrimary)
            Text("毎日をとなりで過ごすための、シロ Pro")
                .font(.brandBody)
                .foregroundStyle(.textSecondary)
        }
    }

    private var benefitList: some View {
        VStack(spacing: Space.sm) {
            ForEach(benefits) { benefit in
                HStack(spacing: Space.md) {
                    ZStack {
                        Circle().fill(Color.accentPink.opacity(0.18)).frame(width: 36, height: 36)
                        Image(systemName: benefit.icon)
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(Color.accentPink)
                    }
                    VStack(alignment: .leading, spacing: 2) {
                        Text(benefit.title).font(.brandBodyStrong).foregroundStyle(.textPrimary)
                        Text(benefit.subtitle).font(.brandCaption).foregroundStyle(.textSecondary)
                    }
                    Spacer()
                }
                .padding(Space.md)
                .glassCard(radius: Radius.md)
            }
        }
    }

    @ViewBuilder
    private func packageCard(_ package: Package) -> some View {
        let product = package.storeProduct
        VStack(alignment: .leading, spacing: Space.sm) {
            if store.isProActive {
                HStack {
                    Label("ご利用中", systemImage: "checkmark.seal.fill")
                        .font(.brandBodyStrong)
                        .foregroundStyle(.green)
                    Spacer()
                    Button("サブスクを管理") { showManageSubscriptions = true }
                        .font(.brandCaption)
                        .foregroundStyle(Color.accentPink)
                }
            } else {
                Button {
                    Task { await purchase(package) }
                } label: {
                    HStack {
                        Text("シロ Pro をはじめる・\(product.localizedPriceString)")
                        if busyPackageID == package.identifier {
                            ProgressView().tint(.white).padding(.leading, 4)
                        }
                    }
                }
                .buttonStyle(BrandPrimaryButtonStyle())
                .disabled(busyPackageID != nil)
            }

            // Apple 3.1.2: 自動更新サブスクの価格・期間・自動更新である旨の開示。
            if let period = product.subscriptionPeriod {
                Text("\(product.localizedPriceString) / \(periodLabel(period))・自動更新。いつでも解約できます。")
                    .font(.caption2)
                    .foregroundStyle(.textTertiary)
            }
        }
        .padding(Space.lg)
        .glassCard()
    }

    private var legalFooter: some View {
        VStack(spacing: Space.sm) {
            Button("購入を復元") { Task { await restore() } }
                .font(.brandCaption.weight(.semibold))
                .foregroundStyle(Color.accentPink)
            // Apple 3.1.2: 自動更新サブスクの購入UI内には利用規約/プライバシーポリシーへの
            // 機能するリンクが必須。
            HStack(spacing: Space.md) {
                Link("利用規約", destination: APIClient.shared.baseURL.appendingPathComponent("terms"))
                Link("プライバシーポリシー", destination: APIClient.shared.baseURL.appendingPathComponent("privacy"))
            }
            .font(.caption2)
            .foregroundStyle(.textTertiary)
            if let message {
                Text(message).font(.brandCaption).foregroundStyle(.textSecondary)
            }
        }
    }

    private func periodLabel(_ period: RevenueCat.SubscriptionPeriod) -> String {
        switch period.unit {
        case .day: return "\(period.value)日ごと"
        case .week: return "\(period.value)週間ごと"
        case .month: return "\(period.value)ヶ月ごと"
        case .year: return "\(period.value)年ごと"
        @unknown default: return ""
        }
    }

    private func purchase(_ package: Package) async {
        busyPackageID = package.identifier
        message = nil
        defer { busyPackageID = nil }
        do {
            let cancelled = try await store.purchase(package)
            if !cancelled {
                message = store.isProActive ? "ご購入ありがとうございます。" : nil
            }
        } catch {
            message = "購入を完了できませんでした。時間をおいて再度お試しください。"
        }
    }

    private func restore() async {
        busyPackageID = "__restore__"
        message = nil
        defer { busyPackageID = nil }
        do {
            try await store.restorePurchases()
            message = "復元が完了しました。"
        } catch {
            message = "復元できませんでした。時間をおいて再度お試しください。"
        }
    }
}

private struct ProBenefit: Identifiable {
    let id = UUID()
    let icon: String
    let title: String
    let subtitle: String
}
