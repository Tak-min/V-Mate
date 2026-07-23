import Foundation
import RevenueCat

/// RevenueCat SDK のラッパー。Shipaton 2026 応募要件("uses the RevenueCat SDK to power in-app
/// purchases")を満たすため、自前StoreKit2実装(旧 StoreKitManager)を置き換える。
/// サーバ側の署名検証は不要になった(RevenueCatが肩代わりする)。代わりに worker 側の
/// webhook(worker/src/revenuecat.ts)が RevenueCat の app_user_id を users.id に束縛する。
@MainActor
final class RevenueCatManager: ObservableObject {
    static let shared = RevenueCatManager()

    /// RevenueCat ダッシュボードで発行される公開SDKキー(秘密鍵ではなくクライアント同梱が前提の設計)。
    /// Apple Developer Program 加入待ちで RevenueCat アカウント・プロジェクトを未作成のため、
    /// 現状はプレースホルダー。発行され次第この値を置き換える
    /// (dev-notes/revenuecat_migration_2026-07-22.md 参照)。
    private static let apiKey = "REVENUECAT_PUBLIC_SDK_KEY_PLACEHOLDER"
    static let proEntitlementID = "pro"

    @Published private(set) var offerings: Offerings?
    @Published private(set) var customerInfo: CustomerInfo?
    @Published private(set) var isConfigured = false

    private init() {}

    var isProActive: Bool {
        customerInfo?.entitlements[Self.proEntitlementID]?.isActive == true
    }

    /// アプリ起動時に1度だけ呼ぶ(匿名で configure)。プレースホルダーキーのままなら何もしない
    /// (RevenueCatプロジェクト未発行の間もアプリがcrashせず、購入導線だけが空のまま動く)。
    func configureIfNeeded() {
        guard !isConfigured, Self.apiKey != "REVENUECAT_PUBLIC_SDK_KEY_PLACEHOLDER" else { return }
        Purchases.configure(withAPIKey: Self.apiKey)
        isConfigured = true
    }

    /// Sign in with Apple 成功直後、サーバの user_id で呼ぶ。匿名IDをこのアカウントへ紐付ける。
    func logIn(_ userId: String) async {
        guard isConfigured else { return }
        if let result = try? await Purchases.shared.logIn(userId) {
            customerInfo = result.customerInfo
        }
    }

    /// アカウント削除時に呼ぶ。次のセッションが前の購入状態を引き継がないようにする。
    func logOut() async {
        guard isConfigured else { return }
        customerInfo = try? await Purchases.shared.logOut()
    }

    func loadOfferings() async {
        guard isConfigured else { return }
        offerings = try? await Purchases.shared.offerings()
    }

    /// - Returns: ユーザーがシステムの購入シートをキャンセルした場合 true。
    @discardableResult
    func purchase(_ package: Package) async throws -> Bool {
        let result = try await Purchases.shared.purchase(package: package)
        customerInfo = result.customerInfo
        return result.userCancelled
    }

    func restorePurchases() async throws {
        customerInfo = try await Purchases.shared.restorePurchases()
    }

    func refreshCustomerInfo() async {
        guard isConfigured else { return }
        customerInfo = try? await Purchases.shared.customerInfo()
    }
}
