import AVFoundation
import Speech
import os

/// マイク音声パイプラインの診断ログ。実機での切り分け用。
let micLog = Logger(subsystem: "com.takmin.vmate", category: "mic")

/// 発話確定前の直近バッファを保持するリングバッファ。VADのonset確認(onsetFrames連続)に
/// かかる間に届くバッファは「まだ発話と確定していない」ため認識リクエストへ送られないが、
/// 確定した瞬間にこのリングバッファの内容を先頭に流し込むことで、発話冒頭の取りこぼしを防ぐ。
struct PreRollBuffer {
    private var buffers: [AVAudioPCMBuffer] = []
    private let capacity: Int

    init(capacityFrames: Int) {
        capacity = max(0, capacityFrames)
    }

    mutating func push(_ buffer: AVAudioPCMBuffer) {
        guard capacity > 0 else { return }
        buffers.append(buffer)
        if buffers.count > capacity {
            buffers.removeFirst(buffers.count - capacity)
        }
    }

    mutating func drainAndClear() -> [AVAudioPCMBuffer] {
        let drained = buffers
        buffers = []
        return drained
    }
}

/// 単純なBoolフラグをオーディオスレッドとMainActorの双方から安全に読み書きするためのロック付きラッパー。
final class LockedFlag: @unchecked Sendable {
    private let lock: OSAllocatedUnfairLock<Bool>

    init(_ initial: Bool) {
        lock = OSAllocatedUnfairLock(initialState: initial)
    }

    var value: Bool {
        get { lock.withLock { $0 } }
        set { lock.withLock { $0 = newValue } }
    }
}

/// AVAudioEngineのtapコールバック(オーディオレンダースレッド、直列実行が保証される)から
/// 同期的に呼ばれる音声キャプチャパイプライン。
///
/// ターン切り替え時は cancelCapture() でタスクを明示キャンセルする。
/// キャンセルしないと前ターンのタスクが生き続け、resumeTurn() によるリセット後に
/// エラーコールバックが届いて useOnDeviceRecognition が誤って false に設定される
/// (Bug: 常にサーバー認識にフォールバックする問題の真因)。
///
/// vad/preRoll/request/task はtapスレッドからのみ触る。`useOnDeviceRecognition`だけは
/// MainActor側からも書かれるため `LockedFlag` で保護する。
final class AudioCapturePipeline {
    struct Callbacks {
        /// 発話開始の通知。MainActorへのホップ・finalText等のリセットは呼び出し側(SpeechRecognizer)が行う。
        var onSpeechOnset: () -> Void
        /// 認識結果(またはエラー)の通知。usedOnDeviceは次回以降のオンデバイス継続判定に使う。
        var onRecognitionEvent: (SFSpeechRecognitionResult?, Error?, Bool) -> Void
    }

    private let recognizer: SFSpeechRecognizer
    private let vad: VoiceActivityDetector
    private let callbacks: Callbacks
    /// 既定はオンデバイス認識(true)。iOS 17以降のiPhoneではja-JPモデルが自動DL済みのため
    /// ネットワーク往復なしで認識が完結し低遅延になる。モデル未DLの端末で失敗した場合は
    /// handleRecognitionResultのフォールバックがvalueをfalseに切り替え、次回以降サーバーに移行。
    let useOnDeviceRecognition = LockedFlag(true)
    /// ターン単位の聞き取りON/OFF。エンジン/tap自体は会話モード中ずっと生かしたまま、
    /// このフラグだけでターンごとの「聞き取り中か」を切り替える。
    let enabled = LockedFlag(false)
    /// MainActorからの次ターン再開要求。tapスレッドが消費するタイミングで vad/preRoll をリセット。
    private let pendingArm = LockedFlag(false)

    private var preRoll: PreRollBuffer
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?

    init(recognizer: SFSpeechRecognizer, vad: VoiceActivityDetector, preRollCapacityFrames: Int, callbacks: Callbacks) {
        self.recognizer = recognizer
        self.vad = vad
        self.callbacks = callbacks
        preRoll = PreRollBuffer(capacityFrames: preRollCapacityFrames)
    }

