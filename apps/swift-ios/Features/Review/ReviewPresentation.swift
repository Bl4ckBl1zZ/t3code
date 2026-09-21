import Foundation

// Copy for the review list rows and the comment composer. Kept apart from the
// views so the wording is pinned by tests rather than read off a screen.

extension FeatureReviewChangeKind {
    /// The one-letter status column, as git and the web client show it.
    var statusLetter: String {
        switch self {
        case .added: "A"
        case .modified: "M"
        case .deleted: "D"
        case .renamed: "R"
        case .binary: "B"
        }
    }

    /// What VoiceOver reads instead of the letter.
    var accessibilityName: String {
        switch self {
        case .added: "Added"
        case .modified: "Modified"
        case .deleted: "Deleted"
        case .renamed: "Renamed"
        case .binary: "Binary"
        }
    }
}

extension FeatureReviewFile {
    var fileName: String {
        path.split(separator: "/").last.map(String.init) ?? path
    }

    var directory: String {
        path.split(separator: "/").dropLast().joined(separator: "/")
    }

    /// The row's second line: the folder, then where a rename came from and
    /// whether the file is binary. A rename within one folder names only the
    /// old file; a move names the old path.
    var reviewDetail: String {
        var parts: [String] = []
        if !directory.isEmpty { parts.append(directory) }
        if let previousPath, previousPath != path {
            let previous = FeatureReviewFile(path: previousPath, change: change, additions: 0, deletions: 0)
            parts.append("from \(previous.directory == directory ? previous.fileName : previousPath)")
        }
        if change == .binary { parts.append("Binary") }
        return parts.joined(separator: " · ")
    }
}

extension FeatureReviewLineSelection {
    /// The composer chip: new-side lines are just "Line 41", since that is the
    /// file the reader is editing; old-side lines say so.
    static func chipTitle(for selection: Self?) -> String {
        guard let selection else { return "Whole file" }
        switch selection.side {
        case .new: return "Line \(selection.line)"
        case .old: return "Old line \(selection.line)"
        }
    }
}
