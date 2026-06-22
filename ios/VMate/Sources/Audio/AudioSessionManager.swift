import AVFoundation

/// アプリ全体で唯一 AVAudioSession を構成する場所。
/// 録音(STT)とTTS再生(SpeechQueue)が同一セッション上で衝突しないようにする。
/// .playback と .playAndRecord を別々に setActive すると、片方が相手のオーディオを
/// 切ってしまうため、会話モード中は常に .playAndRecord(.voiceChat) に統一する。
@MainActor
final class AudioSessionManager {
    static let shared = AudioSessionManager()

    private init() {}

    /// 会話モード用: 録音と再生を同時に許可。.voiceChat はエコーキャンセル(AEC)を有効にし、
    /// スピーカーから出るシロの声をマイクが拾って自己ループするのを抑える。
    func configureForConversation() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: .voiceChat, options: [.defaultToSpeaker, .allowBluetoothHFP])
        try session.setActive(true)
    }

    /// 音声会話モードを使わない場合の再生専用構成(テキストのみ会話時のTTS再生)。
    func configureForPlaybackOnly() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playback, mode: .default)
        try session.setActive(true)
    }

    func deactivate() {
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
}
