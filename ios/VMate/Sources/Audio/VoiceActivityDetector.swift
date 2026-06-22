import AVFoundation

/// Web版 frontend/src/features/voice/recognition.ts の monitor() ロジックの移植。
/// I/O非依存の純ロジック(RMSと現在時刻を渡すだけ)にして、AVAudioEngine無しで
/// ユニットテストできるようにしている。
struct VADConfig {
    var onsetFrames = 2
    var hangoverMs: Double = 1100
    var minThreshold: Float = 0.025
    var noiseMargin: Float = 1.8
    var maxCaptureMs: Double = 15_000
}

enum VADEvent: Equatable {
    case silence
    case speechStarted
    case speechEnded
    case maxDurationReached
}

final class VoiceActivityDetector {
    private let config: VADConfig
    private(set) var capturing = false

    private var aboveFrames = 0
    private var lastVoiceMs: Double = 0
    private var captureStartMs: Double = 0
    private var noiseFloor: Float = 0.01

    init(config: VADConfig = .init()) {
        self.config = config
    }

    /// 1フレーム分のRMSと現在時刻(ms)を渡すと、発話開始/終了/上限到達のイベントを返す。
    /// Web版 monitor() と同一の判定: しきい値は noiseFloor 追従 + 下限、ノイズフロアの
    /// 追従は非capturing時のみ行う。
    func process(rms: Float, nowMs: Double) -> VADEvent {
        let threshold = max(config.minThreshold, noiseFloor * config.noiseMargin + 0.01)

        if rms > threshold {
            aboveFrames += 1
            lastVoiceMs = nowMs
            if !capturing && aboveFrames >= config.onsetFrames {
                capturing = true
                captureStartMs = nowMs
                return .speechStarted
            }
        } else {
            aboveFrames = 0
            if !capturing {
                noiseFloor = noiseFloor * 0.95 + rms * 0.05
            }
            if capturing && nowMs - lastVoiceMs > config.hangoverMs {
                capturing = false
                return .speechEnded
            }
        }

        if capturing && nowMs - captureStartMs > config.maxCaptureMs {
            capturing = false
            return .maxDurationReached
        }

        return .silence
    }

    func reset() {
        capturing = false
        aboveFrames = 0
        lastVoiceMs = 0
        captureStartMs = 0
        noiseFloor = 0.01
    }

    /// AVAudioPCMBuffer 1個分のRMS(正規化、-1..1のfloatサンプル前提)を計算する。
    static func rms(from buffer: AVAudioPCMBuffer) -> Float {
        guard let data = buffer.floatChannelData else { return 0 }
        let frameLength = Int(buffer.frameLength)
        guard frameLength > 0 else { return 0 }
        let channel = data[0]
        var sumSq: Float = 0
        for i in 0..<frameLength {
            let sample = channel[i]
            sumSq += sample * sample
        }
        return (sumSq / Float(frameLength)).squareRoot()
    }
}
