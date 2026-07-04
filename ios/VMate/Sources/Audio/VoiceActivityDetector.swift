import AVFoundation
import Accelerate

/// Web版 frontend/src/features/voice/recognition.ts の monitor() ロジックの移植。
/// I/O非依存の純ロジック(RMSと現在時刻を渡すだけ)にして、AVAudioEngine無しで
/// ユニットテストできるようにしている。
struct VADConfig {
    var onsetFrames = 2
    /// 発話途中の小休止(息継ぎ・言い淀み)で発話が分断されないよう長めに取る。
    /// 1.1s では「えーと」等の間で speechEnded が早発し、文の後半が別発話に分かれて
    /// 取りこぼれることがあったため 1.4s に延長(2026-06-26 ユーザー報告ベース)。
    var hangoverMs: Double = 1400
    /// 短縮ハングオーバー: capturing中のピークRMSに対してこの比率以下の無音が続いた場合に
    /// hangoverMs ではなく shortHangoverMs を使う。エネルギーが明確に落ちた = 発話終了と
    /// みなせるため、不必要な1.4s待ちを700msに短縮してレスポンスを改善する。
    /// shortHangoverMs >= hangoverMs の場合は無効(既定の hangoverMs が使われる)。
    var shortHangoverMs: Double = 700
    /// peakCaptureRms に対する比率しきい値。この値以下なら短縮ハングオーバーを使う。
    /// 0.18(18%)は通常会話のピーク(0.004〜0.008)に対し真の無音(0.0001〜0.0003)が
    /// 概ね 5〜8% なので余裕を持った値。背景ノイズが多い環境ではRMSがピークの
    /// 25%前後を維持するため自然に長ハングオーバー側にフォールバックする。
    var shortHangoverRatio: Float = 0.18
    /// 発話とみなす最小RMS。iOSの AVAudioEngine(.voiceChatの音声処理後)では実機の
    /// 生RMSが「無音 ~0.0003 / 通常発話 ~0.004 / 小声・遠距離 ~0.001-0.0015」という
    /// 非常に小さいスケールになる(実機ログで計測)。マイクから離れた発話を取りこぼさない
    /// よう絶対下限を 0.0006→0.0004 に引き下げ(近距離は拾えるが遠距離で失敗する報告ベース)。
    /// 検出は主にノイズフロア相対(noiseMargin)で行う。
    var minThreshold: Float = 0.0004
    /// ノイズフロアに対する倍率。これを下げるほど感度が上がる(小さなSNRの発話も拾う)。
    /// 遠距離・小声(SNR ~1.5倍程度)でも拾えるよう 1.8→1.4 に低減。誤検出(雑音での誤起動)は
    /// onsetFrames(2連続=128ms持続要求)で抑え、万一起動してもサーバー認識が無音を文字化せず、
    /// hangover後に speechEnded で自然終了するため実害が小さい(自己補正)。
    var noiseMargin: Float = 1.4
    /// しきい値の加算オフセット。ノイズフロアが極小のときに最低限の余裕を持たせる。
    /// 旧実装ではここが 0.01 固定(Webスケール)で発話ピークを上回り検出不能だった。
    /// 遠距離感度向上のため 0.0003→0.0002。
    var thresholdOffset: Float = 0.0002
    var maxCaptureMs: Double = 15_000
    /// ノイズフロアの初期値。iOSの実測無音レベル(~0.0003)に合わせる。
    var initialNoiseFloor: Float = 0.0003
    /// ノイズフロアの最小値(初期値の50%)。極静寂な環境でフロアがゼロに収束するのを防ぎ、
    /// 適応型しきい値が常にフロア相対で機能するよう保証する。
    var noiseFloorMinimum: Float = 0.00015
    /// ノイズフロアが上昇する方向(環境ノイズが増えた)のEMA係数。突発音1フレームで
    /// しきい値が跳ね上がらないよう遅め(WebRTC等のVADが採用する非対称追従と同じ考え方)。
    var floorAttack: Float = 0.05
    /// ノイズフロアが下降する方向(環境が静かになった)のEMA係数。attackより速くすることで、
    /// 騒音が収まった直後にしきい値が高止まりせず、小声をより早く拾えるようにする。
    var floorDecay: Float = 0.2
    /// 聞き取り再開直後のウォームアップ期間(ms)。この間は発話開始を起こさない。
    /// resumeListeningDelay(0.8s)の後にさらにこの期間を設けることで、室内残響の
    /// 减衰しきれなかった成分をノイズフロアとして学習し誤検出を抑制する。
    /// 100ms → 400ms に延長(シロのキャラクターボイスがユーザー発話として認識される問題対策)。
    var warmupMs: Double = 400
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
    /// 現在のノイズフロア。診断ログ用に読み取り可能(書き込みは内部のみ)。
    private(set) var noiseFloor: Float
    /// 直近 process() で算出した実効しきい値。診断ログ用。
    private(set) var debugLastThreshold: Float = 0
    /// reset後の最初の process() フレームの時刻。ウォームアップ判定の基準。
    private var startedMs: Double?
    /// capturing 中の最大 RMS。shortHangover 判定の基準値として使う。
    /// speechEnded/maxDurationReached/reset で 0 にリセットされる。
    private(set) var peakCaptureRms: Float = 0

