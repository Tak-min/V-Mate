import AVFoundation
import Speech
import os

/// マイク音声パイプラインの診断ログ。実機での切り分け用。
/// Console.app や `log` コマンドで subsystem=com.takmin.vmate category=mic を絞り込む。
/// レンダースレッドからの呼び出しはスロットル(handleTap内)してRT安全性を保つ。
///
/// H10: レンダースレッド周辺で高頻度に出す RMS/フレーム長等は Console.app や
/// sysdiagnose で他プロセスから読める privacy 側チャネルになる。release ビルドでは
/// 機密性の高い info/debug を一切出さないため、各 micLog.info/.debug 呼び出しを
/// `#if DEBUG` で個別 gate する。micLog.error は運用上必要(RMSを含まず)なので残す。
let micLog = Logger(subsystem: "com.takmin.vmate", category: "mic")

/// 発話確定前の直近バッファを保持するリングバッファ。VADのonset確認(onsetFrames連続)に
/// かかる間に届くバッファは「まだ発話と確定していない」ため認識リクエストへ送られないが、
/// 確定した瞬間にこのリングバッファの内容を先頭に流し込むことで、発話冒頭の取りこぼしを防ぐ。
/// AVAudioEngineのtapはコールバックごとに新しいAVAudioPCMBufferを渡すため(既存コードの
/// `request.append(buffer)` も同様にtapスコープ外で保持する前提)、ここでも参照をそのまま
/// 保持してよく、ディープコピーは不要。
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
/// このフラグ単体の同期だけが目的で、actorにすると同期APIを公開できずtapの同期スコープから
/// 呼べなくなるため、軽量な`OSAllocatedUnfairLock`を使う。
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

