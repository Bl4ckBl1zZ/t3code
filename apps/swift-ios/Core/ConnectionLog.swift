import Foundation
import os

/// Connection-lifecycle diagnostics for attributing disconnect/reconnect churn.
/// Every event is prefixed "[conn]" so a capture can be tallied with grep
/// (see Scripts/connection-log-tally.sh). Stream from a booted simulator with:
///   xcrun simctl spawn booted log stream \
///     --predicate 'subsystem == "com.t3code" AND category == "connection"'
/// or filter Console.app on the same subsystem/category for a physical device.
public enum ConnectionLog {
    public static let logger = Logger(subsystem: "com.t3code", category: "connection")

    /// WebSocket URLs carry a `wsTicket` credential in the query, and transport
    /// errors can echo the failing URL. Strip the ticket value before logging.
    public static func describe(_ error: any Error) -> String {
        describe(String(describing: error))
    }

    public static func describe(_ message: String) -> String {
        message.replacingOccurrences(
            of: #"wsTicket=[^&\s"')]*"#,
            with: "wsTicket=<redacted>",
            options: .regularExpression
        )
    }
}
