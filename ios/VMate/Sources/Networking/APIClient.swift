import Foundation

/// Cloudflare Worker(本番)への通信クライアント。worker/src/index.ts のAPI契約に一致させる。
/// 匿名ID は Set-Cookie(aikata_uid, HttpOnly)で発行される。URLSession 既定の HTTPCookieStorage.shared
/// がディスクに永続化するため、Web版のブラウザCookieと同じ仕組みでアプリ再起動後も同一の「シロ」を維持できる。
final class APIClient {
    static let shared = APIClient()

    // 本番 Cloudflare Worker。Web版と同一バックエンドにそのまま接続する。
    let baseURL = URL(string: "https://aikata.taku810616.workers.dev")!

    private let session: URLSession

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

    private func get<T: Decodable>(_ path: String, query: [String: String] = [:]) async throws -> T {
        let (data, response) = try await session.data(from: url(path, query: query))
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        return try decode(data, status: status)
    }

    private func post<T: Decodable>(_ path: String, body: [String: Any]) async throws -> T {
        var request = URLRequest(url: url(path))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, response) = try await session.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        return try decode(data, status: status)
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

    // --- TTS ---

    /// emotion を渡すと声の抑揚(stability/style)が変わる。204 は「合成不可・無音で続行」を意味する。
    func fetchTTS(text: String, emotion: Emotion?) async throws -> Data? {
        var query = ["text": text]
        if let emotion { query["emotion"] = emotion.rawValue }
        let (data, response) = try await session.data(from: url("/api/tts", query: query))
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
                    continuation.yield(.error("接続が切れちゃったみたい…バックエンドは起動してる?"))
                    continuation.finish()
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}
