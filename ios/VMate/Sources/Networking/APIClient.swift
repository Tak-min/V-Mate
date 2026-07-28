import Foundation
import Security

/// Cloudflare Worker(本番)への通信クライアント。worker/src/index.ts のAPI契約に一致させる。
/// 匿名ID は Set-Cookie(aikata_uid, HttpOnly)で発行される。URLSession 既定の HTTPCookieStorage.shared
/// がディスクに永続化するため、Web版のブラウザCookieと同じ仕組みでアプリ再起動後も同一の「シロ」を維持できる。
final class APIClient {
    static let shared = APIClient()

    // 本番 Cloudflare Worker。Web版と同一バックエンドにそのまま接続する。
    let baseURL = URL(string: "https://aikata.taku810616.workers.dev")!

    private let session: URLSession
    private let tokenStore = KeychainTokenStore(service: "com.takmin.vmate", account: "session-token")

    private init() {
        let config = URLSessionConfiguration.default
        config.httpCookieStorage = HTTPCookieStorage.shared
        // H7(部分): 旧実装は .always で任意のリダイレクト元からの Cookie を受け入れた。
        // 本API の baseURL は固定 workers.dev 单一オリジンなので、メインドメインからの
        // Cookie のみ受け入れる(リダイレクトで他ドメインから Cookie を注入されるのを防ぐ)。
        // SPKI Certificate Pinning は Cloudflare の証明書ローテ問題と ATS 設計判断が絡む
        // ため本イテレでは対処外。別 dev-note で設計を詰めてから投入する。
        config.httpCookieAcceptPolicy = .onlyFromMainDocumentDomain
        config.timeoutIntervalForRequest = 30
        session = URLSession(configuration: config)
    }

    private func url(_ path: String, query: [String: String] = [:]) -> URL {
        var components = URLComponents(url: baseURL.appendingPathComponent(path), resolvingAgainstBaseURL: false)!
        if !query.isEmpty {
            components.queryItems = query.map { URLQueryItem(name: $0.key, value: $0.value) }
        }
        return components.url!
    }

