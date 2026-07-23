import RevenueCat
import StoreKit
import SwiftUI

/// 課金(RevenueCat SDK)専用のシート。AccountView(身元管理)から開く。
/// 未成年/年齢未確認には購入導線を一切出さない(サーバ権威ゲートは worker/src/agegate.ts が別途強制するが、
/// クライアント側も「買えない購入を煽らない」ための多層防御として同じ方針を守る)。
struct StoreView: View {
    @Environment(\.dismiss) private var dismiss
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

    var body: some View {
        NavigationStack {
            Group {
                if !APIClient.shared.isAuthenticated {
                    signInRequiredNotice
                } else if loadingAge {
                    ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if !isAdult {
                    notAdultNotice
                } else {
                    storeList
                }
            }
            .navigationTitle("シロ Pro")
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("閉じる") { dismiss() } } }
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
        notice(icon: "person.crop.circle.badge.questionmark", title: "サインインが必要です", description: "購入と復元には、前の画面の「Apple ID と連携」が必要です。")
    }

    private var notAdultNotice: some View {
        notice(icon: "hand.raised.fill", title: "ご利用いただけません", description: "この機能は年齢確認が完了した成人の方のみご利用いただけます。")
    }

    /// ContentUnavailableView(iOS 17+)相当の簡易版。deploymentTarget が iOS 16 のため自前実装。
    private func notice(icon: String, title: String, description: String) -> some View {
        VStack(spacing: 12) {
            Image(systemName: icon).font(.system(size: 40)).foregroundStyle(.secondary)
            Text(title).font(.headline)
            Text(description).font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center)
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    @ViewBuilder
    private var storeList: some View {
        List {
            if availablePackages.isEmpty {
                Section {
                    Text("現在ご購入いただける商品がありません。時間をおいて再度お試しください。")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            ForEach(availablePackages, id: \.identifier) { package in
                Section {
                    packageRow(package)
                }
            }
            Section {
                Button("購入を復元") { Task { await restore() } }
                if let message {
                    Text(message).font(.footnote).foregroundStyle(.secondary)
                }
            }
        }
    }

    @ViewBuilder
    private func packageRow(_ package: Package) -> some View {
        let product = package.storeProduct
        VStack(alignment: .leading, spacing: 6) {
            Text(product.localizedTitle).font(.headline)
            Text(product.localizedDescription).font(.footnote).foregroundStyle(.secondary)

            if store.isProActive {
                HStack {
                    Label("ご利用中", systemImage: "checkmark.seal.fill").foregroundStyle(.green)
                    Spacer()
                    Button("サブスクを管理") { showManageSubscriptions = true }
                        .font(.footnote)
                }
                .padding(.top, 4)
            } else {
                Button {
                    Task { await purchase(package) }
                } label: {
                    HStack {
                        Text(product.localizedPriceString)
                        if busyPackageID == package.identifier { ProgressView().padding(.leading, 4) }
                    }
                }
                .disabled(busyPackageID != nil)
                .padding(.top, 4)
            }

            // Apple 3.1.2: 自動更新サブスクの価格・期間・自動更新である旨の開示。
            if let period = product.subscriptionPeriod {
                Text("\(product.localizedPriceString) / \(periodLabel(period))・自動更新。いつでも解約できます。")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 4)
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
