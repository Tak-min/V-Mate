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
    @State private var ageState: AgeLoadState = .loading
    @State private var busyOperation: BusyOperation?
    @State private var message: String?
    @State private var showManageSubscriptions = false

    private enum AgeLoadState: Equatable {
        case loading
        case unknownError
        /// 取得成功時のage_band。サーバは年齢確認未完了のユーザーにnilを返しうる(通信エラーとは区別)。
        case band(String?)
    }

    /// purchase()とrestore()は同じRevenueCat SDK状態(customerInfo)を書き換えるため、
    /// 独立したフラグ2本(旧busyPackageID)だと互いの完了が相手のロックを解除してしまい、
    /// 片方が進行中でももう片方のボタンが押せてしまう競合があった(P-H2/P-H3で顕在化)。
    /// 1つの状態に統合して相互排他にする。
    private enum BusyOperation: Equatable {
        case purchasing(String)
        case restoring
    }

    private var isAdult: Bool {
        if case .band(let band) = ageState { return band == "adult" }
        return false
    }

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
                if !authState.isAuthenticated || store.identity == .signedOut {
                    signInRequiredNotice
                } else {
                    switch ageState {
                    case .loading:
                        ProgressView().tint(.white).padding(.top, 80)
                    case .unknownError:
                        ageErrorNotice
                    case .band:
                        if !isAdult {
                            notAdultNotice
                        } else if store.identity == .unbound {
                            // P-H7: RevenueCatのappUserIDがサーバのuser_idと束縛できていない状態。
                            // ここで購入導線を開くと、課金されても権利が付与されない事故になりうる。
                            identityUnboundNotice
                        } else if store.identity.isBound {
                            paywall
                        } else {
                            ProgressView().tint(.white).padding(.top, 80)
                        }
                    }
                }
            }
            .padding(.bottom, Space.xl)
        }
        .task {
            async let _offerings: Void = store.loadOfferings()
            async let _info: Void = store.refreshCustomerInfo()
            async let _identity: StoreIdentityState = store.syncIdentity()
            await loadAge()
            _ = await _offerings
            _ = await _info
            _ = await _identity
        }
        .manageSubscriptionsSheet(isPresented: $showManageSubscriptions)
    }

    private func loadAge() async {
        ageState = .loading
        do {
            let response = try await APIClient.shared.fetchAge()
            ageState = .band(response.age_band)
        } catch {
            ageState = .unknownError
        }
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

    /// P-H7: RevenueCatのappUserIDがサーバのuser_idと束縛できていない状態専用。
    /// 「押せないボタン」ではなく理由と再試行導線を出す(P-H1/P-H4と同じ規約)。
    private var identityUnboundNotice: some View {
        VStack(spacing: Space.md) {
            notice(icon: "person.crop.circle.badge.exclamationmark", title: "購入の準備ができていません", description: "アカウントとの連携を確認できませんでした。通信環境を確認して、再試行してください。")
            Button("再試行") { Task { await store.syncIdentity() } }
                .buttonStyle(BrandPrimaryButtonStyle())
                .padding(.horizontal, Space.xxl)
        }
    }

    private var ageErrorNotice: some View {
        VStack(spacing: Space.md) {
            notice(icon: "wifi.exclamationmark", title: "年齢情報を確認できませんでした", description: "通信環境を確認して再試行してください。")
            Button("再試行") { Task { await loadAge() } }
                .buttonStyle(BrandPrimaryButtonStyle())
                .padding(.horizontal, Space.xxl)
        }
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
                .onAppear { APIClient.shared.trackEvent("paywall_viewed") }
            benefitList

            // 「ご利用中」はプラン単位ではなくアカウント単位の状態なので、パッケージ数だけ
            // 重複描画しないようここ(paywallレベル)で一度だけ出す(P-H5)。
            if store.isProActive {
                subscriptionManagementCard
            } else if availablePackages.isEmpty {
                offeringsUnavailableNotice
            } else {
                ForEach(availablePackages, id: \.identifier) { package in
                    packageCard(package)
                }
            }

            legalFooter
        }
        .padding(.top, Space.md)
    }

    private var subscriptionManagementCard: some View {
        HStack {
            Label("ご利用中", systemImage: "checkmark.seal.fill")
                .font(.brandBodyStrong)
                .foregroundStyle(.green)
            Spacer()
            Button("サブスクを管理") {
                APIClient.shared.trackEvent("manage_subscription_opened")
                showManageSubscriptions = true
            }
                .font(.brandCaption)
                .foregroundStyle(Color.accentPink)
        }
        .padding(Space.lg)
        .glassCard()
    }

    private var heroSection: some View {
        VStack(spacing: Space.md) {
            BrandMark()
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

    /// 呼び出し元(paywall)がstore.isProActiveをすでに分岐しているため、ここは未購読状態専用。
    private func packageCard(_ package: Package) -> some View {
        let product = package.storeProduct
        return VStack(alignment: .leading, spacing: Space.sm) {
            Button {
                Task { await purchase(package) }
            } label: {
                HStack {
                    Text("シロ Pro をはじめる・\(product.localizedPriceString)")
                    if busyOperation == .purchasing(package.identifier) {
                        ProgressView().tint(.white).padding(.leading, 4)
                    }
                }
            }
            .buttonStyle(BrandPrimaryButtonStyle())
            .disabled(busyOperation != nil || !store.identity.isBound)

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

    /// 商品が0件の状態には「商品自体が存在しない」と「取得に失敗した」の2通りがある(P-H4)。
    /// 後者はRevenueCatManager.offeringsErrorで判別でき、再試行の余地があるため専用ボタンを出す。
    private var offeringsUnavailableNotice: some View {
        VStack(spacing: Space.sm) {
            Text(store.offeringsError != nil
                 ? "商品情報を取得できませんでした。通信環境を確認してください。"
                 : "現在ご購入いただける商品がありません。時間をおいて再度お試しください。")
                .font(.brandBody)
                .foregroundStyle(.textSecondary)
                .multilineTextAlignment(.center)
            if store.offeringsError != nil {
                Button("再試行") { Task { await store.loadOfferings() } }
                    .buttonStyle(BrandPrimaryButtonStyle())
            }
        }
    }

    private var legalFooter: some View {
        VStack(spacing: Space.sm) {
            Button("購入を復元") { Task { await restore() } }
                .font(.brandCaption.weight(.semibold))
                .foregroundStyle(Color.accentPink)
                .disabled(busyOperation != nil)
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
        guard busyOperation == nil else { return }
        busyOperation = .purchasing(package.identifier)
        message = nil
        defer { busyOperation = nil }
        // P-H7: ボタンのdisabled条件はここまでに束縛済みのはずだが、タップの瞬間にサインアウト等で
        // ズレていないかここでも確定させる(多層防御)。既に束縛済みならネットワークI/Oなしで即返る。
        guard await store.syncIdentity().isBound else {
            message = "アカウントとの連携を確認できませんでした。通信環境を確認して、もう一度お試しください。"
            return
        }
        APIClient.shared.trackEvent("purchase_started")
        do {
            let cancelled = try await store.purchase(package)
            guard !cancelled else {
                APIClient.shared.trackEvent("purchase_cancelled")
                return
            }
            // purchase()が返すcustomerInfoはRevenueCatのキャッシュ経由で即座に反映されているとは
            // 限らないため、force: trueで確定判定前に必ずサーバへ問い合わせ直す(P-H2対策)。
            await store.refreshCustomerInfo(force: true)
            if store.isProActive {
                message = "ご購入ありがとうございます。"
                APIClient.shared.trackEvent("purchase_completed")
            } else {
                message = "購入を受け付けました。反映まで少し時間がかかることがあります。"
            }
        } catch {
            message = "購入を完了できませんでした。時間をおいて再度お試しください。"
        }
    }

    private func restore() async {
        guard busyOperation == nil else { return }
        busyOperation = .restoring
        message = nil
        defer { busyOperation = nil }
        APIClient.shared.trackEvent("restore_tapped")
        do {
            try await store.restorePurchases()
            if store.isProActive {
                message = "復元しました。"
                APIClient.shared.trackEvent("restore_succeeded")
            } else {
                message = "復元できる購入が見つかりませんでした。"
            }
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
