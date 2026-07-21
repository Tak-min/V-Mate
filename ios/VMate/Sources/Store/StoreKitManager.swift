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
        } catch {
            // 商品が未作成の環境では非表示／無効のままにする。
            products = []
            isAvailable = false
        }
    }

    func purchase(_ product: Product) async throws {
        guard isAvailable else { throw StoreKitError.unavailable }
        let result = try await product.purchase()
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
    var errorDescription: String? { "アプリ内購入は現在利用できません。" }
}
