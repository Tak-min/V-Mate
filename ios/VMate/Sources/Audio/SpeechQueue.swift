import AVFoundation
import Combine

/// 音声合成キュー。Web版 frontend/src/features/voice/speech.ts と同じ役割:
/// バックエンド /api/tts (ElevenLabs) が返す MP3 を順番に再生し、音量レベルでアバターの口を動かす。
/// 合成が使えない場合(キー未設定=204 や失敗)は無音で続行する。
@MainActor
final class SpeechQueue: NSObject, ObservableObject {
    /// 現在の口の開き具合 (0..1)。AvatarView が毎フレーム参照する。
    @Published private(set) var mouthLevel: Double = 0
    /// 再生中(キューが空でない、または再生中)か。会話モードの聞き取り再開トリガに使う。
    @Published private(set) var isSpeaking = false

    private var queue: [(text: String, emotion: Emotion?)] = []
    private var playing = false
    private var enabled = true
    private var player: AVAudioPlayer?
    private var meterTimer: Timer?
    /// 再生完了待ちの継続。delegate通知 or タイムアウトのどちらかが先に解決する。
    private var playbackContinuation: CheckedContinuation<Void, Never>?

    func setEnabled(_ value: Bool) {
        enabled = value
        if !value { stop() }
    }

    func enqueue(_ text: String, emotion: Emotion?) {
        let clean = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty, enabled else { return }
        queue.append((clean, emotion))
        if !playing { Task { await processQueue() } }
    }

    func stop() {
        queue.removeAll()
        player?.stop()
        player = nil
        meterTimer?.invalidate()
        meterTimer = nil
        mouthLevel = 0
        resumePlaybackContinuationIfNeeded()
    }

    private func processQueue() async {
        playing = true
        isSpeaking = true
        while !queue.isEmpty, enabled {
            let item = queue.removeFirst()
            await playFromBackend(text: item.text, emotion: item.emotion)
        }
        playing = false
        isSpeaking = false
    }

    private func playFromBackend(text: String, emotion: Emotion?) async {
        // AVAudioSessionの構成はAudioSessionManagerに一元化した(録音とのカテゴリ衝突を防ぐため、
        // SpeechQueueからは直接.playbackを設定しない)。テキストのみ利用時はbootstrap時に
        // configureForPlaybackOnly()、音声会話モード中はconfigureForConversation()が
        // CompanionViewModel側で既に呼ばれている前提。
        guard let data = try? await APIClient.shared.fetchTTS(text: text, emotion: emotion) else {
            return
        }
        guard let newPlayer = try? AVAudioPlayer(data: data) else { return }
        newPlayer.isMeteringEnabled = true
        newPlayer.delegate = self
        player = newPlayer
        newPlayer.play()
        startMetering()
        // isPlayingのポーリングだけに頼ると、オーディオ割り込み(着信等)で isPlaying が
        // false に落ちないケースでここが永久に抜けず、キュー全体(以降の発話すべて)が
        // 止まってしまう。delegateの再生完了通知を主経路にしつつ、再生時間+余裕分の
        // タイムアウトを必ず仕掛けて、どちらか早い方で抜けるようにする。
        let timeoutSeconds = max(newPlayer.duration + 2.0, 1.0)
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            playbackContinuation = continuation
            Task { @MainActor [weak self] in
                try? await Task.sleep(nanoseconds: UInt64(timeoutSeconds * 1_000_000_000))
                self?.resumePlaybackContinuationIfNeeded()
            }
        }
        stopMetering()
        mouthLevel = 0
    }

    private func resumePlaybackContinuationIfNeeded() {
        playbackContinuation?.resume()
        playbackContinuation = nil
    }

    private func startMetering() {
        meterTimer?.invalidate()
        meterTimer = Timer.scheduledTimer(withTimeInterval: 1.0 / 30.0, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let self, let player = self.player else { return }
                player.updateMeters()
                let db = player.averagePower(forChannel: 0)
                // dBFS(-160..0)を 0..1 のレベルに正規化(Web版の周波数解析と近い見た目を狙った簡易マッピング)。
                let normalized = max(0, min(1, (db + 50) / 50))
                self.mouthLevel = Double(normalized)
            }
        }
    }

    private func stopMetering() {
        meterTimer?.invalidate()
        meterTimer = nil
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
