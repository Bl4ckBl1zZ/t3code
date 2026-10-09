import Foundation

/// An error that can say the saved credential itself was refused, for errors
/// Core does not define (T3 Connect's relay, for one).
public protocol CredentialRejecting: Error {
    var rejectsCredential: Bool { get }
}

/// Tells a dead credential from a failed network.
///
/// The server closes an open socket as soon as its session is revoked,
/// replaced or expires, and that close carries no code or reason. So the
/// close looks like any dropped connection; the next dial is what tells them
/// apart. Each dial mints a socket ticket over HTTP, and a T3 Connect
/// credential is renewed there first, so a rejection that reaches the dial
/// means renewing failed too. Such a credential never works again: retrying
/// only repeats the refusal, and only pairing again (or renewing T3 Connect
/// access) gets back in.
public enum CredentialRejection {
    public static func isRejected(_ error: any Error) -> Bool {
        if let error = error as? HTTPError {
            switch error {
            case let .status(status, _, _): return status == 401
            case .missingCredential, .incompatibleCredential: return true
            case .invalidResponse, .managedAuthorizationUnavailable: return false
            }
        }
        if let error = error as? any CredentialRejecting {
            return error.rejectsCredential
        }
        return false
    }
}
