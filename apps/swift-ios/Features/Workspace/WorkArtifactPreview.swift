import SwiftUI
import UIKit

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

    private var remoteURL: URL? {
        guard let url = URL(string: artifact.value), ["http", "https"].contains(url.scheme?.lowercased() ?? "") else { return nil }
        return url
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text(artifact.label).font(.headline)
                Button("Open \(artifact.sessionTitle)", action: openConversation)
                if let remoteURL {
                    if artifact.kind == "image" {
                        AsyncImage(url: remoteURL) { phase in
                            if let image = phase.image { image.resizable().scaledToFit() }
                            else if phase.error != nil { Text("Image preview unavailable") }
                            else { ProgressView() }
                        }
                    }
                    Link("Open output", destination: remoteURL)
                    ShareLink(item: remoteURL)
                } else {
                    if let image { Image(uiImage: image).resizable().scaledToFit() }
                    if let preview { Text(preview).textSelection(.enabled) }
                    if let fileURL { ShareLink("Save or share file", item: fileURL) }
                    if loading { ProgressView("Loading output…") }
                    if let failure { Text(failure).foregroundStyle(.red); Button("Retry") { Task { await load() } } }
                }
            }.padding()
        }
        .navigationTitle("Generated output")
        .task { if remoteURL == nil { await load() } }
        .onDisappear {
            if let fileURL { try? FileManager.default.removeItem(at: fileURL.deletingLastPathComponent()) }
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
