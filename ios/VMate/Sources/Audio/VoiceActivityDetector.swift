import AVFoundation

/// Web版 frontend/src/features/voice/recognition.ts の monitor() ロジックの移植。
/// I/O非依存の純ロジック(RMSと現在時刻を渡すだけ)にして、AVAudioEngine無しで
/// ユニットテストできるようにしている。
struct VADConfig {
    var onsetFrames = 2
    var hangoverMs: Double = 1100
    /// 発話とみなす最小RMS。iOSの AVAudioEngine(.voiceChatの音声処理後)では実機の
    /// 生RMSが「無音 ~0.0003 / 通常発話 ~0.004 / 小声・遠距離 ~0.001-0.0015」という
    /// 非常に小さいスケールになる(実機ログで計測)。小声やマイクから遠い発話を取りこぼさない
    /// よう、絶対下限は低めにし、検出は主にノイズフロア相対(noiseMargin)で行う。
    var minThreshold: Float = 0.0006
    /// ノイズフロアに対する倍率。これを下げるほど感度が上がる(小さなSNRの発話も拾う)。
    /// 遠距離小声(SNR ~2-3倍)でも拾えるよう 1.8。誤検出は onsetFrames(2連続=200ms持続要求)、
    /// resume遅延、ウォームアップで抑える。
    var noiseMargin: Float = 1.8
    /// しきい値の加算オフセット。ノイズフロアが極小のときに最低限の余裕を持たせる。
    /// 旧実装ではここが 0.01 固定(Webスケール)で発話ピークを上回り検出不能だった。
    var thresholdOffset: Float = 0.0003
    var maxCaptureMs: Double = 15_000
    /// ノイズフロアの初期値。iOSの実測無音レベル(~0.0003)に合わせる。
    var initialNoiseFloor: Float = 0.0003
    /// ノイズフロアが上昇する方向(環境ノイズが増えた)のEMA係数。突発音1フレームで
    /// しきい値が跳ね上がらないよう遅め(WebRTC等のVADが採用する非対称追従と同じ考え方)。
    var floorAttack: Float = 0.05
    /// ノイズフロアが下降する方向(環境が静かになった)のEMA係数。attackより速くすることで、
    /// 騒音が収まった直後にしきい値が高止まりせず、小声をより早く拾えるようにする。
    var floorDecay: Float = 0.2
    /// マイクを開いた直後のウォームアップ期間(ms)。この間は発話開始を起こさない。
    /// 直前のTTS(MP3)末尾やスピーカー残響がマイクに回り込んでも誤検出しないための保険。
    /// 主対策は CompanionViewModel 側の resume遅延(残響の物理減衰待ち)で、これはその二段目。
    var warmupMs: Double = 200
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
    private var noiseFloor: Float
    /// reset後の最初の process() フレームの時刻。ウォームアップ判定の基準。
    private var startedMs: Double?

    init(config: VADConfig = .init()) {
        self.config = config
        self.noiseFloor = config.initialNoiseFloor
    }

    /// 1フレーム分のRMSと現在時刻(ms)を渡すと、発話開始/終了/上限到達のイベントを返す。
    /// しきい値は noiseFloor 追従 + 下限、ノイズフロアの追従は非capturing時のみ行う。
    func process(rms: Float, nowMs: Double) -> VADEvent {
        if startedMs == nil { startedMs = nowMs }
        let threshold = max(config.minThreshold, noiseFloor * config.noiseMargin + config.thresholdOffset)

        // ウォームアップ期間: マイクを開いた直後はTTS末尾/残響の回り込みやエンジンの不安定
        // フレームがあり得るため発話開始を抑制する。大きな音でノイズフロアを汚さないよう、
        // floor追従はしきい値以下のとき(=環境音とみなせるとき)だけ行う。
        if let started = startedMs, nowMs - started < config.warmupMs {
            aboveFrames = 0
            if rms <= threshold {
                adaptNoiseFloor(toward: rms)
            }
            return .silence
        }

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
                adaptNoiseFloor(toward: rms)
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

    /// rmsが現在のノイズフロアより高ければattack(遅め)、低ければdecay(速め)で追従する。
    private func adaptNoiseFloor(toward rms: Float) {
        let alpha = rms < noiseFloor ? config.floorDecay : config.floorAttack
        noiseFloor = noiseFloor * (1 - alpha) + rms * alpha
    }

    func reset() {
        capturing = false
        aboveFrames = 0
        lastVoiceMs = 0
        captureStartMs = 0
        noiseFloor = config.initialNoiseFloor
        startedMs = nil
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
