import Foundation
import Observation

enum PullRequestReactionLogic {
    static let order = ["thumbs-up", "thumbs-down", "laugh", "hooray", "confused", "heart", "rocket", "eyes"]
    static func emoji(_ content: String) -> String {
        ["thumbs-up": "👍", "thumbs-down": "👎", "laugh": "😄", "hooray": "🎉", "confused": "😕", "heart": "❤️", "rocket": "🚀", "eyes": "👀"][content] ?? content
    }
    static func label(_ content: String) -> String { content.replacingOccurrences(of: "-", with: " ") }
    static func actors(_ reaction: PullRequestReaction) -> String {
        let names = reaction.viewerHasReacted && reaction.actors.count < reaction.count ? ["You"] + reaction.actors : reaction.actors
        let shown = Array(names.prefix(min(3, max(0, reaction.count))))
        let remaining = max(0, reaction.count - shown.count)
        let suffix = remaining > 0 ? ["\(remaining) \(shown.isEmpty ? (remaining == 1 ? "person" : "people") : (remaining == 1 ? "other" : "others"))"] : []
        return (shown + suffix).joined(separator: ", ") + " reacted with " + label(reaction.content)
    }
    static func applying(_ reactions: [PullRequestReaction], changes: [String: Bool]) -> [PullRequestReaction] {
        var values = Dictionary(reactions.map { ($0.content, $0) }, uniquingKeysWith: { _, last in last })
        for (content, reacted) in changes {
            if var existing = values[content] {
                if existing.viewerHasReacted != reacted { existing.count += reacted ? 1 : -1; existing.viewerHasReacted = reacted }
                values[content] = existing.count > 0 ? existing : nil
            } else if reacted { values[content] = .init(content: content, count: 1, actors: [], viewerHasReacted: true) }
        }
        return (order + values.keys.filter { !order.contains($0) }.sorted()).compactMap { values[$0] }
    }
}

@MainActor @Observable
final class PullRequestReactionModel {
    private var base: [PullRequestReaction]
    private var optimistic: [String: Bool] = [:]
    private(set) var pending = Set<String>()
    private(set) var error: String?
    var shown: [PullRequestReaction] { PullRequestReactionLogic.applying(base, changes: optimistic) }
    init(reactions: [PullRequestReaction]) { base = reactions }
    func reconcile(_ reactions: [PullRequestReaction]) {
        base = reactions
        for (content, desired) in optimistic where !pending.contains(content) {
            if (reactions.first { $0.content == content }?.viewerHasReacted ?? false) == desired { optimistic.removeValue(forKey: content) }
        }
    }
    func toggle(_ content: String, send: (String, Bool) async throws -> Void, refresh: () async -> Void) async {
        guard PullRequestReactionLogic.order.contains(content), !pending.contains(content) else { return }
        let desired = !(shown.first { $0.content == content }?.viewerHasReacted ?? false)
        let previous = optimistic[content]
        optimistic[content] = desired; pending.insert(content); error = nil
        do {
            try await send(content, desired)
            pending.remove(content)
            await refresh()
        } catch {
            optimistic[content] = previous; pending.remove(content); self.error = error.localizedDescription
        }
    }
}
