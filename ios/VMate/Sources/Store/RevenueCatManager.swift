import Foundation
import RevenueCat
import os

/// RevenueCat SDK のラッパー。Shipaton 2026 応募要件("uses the RevenueCat SDK to power in-app
/// purchases")を満たすため、自前StoreKit2実装(旧 StoreKitManager)を置き換える。
/// サーバ側の署名検証は不要になった(RevenueCatが肩代わりする)。代わりに worker 側の
/// webhook(worker/src/revenuecat.ts)が RevenueCat の app_user_id を users.id に束縛する。
@MainActor
final class RevenueCatManager: ObservableObject {
    static let shared = RevenueCatManager()

    private static let log = Logger(subsystem: "com.takmin.vmate", category: "store")

    /// RevenueCat ダッシュボードで発行される公開SDKキー(秘密鍵ではなくクライアント同梱が前提の設計)。
    /// V-Mateプロジェクト(appa02c5d1a67)のiOS公開SDKキー
    /// (dev-notes/revenuecat_asc_appstore_setup_2026-07-23.md 参照)。
    private static let apiKey = "appl_scYDhqkoqtTMWYdUUAGtaBBYYIW"
    static let proEntitlementID = "pro"

    @Published private(set) var offerings: Offerings?
    @Published private(set) var customerInfo: CustomerInfo?
    @Published private(set) var isConfigured = false
    /// loadOfferings()専用のエラー状態(StoreViewの「商品が無い」/「取得に失敗した」の
    /// 判別に使う)。customerInfo取得や login/logout のエラーとは別スロットにし、
    /// 非同期に並走する操作同士が互いの結果を上書きしないようにする。
    @Published private(set) var offeringsError: String?

    private init() {}

    var isProActive: Bool {
        customerInfo?.entitlements[Self.proEntitlementID]?.isActive == true
    }

    /// アプリ起動時に1度だけ呼ぶ(匿名で configure)。
    func configureIfNeeded() {
        guard !isConfigured else { return }
        Purchases.configure(withAPIKey: Self.apiKey)
        isConfigured = true
    }

    /// Sign in with Apple 成功直後、サーバの user_id で呼ぶ。匿名IDをこのアカウントへ紐付ける。
    /// 失敗すると購入がRevenueCat上の匿名IDに紐づき、worker側webhookが該当ユーザーを
    /// 見つけられず権利付与がサイレントに失敗しうる(要observability、UI再試行は別スコープ)。
    func logIn(_ userId: String) async {
        guard isConfigured else { return }
        do {
            let result = try await Purchases.shared.logIn(userId)
            customerInfo = result.customerInfo
        } catch {
            Self.log.error("logIn(\(userId, privacy: .private)) failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    /// アカウント削除時に呼ぶ。次のセッションが前の購入状態を引き継がないようにする。
    func logOut() async {
        guard isConfigured else { return }
        do {
            customerInfo = try await Purchases.shared.logOut()
        } catch {
            Self.log.error("logOut failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    func loadOfferings() async {
        guard isConfigured else { return }
        do {
            offerings = try await Purchases.shared.offerings()
            offeringsError = nil
        } catch {
            offeringsError = error.localizedDescription
            Self.log.error("loadOfferings failed: \(error.localizedDescription, privacy: .public)")
        }
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

    /// - Parameter force: true なら常にサーバへ問い合わせる(`.fetchCurrent`)。
    ///   デフォルトの`.cachedOrFetched`は購入直後だと`purchase(_:)`がキャッシュした
    ///   同一のCustomerInfoを返すだけで最新化されない(最大5分の内部TTL)ため、
    ///   購入/復元直後の確定判定には必ず`force: true`を使うこと。
    func refreshCustomerInfo(force: Bool = false) async {
        guard isConfigured else { return }
        do {
            customerInfo = try await Purchases.shared.customerInfo(fetchPolicy: force ? .fetchCurrent : .default)
        } catch {
            Self.log.error("refreshCustomerInfo(force: \(force)) failed: \(error.localizedDescription, privacy: .public)")
        }
    }
}
