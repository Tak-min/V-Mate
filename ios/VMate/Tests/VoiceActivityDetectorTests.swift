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
}
