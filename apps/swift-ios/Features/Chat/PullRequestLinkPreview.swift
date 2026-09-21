import Foundation
import SwiftUI

struct PullRequestLinkTarget: Hashable, Identifiable, Sendable {
    let url: URL
    let repositoryKey: String
    let number: Int
    var id: String { "\(repositoryKey)#\(number)" }

    init?(_ url: URL) {
        guard url.scheme == "https" || url.scheme == "http", let host = url.host,
              url.user == nil, url.password == nil else { return nil }
        let parts = url.path.split(separator: "/").map(String.init)
        let marker: Int
        if parts.count >= 4, parts[2] == "pull" {
            marker = 2
        } else if let index = parts.firstIndex(of: "-"), index >= 2,
                  parts.count > index + 2, parts[index + 1] == "merge_requests" {
            marker = index
        } else { return nil }
        let numberIndex = parts[marker] == "pull" ? marker + 1 : marker + 2
        guard let number = Int(parts[numberIndex]), number > 0 else { return nil }
        self.url = url
        self.number = number
        repositoryKey = ([host] + parts.prefix(marker)).joined(separator: "/").lowercased()
    }

    /// "#482" on GitHub, "!482" for a GitLab merge request.
    var displayNumber: String {
        url.path.contains("/-/merge_requests/") ? "!\(number)" : "#\(number)"
    }

    static func links(in source: String) -> [Self] {
        guard let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue) else { return [] }
        var seen = Set<String>()
        return detector.matches(in: source, range: NSRange(source.startIndex..., in: source))
            .compactMap { $0.url.flatMap(Self.init) }
            .filter { seen.insert($0.id).inserted }
            .prefix(5).map { $0 }
    }
}

struct MarkdownPullRequestContext {
    let threadID: String
    let client: any FeatureClient
}
private struct MarkdownPullRequestContextKey: EnvironmentKey {
    static let defaultValue: MarkdownPullRequestContext? = nil
}
extension EnvironmentValues {
    var markdownPullRequestContext: MarkdownPullRequestContext? {
        get { self[MarkdownPullRequestContextKey.self] }
        set { self[MarkdownPullRequestContextKey.self] = newValue }
    }
}

/// What a pull request link in a message points at, in a short floating
/// sheet: the shared state badge, the title, and one way in. Opening the full
/// detail pushes it and grows the sheet.
struct PullRequestLinkPreview: View {
    let target: PullRequestLinkTarget
    let context: MarkdownPullRequestContext
    @State private var detail: PullRequestDetail?
    @State private var errorMessage: String?
    @State private var path: [Int] = []
    @State private var detent: PresentationDetent = .medium
    @SwiftUI.Environment(\.openURL) private var openURL

    var body: some View {
        NavigationStack(path: $path) {
            Group {
                if let detail {
                    summary(detail)
                } else if let errorMessage {
                    ContentUnavailableView {
                        Label("Couldn’t Load Pull Request", systemImage: "exclamationmark.triangle")
                    } description: {
                        Text(errorMessage)
                    } actions: {
                        Button("Try Again") { Task { await load() } }.buttonStyle(.bordered)
                    }
                } else {
                    placeholder
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .navigationTitle(target.displayNumber)
            .navigationBarTitleDisplayMode(.inline)
            .modifier(PullRequestPreviewSubtitle(repository: detail?.repository))
            .t3NavigationChrome()
            .t3SheetToolbar(.close)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Open in Browser", systemImage: "safari") { openURL(target.url) }
                }
            }
            .navigationDestination(for: Int.self) { number in
                PullRequestDetailSheet(client: context.client, threadID: context.threadID, number: number)
            }
        }
        .presentationDetents([.medium, .large], selection: $detent)
        .t3GlassSheetBackground()
        .onChange(of: path) { _, newPath in if !newPath.isEmpty { detent = .large } }
        .task(id: target.id) { await load() }
        .accessibilityIdentifier("pull-request-link-preview")
    }

    private func summary(_ detail: PullRequestDetail) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 6) {
                PullRequestStateBadge(state: detail.state, isDraft: detail.isDraft)
                Text("\(detail.repository) · #\(String(detail.number))")
                    .font(T3Typography.supporting)
                    .foregroundStyle(T3Colors.textTertiary)
                    .lineLimit(1)
            }
            Text(detail.title)
                .font(T3Typography.threadHeading2)
                .foregroundStyle(T3Colors.textPrimary)
                .fixedSize(horizontal: false, vertical: true)
            Text(meta(detail))
                .font(T3Typography.supporting)
                .monospacedDigit()
                .foregroundStyle(T3Colors.textSecondary)
                .contextMenu {
                    if let author = detail.author, let profile = Self.authorURL(author, requestURL: target.url) {
                        Button("View \(author.login)’s Profile", systemImage: "person.crop.circle") { openURL(profile) }
                    }
                }
            Spacer(minLength: 16)
            Button {
                path.append(target.number)
            } label: {
                Text("Open Pull Request").frame(maxWidth: .infinity)
            }
            .t3ProminentButtonStyle()
            .controlSize(.large)
        }
        .padding(20)
    }

    private func meta(_ detail: PullRequestDetail) -> String {
        var parts: [String] = []
        if let author = detail.author { parts.append("by \(author.name ?? author.login)") }
        parts.append(PullRequestDetailSections.statsLine(detail))
        return parts.joined(separator: " · ")
    }

    /// The summary's shape, static until it loads.
    private var placeholder: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Open · owner/repository · #000").font(T3Typography.supporting)
            Text("A pull request title that wraps").font(T3Typography.threadHeading2)
            Text("by someone · +00 −00 · 0 files").font(T3Typography.supporting)
        }
        .foregroundStyle(T3Colors.textSecondary)
        .redacted(reason: .placeholder)
        .padding(20)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Loading pull request")
    }

    static func authorURL(_ author: PullRequestActor, requestURL: URL) -> URL? {
        guard let host = requestURL.host,
              !author.login.isEmpty,
              author.login.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" || $0 == ".") }) else { return nil }
        return URL(string: "https://\(host)/\(author.login)")
    }

    private func load() async {
        errorMessage = nil
        detail = nil
        do {
            let loaded = try await context.client.pullRequestPreview(threadID: context.threadID, url: target.url)
            try Task.checkCancellation()
            detail = loaded
        } catch is CancellationError {} catch {
            guard !Task.isCancelled else { return }
            errorMessage = error.localizedDescription
        }
    }
}

/// The repository under "#482" on iOS 26; earlier systems show the number alone.
private struct PullRequestPreviewSubtitle: ViewModifier {
    let repository: String?

    func body(content: Content) -> some View {
        if #available(iOS 26.0, *), let repository {
            content.navigationSubtitle(repository)
        } else {
            content
        }
    }
}