    private func decode<T: Decodable>(_ data: Data, status: Int) throws -> T {
        guard (200..<300).contains(status) else {
            let detail = (try? JSONDecoder().decode([String: String].self, from: data))?["detail"] ?? "サーバーエラー"
            throw APIError.server(detail, status)
        }
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw APIError.decoding
        }
    }

    private func authorized(_ request: inout URLRequest) {
        if let token = tokenStore.read() {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
    }

    private func get<T: Decodable>(_ path: String, query: [String: String] = [:]) async throws -> T {
        var request = URLRequest(url: url(path, query: query))
        authorized(&request)
        let (data, response) = try await session.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        return try decode(data, status: status)
    }

    private func post<T: Decodable>(_ path: String, body: [String: Any]) async throws -> T {
        var request = URLRequest(url: url(path))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        authorized(&request)
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, response) = try await session.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        return try decode(data, status: status)
    }

    var isAuthenticated: Bool { tokenStore.read() != nil }

    struct TokenResponse: Codable { let token: String }

    /// Apple の identity token は Worker 側で署名・issuer・audience・nonce を検証する。
    func signInWithApple(identityToken: String, nonce: String) async throws {
        let response: TokenResponse = try await post("/api/auth/apple", body: [
            "identity_token": identityToken,
            "nonce": nonce,
        ])
        try tokenStore.write(response.token)
    }

    func deleteAccount() async throws {
        struct DeleteResponse: Codable { let ok: Bool }
        let _: DeleteResponse = try await post("/api/auth/delete", body: [:])
        try tokenStore.delete()
        clearAnonymousSession()
    }

    /// アカウント自体は残したまま、この端末のセッションだけを終了する。
    /// トークンはstateless JWT(worker/src/auth.ts、30日TTL)でサーバ側にセッション状態が
    /// 無いため、サーバ呼び出しは不要でローカルのKeychain破棄のみで完結する。
    func signOut() throws {
        try tokenStore.delete()
        clearAnonymousSession()
    }

    /// 匿名Cookie(aikata_uid)を破棄する。サインアウト/削除後もこのCookieを残すと、
    /// 同じ端末で別アカウントが後からサインインした際にworker側のreassignUserData
    /// (worker/src/auth.ts loginWithProvider)が、その間の匿名会話を新アカウントへ
    /// 統合してしまう(= 元ユーザーの離脱後の会話が他人のアカウントに混入する)。
    /// HttpOnlyだがWKWebView/JS用の制約であり、ネイティブのHTTPCookieStorageからは
    /// 削除できる。
    private func clearAnonymousSession() {
        let storage = session.configuration.httpCookieStorage ?? HTTPCookieStorage.shared
        for cookie in storage.cookies(for: baseURL) ?? [] where cookie.name == "aikata_uid" {
            storage.deleteCookie(cookie)
        }
    }

    struct MeResponse: Codable { let authenticated: Bool; let email: String?; let user_id: String? }

    /// RevenueCat の appUserID(Purchases.shared.logIn の引数)に使うサーバ側の安定ユーザーID。
    func fetchMe() async throws -> MeResponse {
        try await get("/api/auth/me")
    }

    func trackEvent(_ event: String) {
        Task {
            struct EventResponse: Codable { let ok: Bool }
            _ = try? await post("/api/analytics/event", body: ["event": event]) as EventResponse
        }
    }

    // --- 状態・履歴 ---

    func fetchState() async throws -> CompanionState {
        try await get("/api/state")
    }

    func fetchHistory(limit: Int = 30) async throws -> [ChatMessage] {
        try await get("/api/history", query: ["limit": String(limit)])
    }

    func setProfile(name: String) async throws -> CompanionState {
        try await post("/api/profile", body: ["user_name": name])
    }

    // --- 年齢ゲート ---

    struct AgeResponse: Codable {
        var age_band: String?
        // 旧WorkerのPOST応答は required を返さないため、段階デプロイ中も読めるようoptional。
        var required: Bool?
    }

    func fetchAge() async throws -> AgeResponse {
        try await get("/api/profile/age")
    }

    /// birthDate は "YYYY-MM-DD"。band はクライアントで計算せずサーバの判定を信頼する。
    func setAge(birthDate: String) async throws -> AgeResponse {
        try await post("/api/profile/age", body: ["birth_date": birthDate])
    }

    // --- 通報(Apple 1.2 UGC対応) ---

    struct ReportResponse: Codable {
        var ok: Bool
    }

    func reportMessage(messageId: Int?, reason: String) async throws -> ReportResponse {
        var body: [String: Any] = ["reason": reason]
        if let messageId { body["message_id"] = messageId }
        return try await post("/api/report", body: body)
    }

    // --- 日記 ---

    func fetchDiary() async throws -> DiaryResponse {
        try await get("/api/diary")
    }

    struct GenerateDiaryResponse: Codable {
        var ok: Bool
        var reason: String?
        var entry: DiaryEntry?
    }

    func generateDiary() async throws -> GenerateDiaryResponse {
        try await post("/api/diary/generate", body: [:])
    }

    // --- 自発的な声かけ ---

    func requestNudge(reason: String) async throws -> NudgeResponse {
        try await post("/api/nudge", body: ["reason": reason])
    }

    // --- 音声オンボーディング(初対面) ---

    /// 聞き取った発話(自由文)からシロが名前を抽出し、温かい返事を生成する。DBには書き込まない。
    func requestIntroName(transcript: String) async throws -> IntroNameResponse {
        try await post("/api/onboarding/intro-name", body: ["transcript": transcript])
    }

    // --- TTS ---

    /// emotion を渡すと声の抑揚(stability/style)が変わる。204 は「合成不可・無音で続行」を意味する。
    func fetchTTS(text: String, emotion: Emotion?) async throws -> Data? {
        var query = ["text": text]
        if let emotion { query["emotion"] = emotion.rawValue }
        var request = URLRequest(url: url("/api/tts", query: query))
        authorized(&request)
        let (data, response) = try await session.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        if status == 204 { return nil }
        guard (200..<300).contains(status) else { return nil }
        return data
    }

    // --- チャット(SSE) ---

    enum ChatEvent {
        case emotion(Emotion)
        case token(String)
        case done(CompanionState)
        case error(String)
    }

    /// /api/chat を SSE で受信し、行ごとに events へ AsyncStream で流す。
    /// Web版 frontend/src/features/chat/api.ts の streamChat と同じワイヤ形式(`data: {json}\n\n`)を読む。
    func streamChat(message: String) -> AsyncThrowingStream<ChatEvent, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    var request = URLRequest(url: self.url("/api/chat"))
                    request.httpMethod = "POST"
                    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
                    self.authorized(&request)
                    request.httpBody = try JSONSerialization.data(withJSONObject: [
                        "message": message,
                    ])

                    let (bytes, response) = try await self.session.bytes(for: request)
                    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                    if status == 429 {
                        var buffer = Data()
                        for try await byte in bytes { buffer.append(byte) }
                        let detail = (try? JSONDecoder().decode([String: String].self, from: buffer))?["detail"]
                        continuation.yield(.error(detail ?? "本日の上限に達しました。"))
                        continuation.finish()
                        return
                    }
                    guard (200..<300).contains(status) else {
                        continuation.yield(.error("サーバーに接続できませんでした (\(status))"))
                        continuation.finish()
                        return
                    }

                    for try await line in bytes.lines {
                        try Task.checkCancellation()
                        guard line.hasPrefix("data: ") else { continue }
                        let jsonText = String(line.dropFirst(6))
                        guard let jsonData = jsonText.data(using: .utf8),
                              let obj = try? JSONSerialization.jsonObject(with: jsonData) as? [String: Any],
                              let type = obj["type"] as? String
                        else { continue }
                        switch type {
                        case "emotion":
                            if let raw = obj["emotion"] as? String, let e = Emotion(rawValue: raw) {
                                continuation.yield(.emotion(e))
                            }
                        case "token":
                            if let text = obj["text"] as? String {
                                continuation.yield(.token(text))
                            }
                        case "done":
                            if let data = try? JSONSerialization.data(withJSONObject: obj),
                               let state = try? JSONDecoder().decode(CompanionState.self, from: data) {
                                continuation.yield(.done(state))
                            }
                        case "error":
                            continuation.yield(.error(obj["message"] as? String ?? "応答の生成に失敗しました"))
                        default:
                            break
                        }
                    }
                    continuation.finish()
                } catch is CancellationError {
                    // バージイン(意図的な中断)。エラー表示はしない。
                    continuation.finish()
                } catch {
                    continuation.yield(.error("接続が切れちゃったみたい…少し待ってからもう一度試してみてね"))
                    continuation.finish()
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}

private final class KeychainTokenStore {
    private let service: String
    private let account: String

    init(service: String, account: String) {
        self.service = service
        self.account = account
    }

    func read() -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    func write(_ token: String) throws {
        let data = Data(token.utf8)
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
        let attributes: [String: Any] = [kSecValueData as String: data, kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock]
        let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            var add = query
            attributes.forEach { add[$0.key] = $0.value }
            guard SecItemAdd(add as CFDictionary, nil) == errSecSuccess else { throw APIError.decoding }
        } else if status != errSecSuccess {
            throw APIError.decoding
        }
    }

    func delete() throws {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw APIError.decoding }
    }
}
