import ImageIO
import SwiftUI
import UIKit

public struct FeatureFilesView: View {
    let client: any FeatureClient
    let threadID: String
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
        initialLine: Int? = nil
    ) {
        self.client = client
        self.threadID = threadID
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
            path: route.path.isEmpty ? nil : route.path.joined(separator: "/"),
            line: route.line.flatMap(Int.init)
        )
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
    }

    /// The entry a deep link opens, built from the path alone.
    ///
    /// Synthesized rather than looked up: the listing that would confirm it
    /// belongs to the directory the file sits in, which is exactly the walk the
    /// link exists to skip. A path with no segments — empty, or all separators —
    /// names no file and opens the tree root instead.
    static func deepLinkedEntry(path: String?) -> FeatureFileEntry? {
        guard let path else { return nil }
        let segments = path.split(separator: "/").map(String.init)
        guard let name = segments.last else { return nil }
        return FeatureFileEntry(
            path: segments.joined(separator: "/"),
            name: name,
            kind: .file
        )
    }
}

private struct FeatureFileDirectoryView: View {
    let client: any FeatureClient
    let threadID: String
    let path: String?
    let title: String

    @State private var entries: [FeatureFileEntry] = []
    @State private var searchText = ""
    @State private var includesHidden = false
    @State private var isLoading = true
    @State private var errorMessage: String?

    var body: some View {
        Group {
            if isLoading, entries.isEmpty {
                ProgressView("Loading files…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let errorMessage, entries.isEmpty {
                ContentUnavailableView(
                    "Files unavailable",
                    systemImage: "folder.badge.questionmark",
                    description: Text(errorMessage)
                )
            } else if filteredEntries.isEmpty {
                ContentUnavailableView(
                    searchText.isEmpty ? "Empty folder" : "No matches",
                    systemImage: "folder",
                    description: Text(searchText.isEmpty ? "This folder has no visible files." : "Try another search.")
                )
            } else {
                List(filteredEntries) { entry in
                    NavigationLink {
                        destination(for: entry)
                    } label: {
                        FeatureFileRow(entry: entry)
                    }
                }
                .listStyle(.plain)
                .scrollContentBackground(.hidden)
                .refreshable { await load() }
            }
        }
        .background(T3Colors.background)
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .searchable(text: $searchText, prompt: "Filter files")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Toggle("Show hidden files", isOn: $includesHidden)
                    Button {
                        Task { await load() }
                    } label: {
                        Label("Reload", systemImage: "arrow.clockwise")
                    }
                } label: {
                    Image(systemName: "ellipsis")
                }
                .accessibilityLabel("File browser options")
            }
        }
        .task(id: path) { await load() }
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

    private var filteredEntries: [FeatureFileEntry] {
        entries.featureFiltered(by: searchText, includesHidden: includesHidden)
    }

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            entries = try await client.listFiles(threadID: threadID, path: path)
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

private struct FeatureFileRow: View {
    let entry: FeatureFileEntry

    var body: some View {
        HStack(spacing: 11) {
            Image(systemName: icon)
                .font(.system(size: 15))
                .foregroundStyle(entry.kind == .directory ? .blue : .secondary)
                .frame(width: 20)
            Text(entry.name)
                .font(T3Typography.threadBody)
                .lineLimit(1)
            Spacer()
            if let size = entry.sizeBytes, entry.kind != .directory {
                Text(ByteCountFormatter.string(fromByteCount: Int64(size), countStyle: .file))
                    .font(T3Typography.tool.monospacedDigit())
                    .foregroundStyle(T3Colors.textSecondary)
            }
        }
        .padding(.vertical, 3)
        .accessibilityElement(children: .combine)
    }

    private var icon: String {
        switch entry.kind {
        case .directory: "folder.fill"
        case .symbolicLink: "link"
        case .file:
            switch FeatureFilePreviewKind.infer(path: entry.path) {
            case .image: "photo"
            case .markdown: "doc.richtext"
            case .source: entry.name.hasSuffix(".swift") ? "swift" : "chevron.left.forwardslash.chevron.right"
            case .plainText: "doc.text"
            }
        }
    }
}

private struct FeatureFilePreviewView: View {
    let client: any FeatureClient
    let threadID: String
    let entry: FeatureFileEntry
    /// The 1-based line a deep link pointed at, highlighted and scrolled to once
    /// the file has been read and highlighted.
    var focusedLine: Int?

    @State private var content: FeatureFileContent?
    @State private var sourceLines: [FeatureSourceLine] = []
    @State private var image: UIImage?
    @State private var assetURL: URL?
    @State private var errorMessage: String?
    @State private var isLoading = true

    private var previewKind: FeatureFilePreviewKind {
        FeatureFilePreviewKind.infer(path: entry.path, language: content?.language)
    }

