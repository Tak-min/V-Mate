import Foundation
import RevenueCat
import os

/// RevenueCatのappUserIDとサーバのuser_idの束縛状態。P-H7: `.bound`以外では購入導線を開かない
/// (課金されたのに権利が付与されないサイレント事故を防ぐため。詳細は`syncIdentity()`のコメント参照)。
enum StoreIdentityState: Equatable {
    /// 未確認(configure直後、まだ一度もsyncIdentity()が完了していない)。
    case unknown
    /// サーバ上に実アカウントが無い(匿名Cookieのみ、またはアカウント削除済み)。
    case signedOut
    /// RevenueCatのappUserIDがサーバのuser_idと一致している。関連付けられたuser_idを保持する。
    case bound(String)
    /// サーバアカウントはあるがRevenueCatのappUserIDと一致しない(またはfetchMe失敗)。購入をブロックする。
    case unbound

    var isBound: Bool {
        if case .bound = self { return true }
        return false
    }
}

/// RevenueCatのappUserIDとサーバのuser_idの整合判定。MainActor/SDKに依存しない純関数にすることで
/// ユニットテスト可能にする(RevenueCatManager自体はシングルトン+MainActorでテストできないため)。
enum StoreIdentity {
    static let anonymousPrefix = "$RCAnonymousID:"

    static func isAnonymous(_ appUserID: String) -> Bool {
        appUserID.hasPrefix(anonymousPrefix)
    }

    /// 空・匿名形式は常に不一致扱い(fail-closed)。
    static func matches(appUserID: String, serverUserID: String) -> Bool {
        let trimmedAppUserID = appUserID.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedServerUserID = serverUserID.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedServerUserID.isEmpty, !isAnonymous(trimmedAppUserID) else { return false }
        return trimmedAppUserID == trimmedServerUserID
    }
}

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
    /// P-H7: RevenueCatのappUserIDとサーバuser_idの束縛状態。StoreViewの購入導線はこれが
    /// `.bound`の時にしか開かない。
    @Published private(set) var identity: StoreIdentityState = .unknown

    private var identitySyncTask: Task<StoreIdentityState, Never>?

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

    /// RevenueCatのappUserIDとサーバのuser_idの束縛を確認し、ズレていれば1回だけ紐付けを試みる。
    /// 起動時・Sign in with Apple直後・StoreView表示時・購入タップ時の4箇所から呼ばれる。
    ///
    /// 判定基準は`Purchases.shared.appUserID`とサーバuser_idの**一致そのもの**であり、
    /// 直後の`Purchases.shared.logIn`が成功したかどうかでは判定しない。RevenueCat SDK
    /// (IdentityManager.performLogIn)は、既に同一IDで束縛済みの場合でも customerInfo の
    /// 再取得に失敗すると logIn 自体を throw させる実装になっており、「throw = 未束縛」という
    /// 判定はオフライン環境で正しく束縛済みのユーザーを誤ってブロックしてしまう(要件corpus:
    /// F1、code-architect設計セッションでRevenueCat SDKソースを実測して確認)。
    ///
    /// 既に`.bound`かつSDK側のappUserIDも変わっていなければネットワークI/Oなしで即座に返す
    /// (購入ボタンタップ時の体感コストをゼロにするための高速パス)。
    @discardableResult
    func syncIdentity() async -> StoreIdentityState {
        guard isConfigured else { return .unknown }

        if case .bound(let boundUserId) = identity, StoreIdentity.matches(appUserID: Purchases.shared.appUserID, serverUserID: boundUserId) {
            return identity
        }
        if let inflight = identitySyncTask {
            return await inflight.value
        }

        let task = Task { @MainActor in await self.performIdentitySync() }
        identitySyncTask = task
        let result = await task.value
        identitySyncTask = nil
        return result
    }

    private func performIdentitySync() async -> StoreIdentityState {
        guard APIClient.shared.isAuthenticated else {
            identity = .signedOut
            return identity
        }

        let serverUserId: String?
        do {
            serverUserId = try await APIClient.shared.fetchMe().user_id
        } catch {
            Self.log.error("syncIdentity: fetchMe failed: \(error.localizedDescription, privacy: .public)")
            identity = .unbound
            return identity
        }
        guard let serverUserId else {
            identity = .signedOut
            return identity
        }

        if StoreIdentity.matches(appUserID: Purchases.shared.appUserID, serverUserID: serverUserId) {
            identity = .bound(serverUserId)
            return identity
        }

        do {
            let result = try await Purchases.shared.logIn(serverUserId)
            customerInfo = result.customerInfo
        } catch {
            // throwは判定に使わない(上記コメント参照)。唯一の真実はSDKが永続化したappUserID。
            Self.log.error("syncIdentity: logIn(\(serverUserId, privacy: .private)) failed: \(error.localizedDescription, privacy: .public)")
        }

        identity = StoreIdentity.matches(appUserID: Purchases.shared.appUserID, serverUserID: serverUserId)
            ? .bound(serverUserId) : .unbound
        return identity
    }

    /// アカウント削除時に呼ぶ。次のセッションが前の購入状態を引き継がないようにする。
    func logOut() async {
        guard isConfigured else { return }
        do {
            customerInfo = try await Purchases.shared.logOut()
        } catch {
            Self.log.error("logOut failed: \(error.localizedDescription, privacy: .public)")
        }
        // ログアウト後にRevenueCatのappUserIDは新しい匿名IDへ変わるが、次のsyncIdentity()呼び出し
        // までは古い.boundが残ってしまう(旧アカウントの購入導線が一瞬開いたままになりうる)ため、
        // ここで即座に.signedOutへ落とす。
        identity = .signedOut
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
