import Foundation
import XCTest
@testable import T3Code

final class SignedAttachmentUploadTests: XCTestCase {
    func testUploadsRawBytesToTheEnvironmentWithAuthenticationAndAccepts204() async throws {
        let environment = Environment(id: "env", label: "Remote", httpBaseURL: URL(string: "https://host.test")!, webSocketBaseURL: URL(string: "wss://host.test/ws")!)
        let transport = AttachmentHTTPTransport()
        let api = EnvironmentAPI(transport: transport, credentials: InMemoryCredentialStore(credentials: ["env": EnvironmentCredential(accessToken: "test-token")]))
        try await api.uploadAttachment(for: environment, relativeURL: "/api/attachments/upload/signed-token", data: Data([1, 2, 3]), mimeType: "application/pdf")
        let request = await transport.lastRequest
        XCTAssertEqual(request?.httpMethod, "POST")
        XCTAssertEqual(request?.httpBody, Data([1, 2, 3]))
        XCTAssertEqual(request?.value(forHTTPHeaderField: "Content-Type"), "application/pdf")
        XCTAssertEqual(request?.value(forHTTPHeaderField: "Authorization"), "Bearer test-token")
        XCTAssertEqual(request?.timeoutInterval, 300)
    }

    func testRejectsAnUploadURLOutsideTheEnvironmentBeforeSendingCredentials() async throws {
        let environment = Environment(id: "env", label: "Remote", httpBaseURL: URL(string: "https://host.test")!, webSocketBaseURL: URL(string: "wss://host.test/ws")!)
        let transport = AttachmentHTTPTransport()
        let api = EnvironmentAPI(transport: transport, credentials: InMemoryCredentialStore())
        do {
            try await api.uploadAttachment(for: environment, relativeURL: "https://elsewhere.test/api/attachments/upload/token", data: Data([1]), mimeType: "application/pdf")
            XCTFail("Unexpected upload")
        } catch is RPCError {}
        let request = await transport.lastRequest
        XCTAssertNil(request)
    }

    func testLargerFileCapabilityIsOptionalForOlderServers() throws {
        let old = try JSONDecoder().decode(EnvironmentDescriptor.Capabilities.self, from: Data("{}".utf8))
        XCTAssertNil(old.fileAttachments)
        let current = try JSONDecoder().decode(EnvironmentDescriptor.Capabilities.self, from: Data(#"{"attachmentUploads":true,"fileAttachments":{"maxUploadBytes":52428800}}"#.utf8))
        XCTAssertEqual(current.fileAttachments?.maxUploadBytes, ComposerAttachments.maximumFileBytes)
        XCTAssertEqual(current.attachmentUploads, true)
    }
}

private actor AttachmentHTTPTransport: HTTPTransport {
    private(set) var lastRequest: URLRequest?
    func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        lastRequest = request
        return (Data(), HTTPURLResponse(url: request.url!, statusCode: 204, httpVersion: nil, headerFields: nil)!)
    }
}
