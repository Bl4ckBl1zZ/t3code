import Foundation
import Testing
@testable import T3Code

@Suite("Connection failure guidance")
struct ConnectionFailureTests {
    @Test(arguments: [URLError.timedOut, .cannotConnectToHost, .dnsLookupFailed])
    func networkFailuresOfferQualifiedGuidance(_ code: URLError.Code) {
        let result = ConnectionFailure(error: URLError(code))
        #expect(result.mayBeNetworkBlocking)
        #expect(result.message.contains("may be"))
    }

    @Test
    func authorizationDoesNotSuggestNetworkBlocking() {
        let result = ConnectionFailure(error: T3ConnectRelayError.response(
            status: 401, message: "Sign in again", traceID: nil
        ))
        #expect(!result.mayBeNetworkBlocking)
        #expect(result.message.contains("Sign in again"))
    }

    @Test
    func detailsDoNotDiscloseRequestCredentials() {
        let result = ConnectionFailure(error: NSError(
            domain: NSURLErrorDomain, code: NSURLErrorTimedOut,
            userInfo: [NSURLErrorFailingURLStringErrorKey: "https://example.com/?token=secret"]
        ))
        #expect(!result.details.contains("secret"))
        #expect(!result.message.contains("secret"))
    }
}
