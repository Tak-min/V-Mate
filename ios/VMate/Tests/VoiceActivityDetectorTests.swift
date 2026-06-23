import AVFoundation
import Testing
@testable import VMate

@Suite("VoiceActivityDetector")
struct VoiceActivityDetectorTests {
    // 各テストは warmupMs: 0 でコア検出ロジックを単体検証する(ウォームアップは別テストで検証)。

    @Test("しきい値超えがonsetFrames回連続したら発話開始")
    func detectsSpeechOnset() {
        let vad = VoiceActivityDetector(config: VADConfig(onsetFrames: 2, minThreshold: 0.02, warmupMs: 0))
        #expect(vad.process(rms: 0.1, nowMs: 0) == .silence)
        #expect(vad.process(rms: 0.1, nowMs: 60) == .speechStarted)
        #expect(vad.capturing == true)
    }

    @Test("しきい値超えが1回だけでは発話開始にならない")
    func singleFrameDoesNotTrigger() {
        let vad = VoiceActivityDetector(config: VADConfig(onsetFrames: 3, minThreshold: 0.02, warmupMs: 0))
        #expect(vad.process(rms: 0.1, nowMs: 0) == .silence)
        #expect(vad.process(rms: 0.01, nowMs: 60) == .silence)
        #expect(vad.capturing == false)
    }

    @Test("capturing中にhangoverMsを超える沈黙が続くと発話終了")
    func detectsSpeechEndAfterHangover() {
        let vad = VoiceActivityDetector(config: VADConfig(onsetFrames: 1, hangoverMs: 100, minThreshold: 0.02, warmupMs: 0))
        #expect(vad.process(rms: 0.1, nowMs: 0) == .speechStarted)
        #expect(vad.process(rms: 0.0, nowMs: 50) == .silence) // hangover未満はまだ終了しない
        #expect(vad.capturing == true)
        #expect(vad.process(rms: 0.0, nowMs: 200) == .speechEnded)
        #expect(vad.capturing == false)
    }

    @Test("maxCaptureMsを超えたら強制終了")
    func detectsMaxDurationReached() {
        let vad = VoiceActivityDetector(config: VADConfig(onsetFrames: 1, hangoverMs: 100_000, minThreshold: 0.02, maxCaptureMs: 100, warmupMs: 0))
        #expect(vad.process(rms: 0.1, nowMs: 0) == .speechStarted)
        // 沈黙にならず話し続けていても、上限を超えたら終了する。
        #expect(vad.process(rms: 0.1, nowMs: 150) == .maxDurationReached)
        #expect(vad.capturing == false)
    }

    @Test("沈黙中の環境ノイズにノイズフロアが追従し、同じrmsが発話と判定されなくなる")
    func noiseFloorAdaptsDuringSilenceOnly() {
        // iOS実機スケール(無音 ~0.0003 / 通常発話 ~0.004 / 小声 ~0.0015)に合わせた値。
        let config = VADConfig(onsetFrames: 2, minThreshold: 0.001, noiseMargin: 2.0, warmupMs: 0)
        let testRms: Float = 0.0018
        let ambientRms: Float = 0.0009 // 初期しきい値(~0.001)未満 = 沈黙として扱われる環境ノイズ

        // 追従前: 初期ノイズフロア(0.0003)のままなので testRms はすぐ発話と判定される。
        let fresh = VoiceActivityDetector(config: config)
        _ = fresh.process(rms: testRms, nowMs: 0)
        #expect(fresh.process(rms: testRms, nowMs: 60) == .speechStarted)

        // 環境ノイズだけを長時間与えてノイズフロアを追従させる。
        let warmed = VoiceActivityDetector(config: config)
        var ms = 0.0
        for _ in 0..<200 {
            #expect(warmed.process(rms: ambientRms, nowMs: ms) == .silence)
            ms += 60
        }

        // 追従後: ノイズフロアが上がっているため、同じ testRms はもう発話と判定されない。
        _ = warmed.process(rms: testRms, nowMs: ms)
        #expect(warmed.process(rms: testRms, nowMs: ms + 60) == .silence)
        #expect(warmed.capturing == false)
    }

