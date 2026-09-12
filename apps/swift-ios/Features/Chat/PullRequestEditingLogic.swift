import Foundation

enum PullRequestEditingLogic {
    static func sameLogin(_ one: String?, _ other: String?) -> Bool {
        guard let one, let other else { return false }
        let left = one.trimmingCharacters(in: .whitespacesAndNewlines)
        return !left.isEmpty && left.caseInsensitiveCompare(other.trimmingCharacters(in: .whitespacesAndNewlines)) == .orderedSame
    }
    static func canEditChangeRequest(_ detail: PullRequestDetail) -> Bool {
        detail.capabilities?.edit?.changeRequest == true && (sameLogin(detail.viewer, detail.author?.login) || detail.viewerPermissions?.actions.contains("merge") == true)
    }
    static func canEditComment(detail: PullRequestDetail, author: PullRequestActor?, kind: String) -> Bool {
        detail.capabilities?.edit?.comment == true && ["issue-comment", "review-comment"].contains(kind) && sameLogin(detail.viewer, author?.login)
    }
}

enum PullRequestTextEdit: Identifiable {
    case title(String), description(String), comment(id: String, kind: String, body: String), newComment
    var id: String {
        switch self { case .title: "title"; case .description: "description"; case let .comment(id, _, _): "comment:\(id)"; case .newComment: "new-comment" }
    }
    var label: String {
        switch self { case .title: "Edit title"; case .description: "Edit description"; case .comment: "Edit comment"; case .newComment: "Add comment" }
    }
    var text: String {
        switch self { case let .title(text), let .description(text): text; case let .comment(_, _, body): body; case .newComment: "" }
    }
    func valid(_ text: String) -> Bool {
        switch self {
        case .title: !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && text.utf16.count <= 1024
        case .description: text.utf16.count <= 65_536
        case .comment, .newComment: PullRequestReviewDraftModel.validBody(text)
        }
    }
}
