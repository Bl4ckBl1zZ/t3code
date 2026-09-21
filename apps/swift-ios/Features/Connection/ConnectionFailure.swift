import Foundation
import SwiftUI

public struct ConnectionFailure: Equatable, Sendable {
    public let message: String
    public let details: String
    public let mayBeNetworkBlocking: Bool

    public init(error: any Error) {
        let nsError = error as NSError
        let code = nsError.domain == NSURLErrorDomain ? URLError.Code(rawValue: nsError.code) : nil
        mayBeNetworkBlocking = code.map {
            [.timedOut, .cannotFindHost, .cannotConnectToHost, .dnsLookupFailed,
             .networkConnectionLost, .secureConnectionFailed].contains($0)
        } ?? false
        if mayBeNetworkBlocking {
            message = "This network may be blocking the connection. Try another network or check your VPN."
        } else if code == .notConnectedToInternet {
            message = "You’re offline. Connect to Wi-Fi or cellular data, then try again."
        } else {
            message = error.localizedDescription
        }
        // Transport errors can carry credential-bearing request URLs in userInfo.
        // A domain/code is enough to identify the failure without exposing them.
        details = "\(nsError.domain) (\(nsError.code))"
    }
}

/// A connection failure as the first section of an inset-grouped list, so it
/// scrolls and refreshes with the list: what happened, Try Again, and the
/// technical details for a bug report.
struct ConnectionFailureSection: View {
    let title: String
    let failure: ConnectionFailure
    let isRetrying: Bool
    let retry: () -> Void

    var body: some View {
        Section {
            ConnectionProblemRow(
                title: title,
                message: failure.message,
                systemImage: "wifi.exclamationmark"
            )
            Button(action: retry) {
                HStack {
                    Text("Try Again")
                    Spacer()
                    if isRetrying {
                        ProgressView()
                    }
                }
            }
            .tint(T3Colors.accent)
            .disabled(isRetrying)
            DisclosureGroup("Technical Details") {
                Text(failure.details)
                    .font(.caption.monospaced())
                    .foregroundStyle(T3Colors.textSecondary)
                    .textSelection(.enabled)
            }
            .foregroundStyle(T3Colors.textPrimary)
        }
        .t3GroupedRow()
        .accessibilityIdentifier("connection-failure-guidance")
    }
}
