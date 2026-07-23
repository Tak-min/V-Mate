import Foundation

/// シロの感情。worker/src/util.ts の EMOTION_TAG_RE と一致させること。
enum Emotion: String, Codable, CaseIterable {
    case neutral, happy, sad, angry, relaxed, shy
}

struct ChatMessage: Identifiable, Codable, Equatable {
    var id: UUID = UUID()
    var role: String // "user" | "assistant"
    var content: String
    var emotion: Emotion?
    /// 応答待ち中だけ表示する一言(Web版の waitingCueFor と同じ役割)。本文ではない。
    var cue: String?

    enum CodingKeys: String, CodingKey {
        case role, content, emotion
    }

    init(role: String, content: String, emotion: Emotion? = nil, cue: String? = nil) {
        self.role = role
        self.content = content
        self.emotion = emotion
        self.cue = cue
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        role = try c.decode(String.self, forKey: .role)
        content = try c.decode(String.self, forKey: .content)
        emotion = try? c.decode(Emotion.self, forKey: .emotion)
    }
}

struct CompanionState: Codable, Equatable {
    var user_name: String?
    var affinity: Int
    var stage: String
    var next_stage_at: Int?
    var provider: String
    var recent_facts: [String]?
}

struct DiaryEntry: Identifiable, Codable, Equatable {
    var id: String { entry_date }
    var entry_date: String
    var content: String
}

struct DiaryResponse: Codable {
    var entries: [DiaryEntry]
    var can_generate_today: Bool
}

struct NudgeResponse: Codable {
    var text: String
    var emotion: Emotion
    var days_away: Int?
}

/// 音声オンボーディング(初対面)で、聞き取った発話から名前を抽出した結果。
/// name が nil のときは聞き取れなかった/名乗っていないことを意味し、
/// text にはやり直しを促す優しい返事が入る(空文字にはならない)。
struct IntroNameResponse: Codable {
    var name: String?
    var text: String
    var emotion: Emotion
}

enum APIError: Error, LocalizedError {
    case server(String, Int)
    case decoding
    case network(Error)

    var errorDescription: String? {
        switch self {
        case .server(let detail, let status): return "\(detail) (\(status))"
        case .decoding: return "応答の解析に失敗しました"
        case .network(let e): return e.localizedDescription
        }
    }
}
