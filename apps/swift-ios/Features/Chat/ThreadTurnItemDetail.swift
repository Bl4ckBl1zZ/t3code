import Foundation
import Observation
import SwiftUI

// Ported from packages/client-runtime/src/work-log/itemDetail.ts. The server
// withholds command and tool output on the wire (`outputOmitted`); a work-log
// row fetches it with `orchestration.getTurnItem` while it is open.

public enum ThreadTurnItemDetail {
    private static let maxTextBlockDepth = 4
    private static let liveStatuses: Set<String> = ["idle", "pending", "running", "waiting"]

    /// True when the timeline item withholds content that `getTurnItem` returns.
    public static func needsFetch(_ item: OrchestrationV2TurnItem) -> Bool {
        switch item.payload {
        case .commandExecution:
            return item.outputOmitted
        case let .dynamicTool(_, input, _):
            return item.outputOmitted || isSummarized(input)
        default:
            return false
        }
    }

    /// Cache key for a fetched item. A running item keeps one key, so an open
    /// row fetches once while it streams and again when it finishes, not on
    /// every update.
    public static func revision(_ item: OrchestrationV2TurnItem) -> String {
        liveStatuses.contains(item.base.rawStatus) ? "live" : item.base.updatedAt
    }

    /// Whether expanding the row shows anything. Rows without content must not
    /// offer a disclosure, otherwise they open to an empty panel.
    public static func hasDetail(_ item: OrchestrationV2TurnItem) -> Bool {
        switch item.payload {
        case let .reasoning(text, _):
            return !text.isBlank
        case let .commandExecution(input, output, exitCode, _):
            return !input.isBlank || item.outputOmitted || !(output ?? "").isBlank || exitCode != nil
        case .fileChange, .checkpoint, .fork, .handoff:
            return true
        case let .fileSearch(pattern, results):
            return !(results ?? []).isEmpty || !(pattern ?? "").isBlank
        case let .webSearch(patterns, results):
            return !(results ?? []).isEmpty || !(patterns ?? []).isEmpty
        case let .dynamicTool(_, input, output):
            return item.outputOmitted || formatToolValue(input) != nil || formatToolValue(output) != nil
        case let .approvalRequest(_, _, prompt, _):
            return !(prompt ?? "").isBlank
        case let .userInputRequest(_, questions):
            return !questions.isEmpty
        case let .error(failure, _):
            return !failure.message.isBlank
        case let .proposedPlan(_, markdown, _):
            return !markdown.isBlank
        case let .todoList(_, steps, _):
            return !steps.isEmpty
        case let .subagent(_, _, _, _, childThreadID, prompt, progress, result):
            return childThreadID != nil || !prompt.isBlank || !(progress ?? "").isBlank
                || !(result ?? "").isBlank
        // The inspector shows these; upstream renders them outside the log.
        case let .compaction(_, summary, before, after):
            return !(summary ?? "").isBlank || before != nil || after != nil
        case let .runInterruptRequest(message), let .runInterruptResult(message):
            return !message.isBlank
        case .checkpointRollback, .threadCreated, .userMessage, .assistantMessage, .unknown:
            return false
        }
    }

    /// The tool output a fetched item carries, formatted for display.
    public static func outputText(_ item: OrchestrationV2TurnItem) -> String? {
        switch item.payload {
        case let .commandExecution(_, output, _, _):
            guard let output, !output.isBlank else { return nil }
            let text = commandOutputText(output)
            return text.isEmpty ? nil : text
        case let .dynamicTool(_, _, output):
            return item.outputOmitted ? nil : formatToolValue(output)
        default:
            return nil
        }
    }

    /// A tool input or output for display: text blocks as text, the rest as
    /// indented JSON. `nil` when there is nothing to show.
    public static func formatToolValue(_ value: JSONValue?) -> String? {
        guard let value, value != .null else { return nil }
        if let text = textFromBlocks(value, depth: 0) {
            return text.isBlank ? nil : prettyJSONText(text)
        }
        let json = ThreadActivityInspector.prettyJSON(value)
        return json == "{}" || json == "[]" ? nil : json
    }

