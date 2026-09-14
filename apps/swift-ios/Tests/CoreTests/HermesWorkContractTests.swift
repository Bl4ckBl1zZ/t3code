import Foundation
import Testing
@testable import T3Code

@Suite("Hermes Work contracts")
struct HermesWorkContractTests {
    @Test func decodesServerOwnedAssistantsSchedulesAndResults() throws {
        struct Fixture: Decodable {
            let connections: HermesWorkConnections
            let query: HermesWorkQueryResult
            let mutation: HermesWorkMutationResult
            let groups: HermesWorkGroupsResult
            let changeEvent: HermesWorkChange
            let setup: HermesWorkSetupState
            let modelStatus: HermesWorkModelStatus
            let modelAuthStart: HermesWorkModelAuthStart
            let modelAuthPoll: HermesWorkModelAuthPoll
            let modelAuthCancel: HermesWorkModelAuthCancel
            let modelSet: HermesWorkModelSet
        }
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Fixtures/hermesWork.json")
        let fixture = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
        #expect(fixture.connections.connections.first?.providerInstanceId == "hermes-work")
        #expect(fixture.query.profiles.first?.name == "research")
        #expect(fixture.query.schedules.first?.schedule == "every 1h")
        #expect(fixture.query.schedules.first?.lastError == nil)
        #expect(fixture.query.runs.first?.endedAt != nil)
        #expect(fixture.query.channels.first?.fields.first?.secret == true)
        #expect(fixture.mutation.message == "Conversation opened.")
        #expect(fixture.mutation.threadId == "thread:hermes-work:fixture")
        #expect(fixture.query.sessions?.first?.profile == "research")
        #expect(fixture.query.artifacts?.first?.sessionId != nil)
        #expect(fixture.query.automation?.timezone != nil)
        #expect(fixture.changeEvent.providerInstanceId == "hermes-work")
        #expect(fixture.changeEvent.kind == "cron.changed")
        #expect(fixture.query.threadDetails?.schedulesAvailable == true)
        #expect(fixture.query.threadDetails?.status == "bound")
        #expect(fixture.query.threadDetails?.profile == "research")
        #expect(fixture.query.threadDetails?.sessionId == "session-1")
        #expect(fixture.query.threadDetails?.workspacePath == "/work/research")
        #expect(fixture.query.threadDetails?.schedules.first?.relationship == .createdHere)
        #expect(fixture.groups.groups.first?.name == "Research team")
        #expect(fixture.groups.events.first?.text == "Review complete.")
        #expect(fixture.groups.hasMore == false)
        #expect(try JSONDecoder().decode(HermesWorkThreadDetails.LinkedSchedule.Relationship.self, from: Data("\"run_of\"".utf8)) == .runOf)
        #expect(fixture.setup.phase == "needs_model")
        #expect(!fixture.setup.isActive)
        #expect(!fixture.modelStatus.providers.isEmpty)
        #expect(!fixture.modelAuthStart.sessionId.isEmpty)
        #expect(!fixture.modelAuthStart.verificationUrl.isEmpty)
        #expect(!fixture.modelAuthPoll.status.isEmpty)
        #expect(fixture.modelAuthCancel.ok)
        #expect(fixture.modelSet.ok)
        var raw = try #require(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        var query = try #require(raw["query"] as? [String: Any])
        var legacyDetails = try #require(query["threadDetails"] as? [String: Any])
        legacyDetails.removeValue(forKey: "schedulesAvailable")
        query["threadDetails"] = legacyDetails
        raw["query"] = query
        let legacy = try JSONDecoder().decode(Fixture.self, from: JSONSerialization.data(withJSONObject: raw))
        #expect(legacy.query.threadDetails?.schedulesAvailable == nil)
    }
}
