import Foundation

struct PullRequestHandoffSelection: Equatable, Sendable {
    enum Kind: String, Sendable { case code, comment, check }
    let kind: Kind
    let label: String
    let body: String
    var location: String? = nil
    var url: String? = nil
    var truncated = false

    var context: String {
        let limit = kind == .code ? 16_000 : 8_000
        var lines = [String(label.prefix(500))]
        if let location { lines.append(String(location.prefix(2_000))) }
        if let url { lines.append(String(url.prefix(2_000))) }
        lines.append(String(body.prefix(limit)))
        if truncated || body.count > limit { lines.append("This excerpt was shortened. Inspect the original before changing code.") }
        return lines.joined(separator: "\n")
    }

    static func code(file: FeatureReviewFile, lines: [FeatureDiffLine], firstID: String, lastID: String, commit: String?) -> Self? {
        guard let first = lines.firstIndex(where: { $0.id == firstID }), let last = lines.firstIndex(where: { $0.id == lastID }) else { return nil }
        let range = lines[min(first, last)...max(first, last)]
        let selected = Array(range.prefix(200))
        guard selected.contains(where: { $0.kind != .hunk }) else { return nil }
        let old = selected.compactMap(\.oldLine), new = selected.compactMap(\.newLine)
        func span(_ values: [Int]) -> String { guard let first = values.first, let last = values.last else { return "none" }; return first == last ? String(first) : "\(first)–\(last)" }
        let text = selected.map { line -> String in
            let prefix = line.kind == .addition ? "+" : line.kind == .deletion ? "-" : line.kind == .hunk ? "" : " "
            return prefix + line.text
        }.joined(separator: "\n")
        return Self(kind: .code, label: "Selected pull-request diff", body: text,
            location: "\(file.path) · old lines \(span(old)) · new lines \(span(new))\nRevision: \(commit ?? "whole pull-request diff as loaded; revision not supplied")",
            truncated: range.count > selected.count)
    }

    static func comment(_ comment: PullRequestComment) -> Self {
        Self(kind: .comment, label: "Review remark from \(comment.author?.login ?? "unknown")", body: comment.body, location: comment.path, url: comment.url)
    }
    static func comment(_ comment: PullRequestThreadComment, thread: PullRequestReviewThread) -> Self {
        Self(kind: .comment, label: "Review finding from \(comment.author?.login ?? "unknown")", body: comment.body,
            location: "\(thread.path):\(thread.line.map(String.init) ?? "unknown") [\(thread.side)\(thread.isOutdated ? ", outdated" : "")\(thread.isResolved ? ", resolved" : "")]", url: comment.url)
    }
    static func check(_ check: PullRequestCheck) -> Self {
        Self(kind: .check, label: "Check: \(check.name) (\(check.status.rawValue))", body: check.description ?? "The host did not supply detailed output.", url: check.url)
    }
}

enum PullRequestCheckoutCommand {
    static func build(provider: String?, number: Int, headBranch: String, headRepository: String?) -> String? {
        guard number > 0 else { return nil }
        switch provider {
        case "github": return "gh pr checkout \(number)"
        case "gitlab": return "glab mr checkout \(number)"
        case "azure-devops": return "az repos pr checkout --id \(number)"
        case "bitbucket":
            guard let headRepository,
                  headRepository.range(of: "^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$", options: .regularExpression) != nil,
                  headBranch.range(of: "^[A-Za-z0-9._/@+=,-]+$", options: .regularExpression) != nil,
                  !headBranch.hasPrefix("-") else { return nil }
            return "git clone --single-branch --branch \(headBranch) https://bitbucket.org/\(headRepository).git t3code-pr-\(number)"
        default: return nil
        }
    }
}