    /// Wire projection replaces a large dynamic value with `{ summary, truncated: true }`.
    private static func isSummarized(_ value: JSONValue?) -> Bool {
        guard case let .object(entries)? = value else { return false }
        return entries["truncated"] == .bool(true) && entries["summary"]?.stringValue != nil
    }

    private static func textFromBlocks(_ value: JSONValue, depth: Int) -> String? {
        guard depth <= maxTextBlockDepth else { return nil }
        switch value {
        case let .string(text):
            return text
        case let .array(blocks):
            var parts: [String] = []
            for block in blocks {
                guard let part = textFromBlocks(block, depth: depth + 1) else { return nil }
                parts.append(part)
            }
            return parts.joined(separator: "\n")
        case let .object(entries):
            let type = entries["type"]?.stringValue
            if type == "text", let text = entries["text"]?.stringValue { return text }
            if type == "image" { return "[image]" }
            if type == "resource_link", let uri = entries["uri"]?.stringValue { return uri }
            if type == "resource", case let .object(resource)? = entries["resource"] {
                if let text = resource["text"]?.stringValue { return text }
                if let uri = resource["uri"]?.stringValue { return uri }
            }
            let keys = Set(entries.keys).subtracting(["isError", "is_error"])
            // MCP and provider tool results wrap their text in `content`.
            // `structuredContent` usually repeats it as data, so it only shows
            // when the text is empty.
            if keys == ["content"], let content = entries["content"] {
                return textFromBlocks(content, depth: depth + 1)
            }
            if keys == ["content", "structuredContent"], let content = entries["content"] {
                let text = textFromBlocks(content, depth: depth + 1)
                return text.map { $0.isBlank ? nil : $0 } ?? nil
            }
            return nil
        default:
            return nil
        }
    }

    private static func parseJSON(_ text: String) -> JSONValue? {
        try? JSONDecoder().decode(JSONValue.self, from: Data(text.utf8))
    }

    /// MCP tools often return JSON as minified text, one document per line.
    /// Indent each.
    private static func prettyJSONText(_ text: String) -> String {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.first == "{" || trimmed.first == "[" else { return text }
        if let whole = parseJSON(trimmed) { return ThreadActivityInspector.prettyJSON(whole) }
        let lines = trimmed.split(separator: "\n").map {
            $0.trimmingCharacters(in: .whitespaces)
        }.filter { !$0.isEmpty }
        var documents: [JSONValue] = []
        for line in lines {
            guard let document = parseJSON(line) else { return text }
            documents.append(document)
        }
        return documents.map(ThreadActivityInspector.prettyJSON).joined(separator: "\n\n")
    }

    /// Older Claude bash rows stored the raw `{ stdout, stderr, interrupted }` result.
    private static func commandOutputText(_ output: String) -> String {
        guard output.drop(while: \.isWhitespace).hasPrefix("{\"stdout\""),
              case let .object(entries)? = parseJSON(output.trimmingCharacters(in: .whitespacesAndNewlines)),
              let stdout = entries["stdout"]?.stringValue,
              let stderr = entries["stderr"]?.stringValue,
              case .bool = entries["interrupted"] else {
            return output
        }
        return [stdout, stderr].filter { !$0.isBlank }.joined(separator: "\n")
    }
}

private extension String {
    var isBlank: Bool { allSatisfy(\.isWhitespace) }
}

/// What the open row shows where the withheld output goes.
public enum ThreadTurnItemOutputState: Equatable, Sendable {
    case loading
    case failed(String)
    /// The fetched item carried no output.
    case empty
}

