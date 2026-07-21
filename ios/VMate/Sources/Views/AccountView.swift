import AuthenticationServices
import CryptoKit
import SwiftUI

/// 購入復元の前提となる安定アカウント。購入機能自体はここに置かない。
struct AccountView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var rawNonce = ""
    @State private var busy = false
    @State private var message: String?
    @State private var showDeleteConfirmation = false
    @State private var storeOpen = false

    var body: some View {
        NavigationStack {
            Form {
                Section("アカウント") {
                    if APIClient.shared.isAuthenticated {
                        Label("Apple ID と連携済み", systemImage: "checkmark.seal.fill")
                            .foregroundStyle(.green)
                        Text("機種変更後も会話の記憶と、今後の購入を復元できるようになっています。")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    } else {
                        Text("連携すると、機種変更後も会話の記憶を引き継げます。")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                        SignInWithAppleButton(.continue) { request in
                            let nonce = Self.randomNonce()
                            rawNonce = nonce
                            request.requestedScopes = [.email]
                            request.nonce = Self.sha256(nonce)
                        } onCompletion: { result in
                            handleAppleResult(result)
                        }
                        .signInWithAppleButtonStyle(.black)
                        .frame(height: 48)
                        .disabled(busy)
                    }
                }

                if APIClient.shared.isAuthenticated {
                    Section("シロ Pro") {
                        Button("購入・復元を見る") { storeOpen = true }
                    }

                    Section("データ") {
                        Button("アカウントとデータを削除", role: .destructive) {
                            showDeleteConfirmation = true
                        }
                        Text("会話、記憶、日記、年齢確認情報を削除します。サブスクリプションの解約は App Store で別途行ってください。")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }

                if let message {
                    Section { Text(message).foregroundStyle(.secondary) }
                }
            }
            .navigationTitle("アカウント")
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("閉じる") { dismiss() } } }
            .sheet(isPresented: $storeOpen) { StoreView() }
            .confirmationDialog("アカウントを削除しますか？", isPresented: $showDeleteConfirmation, titleVisibility: .visible) {
                Button("削除する", role: .destructive) { deleteAccount() }
            } message: {
                Text("この操作は取り消せません。App Store のサブスクリプションは別途解約してください。")
            }
        }
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
                message = "Apple ID と連携しました。"
            } catch {
                message = "連携できませんでした。時間をおいて再試行してください。"
            }
        }
    }

    private func deleteAccount() {
        busy = true
        Task {
            defer { busy = false }
            do {
                try await APIClient.shared.deleteAccount()
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