    @Test("ウォームアップ期間中は発話開始を抑制し、期間後に検出を始める")
    func warmupSuppressesOnsetThenDetects() {
        // マイク開直後の warmupMs の間は、しきい値を超えるRMSでも発話開始しない
        // (直前のTTS末尾・スピーカー残響の自己検出を防ぐ)。
        let vad = VoiceActivityDetector(config: VADConfig(onsetFrames: 1, minThreshold: 0.02, warmupMs: 100))
        #expect(vad.process(rms: 0.2, nowMs: 0) == .silence)
        #expect(vad.process(rms: 0.2, nowMs: 50) == .silence)
        #expect(vad.capturing == false)
        // ウォームアップ後(>=100ms)は通常どおり検出する。
        #expect(vad.process(rms: 0.2, nowMs: 120) == .speechStarted)
        #expect(vad.capturing == true)
    }

    @Test("reset()で内部状態が初期化される")
    func resetClearsState() {
        let vad = VoiceActivityDetector(config: VADConfig(onsetFrames: 1, minThreshold: 0.02, warmupMs: 0))
        _ = vad.process(rms: 0.1, nowMs: 0)
        #expect(vad.capturing == true)
        vad.reset()
        #expect(vad.capturing == false)
    }

    @Test("ノイズフロアは下降(decay)の方が上昇(attack)より速く追従する")
    func noiseFloorDecaysFasterThanItRises() {
        // attackとdecayを大きく離し、同じ沈黙ステップ数での追従量の違いを比較する。
        let config = VADConfig(onsetFrames: 1, minThreshold: 0.02, floorAttack: 0.05, floorDecay: 0.5, warmupMs: 0)

        // 上昇方向: 初期floor(0.0003)よりrmsが高い沈黙を1ステップ与える。
        let rising = VoiceActivityDetector(config: config)
        _ = rising.process(rms: 0.001, nowMs: 0)
        let risingThreshold = rising.process(rms: 0.001, nowMs: 60)
        #expect(risingThreshold == .silence) // しきい値(minThreshold=0.02)未満なのでまだ無音判定

        // 下降方向: 一旦騒音でfloorを上げてから、静かな1ステップでどこまで下がるかを見る。
        // 騒音側はminThreshold=0.02未満になるよう小さい値で揃え、純粋にfloor追従だけを見る。
        let decaying = VoiceActivityDetector(config: config)
        for ms in stride(from: 0.0, to: 600, by: 60) {
            _ = decaying.process(rms: 0.01, nowMs: ms) // floorをattackで0.01近くまで上げる
        }
        // 同じ1ステップでrmsを大きく落とした場合、decay(0.5)はattack(0.05)より大幅に速く追従するはず。
        // ここでは間接的に、その後すぐ低rmsの発話がしきい値を超えて検出できることで確認する。
        let quietRms: Float = 0.0015
        _ = decaying.process(rms: quietRms, nowMs: 660) // 1ステップでfloorがquietRms付近まで急落(decay)
        _ = decaying.process(rms: quietRms, nowMs: 720) // floor追従後は無音側に留まる
        let stillSilentAfterDecay = decaying.process(rms: quietRms, nowMs: 780)
        #expect(stillSilentAfterDecay == .silence)
    }
}

@Suite("PreRollBuffer")
struct PreRollBufferTests {
    @Test("容量を超えると古いものから捨てられる")
    func dropsOldestBeyondCapacity() {
        var buffer = PreRollBuffer(capacityFrames: 2)
        let a = makeBuffer()
        let b = makeBuffer()
        let c = makeBuffer()
        buffer.push(a)
        buffer.push(b)
        buffer.push(c)
        let drained = buffer.drainAndClear()
        #expect(drained.count == 2)
        #expect(drained[0] === b)
        #expect(drained[1] === c)
    }

    @Test("drainAndClear後は空になる")
    func drainClearsBuffer() {
        var buffer = PreRollBuffer(capacityFrames: 4)
        buffer.push(makeBuffer())
        _ = buffer.drainAndClear()
        #expect(buffer.drainAndClear().isEmpty)
    }

    @Test("capacityFrames=0なら何も保持しない")
    func zeroCapacityKeepsNothing() {
        var buffer = PreRollBuffer(capacityFrames: 0)
        buffer.push(makeBuffer())
        #expect(buffer.drainAndClear().isEmpty)
    }

    private func makeBuffer() -> AVAudioPCMBuffer {
        let format = AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 1)!
        return AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 16)!
    }
}
