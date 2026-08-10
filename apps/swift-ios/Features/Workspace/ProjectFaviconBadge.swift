import SwiftUI

// The mobile port of the desktop sidebar's repo icon (web
// `ProjectFavicon.tsx`): each project resolves its favicon through the signed
// asset route — `t3.json` `iconPath` first, then well-known favicon files in
// the workspace — and falls back to the letter badge when the repo has none.

/// One app-wide cache of resolved favicon URLs, keyed per project workspace.
/// App-wide because every thread row of the same project would otherwise
/// resolve the same URL, and the signed tokens are bucketed server-side so a
/// session-length cache stays valid.
@MainActor
@Observable
final class ProjectFaviconStore {
    static let shared = ProjectFaviconStore()

    /// `nil` value = resolved, repo has no icon. Missing key = not resolved.
    private(set) var urls: [String: URL?] = [:]

    @ObservationIgnored private var inFlight: Set<String> = []
    @ObservationIgnored private weak var resolver: (any FeatureProjectFaviconResolving)?

    /// Pointed at the session's client by the workspace view; a weak reference
    /// so the store never keeps a torn-down client alive.
    func attach(_ client: AnyObject) {
        resolver = client as? any FeatureProjectFaviconResolving
    }

    func url(environmentID: String?, workspaceRoot: String?, faviconPath: String? = nil) -> URL? {
        guard
            let key = key(
                environmentID: environmentID,
                workspaceRoot: workspaceRoot,
                faviconPath: faviconPath
            )
        else {
            return nil
        }
        return urls[key] ?? nil
    }

    func resolve(environmentID: String?, workspaceRoot: String?, faviconPath: String? = nil) {
        guard let environmentID,
              let workspaceRoot,
              let key = key(
                  environmentID: environmentID,
                  workspaceRoot: workspaceRoot,
                  faviconPath: faviconPath
              ),
              urls[key] == nil,
              !inFlight.contains(key),
              let resolver else {
            return
        }
        inFlight.insert(key)
        Task { @MainActor [weak self] in
            defer { self?.inFlight.remove(key) }
            do {
                // A `nil` answer is the server saying "no icon" — cached, so
                // the row settles on the letter badge instead of re-asking.
                let url = try await resolver.projectFaviconURL(
                    environmentID: environmentID,
                    cwd: workspaceRoot,
                    faviconPath: faviconPath
                )
                self?.urls[key] = url
            } catch {
                // A thrown resolution stays unrecorded so a later appearance
                // retries once the connection is back.
            }
        }
    }

    /// The manual icon path participates in the key so choosing a different
    /// icon on desktop invalidates rows that cached the previous answer.
    private func key(
        environmentID: String?,
        workspaceRoot: String?,
        faviconPath: String?
    ) -> String? {
        guard let environmentID, let workspaceRoot, !workspaceRoot.isEmpty else { return nil }
        return "\(environmentID)|\(workspaceRoot)|\(faviconPath ?? "")"
    }
}

/// The repo icon a thread row shows: the project's favicon when it has one,
/// the letter `ProjectBadge` otherwise (and while loading).
struct ProjectFaviconBadge<Fallback: View>: View {
    let environmentID: String?
    let workspaceRoot: String?
    var faviconPath: String?
    var size: CGFloat = 16
    @ViewBuilder let fallback: Fallback

    private let store = ProjectFaviconStore.shared

    var body: some View {
        Group {
            if let url = store.url(
                environmentID: environmentID,
                workspaceRoot: workspaceRoot,
                faviconPath: faviconPath
            ) {
                AsyncImage(url: url) { phase in
                    switch phase {
                    case let .success(image):
                        image
                            .resizable()
                            .scaledToFill()
                    default:
                        fallback
                    }
                }
                .frame(width: size, height: size)
                .clipShape(RoundedRectangle(cornerRadius: size * 0.25))
            } else {
                fallback
            }
        }
        .task(
            id: (environmentID ?? "") + "|" + (workspaceRoot ?? "") + "|" + (faviconPath ?? "")
        ) {
            store.resolve(
                environmentID: environmentID,
                workspaceRoot: workspaceRoot,
                faviconPath: faviconPath
            )
        }
        .accessibilityHidden(true)
    }
}
