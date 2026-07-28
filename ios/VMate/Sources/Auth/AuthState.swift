import Foundation

/// `APIClient.isAuthenticated` は Keychain を同期読みする computed property で、
/// 値が変わってもSwiftUIは再描画をトリガーしない。サインイン/サインアウト/削除の直後に
/// `refresh()` を呼ぶことで、これを購読する View に変更を伝播させる。
@MainActor
final class AuthState: ObservableObject {
    static let shared = AuthState()

    @Published private(set) var isAuthenticated: Bool

    private init() {
        isAuthenticated = APIClient.shared.isAuthenticated
    }

    /// Keychainのトークンを書き換える操作(サインイン/サインアウト/アカウント削除)の直後に呼ぶ。
    func refresh() {
        isAuthenticated = APIClient.shared.isAuthenticated
    }
}
