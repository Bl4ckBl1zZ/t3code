import SwiftUI

@MainActor
public protocol FeatureNativeAppIconResolving: AnyObject {
    func nativeAppIconURL(environmentID: String, app: ToolActivityNativeAppReference) async throws -> URL?
}

@MainActor
final class NativeAppToolIconStore {
    private struct Entry { let url: URL?; let expires: Date }
    private var entries: [String: Entry] = [:]
    private var pending: [String: Task<URL?, Never>] = [:]

    func resolve(environmentID: String, app: ToolActivityNativeAppReference, client: any FeatureNativeAppIconResolving) async -> URL? {
        let key = environmentID + "|" + app._tag + "|" + (app.appId ?? app.displayName ?? "")
        if let cached = entries[key], cached.expires > Date() { return cached.url }
        if let task = pending[key] { return await task.value }
        let task = Task { @MainActor in try? await client.nativeAppIconURL(environmentID: environmentID, app: app) }
        pending[key] = task
        let url = await task.value
        pending.removeValue(forKey: key)
        if entries.count >= 128, let oldest = entries.min(by: { $0.value.expires < $1.value.expires })?.key { entries.removeValue(forKey: oldest) }
        entries[key] = Entry(url: url, expires: Date().addingTimeInterval(url == nil ? 30 : 300))
        return url
    }
}

struct NativeAppToolIconContext {
    let environmentID: String
    let store: NativeAppToolIconStore
    let client: any FeatureNativeAppIconResolving
}

private struct NativeAppToolIconContextKey: EnvironmentKey {
    static let defaultValue: NativeAppToolIconContext? = nil
}

extension EnvironmentValues {
    var nativeAppToolIconContext: NativeAppToolIconContext? {
        get { self[NativeAppToolIconContextKey.self] }
        set { self[NativeAppToolIconContextKey.self] = newValue }
    }
}

struct NativeAppToolIcon: View {
    let app: ToolActivityNativeAppReference
    let fallback: String
    @SwiftUI.Environment(\.nativeAppToolIconContext) private var context
    @State private var resolved: (key: String, url: URL?)?
    private var requestKey: String { (context?.environmentID ?? "") + "|" + app._tag + "|" + (app.appId ?? app.displayName ?? "") }
    var body: some View {
        Group {
            if resolved?.key == requestKey, let url = resolved?.url {
                AsyncImage(url: url) { phase in
                    if let image = phase.image { image.resizable().scaledToFit() }
                    else { Image(systemName: fallback) }
                }
            } else { Image(systemName: fallback) }
        }
        .frame(width: 16, height: 16)
        .accessibilityHidden(true)
        .task(id: requestKey) {
            guard let context else { return }
            let key = requestKey
            let url = await context.store.resolve(environmentID: context.environmentID, app: app, client: context.client)
            guard !Task.isCancelled else { return }
            resolved = (key, url)
        }
    }
}
