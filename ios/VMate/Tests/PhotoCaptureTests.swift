import Foundation
import Testing
@testable import VMate

@Suite("PhotoCapture")
struct PhotoCaptureTests {
    @Test("PNG data URLをbase64デコードしてDataを返す")
    func decodesValidPNGDataURL() {
        let payload = Data([0x01, 0x02, 0x03]).base64EncodedString()
        let decoded = PhotoCapture.decodeDataURL("data:image/png;base64,\(payload)")
        #expect(decoded == Data([0x01, 0x02, 0x03]))
    }

    @Test("カンマが無い文字列はnilを返す(fail-closed)")
    func returnsNilWithoutComma() {
        #expect(PhotoCapture.decodeDataURL("not-a-data-url") == nil)
    }

    @Test("base64部分が不正な文字列はnilを返す")
    func returnsNilForInvalidBase64() {
        #expect(PhotoCapture.decodeDataURL("data:image/png;base64,***invalid***") == nil)
    }
}
