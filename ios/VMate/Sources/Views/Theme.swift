import SwiftUI

/// アプリ全体のデザイントークン + 共通コンポーネント。
/// PersonaColors.swift(ブランドカラーそのもの)とは責務を分け、こちらは
/// タイポグラフィスケール・余白スケール・「表舞台/裏方」共通のサーフェス定義を持つ。
/// 2026-07-23: UI監査(オンボーディング/メイン画面は独自ブランディングがある一方、
/// Account/Store/Diaryはデフォルトのシステムスタイルがそのまま露出していた)を受けて新設。

// MARK: - Typography
// 地の声を .rounded にする。キャラクター(シロ)に声があるようにUIにも声を持たせる。
extension Font {
    static let brandDisplay = Font.system(.largeTitle, design: .rounded).weight(.bold)
    static let brandTitle = Font.system(.title2, design: .rounded).weight(.bold)
    static let brandHeading = Font.system(.headline, design: .rounded).weight(.semibold)
    static let brandBody = Font.system(.callout, design: .rounded)
    static let brandBodyStrong = Font.system(.callout, design: .rounded).weight(.semibold)
    static let brandCaption = Font.system(.caption, design: .rounded)
    static let brandLabel = Font.system(.body, design: .rounded).weight(.bold)
}

// MARK: - Spacing / Radius
enum Space {
    static let xs: CGFloat = 4
    static let sm: CGFloat = 8
    static let md: CGFloat = 12
    static let lg: CGFloat = 16
    static let xl: CGFloat = 24
    static let xxl: CGFloat = 32
}

enum Radius {
    static let sm: CGFloat = 12
    static let md: CGFloat = 16
    static let lg: CGFloat = 22
}

// MARK: - Semantic colors
extension Color {
    /// 裏方シート(Account/Store/Diary)の地。システム純黒の代わりに使う温かいダークプラム。
    static let brandInkTop = Color(red: 0.12, green: 0.10, blue: 0.16)
    static let brandInkBottom = Color(red: 0.06, green: 0.05, blue: 0.09)
    static let textPrimary = Color.white
    static let textSecondary = Color.white.opacity(0.72)
    static let textTertiary = Color.white.opacity(0.45)
    static let hairline = Color.white.opacity(0.12)
}

// `.foregroundStyle(.textSecondary)`のような先頭ドット記法を通すための橋渡し。
// Appleの`.white`/`.red`等と同じ`ShapeStyle where Self == Color`パターン。
extension ShapeStyle where Self == Color {
    static var textPrimary: Color { .textPrimary }
    static var textSecondary: Color { .textSecondary }
    static var textTertiary: Color { .textTertiary }
}

/// 裏方シート用の温かいダーク背景。RootViewのAmbientBackground(気分連動)とは別に、
/// Account/Store/Diaryのような静的な画面向けの軽量版。
struct BrandBackground: View {
    var body: some View {
        ZStack {
            LinearGradient(colors: [.brandInkTop, .brandInkBottom], startPoint: .top, endPoint: .bottom)
            RadialGradient(colors: [Color.accentPink.opacity(0.18), .clear], center: .top, startRadius: 8, endRadius: 380)
        }
        .ignoresSafeArea()
    }
}

/// フロストガラス面。ConversationOverlay/OnboardingView等に重複していた
/// `.ultraThinMaterial` + strokeBorder の組み合わせを1箇所に集約する。
extension View {
    func glassCard(radius: CGFloat = Radius.lg, strokeOpacity: Double = 0.12) -> some View {
        background {
            RoundedRectangle(cornerRadius: radius, style: .continuous)
                .fill(Color.black.opacity(0.2))
                .overlay(RoundedRectangle(cornerRadius: radius, style: .continuous).fill(.ultraThinMaterial.opacity(0.5)))
                .overlay(RoundedRectangle(cornerRadius: radius, style: .continuous).strokeBorder(Color.white.opacity(strokeOpacity), lineWidth: 1))
        }
    }
}

/// ピンク→ラベンダーの主ボタンスタイル。オンボーディング/初対面/課金画面で
/// 個別に組んでいた同型ボタンを1つに統一する。
struct BrandPrimaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.brandLabel)
            .frame(maxWidth: .infinity)
            .padding(.vertical, Space.md)
            .foregroundStyle(.white)
            .background(LinearGradient.pinkLavender, in: RoundedRectangle(cornerRadius: Radius.md, style: .continuous))
            .shadow(color: Color.accentPink.opacity(0.35), radius: 10, y: 4)
            .opacity(configuration.isPressed ? 0.85 : 1)
            .scaleEffect(configuration.isPressed ? 0.98 : 1)
    }
}

/// 裏方シート(Account/Store/Diary)共通のスカフォールド。BrandBackground + 閉じるボタン付き
/// NavigationStackを1箇所にまとめ、3画面がバラバラのシステムデフォルトスタイルになるのを防ぐ。
struct BrandScreen<Content: View>: View {
    let title: String
    @ViewBuilder var content: () -> Content
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ZStack {
                BrandBackground()
                ScrollView {
                    content()
                        .padding(.horizontal, Space.lg)
                        .padding(.top, Space.sm)
                }
            }
            .navigationTitle(title)
            .toolbarBackground(.hidden, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("閉じる") { dismiss() }
                }
            }
        }
    }
}
