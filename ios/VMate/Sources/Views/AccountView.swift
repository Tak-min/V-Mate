import AuthenticationServices
import CryptoKit
import SwiftUI

/// 購入復元の前提となる安定アカウント。購入機能自体はここに置かない。
struct AccountView: View {
    @Environment(\.dismiss) private var dismiss
    @ObservedObject private var authState = AuthState.shared
    @ObservedObject private var store = RevenueCatManager.shared
    @State private var rawNonce = ""
    @State private var busy = false
    @State private var message: String?
    @State private var showDeleteConfirmation = false
    @State private var storeOpen = false

    var body: some View {
        BrandScreen(title: "アカウント") {
            VStack(alignment: .leading, spacing: Space.xl) {
                accountSection
                // 購入導線はサインイン前でも見せる(StoreView側でサインイン要求を出す)。
                // ここで隠すとPaywallに一切到達できず、新規ユーザーが購入できない(P-C3)。
                proSection

                if authState.isAuthenticated {
                    dataSection
                }

                if let message {
                    Text(message)
                        .font(.brandCaption)
                        .foregroundStyle(.textSecondary)
                }
            }
            .padding(.bottom, Space.xl)
        }
        .sheet(isPresented: $storeOpen) { StoreView() }
        .confirmationDialog("アカウントを削除しますか？", isPresented: $showDeleteConfirmation, titleVisibility: .visible) {
            Button("削除する", role: .destructive) { deleteAccount() }
        } message: {
            Text("この操作は取り消せません。App Store のサブスクリプションは別途解約してください。")
        }
    }

    private var accountSection: some View {
        VStack(alignment: .leading, spacing: Space.md) {
            sectionHeader("アカウント")
            VStack(alignment: .leading, spacing: Space.md) {
                if authState.isAuthenticated {
                    Label("Apple ID と連携済み", systemImage: "checkmark.seal.fill")
                        .font(.brandBodyStrong)
                        .foregroundStyle(.green)
                    Text("機種変更後も会話の記憶と、今後の購入を復元できるようになっています。")
                        .font(.brandCaption)
                        .foregroundStyle(.textSecondary)
                    // 「削除」(dataSection、破壊的操作)とは明確に区別: サインアウトはこの端末の
                    // セッションを終えるだけで、会話やサブスクリプションは失われない。
                    Button("サインアウト") { signOut() }
                        .font(.brandCaption.weight(.semibold))
                        .foregroundStyle(.textSecondary)
                        .disabled(busy)
                    // P-H7: サインイン済みなのに購入導線がブロックされている状態をここでも説明する
                    // (StoreView側の専用noticeだけだと、購入シートを開くまで気づけない)。
                    if store.identity == .unbound {
                        identityUnboundNotice
                    }
                } else {
                    Text("連携すると、機種変更後も会話の記憶を引き継げます。")
                        .font(.brandCaption)
                        .foregroundStyle(.textSecondary)
                    SignInWithAppleButton(.continue) { request in
                        let nonce = Self.randomNonce()
                        rawNonce = nonce
                        request.requestedScopes = [.email]
                        request.nonce = Self.sha256(nonce)
                    } onCompletion: { result in
                        handleAppleResult(result)
                    }
                    .signInWithAppleButtonStyle(.white)
                    .frame(height: 48)
                    .clipShape(RoundedRectangle(cornerRadius: Radius.md, style: .continuous))
                    .disabled(busy)
                }
            }
            .padding(Space.lg)
            .frame(maxWidth: .infinity, alignment: .leading)
            .glassCard()
        }
    }

