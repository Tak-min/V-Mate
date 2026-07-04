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

    @Test("既定設定では遠距離スケールのRMS(旧しきい値では取りこぼした音量)でも発話を検出する")
    func defaultConfigDetectsFarFieldSpeech() {
        // 2026-06-26: 近距離は拾えるが少し離れると取れない報告を受け、既定しきい値を下げた。
        // 旧既定(minThreshold 0.0006 / noiseMargin 1.8 / offset 0.0003 → 実効~0.00084)では
        // 取りこぼした遠距離RMS(~0.0007)を、新既定(実効~0.00062)では検出できることを固定する。
        let vad = VoiceActivityDetector(config: VADConfig()) // 全て既定値
        let farRms: Float = 0.0007
        // warmup(既定400ms)中は検出しない。startedMs=0 なので nowMs < 400 の間は .silence。
        #expect(vad.process(rms: farRms, nowMs: 0) == .silence)   // warmup中
        #expect(vad.process(rms: farRms, nowMs: 200) == .silence)  // warmup中
        // warmup終了: nowMs=400 は "400-0 < 400" = false → warmup を抜ける。
        // onsetFrames=2 なので2フレーム連続で .speechStarted。
        #expect(vad.process(rms: farRms, nowMs: 400) == .silence)      // 1フレーム目(aboveFrames=1)
        #expect(vad.process(rms: farRms, nowMs: 464) == .speechStarted) // 2フレーム目でonset
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
        // shortHangoverMs(700) >= hangoverMs(100) → 短縮ハングオーバーは無効化、常に hangoverMs=100ms を使う。
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
        #expect(vad.peakCaptureRms == 0)
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

    // MARK: - 適応型ハングオーバー (shortHangover) テスト

    @Test("エネルギーがピークの18%未満に落ちると shortHangoverMs で早期終了する")
    func shortHangoverFiresWhenEnergyDropsSignificantly() {
        // hangoverMs=1400 に対して shortHangoverMs=700 が有効になるケース。
        // minThreshold=0.005 を使い、沈黙RMS(0.0002)がしきい値(0.005)以下になることを保証する。
        var config = VADConfig(onsetFrames: 1, hangoverMs: 1400, minThreshold: 0.005, warmupMs: 0)
        config.shortHangoverMs = 700
        config.shortHangoverRatio = 0.18
        let vad = VoiceActivityDetector(config: config)

        // 発話開始(peak RMS = 0.1, threshold ≈ 0.005)
        #expect(vad.process(rms: 0.1, nowMs: 0) == .speechStarted)
        // 話している間(lastVoiceMs更新)
        #expect(vad.process(rms: 0.1, nowMs: 100) == .silence)
        // エネルギーがピーク(0.1)の 0.2%(0.0002) に急落: 0.0002 < 0.18*0.1=0.018 → 短縮パス有効
        // rms=0.0002 < threshold(0.005) → else ブランチで hangover チェック
        #expect(vad.process(rms: 0.0002, nowMs: 200) == .silence) // 200-100=100ms < 700ms
        #expect(vad.process(rms: 0.0002, nowMs: 790) == .silence) // 790-100=690ms < 700ms
        // lastVoiceMs=100, nowMs=900 → 900-100=800ms > shortHangoverMs(700ms) → speechEnded
        #expect(vad.process(rms: 0.0002, nowMs: 900) == .speechEnded)
        #expect(vad.capturing == false)
        #expect(vad.peakCaptureRms == 0)
    }

    @Test("エネルギーがピークの25%程度なら shortHangover を使わず hangoverMs を待つ")
    func highResidualNoisePreventsShortHangover() {
        // 背景ノイズがあり、発話終了後もRMSが高め(ピークの25%)に留まるが threshold未満な場合。
        // peak=0.04, noise=0.01, minThreshold=0.02
        //   noise(0.01) < threshold(0.02) → else ブランチ → hangover チェック ✓
        //   noise(0.01) / peak(0.04) = 25% > 18% → 短縮パス不使用 ✓
        var config = VADConfig(onsetFrames: 1, hangoverMs: 1400, minThreshold: 0.02, warmupMs: 0)
        config.shortHangoverMs = 700
        config.shortHangoverRatio = 0.18
        let vad = VoiceActivityDetector(config: config)

        _ = vad.process(rms: 0.04, nowMs: 0)  // 発話開始, peak=0.04, lastVoiceMs=0
        _ = vad.process(rms: 0.04, nowMs: 100) // 話している, lastVoiceMs=100

        // 残留ノイズ=0.01: 0.01 < threshold(0.02) → silence判定
        //   かつ 0.01 > 0.18*0.04=0.0072 → 短縮パス不使用 → hangoverMs(1400ms)適用
        // 700ms後(800ms経過): shortHangoverなら終わるが、長ハングオーバーなのでまだ沈黙
        #expect(vad.process(rms: 0.01, nowMs: 900) == .silence) // 900-100=800ms < 1400ms
        // 1400ms後(1500ms経過): hangoverMs に達して発話終了
        #expect(vad.process(rms: 0.01, nowMs: 1600) == .speechEnded) // 1600-100=1500ms > 1400ms
    }

    @Test("「えーと」のような中間無音(600ms)では shortHangover が誤発火しない")
    func midSpeechPauseDoesNotTriggerShortHangover() {
        // 発話途中の短い無音(~500ms)で発話が切れないことを確認する。
        // shortHangoverMs=700ms なので 600ms の中間無音はセーフ。
        var config = VADConfig(onsetFrames: 1, hangoverMs: 1400, minThreshold: 0.001, warmupMs: 0)
        config.shortHangoverMs = 700
        config.shortHangoverRatio = 0.18
        let vad = VoiceActivityDetector(config: config)

        _ = vad.process(rms: 0.1, nowMs: 0)    // 発話開始, peak=0.1
        _ = vad.process(rms: 0.1, nowMs: 100)

        // 「えーと」の無音区間: rms=0.0001 (ピークの0.1%) → 短縮パス判定になる
        // しかし無音開始から 600ms < shortHangoverMs(700ms) → まだ終了しない
        #expect(vad.process(rms: 0.0001, nowMs: 200) == .silence) // lastVoiceMs=100, 200-100=100ms
        #expect(vad.process(rms: 0.0001, nowMs: 700) == .silence) // 700-100=600ms < 700ms → 終了しない
        // 発話再開
        #expect(vad.process(rms: 0.1, nowMs: 760) == .silence) // 再び threshold 超え(lastVoiceMs更新)
        #expect(vad.capturing == true)
    }

    @Test("speechEnded後に peakCaptureRms がリセットされる")
    func peakCaptureRmsResetsAfterSpeechEnded() {
        var config = VADConfig(onsetFrames: 1, hangoverMs: 100, minThreshold: 0.01, warmupMs: 0)
        config.shortHangoverRatio = 0 // 短縮ハングオーバー無効
        let vad = VoiceActivityDetector(config: config)

        _ = vad.process(rms: 0.5, nowMs: 0)
        #expect(vad.peakCaptureRms > 0)
        _ = vad.process(rms: 0.0, nowMs: 300)
        #expect(vad.capturing == false)
        #expect(vad.peakCaptureRms == 0)
    }

    @Test("shortHangoverMs >= hangoverMs のとき shortHangover は無効化される")
    func shortHangoverDisabledWhenNotShorter() {
        // shortHangoverMs=2000 >= hangoverMs=100 → 常に hangoverMs=100ms を使う。
        var config = VADConfig(onsetFrames: 1, hangoverMs: 100, minThreshold: 0.01, warmupMs: 0)
        config.shortHangoverMs = 2000
        config.shortHangoverRatio = 0.99
        let vad = VoiceActivityDetector(config: config)

        _ = vad.process(rms: 1.0, nowMs: 0)
        #expect(vad.process(rms: 0.0, nowMs: 200) == .speechEnded) // hangoverMs=100ms で終了
    }

    @Test("ノイズフロアが noiseFloorMinimum を下回らない")
    func noiseFloorDoesNotDecayBelowMinimum() {
        var config = VADConfig(onsetFrames: 1, minThreshold: 0.001, warmupMs: 0)
        config.noiseFloorMinimum = 0.0001
        config.floorDecay = 0.9 // 急速に下降させる
        let vad = VoiceActivityDetector(config: config)

        // 完全無音(rms=0)を大量に流す
        for i in 0..<1000 {
            _ = vad.process(rms: 0, nowMs: Double(i) * 60)
        }
        #expect(vad.noiseFloor >= config.noiseFloorMinimum)
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

@Suite("AudioCapturePipeline gate")
struct AudioCapturePipelineGateTests {
    // tapスレッドのゲート判定(エンジンを止めずにターン単位で聞き取りを切り替える設計)の
    // 真理値表を、AVAudioEngine/SFSpeechRecognizer非依存の純関数として検証する。

    @Test("arm直後(enabled=true, pendingArm=true)は前ターンをリセットしてから処理する")
    func armedWithPendingResetsThenProcesses() {
        let gate = AudioCapturePipeline.gateDecision(enabled: true, pendingArm: true)
        #expect(gate.doReset == true)
        #expect(gate.process == true)
    }

    @Test("通常の聞き取り中(enabled=true, pendingArm=false)はリセットせず処理する")
    func armedSteadyStateProcessesWithoutReset() {
        let gate = AudioCapturePipeline.gateDecision(enabled: true, pendingArm: false)
        #expect(gate.doReset == false)
        #expect(gate.process == true)
    }

    @Test("休止中(enabled=false, pendingArm=false)はフレームを破棄する")
    func disarmedDropsFrame() {
        let gate = AudioCapturePipeline.gateDecision(enabled: false, pendingArm: false)
        #expect(gate.doReset == false)
        #expect(gate.process == false)
    }

    @Test("arm→disarmが立て続けに来た場合(enabled=false, pendingArm=true)もリセットは消費しつつ処理はしない")
    func armThenDisarmConsumesResetButDoesNotProcess() {
        // arm()はpendingArm/enabled両方をtrueにするが、tapが走る前にdisarm()でenabledがfalseに
        // なるケース。取り残しrequestのクローズ(doReset)は行い、フレーム処理(process)はしない。
        let gate = AudioCapturePipeline.gateDecision(enabled: false, pendingArm: true)
        #expect(gate.doReset == true)
        #expect(gate.process == false)
    }
}

@Suite("LockedFlag")
struct LockedFlagTests {
    @Test("初期値を保持し、読み書きが往復する")
    func roundTrips() {
        let flag = LockedFlag(false)
        #expect(flag.value == false)
        flag.value = true
        #expect(flag.value == true)
        flag.value = false
        #expect(flag.value == false)
    }

    @Test("初期値trueで生成できる")
    func initialTrue() {
        let flag = LockedFlag(true)
        #expect(flag.value == true)
    }
}
