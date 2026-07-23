import SwiftUI

@main
struct VMateApp: App {
    init() {
        // RevenueCat は起動直後、最初のUI表示より前に configure するのが公式推奨。
        RevenueCatManager.shared.configureIfNeeded()
    }

    var body: some Scene {
        WindowGroup {
            RootView()
        }
    }
}
