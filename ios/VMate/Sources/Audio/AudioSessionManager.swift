import AVFoundation

/// アプリ全体で唯一 AVAudioSession を構成する場所。
/// 録音(STT)とTTS再生(SpeechQueue)が同一セッション上で衝突しないようにする。
/// .playback と .playAndRecord を別々に setActive すると、片方が相手のオーディオを
/// 切ってしまうため、会話モード中は常に .playAndRecord(.voiceChat) に統一する。
@MainActor
final class AudioSessionManager {
    private enum Configuration: Equatable {
        case conversation
        case playbackOnly
    }

    static let shared = AudioSessionManager()

    /// 直前に適用した構成。同じ構成への再設定はAVAudioSessionの再カテゴリ化/再activateを
    /// 不要に発生させてしまう(会話エンジンを会話を通して起動したままにする設計に変えた
    /// ため、誤って毎ターン呼んでしまった場合のリグレッション防止の保険)。
    private var current: Configuration?

    private init() {}

    /// 会話モード用: 録音と再生を同時に許可。.voiceChat はエコーキャンセル(AEC)を有効にし、
    /// スピーカーから出るシロの声をマイクが拾って自己ループするのを抑える。
    func configureForConversation() throws {
        guard current != .conversation else { return }
        let session = AVAudioSession.sharedInstance()
        // .allowBluetoothHFPを除外: HFP(SCO)接続時にサンプルレートが8kHzに制限され
        // STT精度が大幅低下するため。AirPodsなどA2DP対応デバイスは影響なし。
        try session.setCategory(.playAndRecord, mode: .voiceChat, options: [.defaultToSpeaker, .allowBluetoothA2DP])
        try session.setActive(true)
        current = .conversation
    }

    /// 音声会話モードを使わない場合の再生専用構成(テキストのみ会話時のTTS再生)。
    func configureForPlaybackOnly() throws {
        guard current != .playbackOnly else { return }
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playback, mode: .default)
        try session.setActive(true)
        current = .playbackOnly
    }

    func deactivate() {
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        current = nil
    }
}
