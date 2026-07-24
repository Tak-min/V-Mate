import SwiftUI
import WebKit

/// 本番Worker上で配信される avatar.html(three-vrm の調整済みビューアをそのまま再利用)を
/// 読み込む WKWebView。Web版とアニメーションロジックを共有するため、視線/まばたき/リップシンクの
/// チューニングをSwiftで二重管理しない方針(詳細は ios/dev-notes/vrm_avatar_architecture_2026-06-19.md)。
struct VRMAvatarView: UIViewRepresentable {
    @ObservedObject var viewModel: CompanionViewModel
    /// 読み込み失敗時に true。RootView 側でこれを見て v1 の AvatarView にフォールバックする。
    @Binding var failed: Bool
    /// 3Dモデルの読み込みが実際に完了した(=画面に描画される状態になった)時に呼ばれる。
    /// avatar.html(frontend/src/ios-avatar/entry.ts)は viewer.load() 完了時に
    /// `document.dispatchEvent(new Event('vmate-ready'))` を発火する設計で既に用意されていたが、
    /// Swift側でこれを購読していなかった(2026-07-24発覚)。didFinish(ページのナビゲーション完了)は
    /// three.jsの初期化・VRMモデルのfetch/パース完了より大幅に早く発火するため、「読み込み完了」の
    /// シグナルとしては不正確だった — これがオンボーディングのreveal演出で「キャラクターが実際に
    /// 見える前に音声が流れる」不具合の根本原因。
    var onLoadFinished: (() -> Void)? = nil

    private static let avatarURL = URL(string: "https://aikata.taku810616.workers.dev/ios-avatar/avatar")!
    private static let readyMessageName = "vmateReady"

    func makeUIView(context: Context) -> WKWebView {
        let contentController = WKUserContentController()
        // ページ本体(avatar.bundle.js)が実行されevent発火するより前に確実にリスナーを仕込むため
        // atDocumentStartで注入する(順序が逆だとイベントを取りこぼす)。avatar.html/entry.tsは
        // 一切変更しない(Web版と共有のCloudflare Worker配信アセットへの影響を避けるため、
        // 既存のカスタムイベントを購読するだけに留める)。
        let readyScript = WKUserScript(
            source: "document.addEventListener('vmate-ready', function() { window.webkit.messageHandlers.\(Self.readyMessageName).postMessage('ready'); });",
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        )
        contentController.addUserScript(readyScript)
        contentController.add(context.coordinator, name: Self.readyMessageName)

        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.userContentController = contentController
        let webView = WKWebView(frame: .zero, configuration: config)
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.backgroundColor = .clear
        webView.scrollView.isScrollEnabled = false
        webView.navigationDelegate = context.coordinator
        context.coordinator.observeLoadErrorTitle(on: webView)
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
    final class Coordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
        weak var webView: WKWebView?
        private var lastEmotion: Emotion?
        private var lastMouthLevel: Double = -1
        private let onFailure: () -> Void
        private let onFinish: () -> Void
        private var titleObservation: NSKeyValueObservation?

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

        /// entry.ts は viewer.load() 失敗時に `document.title = "load-error:..."` を設定するのみで
        /// (avatar.htmlはネットワークレベルでは正常に読み込まれるため didFail は発火しない)、
        /// これを検知する手段がSwift側になかった。KVOでtitleの変化を監視し、モデル自体の
        /// 読み込み失敗(壊れたVRMファイル・404等)もdidFail同様にフォールバック対象として扱う。
        func observeLoadErrorTitle(on webView: WKWebView) {
            titleObservation = webView.observe(\.title, options: [.new]) { [weak self] _, change in
                guard let title = change.newValue ?? nil, title.hasPrefix("load-error:") else { return }
                DispatchQueue.main.async { self?.onFailure() }
            }
        }

        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            guard message.name == VRMAvatarView.readyMessageName else { return }
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