    var body: some View {
        Group {
            if isLoading, content == nil, image == nil {
                ProgressView("Loading file…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let image {
                FeatureZoomableImageView(image: image)
                    .background(Color.black)
            } else if let content {
                VStack(spacing: 0) {
                    if content.isTruncated {
                        Label("Partial preview", systemImage: "exclamationmark.triangle")
                            .font(T3Typography.supportingStrong)
                            .foregroundStyle(.orange)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 12)
                            .padding(.vertical, 8)
                            .background(Color.orange.opacity(0.09))
                    }
                    switch previewKind {
                    case .markdown:
                        ScrollView {
                            MarkdownMessageView(content.text)
                                .frame(maxWidth: T3Metrics.readingWidth, alignment: .leading)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(.horizontal, 18)
                                .padding(.vertical, 16)
                        }
                        .scrollDismissesKeyboard(.interactively)
                    case .source, .plainText:
                        FeatureSourceTextView(lines: sourceLines, focusedLine: focusedLine)
                    case .image:
                        EmptyView()
                    }
                }
            } else {
                ContentUnavailableView(
                    previewKind == .image ? "Image unavailable" : "File unavailable",
                    systemImage: previewKind == .image ? "photo.badge.exclamationmark" : "doc.badge.ellipsis",
                    description: Text(errorMessage ?? "The file could not be read.")
                )
            }
        }
        .background(T3Colors.background)
        .navigationTitle(entry.name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if let assetURL {
                ToolbarItem(placement: .topBarTrailing) {
                    ShareLink(item: assetURL) {
                        Image(systemName: "square.and.arrow.up")
                    }
                    .accessibilityLabel("Share image")
                }
            } else if let content {
                ToolbarItem(placement: .topBarTrailing) {
                    ShareLink(item: content.text) {
                        Image(systemName: "square.and.arrow.up")
                    }
                    .accessibilityLabel("Share file contents")
                }
            }
        }
        .task { await load() }
    }

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            if previewKind == .image {
                guard let resolver = client as? any FeatureWorkspaceAssetResolving else {
                    throw FeatureCapabilityUnavailable("Signed image previews")
                }
                let resolvedURL = try await resolver.workspaceAssetURL(
                    threadID: threadID,
                    path: entry.path
                )
                let (data, response) = try await URLSession.shared.data(from: resolvedURL)
                if let response = response as? HTTPURLResponse,
                   !(200 ... 299).contains(response.statusCode) {
                    throw FeatureImagePreviewError.httpStatus(response.statusCode)
                }
                guard data.count <= 64 * 1_024 * 1_024 else {
                    throw FeatureImagePreviewError.tooLarge
                }
                guard let decoded = await Task.detached(priority: .userInitiated, operation: {
                    FeatureImageDecoder.downsample(data, maxPixelSize: 4_096)
                }).value else {
                    throw FeatureImagePreviewError.invalidImage
                }
                guard !Task.isCancelled else { return }
                assetURL = resolvedURL
                image = decoded
                content = nil
                sourceLines = []
            } else {
                let loaded = try await client.readFile(threadID: threadID, path: entry.path)
                let loadedKind = FeatureFilePreviewKind.infer(
                    path: entry.path,
                    language: loaded.language
                )
                let lines: [FeatureSourceLine]
                switch loadedKind {
                case .source:
                    lines = await Task.detached(priority: .userInitiated) {
                        FeatureSourceHighlighter.lines(
                            text: loaded.text,
                            language: loaded.language
                        )
                    }.value
                case .plainText:
                    lines = await Task.detached(priority: .userInitiated) {
                        FeatureSourceHighlighter.lines(text: loaded.text, language: "plain")
                    }.value
                case .markdown:
                    _ = await MarkdownRenderCache.shared.document(
                        for: MarkdownContentRevision(loaded.text)
                    )
                    lines = []
                case .image:
                    lines = []
                }
                guard !Task.isCancelled else { return }
                content = loaded
                sourceLines = lines
                image = nil
                assetURL = nil
            }
            errorMessage = nil
        } catch {
            guard !Task.isCancelled else { return }
            errorMessage = error.localizedDescription
        }
    }
}

private struct FeatureSourceTextView: View {
    let lines: [FeatureSourceLine]
    /// 1-based, as a reader and a tool call both count lines.
    var focusedLine: Int?

    /// The identity of the focused row, which is the line's 0-based index.
    /// `nil` while the file is still loading, so the scroll waits for the lines
    /// rather than being spent on an empty stack.
    private var focusedLineID: Int? {
        guard let focusedLine, focusedLine > 0, !lines.isEmpty else { return nil }
        let id = focusedLine - 1
        return lines.contains { $0.id == id } ? id : nil
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
                                    .frame(width: 44, alignment: .trailing)
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

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeUIView(context: Context) -> UIScrollView {
        let scrollView = UIScrollView()
        scrollView.backgroundColor = .black
        scrollView.delegate = context.coordinator
        scrollView.minimumZoomScale = 1
        scrollView.maximumZoomScale = 6
        scrollView.bouncesZoom = true
        scrollView.decelerationRate = .fast

        let imageView = context.coordinator.imageView
        imageView.translatesAutoresizingMaskIntoConstraints = false
        imageView.contentMode = .scaleAspectFit
        imageView.isAccessibilityElement = true
        imageView.accessibilityLabel = "Image preview"
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

        @objc func toggleZoom(_ recognizer: UITapGestureRecognizer) {
            guard let scrollView else { return }
            let scale = scrollView.zoomScale > scrollView.minimumZoomScale
                ? scrollView.minimumZoomScale
                : min(2.5, scrollView.maximumZoomScale)
            scrollView.setZoomScale(scale, animated: true)
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
