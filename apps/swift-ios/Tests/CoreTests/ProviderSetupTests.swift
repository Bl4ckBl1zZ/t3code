import XCTest
@testable import T3Code

final class ProviderSetupTests: XCTestCase {
    func testOnlyWaitingGoogleFlowsOfferAnOpenableURL() throws {
        for (phase, url, available) in [
            ("waiting", "https://accounts.google.com/o/oauth2/v2/auth?state=fixture", true),
            ("succeeded", "https://accounts.google.com/o/oauth2/v2/auth", false),
            ("waiting", "https://accounts.google.com.example.invalid/auth", false),
            ("waiting", "http://accounts.google.com/auth", false)
        ] {
            let data = try JSONSerialization.data(withJSONObject: ["instanceId": "account-a", "phase": phase, "authorizationUrl": url])
            let state = try JSONDecoder().decode(NativeProviderAuthState.self, from: data)
            XCTAssertEqual(state.signInURL != nil, available)
        }
    }

    func testRemoteCallbackPreservesTheOwningAccountAndFlow() {
        let callback = "http://127.0.0.1:51234/?state=fixture&code=fake"
        let action = NativeProviderSetupAction.completeAuth(flowID: "owned-flow", callbackURL: callback)
        XCTAssertEqual(action.method, "provider.auth.complete")
        XCTAssertEqual(action.payload(instanceID: "account-b"), .object([
            "instanceId": .string("account-b"), "flowId": .string("owned-flow"), "callbackUrl": .string(callback)
        ]))
        XCTAssertEqual(NativeProviderSetupAction.cancelInstall(operationID: "install-b").payload(instanceID: "account-b"),
                       .object(["instanceId": .string("account-b"), "operationId": .string("install-b")]))
    }

    func testInstallFailureKeepsThePreviouslyInstalledVersionVisible() throws {
        let data = Data(#"{"driver":"antigravity","phase":"failed","downloadedBytes":42,"totalBytes":100,"installedVersion":"1.0.0","version":"1.1.1","canRemove":true,"message":"Download failed"}"#.utf8)
        let state = try JSONDecoder().decode(NativeProviderInstallState.self, from: data)
        XCTAssertFalse(state.isActive)
        XCTAssertEqual(state.installedVersion, "1.0.0")
        XCTAssertTrue(state.canRemove)
    }
}
