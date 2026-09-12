import Foundation
import Testing
@testable import T3Code

struct HostResourcesTests {
    @Test func contractSamplesAndClientClockSelection() throws {
        struct Fixture: Decodable { let samples: [HostResourcesSnapshot] }
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Fixtures/hostResources.json")
        let samples = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url)).samples
        #expect(samples[0].cpuCount == 8)
        #expect(samples[1].cpuUtilization == nil)
        let candidates = [
            LoadBalancingCandidate(environmentID: "normal", resources: samples[0], receivedAt: 200000, weight: 50),
            LoadBalancingCandidate(environmentID: "preferred", resources: samples[0], receivedAt: 200000, weight: 100),
            LoadBalancingCandidate(environmentID: "unknown", resources: samples[1], receivedAt: 200000, weight: 100),
        ]
        #expect(LoadBalancedEnvironment.choose(candidates, now: 200000) == "preferred")
        #expect(LoadBalancedEnvironment.choose(candidates, now: 215001) == nil)
        #expect(LoadBalancedEnvironment.choose([.init(environmentID: "excluded", resources: samples[0], receivedAt: 200000, weight: 0)], now: 200000) == nil)
        #expect(try JSONDecoder().decode(HostResourcesSnapshot.self, from: JSONEncoder().encode(samples[0])) == samples[0])
    }
}
