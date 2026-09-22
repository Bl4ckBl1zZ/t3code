import ImageIO
import SwiftUI
import UIKit

private struct WorkspaceMutationRevisionKey: EnvironmentKey {
    static let defaultValue: String? = nil
}

extension EnvironmentValues {
    var workspaceMutationRevision: String? {
        get { self[WorkspaceMutationRevisionKey.self] }
        set { self[WorkspaceMutationRevisionKey.self] = newValue }
    }
}

private struct FileRefreshIdentity: Equatable {
    let threadID: String
    let path: String?
    let mutation: String?
    var document = false
    var attempt = 0
}

public struct FeatureFilesView: View {
    let client: any FeatureClient
    let threadID: String
    let workspaceMutationID: String?
    /// A workspace-relative file the browser should open straight away, handed
    /// over by a file link in the thread feed.
    let initialPath: String?
    /// The 1-based line inside that file to scroll to, when the link named one.
    let initialLine: Int?

    /// The pushed preview. Set from `initialPath`: a link that named a file
    /// should land on it, not on the tree root with the reader left to walk down
    /// to it.
    @State private var deepLinkedFile: FeatureFileEntry?
    /// Spent once. Popping back to the tree clears `deepLinkedFile`, and this
    /// view appearing again behind that pop must not push the same file straight
    /// back on top of it.
    @State private var didFollowDeepLink = false

    public init(
        client: any FeatureClient,
        threadID: String,
        initialPath: String? = nil,
        initialLine: Int? = nil,
        workspaceMutationID: String? = nil
    ) {
        self.client = client
        self.threadID = threadID
        self.workspaceMutationID = workspaceMutationID
        self.initialPath = initialPath
        self.initialLine = initialLine
    }

    /// Where the route a work-log file link built lands in this browser.
    ///
    /// The route models a URL — escaped segments, a line as a string — because
    /// that is what the React Native client navigates with. This client pushes
    /// the preview itself, so the segments rejoin and the line becomes a number
    /// again; a route with no segments names no file and opens the tree root.
    static func destination(for route: ThreadActivityFileRoute) -> (path: String?, line: Int?) {
        (
            path: route.absolutePath ?? (route.path.isEmpty ? nil : route.path.joined(separator: "/")),
            line: route.line.flatMap(Int.init)
        )
    }

    /// Workspace ancestors in root-to-parent order; the current file is excluded.
    static func containingDirectories(path: String) -> [FeatureFileEntry] {
        let parts = path.split(separator: "/").map(String.init)
        return [FeatureFileEntry(path: "", name: "Workspace", kind: .directory)] +
            parts.dropLast().indices.map { index in
                FeatureFileEntry(path: parts.prefix(index + 1).joined(separator: "/"),
                    name: parts[index], kind: .directory)
            }
    }

    public var body: some View {
        FeatureFileDirectoryView(client: client, threadID: threadID, path: nil, title: "Files")
            .background(T3Colors.background)
            .navigationDestination(item: $deepLinkedFile) { entry in
                FeatureFilePreviewView(
                    client: client,
                    threadID: threadID,
                    entry: entry,
                    focusedLine: initialLine
                )
            }
            .task {
                guard !didFollowDeepLink else { return }
                didFollowDeepLink = true
                deepLinkedFile = Self.deepLinkedEntry(path: initialPath)
            }
            .environment(\.workspaceMutationRevision, workspaceMutationID)
    }

    /// The entry a deep link opens, built from the path alone.
    ///
    /// Synthesized rather than looked up: the listing that would confirm it
    /// belongs to the directory the file sits in, which is exactly the walk the
    /// link exists to skip. A path with no segments — empty, or all separators —
    /// names no file and opens the tree root instead.
    static func deepLinkedEntry(path: String?) -> FeatureFileEntry? {
        guard let path else { return nil }
        let segments = FeatureFilePreviewPath.fileLinkSegments(path)
        guard let name = segments.last else { return nil }
        return FeatureFileEntry(
            path: FeatureFilePreviewPath.isAbsolute(path) ? path : segments.joined(separator: "/"),
            name: name,
            kind: .file
        )
    }
}

