import UIKit

extension NativeFeatureClient {
    /// A memory warning ends the kept-alive thread stream; backgrounding ends
    /// it too and saves the shells and open thread the next launch paints from.
    func makeLifecycleObservers() -> [NSObjectProtocol] {
        let center = NotificationCenter.default
        return [
            center.addObserver(
                forName: UIApplication.didReceiveMemoryWarningNotification,
                object: nil,
                queue: .main
            ) { [weak self] _ in
                MainActor.assumeIsolated { self?.releaseThreadsForMemoryPressure() }
            },
            center.addObserver(
                forName: UIApplication.didEnterBackgroundNotification,
                object: nil,
                queue: .main
            ) { [weak self] _ in
                MainActor.assumeIsolated {
                    guard let save = self?.saveForBackground() else { return }
                    let identifier = UIApplication.shared.beginBackgroundTask(
                        withName: "Save sync cache"
                    )
                    Task { @MainActor in
                        await save.value
                        UIApplication.shared.endBackgroundTask(identifier)
                    }
                }
            },
        ]
    }
}
