import AVFoundation
import Combine

/// 音声合成キュー。Web版 frontend/src/features/voice/speech.ts と同じ役割:
/// バックエンド /api/tts が返す MP3 を順番に再生し、音量レベルでアバターの口を動かす。
/// 合成が使えない場合(204 や失敗)は無音で続行する。
///
/// 音声会話モード: attachToEngine(_:) で VPIO AVAudioEngine に接続し、
///   TTS 再生を同じエンジン経由にすることで VPIO の AEC がエコー参照として機能する。
/// テキストモード: 接続なし、従来の AVAudioPlayer 経由で再生する。
@MainActor
final class SpeechQueue: NSObject, ObservableObject {
    /// 現在の口の開き具合 (0..1)。AvatarView が毎フレーム参照する。
    @Published private(set) var mouthLevel: Double = 0
    /// 再生中(キューが空でない、または再生中)か。会話モードの聞き取り再開トリガに使う。
    @Published private(set) var isSpeaking = false

    private var queue: [(text: String, emotion: Emotion?)] = []
    private var playing = false
    private var enabled = true

    // テキストモード(エンジン未接続)用
    private var player: AVAudioPlayer?
    private var meterTimer: Timer?

    // 音声会話モード用 — VPIO エンジンに接続し AEC のエコー参照に供給する
    private var playerNode: AVAudioPlayerNode?
    private var mixerForMetering: AVAudioMixerNode?
    private weak var attachedEngine: AVAudioEngine?

    private var playbackContinuation: CheckedContinuation<Void, Never>?
    // stop() から in-flight の TTS フェッチをキャンセルするために保持する。
    // processQueue() が await task.value 中に stop() が呼ばれると continuation はまだ nil
    // なので resumePlaybackContinuationIfNeeded() では止められない。タスクを直接キャンセル
    // することで fetchTTS が nil を返し、ループが空キューを検知して終了する。
    private var activeFetchTask: Task<Data?, Never>?
    private var pendingFetchTask: Task<Data?, Never>?

    func setEnabled(_ value: Bool) {
        enabled = value
        if !value { stop() }
    }

    func enqueue(_ text: String, emotion: Emotion?) {
        let clean = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty, enabled else { return }
        queue.append((clean, emotion))
        if !playing {
            // playing を同期的にセットしてからタスクを起動する。
            // タスク内で初めてセットすると、複数の enqueue() が連続して呼ばれた場合に
            // 2つ目以降も playing=false を見てしまい processQueue() が二重起動する。
            playing = true
            Task { await processQueue() }
        }
    }

    func stop() {
        queue.removeAll()
        activeFetchTask?.cancel()
        activeFetchTask = nil
        pendingFetchTask?.cancel()
        pendingFetchTask = nil
        playerNode?.stop()
        player?.stop()
        player = nil
        meterTimer?.invalidate()
        meterTimer = nil
        mouthLevel = 0
        resumePlaybackContinuationIfNeeded()
    }

    // MARK: - エンジン接続 (AEC 対応)

    /// 音声会話モード開始時に呼ぶ。SpeechRecognizer.beginSession() より前に呼ぶこと。
    /// AVAudioEngine のグラフにノードを追加してから prepare/start する必要があるため。
    func attachToEngine(_ engine: AVAudioEngine) {
        guard attachedEngine == nil else { return }
        let node = AVAudioPlayerNode()
        let mixer = AVAudioMixerNode()
        engine.attach(node)
        engine.attach(mixer)
        engine.connect(node, to: mixer, format: nil)
        engine.connect(mixer, to: engine.mainMixerNode, format: nil)
        // レンダースレッドから呼ばれる tap でRMSを計測し、@MainActor 側で mouthLevel を更新する。
        // 無音時は buffer の値が ~0 になるため、追加のガード処理は不要。
        mixer.installTap(onBus: 0, bufferSize: 1024, format: nil) { [weak self] buffer, _ in
            let level = SpeechQueue.rmsLevel(from: buffer)
            Task { @MainActor [weak self] in self?.mouthLevel = level }
        }
        playerNode = node
        mixerForMetering = mixer
        attachedEngine = engine
    }

    /// 音声会話モード終了時に呼ぶ。SpeechRecognizer.endSession() の後に呼ぶこと。
    func detachFromEngine() {
        guard let engine = attachedEngine else { return }
        playerNode?.stop()
        mixerForMetering?.removeTap(onBus: 0)
        if let node = playerNode { engine.detach(node) }
        if let mixer = mixerForMetering { engine.detach(mixer) }
        playerNode = nil
        mixerForMetering = nil
        attachedEngine = nil
        mouthLevel = 0
    }

    // MARK: - キュー処理

    /// 文と文の間でTTS取得(ネットワーク往復)を逐次awaitすると、往復の間だけ無音区間ができる
    /// (「音声がたまに途切れる」の正体)。次に再生する文のTTSを、今の文の再生中に先読み
    /// (prefetch)しておくことで、再生がギャップ無く連続するようにする。
    private func processQueue() async {
        isSpeaking = true
        var prefetch: Task<Data?, Never>? = queue.first.map(makeFetchTask)
        pendingFetchTask = prefetch
        while !queue.isEmpty, enabled {
            let item = queue.removeFirst()
            let task = prefetch ?? makeFetchTask(item)
            activeFetchTask = task
            prefetch = queue.first.map(makeFetchTask)
            pendingFetchTask = prefetch
            if let data = await task.value {
                activeFetchTask = nil
                await play(data: data)
            }
        }
        activeFetchTask = nil
        pendingFetchTask = nil
        playing = false
        isSpeaking = false
    }