/// Fetched turn items for one transcript, keyed by source thread, item and
/// revision. Owned by the transcript coordinator so a recycled cell neither
/// refetches nor shows another row's output.
@MainActor @Observable
final class ThreadTurnItemDetailStore {
    enum Entry: Equatable {
        case loading
        case loaded(OrchestrationV2TurnItem?)
        case failed(String)
    }

    typealias Loader = @MainActor (
        _ sourceThreadID: String, _ itemID: String, _ revision: String
    ) async throws -> OrchestrationV2TurnItem?

    @ObservationIgnored var loader: Loader?
    private(set) var entries: [String: Entry] = [:]
    @ObservationIgnored private var insertionOrder: [String] = []
    @ObservationIgnored private let limit: Int

    /// Fetched output is bounded to 256 KB per item on the server, so the
    /// cache holds a screenful of open rows, not the whole thread.
    init(limit: Int = 32, loader: Loader? = nil) {
        self.limit = max(1, limit)
        self.loader = loader
    }

    static func key(_ row: OrchestrationV2ProjectedTurnItem) -> String {
        "\(row.sourceThreadId)\u{1F}\(row.sourceItemId)\u{1F}\(ThreadTurnItemDetail.revision(row.item))"
    }

    func entry(for row: OrchestrationV2ProjectedTurnItem) -> Entry? {
        entries[Self.key(row)]
    }

    /// Fetches the row's full item unless it is cached or in flight. A failed
    /// fetch is retried the next time the row opens.
    func load(_ row: OrchestrationV2ProjectedTurnItem) async {
        guard ThreadTurnItemDetail.needsFetch(row.item), let loader else { return }
        let key = Self.key(row)
        switch entries[key] {
        case .loading, .loaded: return
        case .failed, nil: break
        }
        store(.loading, for: key)
        do {
            let item = try await loader(
                row.sourceThreadId, row.sourceItemId, ThreadTurnItemDetail.revision(row.item)
            )
            store(.loaded(item), for: key)
        } catch is CancellationError {
            // The row closed or scrolled away mid-fetch; the next open retries.
            entries.removeValue(forKey: key)
            insertionOrder.removeAll { $0 == key }
        } catch {
            store(.failed(error.localizedDescription), for: key)
        }
    }

    /// The item the inspector renders, and what stands in for its output while
    /// that is missing. A fetched item of another type (the id was reused) is
    /// ignored rather than shown under the wrong row.
    func resolve(
        _ row: OrchestrationV2ProjectedTurnItem
    ) -> (row: OrchestrationV2ProjectedTurnItem, output: ThreadTurnItemOutputState?) {
        guard ThreadTurnItemDetail.needsFetch(row.item) else { return (row, nil) }
        switch entry(for: row) {
        case let .loaded(item?) where item.type == row.item.type:
            let fetched = OrchestrationV2ProjectedTurnItem(
                position: row.position,
                visibility: row.visibility,
                sourceThreadId: row.sourceThreadId,
                sourceItemId: row.sourceItemId,
                item: item
            )
            return (fetched, ThreadTurnItemDetail.outputText(item) == nil ? .empty : nil)
        case .loaded:
            return (row, .failed("Output is no longer available."))
        case let .failed(message):
            return (row, .failed(message))
        case .loading, nil:
            return (row, loader == nil ? nil : .loading)
        }
    }

    private func store(_ entry: Entry, for key: String) {
        if entries.updateValue(entry, forKey: key) == nil {
            insertionOrder.append(key)
            while insertionOrder.count > limit {
                entries.removeValue(forKey: insertionOrder.removeFirst())
            }
        }
    }
}

private struct ThreadTurnItemDetailStoreKey: EnvironmentKey {
    static let defaultValue: ThreadTurnItemDetailStore? = nil
}

extension EnvironmentValues {
    var threadTurnItemDetails: ThreadTurnItemDetailStore? {
        get { self[ThreadTurnItemDetailStoreKey.self] }
        set { self[ThreadTurnItemDetailStoreKey.self] = newValue }
    }
}
