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

struct PullRequestLinkPreview: View {
    let target: PullRequestLinkTarget
    let context: MarkdownPullRequestContext
    @State private var detail: PullRequestDetail?
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if let detail {
                        Text(detail.repository).font(T3Typography.supporting).foregroundStyle(T3Colors.textSecondary)
                        Text("#\(String(detail.number)) \(detail.title)").font(T3Typography.threadHeading2)
                        Text(PullRequestDetailSections.stateLabel(state: detail.state, isDraft: detail.isDraft))
                            .foregroundStyle(detail.state == .open ? T3Colors.success : T3Colors.accent)
                        if let author = detail.author {
                            if let profile = Self.authorURL(author, requestURL: target.url) {
                                Link("By \(author.name ?? author.login)", destination: profile)
                            } else { Text("By \(author.name ?? author.login)") }
                        }
                        Text(PullRequestDetailSections.statsLine(detail)).monospacedDigit()
                        NavigationLink("Open pull request") {
                            PullRequestDetailSheet(client: context.client, threadID: context.threadID, number: target.number)
                        }.buttonStyle(.borderedProminent)
                    } else if let errorMessage {
                        SettingsErrorBanner(message: errorMessage)
                        Button("Retry") { Task { await load() } }.buttonStyle(.bordered)
                    } else { ProgressView("Loading pull request…") }
                    Link("Open in browser", destination: target.url)
                }
                .padding(20)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .background(T3Colors.background)
            .navigationTitle("Pull request preview")
            .navigationBarTitleDisplayMode(.inline)
        }
        .presentationDetents([.medium, .large])
        .task(id: target.id) { await load() }
        .accessibilityIdentifier("pull-request-link-preview")
    }

    static func authorURL(_ author: PullRequestActor, requestURL: URL) -> URL? {
        guard let host = requestURL.host,
              !author.login.isEmpty,
              author.login.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" || $0 == ".") }) else { return nil }
        return URL(string: "https://\(host)/\(author.login)")
    }

    private func load() async {
        errorMessage = nil
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