    /// MainActorから呼ぶ。次にtapスレッドへバッファが届いたタイミングで、tapスレッド上で
    /// vad/preRollのリセットと前ターンの取り残しrequestの後始末が行われ、その後聞き取りを
    /// 有効化する。エンジン/tap自体は再構築しない(=AECは会話を通して収束したまま)。
    func arm() {
        pendingArm.value = true
        enabled.value = true
    }

    /// MainActorから呼ぶ。以後のtapバッファは即座に捨てられる(エンジンは動き続ける)。
    func disarm() {
        enabled.value = false
    }

    /// tapスレッドのゲート判定を純関数として切り出したもの。
    static func gateDecision(enabled: Bool, pendingArm: Bool) -> (doReset: Bool, process: Bool) {
        (doReset: pendingArm, process: enabled)
    }

    /// tapスレッドから直接(同期)呼ばれる。
    func handleTap(buffer: AVAudioPCMBuffer) {
        let gate = Self.gateDecision(enabled: enabled.value, pendingArm: pendingArm.value)
        if gate.doReset {
            pendingArm.value = false
            vad.reset()
            _ = preRoll.drainAndClear()
            // 新ターン開始のクリーンアップ: 前ターンのタスクを明示キャンセルする。
            // task = nil だけでは参照を手放すだけでコールバックは届き続ける。
            cancelCapture()
        }
        guard gate.process else { return }

        let rms = VoiceActivityDetector.rms(from: buffer)
        let nowMs = CACurrentMediaTime() * 1000
        let event = vad.process(rms: rms, nowMs: nowMs)

        // 沈黙中はログを間引く
        if event != .silence || vad.capturing {
            #if DEBUG
            micLog.debug("tap rms=\(rms, format: .fixed(precision: 5)) thr=\(self.vad.debugLastThreshold, format: .fixed(precision: 5)) floor=\(self.vad.noiseFloor, format: .fixed(precision: 5))")
            #endif
        }

        switch event {
        case .speechStarted:
            #if DEBUG
            micLog.info("VAD speechStarted rms=\(rms, format: .fixed(precision: 5))")
            #endif
            beginCapture()
            for preRollBuffer in preRoll.drainAndClear() {
                request?.append(preRollBuffer)
            }
            request?.append(buffer)
        case .speechEnded, .maxDurationReached:
            #if DEBUG
            micLog.info("VAD \(String(describing: event)) — finishCapture")
            #endif
            // 発話の自然終了: endAudio() でタスクに音声終了を通知し、最終結果コールバックを待つ。
            // タスクはキャンセルしない(commitのためにコールバックが必要)。
            finishCapture()
        case .silence:
            if vad.capturing {
                request?.append(buffer)
            } else {
                preRoll.push(buffer)
            }
        }
    }

    /// マイクを開く前(tapインストール前)に呼ぶ。tapと並行して呼ばないこと。
    func reset() {
        enabled.value = false
        useOnDeviceRecognition.value = true   // セッション開始ごとにオンデバイスを再試行
        pendingArm.value = false
        vad.reset()
        _ = preRoll.drainAndClear()
        task?.cancel()
        task = nil
        request = nil
    }

    /// 同期的に呼ばれる。renderスレッド上でrequestとtaskを即座に生成する。
    /// 非同期DispatchQueue.main.asyncを使わないことで、バッファの遅延やレースを防ぐ。
    private func beginCapture() {
        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = true
        let usedOnDevice = recognizer.supportsOnDeviceRecognition && useOnDeviceRecognition.value
        req.requiresOnDeviceRecognition = usedOnDevice
        request = req
        callbacks.onSpeechOnset()

        #if DEBUG
        micLog.info("beginCapture onDevice=\(usedOnDevice)")
        #endif

        task = recognizer.recognitionTask(with: req) { [weak self] result, error in
            self?.callbacks.onRecognitionEvent(result, error, usedOnDevice)
        }
    }

