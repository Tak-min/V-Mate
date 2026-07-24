import SwiftUI
import WebKit

/// 本番Worker上で配信される avatar.html(three-vrm の調整済みビューアをそのまま再利用)を
/// 読み込む WKWebView。Web版とアニメーションロジックを共有するため、視線/まばたき/リップシンクの
/// チューニングをSwiftで二重管理しない方針(詳細は ios/dev-notes/vrm_avatar_architecture_2026-06-19.md)。
struct VRMAvatarView: UIViewRepresentable {
    @ObservedObject var viewModel: CompanionViewModel
    /// 読み込み失敗時に true。RootView 側でこれを見て v1 の AvatarView にフォールバックする。
    @Binding var failed: Bool
    /// ページの読み込み完了(didFinish)時に呼ばれる。3Dモデル自体の描画完了までの厳密な保証はないが、
    /// オンボーディングのreveal画面で事前読み込みしてから読む猶予(タップまでの数秒)があるため十分な近似値とする。
    var onLoadFinished: (() -> Void)? = nil

    private static let avatarURL = URL(string: "https://aikata.taku810616.workers.dev/ios-avatar/avatar")!

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        let webView = WKWebView(frame: .zero, configuration: config)
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.backgroundColor = .clear
        webView.scrollView.isScrollEnabled = false
        webView.navigationDelegate = context.coordinator
        webView.load(URLRequest(url: Self.avatarURL))
        context.coordinator.webView = webView
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        context.coordinator.sync(emotion: viewModel.currentEmotion, mouthLevel: viewModel.avatarMouthLevel)
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(onFailure: { failed = true }, onFinish: { onLoadFinished?() })
    }

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate {
        weak var webView: WKWebView?
        private var lastEmotion: Emotion?
        private var lastMouthLevel: Double = -1
        private let onFailure: () -> Void
        private let onFinish: () -> Void

        init(onFailure: @escaping () -> Void, onFinish: @escaping () -> Void) {
            self.onFailure = onFailure
            self.onFinish = onFinish
        }

        func sync(emotion: Emotion, mouthLevel: Double) {
            guard let webView else { return }
            if emotion != lastEmotion {
                lastEmotion = emotion
                webView.evaluateJavaScript("window.vmate && window.vmate.setEmotion('\(emotion.rawValue)')")
            }
            // 30fps相当・微小変化は間引いて evaluateJavaScript の呼び過ぎを避ける。
            if abs(mouthLevel - lastMouthLevel) > 0.01 {
                lastMouthLevel = mouthLevel
                webView.evaluateJavaScript("window.vmate && window.vmate.setMouthLevel(\(mouthLevel))")
            }
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            onFinish()
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            onFailure()
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            onFailure()
        }
    }
}
