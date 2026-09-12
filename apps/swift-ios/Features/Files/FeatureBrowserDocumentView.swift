import SwiftUI
import WebKit

/// A streaming document preview with ephemeral web storage and no app scripting bridge.
struct FeatureBrowserDocumentView: View {
    let url: URL
    var refreshURL: (() async throws -> URL)? = nil
    @State private var retryGeneration = UUID()
    @State private var refreshedURL: URL?
    @State private var loading = true
    @State private var failure: String?
    @State private var attempt = 0
    var body: some View {
        ZStack {
            DocumentWebView(url: refreshedURL ?? url, loading: $loading, failure: $failure).id(attempt)
            if let failure {
                ContentUnavailableView {
                    Label("Preview unavailable", systemImage: "doc.badge.ellipsis")
                } description: { Text(failure) } actions: {
                    Button("Reload") {
                        let generation = UUID()
                        retryGeneration = generation
                        Task {
                            self.failure = nil; loading = true
                            do {
                                let nextURL = try await refreshURL?()
                                guard !Task.isCancelled, retryGeneration == generation else { return }
                                refreshedURL = nextURL
                                attempt += 1
                            } catch {
                                guard !Task.isCancelled, retryGeneration == generation else { return }
                                self.failure = error.localizedDescription; loading = false
                            }
                        }
                    }
                }.background(T3Colors.background)
            } else if loading { ProgressView("Loading document…") }
        }
        .onChange(of: url) {
            retryGeneration = UUID()
            refreshedURL = nil
            failure = nil
            loading = true
        }
    }
}

private struct DocumentWebView: UIViewRepresentable {
    let url: URL
    @Binding var loading: Bool
    @Binding var failure: String?
    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = context.coordinator
        view.isOpaque = false
        view.backgroundColor = .systemBackground
        view.allowsBackForwardNavigationGestures = false
        view.load(URLRequest(url: url))
        return view
    }
    func updateUIView(_ view: WKWebView, context: Context) {
        if context.coordinator.url != url {
            context.coordinator.url = url
            view.load(URLRequest(url: url))
        }
    }
    static func dismantleUIView(_ view: WKWebView, coordinator: Coordinator) { view.stopLoading() }
    func makeCoordinator() -> Coordinator { Coordinator(url: url, loading: $loading, failure: $failure) }
    final class Coordinator: NSObject, WKNavigationDelegate {
        var url: URL
        let loading: Binding<Bool>
        let failure: Binding<String?>
        init(url: URL, loading: Binding<Bool>, failure: Binding<String?>) {
            self.url = url; self.loading = loading; self.failure = failure
        }
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { loading.wrappedValue = false }
        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { failed(error) }
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { failed(error) }
        private func failed(_ error: Error) {
            guard (error as NSError).code != NSURLErrorCancelled else { return }
            loading.wrappedValue = false; failure.wrappedValue = error.localizedDescription
        }
        func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
            if navigationResponse.isForMainFrame, let response = navigationResponse.response as? HTTPURLResponse, !(200...299).contains(response.statusCode) {
                loading.wrappedValue = false
                failure.wrappedValue = "The file server returned HTTP \(response.statusCode). Reload to try again."
                decisionHandler(.cancel)
            } else { decisionHandler(.allow) }
        }
    }
}

struct FeatureDocumentAttachmentPreview: View {
    @SwiftUI.Environment(\.dismiss) private var dismiss
    let attachment: FeatureMessageAttachment
    let resolve: @MainActor (FeatureMessageAttachment) async throws -> URL
    @State private var url: URL?
    @State private var error: String?
    @State private var attempt = 0

    var body: some View {
        NavigationStack {
            Group {
                if let url { FeatureBrowserDocumentView(url: url, refreshURL: { try await resolve(attachment) }) }
                else if let error {
                    ContentUnavailableView {
                        Label("Document unavailable", systemImage: "doc.badge.ellipsis")
                    } description: { Text(error) } actions: {
                        Button("Retry") { attempt += 1 }
                        if let download = attachment.url { Link("Download file", destination: download) }
                    }
                } else { ProgressView("Opening document…").frame(maxWidth: .infinity, maxHeight: .infinity) }
            }
            .background(T3Colors.background).navigationTitle(attachment.name)
            .navigationBarTitleDisplayMode(.inline).t3NavigationChrome()
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } } }
        }
        .task(id: attempt) {
            error = nil
            do {
                let resolved = try await resolve(attachment)
                guard !Task.isCancelled else { return }
                url = resolved
            } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
        }
    }
}