/// AVAudioEngineのtapコールバック(オーディオレンダースレッド)から呼ばれる音声キャプチャパイプライン。
/// VADで発話を検出したら `SFSpeechAudioBufferRecognitionRequest` + `recognitionTask` の生成を
/// `setupQueue`(非同期、`.userInitiated`)に委譲し、renderスレッドをObjC allocから解放する。
/// 生成完了までに届くバッファは `pendingCapture` に貯め、request publish後の次フレームで一括flush。
/// これにより旧実装(renderスレッド同期生成)の問題を解消しつつ、「後続バッファが捨てられるrace」も
/// 再発しない。
///
/// スレッド分担:
/// - renderスレッド: vad/preRoll/pendingCapture/awaitingRequest を単独所有。
/// - メインスレッド(DispatchQueue.main.async): req+task を生成し armedRequest/liveTask に publish するだけ。append はしない。
/// - MainActor: arm()/disarm() で LockedFlag に書き込む。
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
    /// (サーバー認識に固定すると往復遅延が常に発生する — 2026-06-27実機報告で確認)
    let useOnDeviceRecognition = LockedFlag(true)
    /// ターン単位の聞き取りON/OFF。MainActor(arm/disarm)が書き、tapスレッドが読む橋渡し。
    let enabled = LockedFlag(false)
    /// MainActorからの次ターン再開要求。tapスレッドが消費するタイミングで vad/preRoll をリセット。
    private let pendingArm = LockedFlag(false)
    /// 非同期生成されたrequest。メインスレッド(DispatchQueue.main.async)が書き、tapスレッドが読む橋渡し。
    private let armedRequest = OSAllocatedUnfairLock<SFSpeechAudioBufferRecognitionRequest?>(initialState: nil)
    /// 認識タスク。メインスレッドが生成し、endCapture/resetでcancelする。
    private let liveTask = OSAllocatedUnfairLock<SFSpeechRecognitionTask?>(initialState: nil)
    /// ターン番号。endCapture/resetで進め、メインスレッド上の遅延生成が古いターンへの適用を破棄できる。
    private let generation = OSAllocatedUnfairLock<Int>(initialState: 0)
    /// request生成完了前に届いたバッファ。renderスレッド単独で読み書き。
    private var pendingCapture: [AVAudioPCMBuffer] = []
    /// request非同期生成を待機中かどうか。renderスレッド単独。
    private var awaitingRequest = false
    /// 診断ログのスロットル用。renderスレッド単独。
    private var tapFrameCount = 0

    private var preRoll: PreRollBuffer

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

    /// tapスレッドのゲート判定を純関数として切り出したもの。AVAudioEngine/SFSpeechRecognizer
    /// に依存せずユニットテストできるようにするためのseam。
    static func gateDecision(enabled: Bool, pendingArm: Bool) -> (doReset: Bool, process: Bool) {
        (doReset: pendingArm, process: enabled)
    }

    func handleTap(buffer: AVAudioPCMBuffer) {
        let gate = Self.gateDecision(enabled: enabled.value, pendingArm: pendingArm.value)
        if gate.doReset {
            pendingArm.value = false
            vad.reset()
            _ = preRoll.drainAndClear()
            endCapture()
        }
        guard gate.process else { return }

        let rms = VoiceActivityDetector.rms(from: buffer)
        let nowMs = CACurrentMediaTime() * 1000
        let event = vad.process(rms: rms, nowMs: nowMs)

        // RMSは~16fps(64ms/buffer)で来るため、~0.5s毎(8バッファ毎)にスロットルしてログ。
        // 発話イベント(speechStarted等)は希少なので毎回ログする。
        tapFrameCount &+= 1
        if tapFrameCount % 8 == 0 {
            #if DEBUG
            micLog.debug("tap rms=\(rms, format: .fixed(precision: 5)) thr=\(self.vad.debugLastThreshold, format: .fixed(precision: 5)) floor=\(self.vad.noiseFloor, format: .fixed(precision: 5)) cap=\(self.vad.capturing) frames=\(buffer.frameLength)")
            #endif
        }

        switch event {
        case .speechStarted:
            #if DEBUG
            micLog.info("VAD speechStarted rms=\(rms, format: .fixed(precision: 5)) thr=\(self.vad.debugLastThreshold, format: .fixed(precision: 5))")
            #endif
            // preRollをpendingCaptureに引き継ぎ、非同期生成を開始。生成完了まで
            // このバッファ含め後続バッファはpendingCaptureに貯める(捨てない)。
            pendingCapture = preRoll.drainAndClear()
            beginCapture()
            feed(buffer)
        case .speechEnded, .maxDurationReached:
            #if DEBUG
            micLog.info("VAD \(String(describing: event)) — endCapture")
            #endif
            endCapture()
        case .silence:
            if vad.capturing {
                feed(buffer)
            } else {
                preRoll.push(buffer)
            }
        }
    }

    /// マイクを開く前(tapインストール前)に呼ぶ。tapと並行して呼ばないこと。
    func reset() {
        enabled.value = false
        pendingArm.value = false
        generation.withLock { $0 += 1 }
        awaitingRequest = false
        pendingCapture.removeAll()
        vad.reset()
        _ = preRoll.drainAndClear()
        // ロック外でcancel()/cancel対象の外部APIをロック保持中に呼わない)
        let oldTask = liveTask.withLock { t -> SFSpeechRecognitionTask? in defer { t = nil }; return t }
        oldTask?.cancel()
        armedRequest.withLock { $0 = nil }
    }

    /// renderスレッドから呼ぶ。ObjC allocをDispatchQueue.mainに退避してrenderスレッドを解放する。
    /// SFSpeechRecognizerはAppleドキュメント上メインスレッドでの使用が必要なため、
    /// DispatchQueue.main.asyncで生成する(.userInitiatedキューはドキュメント違反)。
    /// onSpeechOnset() は同期で即発火(バージインの応答性を維持)。
    private func beginCapture() {
        let gen = generation.withLock { $0 += 1; return $0 }
        awaitingRequest = true
        armedRequest.withLock { $0 = nil }
        callbacks.onSpeechOnset()

        let usedOnDevice = recognizer.supportsOnDeviceRecognition && useOnDeviceRecognition.value
        #if DEBUG
        micLog.info("beginCapture gen=\(gen) onDevice=\(usedOnDevice) (dispatching request creation to main)")
        #endif
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            let req = SFSpeechAudioBufferRecognitionRequest()
            req.shouldReportPartialResults = true
            req.requiresOnDeviceRecognition = usedOnDevice
            let task = self.recognizer.recognitionTask(with: req) { [weak self] result, error in
                self?.callbacks.onRecognitionEvent(result, error, usedOnDevice)
            }
            // endCapture/resetでgenが進んでいればこの発話ターンはもう終わっている
            guard self.generation.withLock({ $0 }) == gen else {
                #if DEBUG
                micLog.info("beginCapture gen=\(gen) stale (turn ended before publish) — task cancelled")
                #endif
                task.cancel()
                return
            }
            self.liveTask.withLock { $0 = task }
            self.armedRequest.withLock { $0 = req }   // requestをpublish(tapスレッドが読み始める)
            #if DEBUG
            micLog.info("beginCapture gen=\(gen) request PUBLISHED")
            #endif
        }
    }

    /// バッファをrequestに送る。request未生成ならpendingCaptureに貯め、
    /// 生成完了後の初回呼び出しで一括flush→以後直接append。renderスレッド単独で呼ぶ。
    private func feed(_ buffer: AVAudioPCMBuffer) {
        if let req = armedRequest.withLock({ $0 }) {
            if awaitingRequest {
                let flushed = pendingCapture.count
                for b in pendingCapture { req.append(b) }
                pendingCapture.removeAll()
                awaitingRequest = false
                #if DEBUG
                micLog.info("feed: request ready — flushed \(flushed) pending buffers, now appending live")
                #endif
            }
            req.append(buffer)
        } else {
            pendingCapture.append(buffer)
            // 滞留が異常に伸びたら(=publishが来ていない)警告。32バッファ≈2秒。
            if pendingCapture.count == 32 {
                micLog.error("feed: pendingCapture reached 32 buffers (~2s) without request publish — main queue stalled?")
            }
        }
    }

    private func endCapture() {
        generation.withLock { $0 += 1 }
        awaitingRequest = false
        pendingCapture.removeAll()
        // ロック外でendAudio()(ロック保持中に外部APIを呼ばない=os_unfair_lock再入禁止)
        let oldReq = armedRequest.withLock { req -> SFSpeechAudioBufferRecognitionRequest? in
            defer { req = nil }
            return req
        }
        oldReq?.endAudio()
        liveTask.withLock { $0 = nil }   // task は endAudio後に自然に完了させる(cancelしない)
    }
}

