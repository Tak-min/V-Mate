import AVFoundation
import Combine

/// 音声合成キュー。Web版 frontend/src/features/voice/speech.ts と同じ役割:
/// バックエンド /api/tts (ElevenLabs) が返す MP3 を順番に再生し、音量レベルでアバターの口を動かす。
/// 合成が使えない場合(キー未設定=204 や失敗)は無音で続行する。
@MainActor
final class SpeechQueue: ObservableObject {
    /// 現在の口の開き具合 (0..1)。AvatarView が毎フレーム参照する。
    @Published private(set) var mouthLevel: Double = 0

    private var queue: [(text: String, emotion: Emotion?)] = []
    private var playing = false
    private var enabled = true
    private var player: AVAudioPlayer?
    private var meterTimer: Timer?

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
    }

    private func processQueue() async {
        playing = true
        while !queue.isEmpty, enabled {
            let item = queue.removeFirst()
            await playFromBackend(text: item.text, emotion: item.emotion)
        }
        playing = false
    }

    private func playFromBackend(text: String, emotion: Emotion?) async {
        do {
            try AVAudioSession.sharedInstance().setCategory(.playback, mode: .default)
            try AVAudioSession.sharedInstance().setActive(true)
        } catch {
            // セッション設定失敗時も無音で続行(Web版のフォールバック方針に合わせる)
        }
        guard let data = try? await APIClient.shared.fetchTTS(text: text, emotion: emotion) else {
            return
        }
        guard let newPlayer = try? AVAudioPlayer(data: data) else { return }
        newPlayer.isMeteringEnabled = true
        player = newPlayer
        newPlayer.play()
        startMetering()
        while newPlayer.isPlaying {
            try? await Task.sleep(nanoseconds: 60_000_000)
        }
        stopMetering()
        mouthLevel = 0
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
