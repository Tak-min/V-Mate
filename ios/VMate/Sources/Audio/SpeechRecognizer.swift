import AVFoundation
import Speech

/// Web版 frontend/src/features/voice/recognition.ts の SpeechRecognizer クラスのSwift移植。
/// AVAudioEngine の入力タップで VoiceActivityDetector を回し、発話区間だけ
/// SFSpeechRecognizer に音声を渡す。沈黙時は認識を起動しない(マイクの監視だけ)。
@MainActor
final class SpeechRecognizer {
    enum ErrorKind {
        case permission
        case noMic
        case unsupported
        case transient
    }

    struct Callbacks {
        var onPartial: (String) -> Void
        var onUtterance: (String) -> Void
        /// 発話検出の瞬間(バージイン用フック。応答中/発話中にこれが来たら中断する)。
        var onSpeechOnset: () -> Void
        var onError: (ErrorKind, String) -> Void
    }

    private static let minUtteranceLength = 2

    private let recognizer: SFSpeechRecognizer?
    private let audioEngine = AVAudioEngine()
    private let vad = VoiceActivityDetector()

    private var callbacks: Callbacks?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var running = false
    private var finalText = ""
    /// オンデバイス認識を試すかどうか。端末にその言語のオンデバイスモデルが
    /// 未ダウンロードだと requiresOnDeviceRecognition=true は1件も結果を返さず
    /// 即時失敗する(既知のSFSpeechRecognizerの挙動)。最初の発話で検出したら
    /// 以後はサーバー認識にフォールバックする。
    private var useOnDeviceRecognition = true
    private var onDeviceFailureNotified = false
    private var receivedAnyResult = false

    init(locale: Locale = Locale(identifier: "ja-JP")) {
        recognizer = SFSpeechRecognizer(locale: locale)
    }

    var isActive: Bool { running }

    /// マイクと音声認識の利用許可を求める。両方許可されないと会話モードは使えない。
    func requestAuthorization() async -> Bool {
        let speechStatus = await withCheckedContinuation { (continuation: CheckedContinuation<SFSpeechRecognizerAuthorizationStatus, Never>) in
            SFSpeechRecognizer.requestAuthorization { status in
                continuation.resume(returning: status)
            }
        }
        guard speechStatus == .authorized else { return false }

        let micGranted = await withCheckedContinuation { (continuation: CheckedContinuation<Bool, Never>) in
            AVAudioSession.sharedInstance().requestRecordPermission { granted in
                continuation.resume(returning: granted)
            }
        }
        return micGranted
    }

    /// マイクを開きVAD監視を開始する(認識自体は発話検出時のみ起動)。
    func start(callbacks: Callbacks) {
        guard !running else { return }
        guard let recognizer, recognizer.isAvailable else {
            callbacks.onError(.unsupported, "音声認識が使えない環境みたい。")
            return
        }
        self.callbacks = callbacks
        vad.reset()
        finalText = ""

        let input = audioEngine.inputNode
        let format = input.outputFormat(forBus: 0)
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
            self?.handleTap(buffer: buffer)
        }

        do {
            audioEngine.prepare()
            try audioEngine.start()
            running = true
        } catch {
            callbacks.onError(.noMic, "マイクが開けなかったみたい。接続を確認してね。")
            input.removeTap(onBus: 0)
        }
    }

    /// 聞き取り停止(発話中のエコー防止・会話モード終了の双方で使う。マイクも解放)。
    func stop() {
        running = false
        audioEngine.inputNode.removeTap(onBus: 0)
        if audioEngine.isRunning { audioEngine.stop() }
        task?.cancel()
        task = nil
        request = nil
        vad.reset()
        finalText = ""
    }

    /// tapはオーディオスレッドから呼ばれる。VADの判定はそのスレッドで行い(状態はVAD内部のみ)、
    /// SFSpeechAudioBufferRecognitionRequest.append はスレッドセーフなのでここで直接呼ぶ。
    /// コールバック経由でのUI/ViewModelへの通知だけ MainActor へホップする。
    private func handleTap(buffer: AVAudioPCMBuffer) {
        let rms = VoiceActivityDetector.rms(from: buffer)
        let nowMs = Date().timeIntervalSince1970 * 1000
        let event = vad.process(rms: rms, nowMs: nowMs)

        switch event {
        case .speechStarted:
            Task { @MainActor [weak self] in self?.beginCapture() }
        case .speechEnded, .maxDurationReached:
            Task { @MainActor [weak self] in self?.endCapture() }
        case .silence:
            break
        }

        if let request, vad.capturing {
            request.append(buffer)
        }
    }

    private func beginCapture() {
        guard let recognizer else { return }
        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = true
        let usedOnDevice = recognizer.supportsOnDeviceRecognition && useOnDeviceRecognition
        req.requiresOnDeviceRecognition = usedOnDevice
        request = req
        finalText = ""
        receivedAnyResult = false
        callbacks?.onSpeechOnset()

        task = recognizer.recognitionTask(with: req) { [weak self] result, error in
            Task { @MainActor [weak self] in
                self?.handleRecognitionResult(result: result, error: error, usedOnDevice: usedOnDevice)
            }
        }
    }

    private func endCapture() {
        request?.endAudio()
    }

    private func handleRecognitionResult(result: SFSpeechRecognitionResult?, error: Error?, usedOnDevice: Bool) {
        if let result {
            receivedAnyResult = true
            finalText = result.bestTranscription.formattedString
            callbacks?.onPartial(finalText)
            if result.isFinal {
                commit()
            }
        }
        if error != nil {
            // オンデバイスモデル未ダウンロード等で1件も結果が来ずに失敗した場合、
            // 以後はオンデバイスを諦めてサーバー認識に切り替える(無音のまま固まるのを防ぐ)。
            if usedOnDevice, !receivedAnyResult {
                useOnDeviceRecognition = false
                if !onDeviceFailureNotified {
                    onDeviceFailureNotified = true
                    callbacks?.onError(.transient, "音声認識をサーバー方式に切り替えたよ。もう一度話してみてね。")
                }
            }
            commit()
        }
    }

    private func commit() {
        let text = finalText.trimmingCharacters(in: .whitespacesAndNewlines)
        finalText = ""
        request = nil
        task = nil
        if text.count >= Self.minUtteranceLength {
            callbacks?.onUtterance(text)
        }
    }
}
