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

struct ConnectionFailureView: View {
    let failure: ConnectionFailure
    let isRetrying: Bool
    let retry: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label(failure.message, systemImage: "wifi.exclamationmark")
                .font(T3Typography.supporting)
                .foregroundStyle(T3Colors.textPrimary)
            DisclosureGroup("Technical details") {
                Text(failure.details)
                    .font(.caption.monospaced())
                    .textSelection(.enabled)
            }
            Button("Retry connection", action: retry)
                .buttonStyle(.bordered)
                .disabled(isRetrying)
        }
        .padding(16)
        .background(T3Colors.surface, in: RoundedRectangle(cornerRadius: 14))
        .padding(.horizontal, 16)
        .accessibilityIdentifier("connection-failure-guidance")
    }
}
