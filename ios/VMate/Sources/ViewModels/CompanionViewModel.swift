import Foundation
import Combine
import Speech

/// ハンズフリー音声会話の状態。Web版 useCompanion.ts の VoiceMode と同じ役割。
/// off=テキストのみ / listening=聞き取り中 / thinking=応答待ち / speaking=発話中
enum VoiceMode {
    case off
    case listening
    case thinking
    case speaking
}

/// Web版 frontend/src/features/chat/useCompanion.ts のSwift移植。
/// 同じ本番Cloudflare Workerバックエンドに接続し、同じ会話フロー(挨拶→チャット→アイドル声かけ)を再現する。
@MainActor
final class CompanionViewModel: ObservableObject {
    @Published var messages: [ChatMessage] = []
    @Published var state: CompanionState?
    @Published var busy = false
    @Published var ready = false
    @Published var voiceEnabled = true
    @Published var avatarMouthLevel: Double = 0
    @Published var currentEmotion: Emotion = .neutral

    // --- ハンズフリー音声会話 ---
    @Published var voiceMode: VoiceMode = .off
    @Published var partialTranscript: String = ""
    @Published var voiceError: String?
    let voiceSupported = SFSpeechRecognizer.authorizationStatus() != .restricted

    /// 初回起動判定(UserDefaults)。Web版の localStorage aikata_onboarded に相当。
    var isFirstRun: Bool {
        !UserDefaults.standard.bool(forKey: "vmate_onboarded")
    }

    func markOnboarded() {
        UserDefaults.standard.set(true, forKey: "vmate_onboarded")
    }

    let speech = SpeechQueue()
    private let recognizer = SpeechRecognizer()
    private var streamTask: Task<Void, Never>?

    // Web版と同じ間引き設定(2026-06-19 干渉低減対応)。
    private let idleNudgeSeconds: TimeInterval = 240
    private let relaxAfterSeconds: TimeInterval = 6

    private var idleTimer: Timer?
    private var relaxTimer: Timer?
    private var greeted = false
    private var mouthLevelCancellable: AnyCancellable?
    private var isSpeakingCancellable: AnyCancellable?
    /// 応答終了→聞き取り再開を遅延させるための待機ジョブ(キャンセル可能)。
    private var resumeWorkItem: DispatchWorkItem?
    /// TTS再生終了から聞き取りを再開するまでの待ち時間。
    /// 0.45s では TTS末尾の残響がVADを誤起動させることがあった(6/23以降の常時エンジン設計では
    /// AECは収束済みだが室内残響はAECでは除去されない)。1.2s に延長してVAD warmup(400ms)と
    /// 合わせて合計~1.6s の保護窓を確保する。
    private let resumeListeningDelay: TimeInterval = 1.2

    init() {
        mouthLevelCancellable = speech.$mouthLevel
            .receive(on: DispatchQueue.main)
            .sink { [weak self] level in self?.avatarMouthLevel = level }
        // TTS再生キューが空になったら、会話モード中は聞き取りを再開する。
        // isSpeaking が true に戻った場合(マルチセンテンス応答のキューアンダーラン後に
        // 次の文が届いた)は、予約済みの workItem をキャンセルしてループを防ぐ。
        isSpeakingCancellable = speech.$isSpeaking
            .receive(on: DispatchQueue.main)
            .sink { [weak self] isSpeaking in
                guard let self else { return }
                if isSpeaking {
                    // TTS 再開 → アンダーラン後の回復。予約中の arm をキャンセルする。
                    self.resumeWorkItem?.cancel()
                    self.resumeWorkItem = nil
                } else if self.voiceMode == .speaking {
                    self.resumeListening()
                }
            }
    }

    func bootstrap() async {
        // 研究条件の取得は廃止(製品では研究スキャフォールドを撤去。Web版と同形)。
        try? AudioSessionManager.shared.configureForPlaybackOnly()
        ready = true

        async let stateTask: CompanionState? = try? APIClient.shared.fetchState()
        async let historyTask: [ChatMessage]? = try? APIClient.shared.fetchHistory()
        state = await stateTask
        if let history = await historyTask { messages = history }

        // 初回ユーザーは OnboardingView 経由で fireGreeting() が呼ばれる。
        // 2回目以降のユーザーのみここで挨拶。
        if !isFirstRun && !greeted {
            greeted = true
            await requestNudge(reason: "greeting")
            resetIdleTimer()
        }
    }

