import Foundation

enum NativeWorkspaceMapper {
    static func files(
        _ entries: [ProjectEntry],
        directory: String?
    ) -> [FeatureFileEntry] {
        let directory = normalize(directory ?? "")
        let prefix = directory.isEmpty ? "" : "\(directory)/"
        var children: [String: FeatureFileEntry] = [:]

        for entry in entries {
            let fullPath = normalize(entry.path)
            guard fullPath.hasPrefix(prefix) else { continue }
            let remainder = String(fullPath.dropFirst(prefix.count))
            guard !remainder.isEmpty else { continue }

            let component = remainder.split(separator: "/", maxSplits: 1).first.map(String.init)!
            let childPath = prefix + component
            let isNested = remainder.contains("/")
            let kind: FeatureFileKind = isNested || entry.kind == .directory
                ? .directory
                : .file
            if children[childPath]?.kind == .directory {
                continue
            }
            children[childPath] = FeatureFileEntry(
                path: childPath,
                name: component,
                kind: kind,
                isHidden: component.hasPrefix(".")
            )
        }

        return Array(children.values).featureFiltered(by: "", includesHidden: true)
    }

    static func language(for path: String) -> String? {
        switch URL(fileURLWithPath: path).pathExtension.lowercased() {
        case "swift": "swift"
        case "ts", "tsx": "typescript"
        case "js", "jsx", "mjs", "cjs": "javascript"
        case "json": "json"
        case "md", "mdx": "markdown"
        case "css", "scss": "css"
        case "html", "htm": "html"
        case "xml", "svg": "xml"
        case "sh", "zsh", "bash": "shell"
        case "py": "python"
        case "rs": "rust"
        case "go": "go"
        case "rb": "ruby"
        case "sql": "sql"
        case "toml": "toml"
        case "yml", "yaml": "yaml"
        default: nil
        }
    }

    static func review(_ preview: ReviewDiffPreview) -> FeatureReview {
        FeatureReview(
            title: "Working tree",
            baseReference: preview.sources.compactMap(\.baseRef).first,
            files: preview.sources.flatMap(NativeUnifiedDiffMapper.parseDiff),
            isTruncated: preview.sources.contains(where: \.truncated)
        )
    }

    /// Lossless read of `VcsStatusResult` into the feature-layer status.
    ///
    /// Everything the wire carries is carried through. The flags in particular:
    /// `hasWorkingTreeChanges`, `hasUpstream`, `isDefaultRef` and
    /// `hasPrimaryRemote` used to be dropped here, which is why the thread
    /// details sheet had to reconstruct them — and why its `isDefaultRef` guess
    /// (always false) meant the "you are committing to the default branch"
    /// confirmation could never fire.
    ///
    /// One thing stays unset because the contract does not report it, not
    /// because the mapping is lossy: `upstream`. `VcsStatusResult` reports
    /// `hasUpstream` but not the upstream ref name — the driver resolves
    /// `branch.upstream` internally and drops it before the boundary
    /// (GitVcsDriverCore's `statusDetails`), so there is nothing to map.
    ///
    /// Per-file state and staged-ness *are* reported now. They come from git's
    /// porcelain XY codes, which the server used to parse only to decide *that*
    /// a path changed. They are not derivable from the line counts next to them:
    /// the numstat is `git diff HEAD`, which folds index and working tree into
    /// one entry per path, so an added file and an addition-only edit are the
    /// same `n/0`, and a 0/0 entry is an untracked file or a binary one.
    static func sourceControl(_ status: VCSStatus) -> FeatureSourceControlStatus {
        FeatureSourceControlStatus(
            isRepository: status.isRepo,
            branch: status.refName,
            hasUpstream: status.hasUpstream,
            isDefaultRef: status.isDefaultRef,
            hasPrimaryRemote: status.hasPrimaryRemote,
            aheadCount: status.aheadCount,
            behindCount: status.behindCount,
            hasWorkingTreeChanges: status.hasWorkingTreeChanges,
            insertions: status.workingTree.insertions,
            deletions: status.workingTree.deletions,
            files: status.workingTree.files.map(sourceControlFile),
            pullRequest: status.pr.map(pullRequest)
        )
    }

    static func pullRequest(_ changeRequest: VCSChangeRequest) -> FeaturePullRequest {
        FeaturePullRequest(
            number: changeRequest.number,
            title: changeRequest.title,
            state: changeRequest.state,
            url: URL(string: changeRequest.url),
            updatedAt: changeRequest.updatedAt.flatMap(isoDate)
        )
    }

