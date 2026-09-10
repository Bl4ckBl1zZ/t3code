import SwiftUI

private struct ThreadWorkLogHistoryKey: EnvironmentKey {
    static let defaultValue: ThreadWorkLogHistoryStore? = nil
}
extension EnvironmentValues {
    var threadWorkLogHistory: ThreadWorkLogHistoryStore? {
        get { self[ThreadWorkLogHistoryKey.self] }
        set { self[ThreadWorkLogHistoryKey.self] = newValue }
    }
}