/// Web版 frontend/src/features/voice/recognition.ts の SpeechRecognizer クラスのSwift移植。
/// AVAudioEngine の入力タップで VoiceActivityDetector を回し、発話区間だけ
/// SFSpeechRecognizer に音声を渡す。沈黙時は認識を起動しない(マイクの監視だけ)。
/// 実際のタップ処理・リクエスト生成は`AudioCapturePipeline`(tapスレッド専有)に委譲し、
/// このクラスは公開API・コールバック保持・認識結果の解釈(finalText組み立て、
/// オンデバイスフォールバック判定)というMainActor上のロジックだけを担う薄いファサード。
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
    /// VADのonset確認に必要なフレーム数 + 余裕フレーム。確定までに届いた分に加え、
    /// 「しきい値直下でじわっと立ち上がる遠距離・小声の発話冒頭」も遡って認識へ送れるよう、
    /// pre-rollを厚めに確保する(2+6=8フレーム≒512ms@16kHz)。冒頭の語頭子音欠けを防ぐ。
    private static let preRollMargin = 6

    private let recognizer: SFSpeechRecognizer?
    private let audioEngine = AVAudioEngine()
    private let vadConfig = VADConfig()
    private var pipeline: AudioCapturePipeline?

    private var callbacks: Callbacks?
    private var running = false
    private var finalText = ""
    /// オンデバイス認識を試すかどうか。端末にその言語のオンデバイスモデルが
    /// 未ダウンロードだと requiresOnDeviceRecognition=true は1件も結果を返さず
    /// 即時失敗する(既知のSFSpeechRecognizerの挙動)。最初の発話で検出したら
    /// 以後はサーバー認識にフォールバックする。
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

    /// 会話モードに入る時に1回だけ呼ぶ。マイクとAVAudioEngineを開いたままにし、AECを
    /// 会話を通して収束させる(以前は発話ターンごとにエンジンを再起動しており、ターン
    /// ごとにAEC再収束が走ることで発話冒頭の1〜2秒が聞き取れない不具合の原因になっていた)。
    /// 実際の「聞き取り中/休止中」の切り替えは `resumeTurn()`/`pauseTurn()` で行う。
    func beginSession(callbacks: Callbacks) {
        guard !running else { return }
        guard let recognizer, recognizer.isAvailable else {
            callbacks.onError(.unsupported, "音声認識が使えない環境みたい。")
            return
        }
        self.callbacks = callbacks
        finalText = ""
        receivedAnyResult = false

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
        // prepare()後にグラフを変更(installTap)すると内部アサートでクラッシュする。
        // outputFormat は configureForConversation()でAVAudioSessionが設定済みのため、
        // prepare前でも .voiceChat の 16kHz フォーマットを正確に返す。
        let input = audioEngine.inputNode
        let format = input.outputFormat(forBus: 0)
        #if DEBUG
        micLog.info("beginSession tapFormat sr=\(format.sampleRate) ch=\(format.channelCount) common=\(format.commonFormat.rawValue) interleaved=\(format.isInterleaved) | onDeviceSupported=\(recognizer.supportsOnDeviceRecognition) available=\(recognizer.isAvailable)")
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
        // removeTapは同期的にtapコールバックの完了を保証するため、これ以降は
        // pipelineをMainActorから安全に触れる(tapスレッドとの並行アクセスが無くなる)。
        audioEngine.inputNode.removeTap(onBus: 0)
        if audioEngine.isRunning { audioEngine.stop() }
        pipeline?.reset()
        pipeline = nil
        finalText = ""
    }

    /// 1ターン分の聞き取りを再開する。エンジン/tapには触らず、`AudioCapturePipeline`の
    /// ゲートフラグを立てるだけ(実際のVAD/preRollリセットはtapスレッド側で行われる)。
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

    /// AudioCapturePipelineからのonSpeechOnset通知(MainActor上)。発話単位の状態をリセットしてからUIへ伝える。
    private func handleSpeechOnset() {
        finalText = ""
        receivedAnyResult = false
        callbacks?.onSpeechOnset()
    }

    private func handleRecognitionResult(result: SFSpeechRecognitionResult?, error: Error?, usedOnDevice: Bool) {
        if let result {
            receivedAnyResult = true
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
            micLog.error("recognition error onDevice=\(usedOnDevice) receivedAny=\(self.receivedAnyResult): \(error.localizedDescription)")
            // オンデバイスモデル未ダウンロード等で1件も結果が来ずに失敗した場合、
            // 以後はオンデバイスを諦めてサーバー認識に切り替える(無音のまま固まるのを防ぐ)。
            if usedOnDevice, !receivedAnyResult {
                pipeline?.useOnDeviceRecognition.value = false
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