    func send(_ raw: String) {
        let message = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !message.isEmpty, !busy else { return }
        busy = true
        messages.append(ChatMessage(role: "user", content: message))
        let placeholderIndex = messages.count
        messages.append(ChatMessage(role: "assistant", content: "", emotion: .relaxed, cue: waitingCue(for: message)))

        let splitter = SentenceSplitter()
        var emotion: Emotion = .neutral
        if voiceMode != .off { voiceMode = .thinking }

        streamTask = Task {
            do {
                for try await event in APIClient.shared.streamChat(message: message) {
                    try Task.checkCancellation()
                    switch event {
                    case .emotion(let e):
                        emotion = e
                        currentEmotion = e
                        scheduleRelax()
                    case .token(let text):
                        appendToMessage(at: placeholderIndex, text: text, emotion: emotion)
                        if voiceMode == .thinking { voiceMode = .speaking }
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
            } catch is CancellationError {
                // バージイン(意図的な中断)。エラー表示はしない。
            } catch {
                appendToMessage(at: placeholderIndex, text: "(接続が切れちゃったみたい…バックエンドは起動してる?)", emotion: emotion)
            }
            busy = false
            resetIdleTimer()
            // 音声会話中は、応答完了かつTTS再生キューが空ならここで即座に聞き取りへ戻す
            // (TTSキューがそもそも空=無音応答だった場合、speech.$isSpeakingのfalse遷移が
            // 発火しないため、ここでも明示的にチェックする)。
            if voiceMode != .off, !speech.isSpeaking {
                resumeListening()
            }
        }
    }

    // MARK: - ハンズフリー音声会話

    /// マイクボタン: off⇄listening。初回は権限要求。
    func toggleHandsFree() async {
        if voiceMode != .off {
            stopListening()
            return
        }
        guard voiceSupported else {
            voiceError = "このデバイスは音声入力に対応していないみたい。"
            return
        }
        let granted = await recognizer.requestAuthorization()
        guard granted else {
            voiceError = "マイク/音声認識の使用が許可されていないみたい。設定から許可してね。"
            return
        }
        voiceError = nil
        try? AudioSessionManager.shared.configureForConversation()
        if !voiceEnabled { toggleVoice() } // 会話なので相手の声も聞こえるように
        beginVoiceSession()
    }

    /// 会話モードに入る時に1回だけ呼ぶ。マイク/AVAudioEngineを開いたまま会話を通して
    /// 使い続けることで、ターンごとのエンジン再起動(AEC再収束による発話冒頭ロス)を無くす。
    /// 以後のターンの聞き取り再開/休止は `resumeListening()`/`handleUtterance()` が行う。
    private func beginVoiceSession() {
        resumeWorkItem?.cancel()
        resumeWorkItem = nil
        partialTranscript = ""
        voiceMode = .listening
        recognizer.beginSession(callbacks: .init(
            onPartial: { [weak self] text in self?.partialTranscript = text },
            onUtterance: { [weak self] text in self?.handleUtterance(text) },
            onSpeechOnset: { [weak self] in self?.handleSpeechOnset() },
            onError: { [weak self] _, message in self?.voiceError = message }
        ))
    }

    private func stopListening() {
        resumeWorkItem?.cancel()
        resumeWorkItem = nil
        recognizer.endSession()
        partialTranscript = ""
        voiceMode = .off
        try? AudioSessionManager.shared.configureForPlaybackOnly()
    }

    /// マイクが1ターン分の発話を確定 → 送信。エコー防止に聞き取りは一旦休止する
    /// (エンジン自体は止めない。`resumeListening()`がターン再開時に`resumeTurn()`で再開する)。
    private func handleUtterance(_ text: String) {
        guard voiceMode != .off else { return }
        recognizer.pauseTurn()
        partialTranscript = ""
        send(text)
    }

    /// バージイン: 発話/応答待ちの最中にユーザーが話し始めたら、中断してそのまま聞き取りを続ける。
    private func handleSpeechOnset() {
        guard voiceMode == .thinking || voiceMode == .speaking else { return }
        resumeWorkItem?.cancel()
        resumeWorkItem = nil
        streamTask?.cancel()
        speech.stop()
        voiceMode = .listening
    }

    /// 応答完了+TTS再生キューが空になったら聞き取りを再開する。
    /// workItem 発火時に `speech.isSpeaking` を再チェックし、マルチセンテンス応答の
    /// キューアンダーラン後に TTS が再開していた場合は arm をスキップする(ループ防止)。
    private func resumeListening() {
        guard voiceMode != .off else { return }
        resumeWorkItem?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self,
                  self.voiceMode != .off,
                  !self.speech.isSpeaking else { return }
            self.partialTranscript = ""
            self.voiceMode = .listening
            self.recognizer.resumeTurn()
        }
        resumeWorkItem = work
        DispatchQueue.main.asyncAfter(deadline: .now() + resumeListeningDelay, execute: work)
    }

    /// オンボーディング完了後に呼び出される挨拶トリガー。
    func fireGreeting() {
        guard !greeted else { return }
        greeted = true
        Task {
            await requestNudge(reason: "greeting")
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
