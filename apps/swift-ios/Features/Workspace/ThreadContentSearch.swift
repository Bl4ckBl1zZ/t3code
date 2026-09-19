import Foundation

/// A thread whose transcript matched a Home search, keyed by UI thread id.
public struct FeatureThreadSearchMatch: Equatable, Sendable {
    public let source: ThreadSearchSource
    public let snippet: String

    public init(source: ThreadSearchSource, snippet: String) {
        self.source = source
        self.snippet = snippet
    }
}

/// Server-side message search, the half of Home search the local index cannot
/// answer: titles, projects and pull requests are matched on device, while
/// what a thread's messages said lives only on its environment.
@MainActor
protocol FeatureThreadContentSearching: AnyObject {
    /// Matches from every reachable environment. An environment that fails,
    /// or predates `orchestration.searchThreads`, contributes nothing rather
    /// than failing the search.
    func searchThreadContent(query: String) async -> [String: FeatureThreadSearchMatch]
}

enum ThreadContentSearch {
    /// The server rejects shorter queries, and a single character would match
    /// nearly every message anyway.
    static let minimumQueryLength = 2
    /// Matches the web sidebar's debounce, so typing does not fan out one
    /// request per keystroke to every environment.
    static let debounce: Duration = .milliseconds(200)

    static func normalizedQuery(_ query: String) -> String? {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count >= minimumQueryLength else { return nil }
        return String(trimmed.prefix(200))
    }
}

/// The excerpt a content match shows under its Home row: who wrote the
/// matched message and the server's snippet, with the query emphasised.
struct HomeThreadSearchExcerpt: Equatable {
    let match: FeatureThreadSearchMatch
    let query: String

    var speaker: String { match.source == .user ? "You:" : "Agent:" }

    /// Every case-insensitive occurrence of the query in the snippet.
    var highlightedRanges: [Range<String.Index>] {
        var ranges: [Range<String.Index>] = []
        var searchStart = match.snippet.startIndex
        while searchStart < match.snippet.endIndex,
              let range = match.snippet.range(
                  of: query,
                  options: [.caseInsensitive, .diacriticInsensitive],
                  range: searchStart..<match.snippet.endIndex
              )
        {
            ranges.append(range)
            searchStart = range.upperBound
        }
        return ranges
    }
}