    /// The linked-pull-request path reads `pullRequests.detail` rather than the
    /// workspace's VCS status, so the same row shape is built from the richer
    /// payload. Only the fields a row shows are carried across; the rest is what
    /// the detail sheet opens for.
    static func pullRequest(_ detail: PullRequestDetail) -> FeaturePullRequest {
        FeaturePullRequest(
            number: detail.number,
            title: detail.title,
            state: detail.state.rawValue,
            url: URL(string: detail.url),
            updatedAt: isoDate(detail.updatedAt)
        )
    }

    /// Servers stamp with and without fractional seconds depending on the
    /// provider, so both spellings are tried before giving up. An unparseable
    /// stamp reads as absent, which the settle rules treat as "server does not
    /// report it" — the same always-settle fallback web takes.
    static func isoDate(_ value: String) -> Date? {
        fractionalISO8601.date(from: value) ?? plainISO8601.date(from: value)
    }

    private static let fractionalISO8601: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private static let plainISO8601 = ISO8601DateFormatter()

    /// One changed path, with the porcelain code the server now carries.
    ///
    /// A file from a server that predates the per-file status fields has no
    /// `changeKind` at all. `.modified` is the fallback for that case only — it
    /// is what the whole list used to be, and it is the least wrong label for
    /// "git says this path changed and will not say how".
    static func sourceControlFile(_ file: VCSWorkingTreeFile) -> FeatureSourceControlFile {
        FeatureSourceControlFile(
            path: file.path,
            state: sourceControlFileState(file.changeKind),
            // Staged-ness is the presence of an index-side change, which is
            // exactly what porcelain's first XY column reports.
            isStaged: file.stagedChangeKind != nil,
            insertions: file.insertions,
            deletions: file.deletions,
            hasUnstagedChanges: file.unstagedChangeKind != nil,
            previousPath: file.originalPath
        )
    }

    private static func sourceControlFileState(
        _ kind: VCSWorkingTreeFileChangeKind?
    ) -> FeatureSourceControlFileState {
        switch kind {
        case .added: .added
        case .modified: .modified
        case .deleted: .deleted
        case .renamed: .renamed
        // A copy puts a new file at this path; nothing downstream draws copies
        // apart from additions, and the source is carried as `previousPath`.
        case .copied: .added
        case .untracked: .untracked
        case .conflicted: .conflicted
        case nil: .modified
        }
    }

    static func gitAction(_ action: FeatureSourceControlAction) -> GitStackedAction {
        switch action {
        case .commit: .commit
        case .push: .push
        case .createPullRequest: .createPullRequest
        case .commitAndPush: .commitAndPush
        case .commitPushAndCreatePullRequest: .commitPushAndPullRequest
        case .pull:
            // Pull has a dedicated VCS endpoint and never reaches this mapping.
            .push
        }
    }

    static func terminal(_ snapshot: TerminalSessionSnapshot) -> FeatureTerminalSnapshot {
        FeatureTerminalSnapshot(
            threadID: snapshot.threadId,
            terminalID: snapshot.terminalId,
            state: terminalState(snapshot.status),
            title: snapshot.label,
            workingDirectory: snapshot.cwd,
            buffer: snapshot.history,
            exitCode: snapshot.exitCode,
            updatedAt: snapshot.updatedAt
        )
    }

    static func terminal(_ summary: TerminalSummary) -> FeatureTerminalSnapshot {
        FeatureTerminalSnapshot(
            threadID: summary.threadId,
            terminalID: summary.terminalId,
            state: terminalState(summary.status),
            title: summary.label,
            workingDirectory: summary.cwd,
            exitCode: summary.exitCode,
            hasRunningSubprocess: summary.hasRunningSubprocess,
            updatedAt: summary.updatedAt
        )
    }

    private static func terminalState(_ status: TerminalSessionStatus) -> FeatureTerminalState {
        switch status {
        case .starting: .starting
        case .running: .running
        case .exited: .exited
        case .error: .failed
        }
    }

    private static func normalize(_ path: String) -> String {
        path.replacingOccurrences(of: "\\", with: "/")
            .split(separator: "/", omittingEmptySubsequences: true)
            .joined(separator: "/")
    }

}