/// Where the search field looks: the folder on screen, or the whole workspace
/// through the server's recursive search.
private enum FileSearchScope: Hashable {
    case folder
    case workspace
}

private struct WorkspaceSearchKey: Equatable {
    let query: String
    let scope: FileSearchScope
    let includesHidden: Bool
}

private struct FeatureFileDirectoryView: View {
    @SwiftUI.Environment(\.workspaceMutationRevision) private var mutationRevision
    @State private var loadGeneration = UUID()
    @State private var reloadAttempt = 0
    let client: any FeatureClient
    let threadID: String
    let path: String?
    let title: String

    @State private var entries: [FeatureFileEntry] = []
    @State private var searchText = ""
    @State private var searchScope = FileSearchScope.folder
    @State private var workspaceResults: [FeatureFileEntry] = []
    @State private var isSearchingWorkspace = false
    @State private var workspaceSearchError: String?
    @AppStorage("t3.files.showHidden") private var includesHidden = false
    @State private var isLoading = true
    @State private var errorMessage: String?

    var body: some View {
        content
            .background(T3Colors.background)
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .t3Searchable(text: $searchText, prompt: Text(searchScope == .folder ? "Search \(title)" : "Search Workspace"))
            .searchScopes($searchScope) {
                Text("This Folder").tag(FileSearchScope.folder)
                Text("Workspace").tag(FileSearchScope.workspace)
            }
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Toggle(isOn: $includesHidden) {
                            Label("Show Hidden Files", systemImage: "eye")
                        }
                    } label: {
                        Label("File Browser Options", systemImage: "ellipsis")
                    }
                }
            }
            .t3NavigationChrome()
            .task(id: FileRefreshIdentity(threadID: threadID, path: path, mutation: mutationRevision, attempt: reloadAttempt)) { await load() }
            .task(id: WorkspaceSearchKey(query: trimmedQuery, scope: searchScope, includesHidden: includesHidden)) {
                await searchWorkspace()
            }
    }

    @ViewBuilder
    private var content: some View {
        if searchScope == .workspace, !trimmedQuery.isEmpty {
            workspaceSearchResults
        } else if isLoading, entries.isEmpty {
            ProgressView("Loading files…")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if let errorMessage, entries.isEmpty {
            ContentUnavailableView {
                Label("Couldn't Load Files", systemImage: "folder.badge.questionmark")
            } description: {
                Text(errorMessage)
            } actions: {
                Button("Try Again") { reloadAttempt += 1 }
                    .t3SecondaryButtonStyle()
            }
        } else if filteredEntries.isEmpty {
            emptyState
        } else {
            List {
                if let errorMessage {
                    Section {
                        T3ToolBanner(
                            tone: .warning,
                            title: "Couldn't Refresh",
                            message: errorMessage,
                            actionTitle: "Retry",
                            action: { reloadAttempt += 1 }
                        )
                        .listRowBackground(Color.clear)
                        .listRowSeparator(.hidden)
                        .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
                    }
                }
                Section {
                    ForEach(filteredEntries) { entry in
                        NavigationLink {
                            destination(for: entry)
                        } label: {
                            FeatureFileRow(entry: entry)
                        }
                        .listRowBackground(Color.clear)
                    }
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .animation(.default, value: filteredEntries.map(\.id))
            .refreshable { await load() }
        }
    }

    @ViewBuilder
    private var emptyState: some View {
        if !trimmedQuery.isEmpty {
            ContentUnavailableView {
                Label("No Results for “\(trimmedQuery)”", systemImage: "magnifyingglass")
            } description: {
                Text("Nothing in this folder matches.")
            } actions: {
                Button("Search Workspace") { searchScope = .workspace }
                    .t3SecondaryButtonStyle()
            }
        } else if !includesHidden, entries.contains(where: \.isHidden) {
            ContentUnavailableView {
                Label("Empty Folder", systemImage: "folder")
            } description: {
                Text("This folder only has hidden files.")
            } actions: {
                Button("Show Hidden Files") { includesHidden = true }
                    .t3SecondaryButtonStyle()
            }
        } else {
            ContentUnavailableView(
                "Empty Folder",
                systemImage: "folder",
                description: Text("This folder has no files.")
            )
        }
    }

    @ViewBuilder
    private var workspaceSearchResults: some View {
        let results = includesHidden ? workspaceResults : workspaceResults.filter { !$0.isHidden }
        if isSearchingWorkspace, results.isEmpty {
            ProgressView("Searching workspace…")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if let workspaceSearchError, results.isEmpty {
            ContentUnavailableView {
                Label("Couldn't Search", systemImage: "magnifyingglass")
            } description: {
                Text(workspaceSearchError)
            }
        } else if results.isEmpty {
            ContentUnavailableView.search(text: trimmedQuery)
        } else {
            List(results) { entry in
                NavigationLink {
                    destination(for: entry)
                } label: {
                    FeatureFileRow(entry: entry, showsLocation: true)
                }
                .listRowBackground(Color.clear)
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
        }
    }

    @ViewBuilder
    private func destination(for entry: FeatureFileEntry) -> some View {
        if entry.kind == .directory {
            FeatureFileDirectoryView(
                client: client,
                threadID: threadID,
                path: entry.path,
                title: entry.name
            )
        } else {
            FeatureFilePreviewView(client: client, threadID: threadID, entry: entry)
        }
    }

    private var trimmedQuery: String {
        searchText.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var filteredEntries: [FeatureFileEntry] {
        entries.featureFiltered(by: searchText, includesHidden: includesHidden)
    }

    private func load() async {
        let generation = UUID()
        loadGeneration = generation
        isLoading = true
        defer { if loadGeneration == generation { isLoading = false } }
        do {
            let loaded = try await client.listFiles(threadID: threadID, path: path)
            guard !Task.isCancelled, loadGeneration == generation else { return }
            entries = loaded
            errorMessage = nil
        } catch {
            guard !Task.isCancelled, loadGeneration == generation else { return }
            errorMessage = error.localizedDescription
        }
    }

    /// Recursive search across the workspace, debounced so each keystroke
    /// does not become a server call.
    private func searchWorkspace() async {
        let query = trimmedQuery
        guard searchScope == .workspace, !query.isEmpty else {
            workspaceResults = []
            workspaceSearchError = nil
            return
        }
        try? await Task.sleep(for: .milliseconds(250))
        guard !Task.isCancelled else { return }
        isSearchingWorkspace = true
        defer { isSearchingWorkspace = false }
        do {
            let results = try await client.searchThreadFiles(threadID: threadID, query: query, limit: 200)
            guard !Task.isCancelled else { return }
            workspaceResults = results
            workspaceSearchError = nil
        } catch {
            guard !Task.isCancelled else { return }
            workspaceResults = []
            workspaceSearchError = error.localizedDescription
        }
    }
}

private struct FeatureFileRow: View {
    let entry: FeatureFileEntry
    /// Search results come from anywhere in the workspace, so they say where.
    var showsLocation = false

    @SwiftUI.Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @ScaledMetric(relativeTo: .body) private var glyphWidth: CGFloat = 24

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: icon)
                .font(.body)
                .foregroundStyle(entry.kind == .directory ? T3Colors.accent : T3Colors.textSecondary)
                .frame(width: glyphWidth)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(entry.name)
                    .font(T3Typography.threadBody)
                    .foregroundStyle(T3Colors.textPrimary)
                    .lineLimit(dynamicTypeSize.isAccessibilitySize ? 2 : 1)
                    .truncationMode(.middle)
                if let detail {
                    Text(detail)
                        .font(.footnote)
                        .foregroundStyle(T3Colors.textSecondary)
                        .lineLimit(1)
                        .truncationMode(showsLocation ? .head : .tail)
                }
            }
        }
        .padding(.vertical, 2)
        .opacity(entry.isHidden ? 0.55 : 1)
        .accessibilityElement(children: .combine)
    }

    /// The folder for a search result; size and kind for a file.
    private var detail: String? {
        if showsLocation {
            let folder = (entry.path as NSString).deletingLastPathComponent
            return folder.isEmpty ? "Workspace" : folder
        }
        guard entry.kind == .file else { return nil }
        let size = entry.sizeBytes.map {
            ByteCountFormatter.string(fromByteCount: Int64($0), countStyle: .file)
        }
        let parts = [size, FeatureFileKindLabel.kind(forPath: entry.name)].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    private var icon: String {
        switch entry.kind {
        case .directory: "folder.fill"
        case .symbolicLink: "link"
        case .file:
            switch FeatureFilePreviewKind.infer(path: entry.path) {
            case .video: "film"
            case .browserDocument: "doc.richtext"
            case .quickLook: "doc.fill"
            case .image: "photo"
            case .markdown: "doc.richtext"
            case .source: entry.name.hasSuffix(".swift") ? "swift" : "chevron.left.forwardslash.chevron.right"
            case .plainText: "doc.text"
            }
        }
    }
}

private struct FeatureFilePreviewView: View {
    @SwiftUI.Environment(\.workspaceMutationRevision) private var mutationRevision
    @State private var loadGeneration = UUID()
    @State private var reloadAttempt = 0
    let client: any FeatureClient
    let threadID: String
    let entry: FeatureFileEntry
    /// The 1-based line a deep link pointed at, highlighted and scrolled to once
    /// the file has been read and highlighted.
    var focusedLine: Int?

    @State private var content: FeatureFileContent?
    @AppStorage("t3.files.renderHTML") private var renderHTML = true
    @State private var revealDismissed = false
    @State private var sourceLines: [FeatureSourceLine] = []
    @State private var image: UIImage?
    @State private var assetURL: URL?
    /// A local copy of the file: what Quick Look shows and what Share sends,
    /// so the recipient gets the file rather than an expiring link.
    @State private var downloadedFile: URL?
    /// Set when the file is not text and Quick Look cannot show it either.
    @State private var hasNoPreview = false
    @State private var errorMessage: String?
    @State private var isLoading = true
    /// A containing folder picked from the title menu.
    @State private var revealedDirectory: FeatureFileEntry?

    private var previewKind: FeatureFilePreviewKind {
        FeatureFilePreviewKind.infer(path: entry.path, language: content?.language)
    }

    private var isHTML: Bool { ["html", "htm"].contains(URL(fileURLWithPath: entry.path).pathExtension.lowercased()) }
    private var showDocument: Bool { previewKind == .browserDocument && (!isHTML || (renderHTML && (focusedLine == nil || revealDismissed))) }
    private var hasPreview: Bool {
        content != nil || image != nil || assetURL != nil || downloadedFile != nil || hasNoPreview
    }

    var body: some View {
        Group {
            if isLoading, !hasPreview {
                ProgressView("Loading file…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if hasNoPreview {
                FeatureFileNoPreviewView(name: entry.name, fileURL: downloadedFile, sizeBytes: entry.sizeBytes)
            } else if let downloadedFile, image == nil {
                FeatureQuickLookView(fileURL: downloadedFile)
                    .ignoresSafeArea(edges: .bottom)
            } else if let assetURL, previewKind == .video {
                FeatureInlineVideoView(url: assetURL, title: entry.name)
                    .frame(maxWidth: .infinity, maxHeight: .infinity).background(.black)
            } else if let assetURL, showDocument {
                FeatureBrowserDocumentView(url: assetURL, refreshURL: {
                    guard let resolver = client as? any FeatureWorkspaceAssetResolving else { throw FeatureCapabilityUnavailable("File previews") }
                    return WorkspaceMutationRevision.assetURL(try await resolver.workspaceAssetURL(threadID: threadID, path: entry.path), revision: mutationRevision)
                })
            } else if let image {
                FeatureZoomableImageView(image: image, name: entry.name)
                    .ignoresSafeArea(edges: .bottom)
            } else if let content {
                VStack(spacing: 0) {
                    if content.isTruncated {
                        T3ToolBanner(tone: .warning, title: partialPreviewText(content))
                            .padding(.horizontal, 12)
                            .padding(.vertical, 6)
                    }
                    switch previewKind {
                    case .markdown:
                        ScrollView {
                            MarkdownMessageView(content.text)
                                .environment(\.markdownMediaContext, MarkdownMediaContext(threadID: threadID, client: client, baseDirectory: FeatureFilePreviewPath.parent(entry.path)))
                                .frame(maxWidth: T3Metrics.readingWidth, alignment: .leading)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(.horizontal, 18)
                                .padding(.vertical, 16)
                        }
                    case .source, .plainText, .browserDocument, .quickLook:
                        FeatureSourceTextView(lines: sourceLines, focusedLine: focusedLine)
                    case .image, .video:
                        EmptyView()
                    }
                }
            } else {
                ContentUnavailableView {
                    Label("Couldn't Open \(entry.name)", systemImage: previewKind == .image ? "photo.badge.exclamationmark" : "doc.badge.ellipsis")
                } description: {
                    Text(errorMessage ?? "The file could not be read.")
                } actions: {
                    Button("Try Again") { reloadAttempt += 1 }
                        .t3SecondaryButtonStyle()
                }
            }
        }
        .background(T3Colors.background)
        .navigationTitle(entry.name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbarTitleMenu { folderMenu }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) { shareButton }
            ToolbarItem(placement: .topBarTrailing) { moreMenu }
        }
        .t3NavigationChrome()
        .navigationDestination(item: $revealedDirectory) { directory in
            FeatureFileDirectoryView(
                client: client,
                threadID: threadID,
                path: directory.path.isEmpty ? nil : directory.path,
                title: directory.name
            )
        }
        .safeAreaInset(edge: .top, spacing: 0) {
            if let errorMessage, hasPreview {
                T3ToolBanner(
                    tone: .warning,
                    title: "Couldn't Refresh",
                    message: "Showing the previous preview. \(errorMessage)",
                    actionTitle: "Retry",
                    action: { reloadAttempt += 1 }
                )
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
            }
        }
        .task(id: FileRefreshIdentity(threadID: threadID, path: entry.path, mutation: mutationRevision, document: showDocument, attempt: reloadAttempt)) { await load() }
        .onDisappear {
            if let downloadedFile { FeatureFileDownload.discard(downloadedFile) }
        }
    }

    /// The path back up, from the title: each containing folder opens in place.
    @ViewBuilder
    private var folderMenu: some View {
        if !FeatureFilePreviewPath.isAbsolute(entry.path) {
            Section("Show in Folder") {
                ForEach(FeatureFilesView.containingDirectories(path: entry.path).reversed()) { directory in
                    Button {
                        revealedDirectory = directory
                    } label: {
                        Label(directory.path.isEmpty ? "Workspace" : directory.name, systemImage: "folder")
                    }
                }
            }
            .accessibilityIdentifier("file-preview-folders")
        }
    }

    @ViewBuilder
    private var shareButton: some View {
        if let downloadedFile {
            ShareLink(item: downloadedFile) {
                Label("Share", systemImage: "square.and.arrow.up")
            }
        } else if let assetURL {
            ShareLink(item: assetURL) {
                Label("Share", systemImage: "square.and.arrow.up")
            }
        } else if let content {
            ShareLink(item: content.text) {
                Label("Share", systemImage: "square.and.arrow.up")
            }
        }
    }

    private var moreMenu: some View {
        Menu {
            if isHTML {
                Button(
                    showDocument ? "Show HTML Source" : "Show Rendered Page",
                    systemImage: showDocument ? "chevron.left.forwardslash.chevron.right" : "eye"
                ) {
                    renderHTML = !showDocument
                    revealDismissed = true
                }
            }
            if let image {
                Button("Save to Photos", systemImage: "square.and.arrow.down") {
                    UIImageWriteToSavedPhotosAlbum(image, nil, nil, nil)
                    T3HUD.show("Saved to Photos", systemImage: "photo")
                }
            }
            Button("Reload", systemImage: "arrow.clockwise") { reloadAttempt += 1 }
                .disabled(isLoading)
        } label: {
            Label("More", systemImage: "ellipsis")
        }
    }

    /// "Showing the first 1 MB of 3.4 MB."
    private func partialPreviewText(_ content: FeatureFileContent) -> String {
        let shown = ByteCountFormatter.string(fromByteCount: Int64(content.text.utf8.count), countStyle: .file)
        guard let total = content.totalBytes else { return "Showing the first \(shown) of this file." }
        return "Showing the first \(shown) of \(ByteCountFormatter.string(fromByteCount: Int64(total), countStyle: .file))."
    }

    private func resolvedAssetURL() async throws -> URL {
        guard let resolver = client as? any FeatureWorkspaceAssetResolving else {
            throw FeatureCapabilityUnavailable("File previews")
        }
        return try await resolver.workspaceAssetURL(threadID: threadID, path: entry.path)
    }

    /// Downloads the file for Quick Look, or for the no-preview tile's Share
    /// when Quick Look cannot show it.
    private func loadDownload(generation: UUID) async throws {
        let url = try await resolvedAssetURL()
        let file = try await FeatureFileDownload.download(from: url, name: entry.name)
        guard !Task.isCancelled, loadGeneration == generation else {
            FeatureFileDownload.discard(file)
            return
        }
        if let previous = downloadedFile { FeatureFileDownload.discard(previous) }
        downloadedFile = file
        hasNoPreview = !FeatureQuickLookView.canPreview(file)
        content = nil; image = nil; assetURL = nil; sourceLines = []
    }

    private func load() async {
        let generation = UUID()
        loadGeneration = generation
        isLoading = true
        defer { if loadGeneration == generation { isLoading = false } }
        do {
            if previewKind == .quickLook {
                try await loadDownload(generation: generation)
            } else if previewKind == .video || showDocument {
                let url = try await resolvedAssetURL()
                guard !Task.isCancelled, loadGeneration == generation else { return }
                assetURL = WorkspaceMutationRevision.assetURL(url, revision: mutationRevision); content = nil; image = nil; sourceLines = []
            } else if previewKind == .image {
                let resolvedURL = try await resolvedAssetURL()
                let request = URLRequest(url: resolvedURL, cachePolicy: .reloadIgnoringLocalCacheData)
                let (data, response) = try await URLSession.shared.data(for: request)
                if let response = response as? HTTPURLResponse,
                   !(200 ... 299).contains(response.statusCode) {
                    throw FeatureImagePreviewError.httpStatus(response.statusCode)
                }
                guard data.count <= 64 * 1_024 * 1_024 else {
                    throw FeatureImagePreviewError.tooLarge
                }
                let name = entry.name
                let decoded = await Task.detached(priority: .userInitiated) {
                    (
                        image: FeatureImageDecoder.downsample(data, maxPixelSize: 4_096),
                        file: try? FeatureFileDownload.write(data, name: name)
                    )
                }.value
                guard let decodedImage = decoded.image else {
                    if let file = decoded.file { FeatureFileDownload.discard(file) }
                    throw FeatureImagePreviewError.invalidImage
                }
                guard !Task.isCancelled, loadGeneration == generation else { return }
                if let previous = downloadedFile { FeatureFileDownload.discard(previous) }
                // The image itself is shared, not the signed link it came from.
                downloadedFile = decoded.file
                assetURL = nil
                image = decodedImage
                content = nil
                sourceLines = []
            } else {
                let loaded: FeatureFileContent
                do {
                    loaded = try await client.readFile(threadID: threadID, path: entry.path)
                } catch where Self.isBinaryReadError(error) {
                    // Not text after all: show it the way Files.app would.
                    try await loadDownload(generation: generation)
                    errorMessage = nil
                    return
                }
                let loadedKind = FeatureFilePreviewKind.infer(
                    path: entry.path,
                    language: loaded.language
                )
                let lines: [FeatureSourceLine]
                switch loadedKind {
                case .source, .browserDocument:
                    lines = await Task.detached(priority: .userInitiated) {
                        FeatureSourceHighlighter.lines(
                            text: loaded.text,
                            language: loaded.language
                        )
                    }.value
                case .plainText, .quickLook:
                    lines = await Task.detached(priority: .userInitiated) {
                        FeatureSourceHighlighter.lines(text: loaded.text, language: "plain")
                    }.value
                case .markdown:
                    _ = await MarkdownRenderCache.shared.document(
                        for: MarkdownContentRevision(loaded.text)
                    )
                    lines = []
                case .image, .video:
                    lines = []
                }
                guard !Task.isCancelled, loadGeneration == generation else { return }
                content = loaded
                sourceLines = lines
                image = nil
                assetURL = nil
            }
            errorMessage = nil
        } catch {
            guard !Task.isCancelled, loadGeneration == generation else { return }
            errorMessage = Self.readableError(error)
        }
    }

    /// The server refuses to read binary files as text, with a message that
    /// carries the absolute workspace path.
    private static func isBinaryReadError(_ error: Error) -> Bool {
        error.localizedDescription.localizedCaseInsensitiveContains("binary")
    }

    private static func readableError(_ error: Error) -> String {
        isBinaryReadError(error)
            ? "There's no preview for this kind of file."
            : error.localizedDescription
    }
}

private struct FeatureSourceTextView: View {
    let lines: [FeatureSourceLine]
    /// 1-based, as a reader and a tool call both count lines.
    var focusedLine: Int?

    /// One digit's width at the current text size; the gutter grows with the
    /// number of digits instead of clipping past line 9,999.
    @ScaledMetric(relativeTo: .callout) private var digitWidth: CGFloat = 9

    /// The identity of the focused row, which is the line's 0-based index.
    /// `nil` while the file is still loading, so the scroll waits for the lines
    /// rather than being spent on an empty stack.
    private var focusedLineID: Int? {
        guard let focusedLine, focusedLine > 0, !lines.isEmpty else { return nil }
        let id = focusedLine - 1
        return lines.contains { $0.id == id } ? id : nil
    }

    private var gutterWidth: CGFloat {
        let digits = max(2, String(lines.last?.number ?? 0).count)
        return digitWidth * CGFloat(digits) + 4
    }

    var body: some View {
        GeometryReader { proxy in
            ScrollViewReader { scroll in
                ScrollView([.horizontal, .vertical]) {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(lines) { line in
                            HStack(alignment: .top, spacing: 10) {
                                Text("\(line.number)")
                                    .foregroundStyle(.tertiary)
                                    .frame(width: gutterWidth, alignment: .trailing)
                                    .accessibilityHidden(true)
                                FeatureHighlightedSourceLine(line: line)
                            }
                            .font(T3Typography.code)
                            .fixedSize(horizontal: true, vertical: false)
                            .frame(
                                minWidth: proxy.size.width,
                                minHeight: 22,
                                alignment: .leading
                            )
                            .background(
                                line.id == focusedLineID
                                    ? T3Colors.accent.opacity(0.16)
                                    : Color.clear
                            )
                            .id(line.id)
                        }
                    }
                    .frame(minWidth: proxy.size.width, alignment: .leading)
                    .padding(.vertical, 10)
                    .padding(.trailing, 14)
                    .textSelection(.enabled)
                }
                // Keyed on the resolved row: the file is read asynchronously, so
                // the target only exists once the highlighter has run.
                .task(id: focusedLineID) {
                    guard let focusedLineID else { return }
                    // One turn of the run loop for the lazy stack to build the
                    // rows the proxy is about to look for.
                    await Task.yield()
                    guard !Task.isCancelled else { return }
                    scroll.scrollTo(focusedLineID, anchor: .center)
                }
            }
        }
        .background(T3Colors.background)
        .accessibilityLabel("Source file")
    }
}

private struct FeatureHighlightedSourceLine: View {
    let line: FeatureSourceLine

    var body: some View {
        renderedText
            .fixedSize(horizontal: true, vertical: false)
    }

    private var renderedText: Text {
        guard !line.spans.isEmpty else { return Text(" ") }
        return line.spans.reduce(Text("")) { output, span in
            output + Text(verbatim: span.text).foregroundColor(color(for: span.kind))
        }
    }

    private func color(for kind: FeatureSourceTokenKind) -> Color {
        switch kind {
        case .plain: T3Colors.textPrimary.opacity(0.92)
        case .comment: T3Colors.textTertiary
        case .keyword: T3Colors.syntaxKeyword
        case .literal: T3Colors.syntaxLiteral
        case .number: T3Colors.syntaxNumber
        case .property: T3Colors.syntaxProperty
        }
    }
}

private struct FeatureZoomableImageView: UIViewRepresentable {
    let image: UIImage
    /// Read by VoiceOver instead of a generic "image".
    let name: String

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeUIView(context: Context) -> UIScrollView {
        let scrollView = UIScrollView()
        scrollView.backgroundColor = T3Colors.uiBackground
        scrollView.delegate = context.coordinator
        scrollView.minimumZoomScale = 1
        scrollView.maximumZoomScale = 6
        scrollView.bouncesZoom = true
        scrollView.decelerationRate = .fast

        let imageView = context.coordinator.imageView
        imageView.translatesAutoresizingMaskIntoConstraints = false
        imageView.contentMode = .scaleAspectFit
        imageView.isAccessibilityElement = true
        imageView.accessibilityTraits = .image
        scrollView.addSubview(imageView)
        NSLayoutConstraint.activate([
            imageView.leadingAnchor.constraint(equalTo: scrollView.contentLayoutGuide.leadingAnchor),
            imageView.trailingAnchor.constraint(equalTo: scrollView.contentLayoutGuide.trailingAnchor),
            imageView.topAnchor.constraint(equalTo: scrollView.contentLayoutGuide.topAnchor),
            imageView.bottomAnchor.constraint(equalTo: scrollView.contentLayoutGuide.bottomAnchor),
            imageView.widthAnchor.constraint(equalTo: scrollView.frameLayoutGuide.widthAnchor),
            imageView.heightAnchor.constraint(equalTo: scrollView.frameLayoutGuide.heightAnchor),
        ])

        let doubleTap = UITapGestureRecognizer(
            target: context.coordinator,
            action: #selector(Coordinator.toggleZoom(_:))
        )
        doubleTap.numberOfTapsRequired = 2
        scrollView.addGestureRecognizer(doubleTap)
        context.coordinator.scrollView = scrollView
        return scrollView
    }

    func updateUIView(_ scrollView: UIScrollView, context: Context) {
        scrollView.backgroundColor = T3Colors.uiBackground
        context.coordinator.imageView.accessibilityLabel = name
        if context.coordinator.imageView.image !== image {
            context.coordinator.imageView.image = image
            scrollView.setZoomScale(scrollView.minimumZoomScale, animated: false)
        }
    }

    final class Coordinator: NSObject, UIScrollViewDelegate {
        let imageView = UIImageView()
        weak var scrollView: UIScrollView?

        func viewForZooming(in scrollView: UIScrollView) -> UIView? {
            imageView
        }

        /// Zooms in on the point that was tapped, the way Photos does, and back
        /// out on a second double tap.
        @objc func toggleZoom(_ recognizer: UITapGestureRecognizer) {
            guard let scrollView else { return }
            if scrollView.zoomScale > scrollView.minimumZoomScale {
                scrollView.setZoomScale(scrollView.minimumZoomScale, animated: true)
                return
            }
            let scale = min(2.5, scrollView.maximumZoomScale)
            let point = recognizer.location(in: imageView)
            let size = CGSize(
                width: scrollView.bounds.width / scale,
                height: scrollView.bounds.height / scale
            )
            let rect = CGRect(
                x: point.x - size.width / 2,
                y: point.y - size.height / 2,
                width: size.width,
                height: size.height
            )
            scrollView.zoom(to: rect, animated: true)
        }
    }
}

private enum FeatureImageDecoder {
    static func downsample(_ data: Data, maxPixelSize: CGFloat) -> UIImage? {
        let sourceOptions = [kCGImageSourceShouldCache: false] as CFDictionary
        guard let source = CGImageSourceCreateWithData(data as CFData, sourceOptions) else {
            return nil
        }
        let options = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixelSize,
        ] as CFDictionary
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options) else {
            return nil
        }
        return UIImage(cgImage: image)
    }
}

private enum FeatureImagePreviewError: LocalizedError {
    case httpStatus(Int)
    case invalidImage
    case tooLarge

    var errorDescription: String? {
        switch self {
        case let .httpStatus(status): "The image server returned HTTP \(status)."
        case .invalidImage: "The file is not a supported image."
        case .tooLarge: "The image is larger than the 64 MB preview limit."
        }
    }
}
