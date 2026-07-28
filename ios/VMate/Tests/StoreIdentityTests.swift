import Testing
@testable import VMate

@Suite("StoreIdentity")
struct StoreIdentityTests {
    @Test("appUserIDとserverUserIDが完全一致すれば束縛済みとみなす")
    func matchesWhenIdentical() {
        #expect(StoreIdentity.matches(appUserID: "user-123", serverUserID: "user-123"))
    }

    @Test("appUserIDが$RCAnonymousID:形式(logIn未成功)なら常に不一致(本バグの中核ケース)")
    func doesNotMatchAnonymousAppUserID() {
        #expect(!StoreIdentity.matches(appUserID: "$RCAnonymousID:ABCDEF123456", serverUserID: "user-123"))
    }

    @Test("別々の実IDは不一致")
    func doesNotMatchDifferentRealIDs() {
        #expect(!StoreIdentity.matches(appUserID: "user-123", serverUserID: "user-456"))
    }

    @Test("serverUserIDが空文字なら常に不一致(fail-closed)")
    func doesNotMatchEmptyServerUserID() {
        #expect(!StoreIdentity.matches(appUserID: "user-123", serverUserID: ""))
    }

    @Test("前後の空白は無視して比較する(SDKがtrimして永続化する挙動と整合)")
    func matchesIgnoringSurroundingWhitespace() {
        #expect(StoreIdentity.matches(appUserID: "  user-123 \n", serverUserID: "user-123"))
    }
}