    init(config: VADConfig = .init()) {
        self.config = config
        self.noiseFloor = config.initialNoiseFloor
    }

    /// 1フレーム分のRMSと現在時刻(ms)を渡すと、発話開始/終了/上限到達のイベントを返す。
    /// しきい値は noiseFloor 追従 + 下限、ノイズフロアの追従は non-capturing 時のみ行う。
    func process(rms: Float, nowMs: Double) -> VADEvent {
        if startedMs == nil { startedMs = nowMs }
        let threshold = max(config.minThreshold, noiseFloor * config.noiseMargin + config.thresholdOffset)
        debugLastThreshold = threshold

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

        // capturing 中のピーク RMS を記録(shortHangover 判定用)。
        if capturing {
            peakCaptureRms = max(peakCaptureRms, rms)
        }

        if rms > threshold {
            aboveFrames += 1
            lastVoiceMs = nowMs
            if !capturing && aboveFrames >= config.onsetFrames {
                capturing = true
                captureStartMs = nowMs
                peakCaptureRms = rms
                return .speechStarted
            }
        } else {
            aboveFrames = 0
            if !capturing {
                adaptNoiseFloor(toward: rms)
            }
            if capturing && nowMs - lastVoiceMs > effectiveHangoverMs(currentRms: rms) {
                capturing = false
                peakCaptureRms = 0
                return .speechEnded
            }
        }

        if capturing && nowMs - captureStartMs > config.maxCaptureMs {
            capturing = false
            peakCaptureRms = 0
            return .maxDurationReached
        }

        return .silence
    }

    /// rmsが現在のノイズフロアより高ければattack(遅め)、低ければdecay(速め)で追従する。
    /// 下限クランプにより、静寂な環境でフロアがゼロに収束して適応機能が失われるのを防ぐ。
    private func adaptNoiseFloor(toward rms: Float) {
        let alpha = rms < noiseFloor ? config.floorDecay : config.floorAttack
        let updated = noiseFloor * (1 - alpha) + rms * alpha
        noiseFloor = max(config.noiseFloorMinimum, updated)
    }

    /// 現在の RMS とピーク RMS の比率に基づき、適切なハングオーバー時間を返す。
    /// エネルギーが明確に落ちている(=真の無音)場合は shortHangoverMs で早期確定する。
    /// shortHangoverMs >= hangoverMs の場合は常に hangoverMs を使う(無効化パス)。
    private func effectiveHangoverMs(currentRms: Float) -> Double {
        guard config.shortHangoverMs < config.hangoverMs,
              config.shortHangoverRatio > 0,
              peakCaptureRms > 0,
              currentRms < config.shortHangoverRatio * peakCaptureRms
        else { return config.hangoverMs }
        return config.shortHangoverMs
    }

    func reset() {
        capturing = false
        aboveFrames = 0
        lastVoiceMs = 0
        captureStartMs = 0
        noiseFloor = config.initialNoiseFloor
        startedMs = nil
        peakCaptureRms = 0
    }

    /// AVAudioPCMBuffer 1個分の RMS を vDSP_rmsqv で計算する。
    /// 旧実装のスカラーループをAMD/ARM SIMD命令にオフロードし、
    /// オーディオレンダースレッドの CPU 使用を削減する。
    static func rms(from buffer: AVAudioPCMBuffer) -> Float {
        guard let data = buffer.floatChannelData else { return 0 }
        let frameLength = vDSP_Length(buffer.frameLength)
        guard frameLength > 0 else { return 0 }
        var result: Float = 0
        vDSP_rmsqv(data[0], 1, &result, frameLength)
        return result
    }
}
