import Foundation
import StoreKit

/// StoreKit 2 の端末側状態。サーバが検証を受理するまで、ここだけでは有料権利を解放しない。
@MainActor
final class StoreKitManager: ObservableObject {
    static let shared = StoreKitManager()

    // P3 catalog.ts と同じ暫定 ID。本番では App Store Connect に同じ ID を作成して有効化する。
    static let productIDs = ["vmate.pro"]
    @Published private(set) var products: [Product] = []
    @Published private(set) var ownedProductIDs = Set<String>()
    @Published private(set) var isAvailable = false
    private var updatesTask: Task<Void, Never>?

    private init() {
        updatesTask = Task { [weak self] in
            for await result in Transaction.updates {
                await self?.handle(result)
            }
        }
    }

    deinit { updatesTask?.cancel() }

    func prepare() async {
        do {
            products = try await Product.products(for: Self.productIDs)
            isAvailable = !products.isEmpty && AppStore.canMakePayments
            await refreshEntitlements()
            // ASSN V2 webhook 未実装(P4b見送り)のため、更新/失効をサーバへ伝える経路が
            // クライアント起動時の再送しか無い。認証済みの時だけ、現在有効な取引を都度サーバへ
            // 再検証させ、entitlements.expires_at を前進させる(未認証はサーバが403のため送らない)。
            if APIClient.shared.isAuthenticated {
                await resubmitCurrentEntitlements()
            }
        } catch {
            // 商品が未作成の環境では非表示／無効のままにする。
            products = []
            isAvailable = false
        }
    }

    private func resubmitCurrentEntitlements() async {
        for await result in Transaction.currentEntitlements {
            guard case let .verified(transaction) = result, Self.productIDs.contains(transaction.productID) else { continue }
            try? await APIClient.shared.verifyApplePurchase(signedTransaction: result.jwsRepresentation)
        }
    }

    func purchase(_ product: Product) async throws {
        guard isAvailable else { throw StoreKitError.unavailable }
        // appAccountToken はサーバ検証で必須。トークン無しの取引はサーバに必ず拒否されるため、購入前に
        // 取得できなければ購入を開始しない(開始してしまうと、ユーザーは Apple に支払ったのに権利が
        // 付与されない=ユーザー側の金銭損失バグになる)。取得失敗/UUIDパース失敗はどちらもエラーで止める。
        guard let tokenString = try? await APIClient.shared.fetchAppAccountToken(),
              let token = UUID(uuidString: tokenString) else {
            throw StoreKitError.accountTokenUnavailable
        }
        let result = try await product.purchase(options: [.appAccountToken(token)])
        if case let .success(verification) = result,
           case let .verified(transaction) = verification {
            try await submit(transaction, signedTransaction: verification.jwsRepresentation)
        }
        // pending/cancelled/unverified は finish も権利付与もしない。
    }

    /// AppStore.sync は認証プロンプトを出すため、UI の明示操作からだけ呼ぶ。
    func restorePurchases() async throws {
        try await AppStore.sync()
        await refreshEntitlements()
    }

    func refreshEntitlements() async {
        var owned = Set<String>()
        for await result in Transaction.currentEntitlements {
            guard case let .verified(transaction) = result, Self.productIDs.contains(transaction.productID) else { continue }
            owned.insert(transaction.productID)
            // サーバが有効化されるまでは finish/解放しない。既存取引の同期境界を準備するだけ。
        }
        ownedProductIDs = owned
    }

    private func handle(_ result: VerificationResult<Transaction>) async {
        guard case let .verified(transaction) = result, Self.productIDs.contains(transaction.productID) else { return }
        try? await submit(transaction, signedTransaction: result.jwsRepresentation)
    }

    private func submit(_ transaction: Transaction, signedTransaction: String) async throws {
        // API が検証器を有効化して 2xx を返すまで finish しない。失敗時は StoreKit が再通知する。
        try await APIClient.shared.verifyApplePurchase(signedTransaction: signedTransaction)
        await transaction.finish()
        await refreshEntitlements()
    }
}

enum StoreKitError: LocalizedError {
    case unavailable
    case accountTokenUnavailable
    var errorDescription: String? {
        switch self {
        case .unavailable: return "アプリ内購入は現在利用できません。"
        case .accountTokenUnavailable: return "購入の準備に失敗しました。通信状態を確認して再度お試しください。"
        }
    }
}
