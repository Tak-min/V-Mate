import Foundation

/// ストリーミングテキストから「文」が完成するたびに取り出す。Web版 speech.ts の SentenceSplitter と同じ役割。
final class SentenceSplitter {
    private var buffer = ""
    private let terminators: Set<Character> = ["。", "!", "?", "！", "？", "\n"]

    func feed(_ chunk: String) -> [String] {
        buffer += chunk
        var sentences: [String] = []
        var current = ""
        for ch in buffer {
            current.append(ch)
            if terminators.contains(ch) {
                let trimmed = current.trimmingCharacters(in: .whitespacesAndNewlines)
                if !trimmed.isEmpty { sentences.append(trimmed) }
                current = ""
            }
        }
        buffer = current
        return sentences
    }

    func flush() -> String? {
        let rest = buffer.trimmingCharacters(in: .whitespacesAndNewlines)
        buffer = ""
        return rest.isEmpty ? nil : rest
    }
}