    private var identityUnboundNotice: some View {
        HStack(alignment: .top, spacing: Space.sm) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(.orange)
            VStack(alignment: .leading, spacing: 2) {
                Text("購入の準備ができていません").font(.brandCaption.weight(.semibold)).foregroundStyle(.textPrimary)
                Text("通信環境を確認し、再試行してください。").font(.brandCaption).foregroundStyle(.textSecondary)
            }
            Spacer()
            Button("再試行") { Task { await store.syncIdentity() } }
                .font(.brandCaption.weight(.semibold))
                .foregroundStyle(Color.accentPink)
        }
    }

    private var proSection: some View {
        VStack(alignment: .leading, spacing: Space.md) {
            sectionHeader("シロ Pro")
            Button { storeOpen = true } label: {
                HStack(spacing: Space.md) {
                    Image(systemName: "sparkles")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(Color.accentPink)
                        .frame(width: 20)
                    Text("購入・復元を見る")
                        .font(.brandBodyStrong)
                        .foregroundStyle(Color.accentPink)
                    Spacer()
                    Image(systemName: "chevron.right")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.textTertiary)
                }
            }
            .padding(Space.lg)
            .frame(maxWidth: .infinity, alignment: .leading)
            .glassCard()
        }
    }

    private var dataSection: some View {
        VStack(alignment: .leading, spacing: Space.md) {
            sectionHeader("データ")
            VStack(alignment: .leading, spacing: Space.md) {
                Button(role: .destructive) {
                    showDeleteConfirmation = true
                } label: {
                    HStack(spacing: Space.md) {
                        Image(systemName: "trash.fill")
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundStyle(.red)
                            .frame(width: 20)
                        Text("アカウントとデータを削除")
                            .font(.brandBodyStrong)
                            .foregroundStyle(.red)
                    }
                }
                Text("会話、記憶、日記、年齢確認情報を削除します。サブスクリプションの解約は App Store で別途行ってください。")
                    .font(.brandCaption)
                    .foregroundStyle(.textSecondary)
            }
            .padding(Space.lg)
            .frame(maxWidth: .infinity, alignment: .leading)
            .glassCard()
        }
    }

    private func sectionHeader(_ title: String) -> some View {
        Text(title)
            .font(.brandCaption.weight(.semibold))
            .foregroundStyle(.textTertiary)
            .textCase(.uppercase)
    }

    private func handleAppleResult(_ result: Result<ASAuthorization, Error>) {
        guard case let .success(authorization) = result,
              let credential = authorization.credential as? ASAuthorizationAppleIDCredential,
              let tokenData = credential.identityToken,
              let token = String(data: tokenData, encoding: .utf8),
              !rawNonce.isEmpty else {
            if case let .failure(error) = result, (error as? ASAuthorizationError)?.code != .canceled { message = "Apple との連携に失敗しました。" }
            return
        }
        busy = true
        Task {
            defer { busy = false }
            do {
                try await APIClient.shared.signInWithApple(identityToken: token, nonce: Self.sha256(rawNonce))
                authState.refresh()
                // RevenueCat の匿名IDをこのアカウントへ紐付ける(worker側 webhook が app_user_id で
                // アカウントを束縛するため、束縛確認込みのsyncIdentity()で実user_idを渡す。P-H7)。
                if await RevenueCatManager.shared.syncIdentity().isBound {
                    message = "Apple ID と連携しました。"
                } else {
                    message = "Apple ID と連携しましたが、購入の準備が完了していません。通信環境を確認して、もう一度お試しください。"
                }
            } catch {
                message = "連携できませんでした。時間をおいて再試行してください。"
            }
        }
    }

    private func signOut() {
        busy = true
        Task {
            defer { busy = false }
            do {
                try APIClient.shared.signOut()
            } catch {
                message = "サインアウトできませんでした。"
                return
            }
            // deleteAccount()と同じ順序: RevenueCatのログアウトを待ってから
            // authStateを更新する(未awaitのdetached Taskだと、直後の再サインインと
            // 順序が競合してcustomerInfoが古い匿名状態で上書きされうる)。
            await RevenueCatManager.shared.logOut()
            authState.refresh()
            message = "サインアウトしました。"
        }
    }

    private func deleteAccount() {
        busy = true
        Task {
            defer { busy = false }
            do {
                try await APIClient.shared.deleteAccount()
                await RevenueCatManager.shared.logOut()
                authState.refresh()
                dismiss()
            } catch {
                message = "削除できませんでした。時間をおいて再試行してください。"
            }
        }
    }

    private static func randomNonce(length: Int = 32) -> String {
        let alphabet = Array("0123456789ABCDEFGHIJKLMNOPQRSTUVXYZabcdefghijklmnopqrstuvwxyz-._")
        return String((0..<length).compactMap { _ in alphabet.randomElement() })
    }

    private static func sha256(_ value: String) -> String {
        SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
    }
}
