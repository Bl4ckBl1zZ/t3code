import Foundation

struct WorkspaceMutationItem: Sendable {
    let sourceThreadID: String
    let itemID: String
    let type: String
    let status: String
    let updatedAt: String
}

enum WorkspaceMutationRevision {
    /// Completed shell commands count too: they can change paths the provider did not report.
    static func latest<S: Sequence>(_ items: S) -> String? where S.Element == WorkspaceMutationItem {
        var latestAt = -Double.infinity
        var revision: String?
        for item in items {
            guard ["file_change", "command_execution"].contains(item.type),
                  ["completed", "failed", "cancelled", "interrupted"].contains(item.status),
                  let date = (try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(item.updatedAt))
                    ?? (try? Date.ISO8601FormatStyle().parse(item.updatedAt)) else { continue }
            let at = date.timeIntervalSince1970
            if at >= latestAt {
                latestAt = at
                revision = "\(item.sourceThreadID):\(item.itemID):\(at)"
            }
        }
        return revision
    }

    /// A changed signed asset must not reuse the previous image/document response.
    static func assetURL(_ url: URL, revision: String?) -> URL {
        guard let revision, var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return url }
        // Preserve the byte spelling of signed query values (notably %2B); rebuilding
        // queryItems can turn an escaped plus into a form-decoded space on the server.
        var items = (components.percentEncodedQuery ?? "").split(separator: "&").map(String.init).filter {
            $0.split(separator: "=", maxSplits: 1).first?.removingPercentEncoding != "workspace-revision"
        }
        let allowed = CharacterSet.urlQueryAllowed.subtracting(CharacterSet(charactersIn: "+&=?#"))
        guard let value = revision.addingPercentEncoding(withAllowedCharacters: allowed) else { return url }
        items.append("workspace-revision=" + value)
        components.percentEncodedQuery = items.joined(separator: "&")
        return components.url ?? url
    }
}
