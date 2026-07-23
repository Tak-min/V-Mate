import Foundation
import Combine

/// オンボーディングの「初対面」ステップ専用の音声オーケストレーション。
/// CompanionViewModel とは独立した SpeechRecognizer/SpeechQueue を持つ
/// (fullScreenCover 内で完結し、完了時に必ず endSession/detachFromEngine するため、
/// メインのハンズフリー会話と AVAudioEngine が同時起動することはない)。
@MainActor
final class FirstMeetingViewModel: ObservableObject {
    enum Phase: Equatable {
        case idle
        case speakingIntro
        case speakingAskName
        case listening
        case thinking
        case speakingReaction
        case done
        /// 権限拒否・聞き取り失敗の繰り返し・通信エラー等で、音声をあきらめて手入力へ切り替える。
        case textFallback
    }

    @Published private(set) var phase: Phase = .idle
    /// シロの現在のセリフ(吹き出し表示用)。TTSが鳴らない/ミュート環境でも内容が伝わるよう常に併記する。
    @Published private(set) var caption: String = ""
    @Published private(set) var partialTranscript: String = ""
    @Published private(set) var resolvedName: String?

    private let recognizer = SpeechRecognizer()
    private let speech = SpeechQueue()
    private var isSpeakingCancellable: AnyCancellable?
    private var retryCount = 0
    private let maxRetries = 2

    private static let introLine = "はじめまして。ぼくはシロだよ。会えて、なんだかうれしいな。"
    private static let askNameLine = "ねえ、お名前、聞いてもいい？"

    func start() async {
        guard phase == .idle else { return }
        let granted = await recognizer.requestAuthorization()
        guard granted else {
            phase = .textFallback
            return
        }
        try? AudioSessionManager.shared.configureForConversation()
        observeSpeechCompletion()
        await speakAndWait(Self.introLine, emotion: .happy)
        guard phase != .textFallback else { return }
        phase = .speakingAskName
        await speakAndWait(Self.askNameLine, emotion: .shy)
        guard phase != .textFallback else { return }
        beginListening()
    }

    /// 手入力フォールバックへの明示的な切り替え(ユーザーが「名前を入力する」を選んだ場合)。
    func switchToTextFallback() {
        finish(resolvedName: nil, endPhase: .textFallback)
    }

    /// オンボーディングのこのステップを離れる際に必ず呼ぶ(音声エンジンの後始末)。
    func teardown() {
        isSpeakingCancellable?.cancel()
        speech.stop()
        recognizer.endSession()
        speech.detachFromEngine()
        try? AudioSessionManager.shared.configureForPlaybackOnly()
    }

    // MARK: - 発話

    private func observeSpeechCompletion() {
        isSpeakingCancellable = speech.$isSpeaking
            .receive(on: DispatchQueue.main)
            .sink { _ in }
    }

    /// 台詞を再生し、再生完了(isSpeaking: true→false)まで一時停止する。
    private func speakAndWait(_ text: String, emotion: Emotion) async {
        caption = text
        speech.enqueue(text, emotion: emotion)
        await waitUntilSpeechQueueDrains()
    }

    private func waitUntilSpeechQueueDrains() async {
        // enqueue 直後は isSpeaking が非同期に true へ遷移するため、まず true になるのを待ってから
        // false に戻るのを待つ(即 false のままだと enqueue 前の状態を誤って「完了」とみなしてしまう)。
        var becameActive = false
        for await isSpeaking in speech.$isSpeaking.values {
            if isSpeaking { becameActive = true; continue }
            if becameActive { break }
        }
    }

    // MARK: - 聞き取り

    private func beginListening() {
        partialTranscript = ""
        phase = .listening
        speech.attachToEngine(recognizer.audioEngine)
        recognizer.beginSession(callbacks: .init(
            onPartial: { [weak self] text in self?.partialTranscript = text },
            onUtterance: { [weak self] text in self?.handleUtterance(text) },
            onSpeechOnset: {},
            onError: { [weak self] _, _ in self?.handleListeningUnavailable() }
        ))
    }

    private func handleListeningUnavailable() {
        guard phase == .listening else { return }
        finish(resolvedName: nil, endPhase: .textFallback)
    }

    private func handleUtterance(_ text: String) {
        guard phase == .listening else { return }
        recognizer.pauseTurn()
        partialTranscript = ""
        phase = .thinking
        Task { await resolveName(from: text) }
    }

    private func resolveName(from transcript: String) async {
        guard let response = try? await APIClient.shared.requestIntroName(transcript: transcript) else {
            // ネットワーク不調: 聞き取り直しでは解決しないので手入力へ促す。
            finish(resolvedName: nil, endPhase: .textFallback)
            return
        }
        phase = .speakingReaction
        await speakAndWait(response.text, emotion: response.emotion)
        if let name = response.name, !name.isEmpty {
            finish(resolvedName: name, endPhase: .done)
            return
        }
        retryCount += 1
        guard retryCount <= maxRetries else {
            finish(resolvedName: nil, endPhase: .textFallback)
            return
        }
        // beginSession は最初の1回のみ。以降は同じセッション内でターンを再開する。
        partialTranscript = ""
        phase = .listening
        recognizer.resumeTurn()
    }

    private func finish(resolvedName: String?, endPhase: Phase) {
        self.resolvedName = resolvedName
        phase = endPhase
        teardown()
    }
}