    private func makeFetchTask(_ item: (text: String, emotion: Emotion?)) -> Task<Data?, Never> {
        Task { try? await APIClient.shared.fetchTTS(text: item.text, emotion: item.emotion) }
    }

    private func play(data: Data) async {
        if let node = playerNode {
            await playViaPlayerNode(data: data, node: node)
        } else {
            await playViaAVAudioPlayer(data: data)
        }
    }

    // MARK: - 再生 (音声会話モード — VPIO エンジン経由)

    private func playViaPlayerNode(data: Data, node: AVAudioPlayerNode) async {
        // MP3 をテンポラリファイルに書き出してから AVAudioFile として読み込む。
        // AVAudioPlayerNode は AVAudioFile / AVAudioPCMBuffer をスケジュールする API のみ
        // 提供していて、Data を直接渡す API がないため。
        let tmpURL = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString + ".mp3")
        // defer を do-catch より前に宣言し、書き込み失敗で return した場合も
        // テンポラリファイルが確実に削除されるようにする。
        defer { try? FileManager.default.removeItem(at: tmpURL) }
        do {
            try data.write(to: tmpURL)
        } catch {
            return
        }
        guard let audioFile = try? AVAudioFile(forReading: tmpURL) else { return }
        let duration = Double(audioFile.length) / audioFile.processingFormat.sampleRate

        node.scheduleFile(audioFile, at: nil, completionCallbackType: .dataPlayedBack) { [weak self] _ in
            Task { @MainActor [weak self] in self?.resumePlaybackContinuationIfNeeded() }
        }
        // ノードが停止状態(stop()呼び出し後など)の場合に再開する。
        // すでに再生中の場合はスケジュールされたファイルが順番に再生される。
        if !node.isPlaying { node.play() }

        let timeoutSeconds = max(duration + 2.0, 1.0)
        var timeoutTask: Task<Void, Never>?
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            playbackContinuation = continuation
            timeoutTask = Task { @MainActor [weak self] in
                try? await Task.sleep(nanoseconds: UInt64(timeoutSeconds * 1_000_000_000))
                self?.resumePlaybackContinuationIfNeeded()
            }
        }
        // 正常完了・stop()のどちらでcontinuationが解決されても、タイムアウトTaskをキャンセルして
        // 解放する。キャンセル済みの場合はno-op。
        timeoutTask?.cancel()
    }

    // MARK: - 再生 (テキストモード — AVAudioPlayer fallback)

    private func playViaAVAudioPlayer(data: Data) async {
        // AVAudioSessionの構成はAudioSessionManagerに一元化した(録音とのカテゴリ衝突を防ぐため、
        // SpeechQueueからは直接.playbackを設定しない)。
        guard let newPlayer = try? AVAudioPlayer(data: data) else { return }
        newPlayer.isMeteringEnabled = true
        newPlayer.delegate = self
        player = newPlayer
        newPlayer.play()
        startMetering()
        // isPlayingのポーリングだけに頼ると、オーディオ割り込みでキュー全体が止まってしまう。
        // delegateの再生完了通知を主経路にしつつ、タイムアウトを必ず仕掛ける。
        let timeoutSeconds = max(newPlayer.duration + 2.0, 1.0)
        var timeoutTask: Task<Void, Never>?
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            playbackContinuation = continuation
            timeoutTask = Task { @MainActor [weak self] in
                try? await Task.sleep(nanoseconds: UInt64(timeoutSeconds * 1_000_000_000))
                self?.resumePlaybackContinuationIfNeeded()
            }
        }
        timeoutTask?.cancel()
        stopMetering()
        mouthLevel = 0
    }

    private func resumePlaybackContinuationIfNeeded() {
        playbackContinuation?.resume()
        playbackContinuation = nil
    }

    // MARK: - メータリング (テキストモード用タイマー)

    private func startMetering() {
        meterTimer?.invalidate()
        meterTimer = Timer.scheduledTimer(withTimeInterval: 1.0 / 30.0, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let self, let player = self.player else { return }
                player.updateMeters()
                let db = player.averagePower(forChannel: 0)
                let normalized = max(0, min(1, (db + 50) / 50))
                self.mouthLevel = Double(normalized)
            }
        }
    }

    private func stopMetering() {
        meterTimer?.invalidate()
        meterTimer = nil
    }

    // MARK: - メータリング (音声会話モード用 — tap コールバックから呼ばれる)

    private static func rmsLevel(from buffer: AVAudioPCMBuffer) -> Double {
        guard let data = buffer.floatChannelData?.pointee, buffer.frameLength > 0 else { return 0 }
        let count = Int(buffer.frameLength)
        var sum: Float = 0
        for i in 0..<count { sum += data[i] * data[i] }
        let rms = sqrt(sum / Float(count))
        let db = 20 * log10(max(rms, 1e-7))
        return Double(max(0, min(1, (db + 50) / 50)))
    }
}

extension SpeechQueue: AVAudioPlayerDelegate {
    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        Task { @MainActor [weak self] in
            self?.resumePlaybackContinuationIfNeeded()
        }
    }

    nonisolated func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) {
        Task { @MainActor [weak self] in
            self?.resumePlaybackContinuationIfNeeded()
        }
    }
}
