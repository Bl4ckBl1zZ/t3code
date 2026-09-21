import QuickLook
import SwiftUI
import UIKit

/// A generated output, full bleed: an image, the text itself, or Quick Look
/// for any other file. Sharing lives in the toolbar; the conversation that
/// made it is one tap away at the bottom.
struct WorkArtifactPreview: View {
    let manager: any FeatureWorkManaging
    let environmentID: String
    let connectionID: String
    let profile: String
    let artifact: HermesWorkArtifact
    let openConversation: () -> Void
    @State private var image: UIImage?
    @State private var fileURL: URL?
    @State private var preview: String?
    @State private var failure: String?
    @State private var loading = false
    @State private var quickLookURL: URL?

    private var remoteURL: URL? {
        guard let url = URL(string: artifact.value), ["http", "https"].contains(url.scheme?.lowercased() ?? "") else { return nil }
        return url
    }

    var body: some View {
        content
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(T3Colors.background)
            .navigationTitle(artifact.label)
            .navigationBarTitleDisplayMode(.inline)
            .outputSubtitle(artifact.sessionTitle)
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    if let url = remoteURL ?? fileURL {
                        ShareLink(item: url)
                    }
                }
                ToolbarItem(placement: .bottomBar) {
                    Button("Open Conversation", systemImage: "bubble.left.and.bubble.right", action: openConversation)
                }
            }
            .t3NavigationChrome()
            .quickLookPreview($quickLookURL)
            .task { if remoteURL == nil { await load() } }
            .onDisappear {
                if let fileURL { try? FileManager.default.removeItem(at: fileURL.deletingLastPathComponent()) }
            }
    }

    @ViewBuilder
    private var content: some View {
        if let remoteURL {
            if artifact.kind == "image" {
                AsyncImage(url: remoteURL) { phase in
                    if let image = phase.image {
                        ScrollView([.horizontal, .vertical]) {
                            image.resizable().scaledToFit()
                        }
                    } else if phase.error != nil {
                        ContentUnavailableView(
                            "Image Unavailable",
                            systemImage: "photo",
                            description: Text("The image couldn't be loaded. Share the link to open it elsewhere.")
                        )
                    } else {
                        ProgressView()
                    }
                }
            } else {
                ContentUnavailableView {
                    Label("Link", systemImage: "link")
                } description: {
                    Text(remoteURL.absoluteString)
                } actions: {
                    Link("Open Link", destination: remoteURL)
                        .t3SecondaryButtonStyle()
                }
            }
        } else if let failure {
            ContentUnavailableView {
                Label("Couldn't Load Output", systemImage: "exclamationmark.triangle")
            } description: {
                Text(failure)
            } actions: {
                Button("Retry") { Task { await load() } }
                    .t3SecondaryButtonStyle()
            }
        } else if let image {
            ScrollView([.horizontal, .vertical]) {
                Image(uiImage: image).resizable().scaledToFit()
            }
        } else if let preview {
            ScrollView {
                Text(preview)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding()
            }
        } else if let fileURL {
            ContentUnavailableView {
                Label(fileURL.lastPathComponent, systemImage: "doc")
            } description: {
                Text("This file has no inline preview.")
            } actions: {
                Button("Quick Look") { quickLookURL = fileURL }
                    .t3SecondaryButtonStyle()
            }
        } else if loading {
            ProgressView("Loading Output…")
        }
    }

    private func load() async {
        loading = true; failure = nil
        defer { loading = false }
        do {
            let value: String
            if artifact.value.hasPrefix("data:") { value = artifact.value }
            else {
                let response = try await manager.workQuery(environmentID: environmentID, input: .object([
                    "providerInstanceId": .string(connectionID), "profile": .string(profile), "section": .string("artifact"),
                    "id": .string(artifact.sessionId), "path": .string(artifact.value)
                ]))
                guard let content = response.content else { throw FeatureCapabilityUnavailable("This output") }
                value = content
            }
            guard let comma = value.firstIndex(of: ","), value[..<comma].contains(";base64"),
                  let bytes = Data(base64Encoded: String(value[value.index(after: comma)...])) else {
                throw FeatureCapabilityUnavailable("This output format")
            }
            image = UIImage(data: bytes)
            if image == nil, let text = String(data: bytes, encoding: .utf8) { preview = String(text.prefix(100_000)) }
            let directory = FileManager.default.temporaryDirectory.appendingPathComponent("t3-work-output-\(UUID().uuidString)", isDirectory: true)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let name = URL(fileURLWithPath: artifact.label).lastPathComponent
            let target = directory.appendingPathComponent(name.isEmpty ? "output" : name)
            try bytes.write(to: target, options: .atomic)
            fileURL = target
        } catch { failure = error.localizedDescription }
    }
}

private extension View {
    /// The conversation that made the output, under its name on iOS 26.
    @ViewBuilder
    func outputSubtitle(_ subtitle: String) -> some View {
        if #available(iOS 26, *) {
            navigationSubtitle(subtitle)
        } else {
            self
        }
    }
}
