import Foundation
import Combine

/// Web版 frontend/src/features/chat/useCompanion.ts のSwift移植。
/// 同じ本番Cloudflare Workerバックエンドに接続し、同じ会話フロー(挨拶→チャット→アイドル声かけ)を再現する。
@MainActor
final class CompanionViewModel: ObservableObject {
    @Published var messages: [ChatMessage] = []
    @Published var state: CompanionState?
    @Published var busy = false
    @Published var ready = false
    @Published var voiceEnabled = true
    @Published var condition: PresentationCondition?
    @Published var avatarMouthLevel: Double = 0
    @Published var currentEmotion: Emotion = .neutral

    let speech = SpeechQueue()

    // Web版と同じ間引き設定(2026-06-19 干渉低減対応)。
    private let idleNudgeSeconds: TimeInterval = 240
    private let relaxAfterSeconds: TimeInterval = 6

    private var idleTimer: Timer?
    private var relaxTimer: Timer?
    private var greeted = false
    private var mouthLevelCancellable: AnyCancellable?

    init() {
        mouthLevelCancellable = speech.$mouthLevel
            .receive(on: DispatchQueue.main)
            .sink { [weak self] level in self?.avatarMouthLevel = level }
    }

    func bootstrap() async {
        do {
            let session = try await APIClient.shared.startResearchSession()
            condition = session.condition
            APIClient.shared.logResearchEvent(condition: session.condition, eventType: "condition_loaded")
        } catch {
            condition = .stylized
        }
        ready = true

        async let stateTask: CompanionState? = try? APIClient.shared.fetchState()
        async let historyTask: [ChatMessage]? = try? APIClient.shared.fetchHistory()
        state = await stateTask
        if let history = await historyTask { messages = history }

        if !greeted {
            greeted = true
            await requestNudge(reason: "greeting")
            resetIdleTimer()
        }
    }

    func send(_ raw: String) {
        let message = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !message.isEmpty, !busy, let condition else { return }
        busy = true
        messages.append(ChatMessage(role: "user", content: message))
        let placeholderIndex = messages.count
        messages.append(ChatMessage(role: "assistant", content: "", emotion: .relaxed, cue: waitingCue(for: message)))

        let splitter = SentenceSplitter()
        var emotion: Emotion = .neutral

        Task {
            do {
                for try await event in APIClient.shared.streamChat(message: message, condition: condition) {
                    switch event {
                    case .emotion(let e):
                        emotion = e
                        currentEmotion = e
                        scheduleRelax()
                    case .token(let text):
                        appendToMessage(at: placeholderIndex, text: text, emotion: emotion)
                        for sentence in splitter.feed(text) {
                            speech.enqueue(sentence, emotion: emotion)
                        }
                    case .done(let newState):
                        state = newState
                        if let rest = splitter.flush() {
                            speech.enqueue(rest, emotion: emotion)
                        }
                    case .error(let message):
                        appendToMessage(at: placeholderIndex, text: message, emotion: emotion)
                    }
                }
            } catch {
                appendToMessage(at: placeholderIndex, text: "(接続が切れちゃったみたい…バックエンドは起動してる?)", emotion: emotion)
            }
            busy = false
            resetIdleTimer()
        }
    }

    func saveName(_ name: String) {
        Task {
            if let next = try? await APIClient.shared.setProfile(name: name) {
                state = next
            }
        }
    }

    func toggleVoice() {
        voiceEnabled.toggle()
        speech.setEnabled(voiceEnabled)
        if let condition {
            APIClient.shared.logResearchEvent(condition: condition, eventType: "voice_toggled", payload: ["enabled": voiceEnabled])
        }
    }

    func noticeInputActivity() {
        resetIdleTimer()
    }

    // MARK: - 内部

    private func appendToMessage(at index: Int, text: String, emotion: Emotion) {
        guard messages.indices.contains(index) else { return }
        messages[index].content += text
        messages[index].emotion = emotion
    }

    private func requestNudge(reason: String) async {
        guard let response = try? await APIClient.shared.requestNudge(reason: reason), !response.text.isEmpty else { return }
        messages.append(ChatMessage(role: "assistant", content: response.text, emotion: response.emotion))
        currentEmotion = response.emotion
        scheduleRelax()
        speech.enqueue(response.text, emotion: response.emotion)
    }

    private func resetIdleTimer() {
        idleTimer?.invalidate()
        idleTimer = Timer.scheduledTimer(withTimeInterval: idleNudgeSeconds, repeats: false) { [weak self] _ in
            Task { @MainActor in await self?.requestNudge(reason: "idle") }
        }
    }

    private func scheduleRelax() {
        relaxTimer?.invalidate()
        relaxTimer = Timer.scheduledTimer(withTimeInterval: relaxAfterSeconds, repeats: false) { [weak self] _ in
            Task { @MainActor in self?.currentEmotion = .neutral }
        }
    }

    private func waitingCue(for message: String) -> String {
        let defaults = ["うん、聞いてる。", "少し考えるね。", "ちゃんと受け取ったよ。", "今の言葉、ゆっくり見てる。"]
        if message.range(of: "疲|つか|しんど|眠|ねむ|つら|辛|だる|限界", options: .regularExpression) != nil {
            return ["そっか、少し重かったんだね。", "うん、無理しないで聞くね。"].randomElement()!
        }
        if message.range(of: "不安|怖|こわ|心配|緊張|泣|かなしい|悲", options: .regularExpression) != nil {
            return ["大丈夫、急がなくていいよ。", "ここにいるから、ゆっくりでいいよ。"].randomElement()!
        }
        if message.range(of: "嬉|うれ|楽しか|最高|できた|成功|よかった", options: .regularExpression) != nil {
            return ["わ、それ聞きたい。", "いいね、ちゃんと聞かせて。"].randomElement()!
        }
        if message.hasSuffix("?") || message.hasSuffix("?") || message.range(of: "どう|なぜ|なんで|教えて|かな", options: .regularExpression) != nil {
            return ["うん、いっしょに考える。", "少し整理してみるね。"].randomElement()!
        }
        if message.count > 80 {
            return ["長めに話してくれてるね。ちゃんと読んでる。", "ひとつずつ受け取るね。"].randomElement()!
        }
        return defaults.randomElement()!
    }

    deinit {
        idleTimer?.invalidate()
        relaxTimer?.invalidate()
    }
}
