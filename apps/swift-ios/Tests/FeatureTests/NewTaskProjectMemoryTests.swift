import Foundation
import Testing
@testable import T3Code

@Suite("New-task project memory")
struct NewTaskProjectMemoryTests {
    private static func project(_ id: String, environment: String) -> FeatureProject {
        FeatureProject(id: id, environmentID: environment, name: id, path: "/code/\(id)")
    }

    @Test
    func preferredProjectIsTheOneLastSelected() {
        var memory = NewTaskProjectMemory()
        memory.record(projectID: "restorecord", environmentID: "air")

        let projects = [
            Self.project("app", environment: "air"),
            Self.project("restorecord", environment: "air"),
        ]
        #expect(memory.preferredProjectID(in: projects) == "restorecord")
    }

    @Test
    func nothingIsPreferredBeforeAProjectHasBeenSelected() {
        let memory = NewTaskProjectMemory()
        #expect(memory.preferredProjectID(in: [Self.project("app", environment: "air")]) == nil)
    }

    @Test
    func aDeletedProjectFallsBackToTheCallersDefault() {
        var memory = NewTaskProjectMemory()
        memory.record(projectID: "gone", environmentID: "air")

        #expect(memory.preferredProjectID(in: [Self.project("app", environment: "air")]) == nil)
    }

    @Test
    func aMissingEnvironmentFallsBackToAnotherRememberedProject() {
        var memory = NewTaskProjectMemory()
        memory.record(projectID: "studio", environmentID: "mini")
        memory.record(projectID: "restorecord", environmentID: "air")

        // The environment used last is offline; the project remembered for the
        // remaining one still beats "whatever sorts first".
        let projects = [
            Self.project("app", environment: "mini"),
            Self.project("studio", environment: "mini"),
        ]
        #expect(memory.preferredProjectID(in: projects) == "studio")
    }

    @Test
    func selectionIsRememberedPerEnvironment() {
        var memory = NewTaskProjectMemory()
        memory.record(projectID: "studio", environmentID: "mini")
        memory.record(projectID: "restorecord", environmentID: "air")

        #expect(memory.rememberedProjectID(forEnvironment: "mini") == "studio")
        #expect(memory.rememberedProjectID(forEnvironment: "air") == "restorecord")
    }

    @Test
    func theStoreSurvivesReadingItBackFromDefaults() throws {
        let suiteName = "swift-ios.tests.new-task-project-memory"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defaults.removePersistentDomain(forName: suiteName)
        defer { defaults.removePersistentDomain(forName: suiteName) }

        let store = NewTaskProjectMemoryStore(defaults: defaults, key: "test.project")
        #expect(store.memory() == NewTaskProjectMemory())

        store.record(projectID: "restorecord", environmentID: "air")

        let reopened = NewTaskProjectMemoryStore(defaults: defaults, key: "test.project")
        #expect(reopened.memory().lastEnvironmentID == "air")
        #expect(reopened.memory().rememberedProjectID(forEnvironment: "air") == "restorecord")
    }
}
