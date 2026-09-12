import XCTest
@testable import T3Code

final class ServerUpdateTests: XCTestCase {
    private func ready(_ version: String) throws -> NativeServerUpdateReady {
        try JSONDecoder().decode(NativeServerUpdateReady.self, from: Data("{\"type\":\"ready\",\"payload\":{\"environment\":{\"serverVersion\":\"\(version)\"}}}".utf8))
    }
    private let prepared = NativeServerUpdateResult(targetVersion: "2.0.0", method: "desktop-app", updateId: nil, desktopUpdateToken: "prepared-1")

    func testIgnoresMigrationPayloadAndDecodesPreparation() throws {
        let migration = try JSONDecoder().decode(NativeServerUpdateReady.self, from: Data(#"{"type":"legacyThreadMigration","payload":{"status":"running","totalThreadCount":2}}"#.utf8))
        XCTAssertNil(migration.payload)
        let progress = try JSONDecoder().decode(NativeServerUpdateProgress.self, from: Data(#"{"type":"complete","result":{"targetVersion":"2.0.0","method":"desktop-app","desktopUpdateToken":"prepared-1"}}"#.utf8))
        XCTAssertEqual(progress.result, prepared)
    }

    func testLostCommitRetriesAndRequiresPreparedVersion() async throws {
        let (events, continuation) = AsyncThrowingStream<NativeServerUpdateReady, Error>.makeStream()
        continuation.yield(try ready("1.0.0"))
        let old = try ready("1.0.0")
        let updated = try ready("2.0.0")
        let counter = CommitCounter()
        let result = try await NativeDesktopUpdateHandoff.run(prepared: prepared, events: events) {
            let attempt = await counter.increment()
            continuation.yield(attempt == 1 ? old : updated)
            throw RPCError.disconnected
        }
        XCTAssertEqual(result, "2.0.0")
        let count = await counter.value
        XCTAssertEqual(count, 2)
        continuation.finish()
    }

    func testInitialReadyCannotProveInstallation() async throws {
        let (events, continuation) = AsyncThrowingStream<NativeServerUpdateReady, Error>.makeStream()
        continuation.yield(try ready("2.0.0"))
        continuation.finish()
        do {
            _ = try await NativeDesktopUpdateHandoff.run(prepared: prepared, events: events) { throw RPCError.disconnected }
            XCTFail("The initial replay must not count as a completed update")
        } catch RPCError.disconnected {} catch { XCTFail("Unexpected error: \(error)") }
    }

    func testInstallerFailureIsNotRetried() async throws {
        let (events, continuation) = AsyncThrowingStream<NativeServerUpdateReady, Error>.makeStream()
        continuation.yield(try ready("1.0.0"))
        let counter = CommitCounter()
        do {
            _ = try await NativeDesktopUpdateHandoff.run(prepared: prepared, events: events) {
                _ = await counter.increment()
                throw RPCError.remote("Installer refused")
            }
            XCTFail("Expected installer failure")
        } catch RPCError.remote(let message) { XCTAssertEqual(message, "Installer refused") }
        let count = await counter.value
        XCTAssertEqual(count, 1)
        continuation.finish()
    }
}

private actor CommitCounter {
    var value = 0
    func increment() -> Int { value += 1; return value }
}
