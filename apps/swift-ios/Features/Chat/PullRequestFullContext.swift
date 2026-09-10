import Foundation

/// File sides always come from the host PR/commit comparison, never review.getDiffFileContents.
enum PullRequestFullContext {
    static func input(file: FeatureReviewFile, commit: String?) -> PullRequestDiffFileInput? {
        let change: String
        switch file.change {
        case .added: change = "new"
        case .deleted: change = "deleted"
        case .renamed: change = file.additions == 0 && file.deletions == 0 ? "rename-pure" : "rename-changed"
        case .modified: change = "change"
        case .binary: return nil
        }
        return .init(changeType: change, oldPath: file.previousPath ?? file.path, newPath: file.path, commit: commit)
    }

    static func positionKey(_ line: FeatureDiffLine) -> String {
        "\(line.kind.rawValue):\(line.oldLine ?? 0):\(line.newLine ?? 0)"
    }

    static func matchesPatch(file: FeatureReviewFile, contents: PullRequestDiffFileContents) -> Bool {
        let old = contents.oldContents.split(separator: "\n", omittingEmptySubsequences: false)
        let new = contents.newContents.split(separator: "\n", omittingEmptySubsequences: false)
        return file.lines.allSatisfy { line in
            if let number = line.oldLine, number > 0 {
                guard old.indices.contains(number - 1), old[number - 1] == line.text else { return false }
            }
            if let number = line.newLine, number > 0 {
                guard new.indices.contains(number - 1), new[number - 1] == line.text else { return false }
            }
            return true
        }
    }

    static func lines(file: FeatureReviewFile, contents: PullRequestDiffFileContents) -> [FeatureDiffLine]? {
        // Without hunks, the old/new snapshots do not tell the hydrator which lines
        // changed. Render explicitly labelled file versions instead of inventing a diff.
        if file.lines.isEmpty && (file.change == .modified || (file.change == .renamed && (file.additions > 0 || file.deletions > 0))) { return nil }
        return FeatureFullDiffHydrator.lines(for: file, contents: .init(oldContents: contents.oldContents, newContents: contents.newContents))
    }
}