    /// 新ターン開始時に前ターンのタスクを明示キャンセルする。
    /// task = nil だけでは参照を手放すだけでコールバックは止まらない。
    /// キャンセルしないと receivedAnyResult リセット後に届く古いエラーコールバックが
    /// useOnDeviceRecognition を誤って false に設定してしまう。
    private func cancelCapture() {
        task?.cancel()
        task = nil
        request = nil
    }

    /// 発話の自然終了。endAudio() で残バッファを処理させ最終結果コールバックを待つ。
    /// タスクはキャンセルしない(isFinal コールバック → commit() に必要)。
    private func finishCapture() {
        request?.endAudio()
        request = nil
        task = nil
    }
}

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
        /// 発話検出の瞬間(バージイン用フック)。
        var onSpeechOnset: () -> Void
        var onError: (ErrorKind, String) -> Void
    }

    private static let minUtteranceLength = 2
    /// VADのonset確認に必要なフレーム数 + 余裕フレーム。pre-rollを厚めに確保する(2+6=8フレーム≒512ms@16kHz)。
    private static let preRollMargin = 6

    private let recognizer: SFSpeechRecognizer?
    private let audioEngine = AVAudioEngine()
    private let vadConfig = VADConfig()
    private var pipeline: AudioCapturePipeline?

    private var callbacks: Callbacks?
    private var running = false
    private var finalText = ""
    private var onDeviceFailureNotified = false
    private var receivedAnyResult = false
    /// このセッション中にオンデバイス認識が1回でも成功したか。
    /// 成功実績があればモデルは確実に存在するため、その後「発話なし」エラーが来ても
    /// useOnDeviceRecognition を false にしない(誤起動の無音認識を失敗扱いしないため)。
    private var onDeviceEverSucceeded = false

    init(locale: Locale = Locale(identifier: "ja-JP")) {
        recognizer = SFSpeechRecognizer(locale: locale)
    }

    var isActive: Bool { running }

    /// マイクと音声認識の利用許可を求める。
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

    /// 会話モードに入る時に1回だけ呼ぶ。マイクとAVAudioEngineを開いたままにし、AECを
    /// 会話を通して収束させる。
    func beginSession(callbacks: Callbacks) {
        guard !running else { return }
        guard let recognizer, recognizer.isAvailable else {
            callbacks.onError(.unsupported, "音声認識が使えない環境みたい。")
            return
        }
        self.callbacks = callbacks
        finalText = ""
        receivedAnyResult = false
        onDeviceFailureNotified = false
        onDeviceEverSucceeded = false

        let vad = VoiceActivityDetector(config: vadConfig)
        let newPipeline = AudioCapturePipeline(
            recognizer: recognizer,
            vad: vad,
            preRollCapacityFrames: vadConfig.onsetFrames + Self.preRollMargin,
            callbacks: AudioCapturePipeline.Callbacks(
                onSpeechOnset: { [weak self] in
                    Task { @MainActor [weak self] in self?.handleSpeechOnset() }
                },
                onRecognitionEvent: { [weak self] result, error, usedOnDevice in
                    Task { @MainActor [weak self] in
                        self?.handleRecognitionResult(result: result, error: error, usedOnDevice: usedOnDevice)
                    }
                }
            )
        )
        pipeline = newPipeline

        // Apple推奨の正しい順序: installTap → prepare() → start()
        let input = audioEngine.inputNode
        let format = input.outputFormat(forBus: 0)
        #if DEBUG
        micLog.info("beginSession tapFormat sr=\(format.sampleRate) ch=\(format.channelCount) | onDeviceSupported=\(recognizer.supportsOnDeviceRecognition) available=\(recognizer.isAvailable)")
        #endif
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
            newPipeline.handleTap(buffer: buffer)
        }

        do {
            audioEngine.prepare()
            try audioEngine.start()
            running = true
            newPipeline.arm()
            #if DEBUG
            micLog.info("beginSession engine started, pipeline armed")
            #endif
        } catch {
            micLog.error("beginSession engine start FAILED: \(error.localizedDescription)")
            callbacks.onError(.noMic, "マイクが開けなかったみたい。接続を確認してね。")
            input.removeTap(onBus: 0)
        }
    }

    /// 会話モード終了時に1回だけ呼ぶ。マイクを解放する(エンジン停止・tap除去)。
    func endSession() {
        running = false
        audioEngine.inputNode.removeTap(onBus: 0)
        if audioEngine.isRunning { audioEngine.stop() }
        pipeline?.reset()
        pipeline = nil
        finalText = ""
    }

    /// 1ターン分の聞き取りを再開する。エンジン/tapには触らず、`AudioCapturePipeline`の
    /// ゲートフラグを立てるだけ。
    func resumeTurn() {
        guard running else { return }
        finalText = ""
        receivedAnyResult = false
        pipeline?.arm()
    }

    /// 1ターン分の聞き取りを休止する(発話確定後のエコー防止用)。エンジンは動き続ける。
    func pauseTurn() {
        pipeline?.disarm()
    }

    /// AudioCapturePipelineからのonSpeechOnset通知(MainActor上)。
    private func handleSpeechOnset() {
        finalText = ""
        receivedAnyResult = false
        callbacks?.onSpeechOnset()
    }

    private func handleRecognitionResult(result: SFSpeechRecognitionResult?, error: Error?, usedOnDevice: Bool) {
        if let result {
            receivedAnyResult = true
            if usedOnDevice { onDeviceEverSucceeded = true }
            finalText = result.bestTranscription.formattedString
            #if DEBUG
            micLog.info("recognition result final=\(result.isFinal) len=\(self.finalText.count) onDevice=\(usedOnDevice)")
            #endif
            callbacks?.onPartial(finalText)
            if result.isFinal {
                commit()
            }
        }
        if let error {
            micLog.error("recognition error onDevice=\(usedOnDevice) receivedAny=\(self.receivedAnyResult) everSucceeded=\(self.onDeviceEverSucceeded): \(error.localizedDescription)")
            // オンデバイス無効化の判定:
            //   条件1: result が1件も来ていない(発話なし or モデル未DL)
            //   条件2: このセッションで一度も成功していない
            //          (成功実績があればモデルは存在する → 今回は単なる誤起動無音と判断、無効化しない)
            //   条件3: エラーが「発話なし/一時的」ではない
            //          1110 = 発話未検出, 1101 = 一時エラー(騒音等)
            //          これらは誤起動の通常終了なのでオンデバイスを無効化しない。
            //          モデル自体が使えない場合は別のエラーコードになる。
            if usedOnDevice, !receivedAnyResult, !onDeviceEverSucceeded {
                let ns = error as NSError
                let isNoSpeechOrTransient = ns.domain == "kAFAssistantErrorDomain"
                    && (ns.code == 1110 || ns.code == 1101)
                if !isNoSpeechOrTransient {
                    micLog.error("on-device model unavailable (domain=\(ns.domain) code=\(ns.code)) — switching to server STT")
                    pipeline?.useOnDeviceRecognition.value = false
                    if !onDeviceFailureNotified {
                        onDeviceFailureNotified = true
                        callbacks?.onError(.transient, "音声認識をサーバー方式に切り替えたよ。もう一度話してみてね。")
                    }
                }
            }
            commit()
        }
    }

    private func commit() {
        let text = finalText.trimmingCharacters(in: .whitespacesAndNewlines)
        finalText = ""
        if text.count >= Self.minUtteranceLength {
            #if DEBUG
            micLog.info("commit → onUtterance len=\(text.count)")
            #endif
            callbacks?.onUtterance(text)
        } else {
            #if DEBUG
            micLog.info("commit skipped (len=\(text.count) < \(Self.minUtteranceLength))")
            #endif
        }
    }
}
