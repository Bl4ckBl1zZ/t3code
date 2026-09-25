import Foundation
import Testing
@testable import T3Code

/// The server-backed pages keep what the server last said while they reload
/// and while their own writes are in flight. Blanking it made every toggle
/// fall back to its default after each save.
struct ServerSettingsPageStateTests {
    private let config = ServerConfigSnapshot(providers: [])

    @Test func aReloadKeepsTheLastConfigVisible() {
        var page = ServerSettingsPageState()
        page.beginLoad(environmentID: "a")
        #expect(page.isLoading)
        #expect(page.config == nil)
        page.finishLoad(config)
        #expect(!page.isLoading)

        page.beginLoad(environmentID: "a")
        #expect(page.config == config)
        #expect(page.isLoading)
    }

    @Test func switchingServersStartsOver() {
        var page = ServerSettingsPageState()
        page.beginLoad(environmentID: "a")
        page.finishLoad(config)
        page.beginWrite(.init(newWorktreesStartFromOrigin: true))

        page.beginLoad(environmentID: "b")
        #expect(page.environmentID == "b")
        #expect(page.config == nil)
        #expect(page.pending == ServerSettingsPatchInput())
        #expect(!page.isWriting)
    }

    @Test func pendingWritesWinUntilTheLastOneLands() {
        var page = ServerSettingsPageState()
        page.beginLoad(environmentID: "a")
        page.finishLoad(config)

        page.beginWrite(.init(newWorktreesStartFromOrigin: true))
        page.beginWrite(.init(defaultAutoPull: false))
        #expect(page.pending.newWorktreesStartFromOrigin == true)
        #expect(page.pending.defaultAutoPull == false)

        // A load that lands mid-write may predate the writes, so they stay.
        page.finishLoad(config)
        #expect(page.pending.newWorktreesStartFromOrigin == true)

        let firstSettled = page.finishWrite(succeeded: true)
        let lastSettled = page.finishWrite(succeeded: true)
        #expect(!firstSettled)
        #expect(lastSettled)
        #expect(!page.isWriting)
        page.finishLoad(config)
        #expect(page.pending == ServerSettingsPatchInput())
    }

    @Test func aFailedWriteRevertsToTheServerAnswer() {
        var page = ServerSettingsPageState()
        page.beginLoad(environmentID: "a")
        page.finishLoad(config)
        page.beginWrite(.init(newWorktreesStartFromOrigin: true))
        let settled = page.finishWrite(succeeded: false)
        #expect(settled)
        #expect(page.pending.newWorktreesStartFromOrigin == nil)
        #expect(page.config == config)
    }

    @Test func laterPatchesMergeKeyByKey() {
        var first = ServerSettingsPatchInput()
        first.projectAutoPullOverrides = ["one": true]
        var style = SourceControlWritingStylePatch()
        style.mode = "custom"
        first.sourceControlWritingStyle = style

        var second = ServerSettingsPatchInput()
        second.projectAutoPullOverrides = ["two": false]
        var laterStyle = SourceControlWritingStylePatch()
        laterStyle.followChangeRequestTemplates = true
        second.sourceControlWritingStyle = laterStyle
        second.defaultAutoPull = true

        let merged = first.merged(with: second)
        #expect(merged.projectAutoPullOverrides?["one"] == .some(true))
        #expect(merged.projectAutoPullOverrides?["two"] == .some(false))
        #expect(merged.sourceControlWritingStyle?.mode == "custom")
        #expect(merged.sourceControlWritingStyle?.followChangeRequestTemplates == true)
        #expect(merged.defaultAutoPull == true)
    }
}

/// New Automation used to target the first saved server unconditionally, so
/// no other server could get one.
struct AutomationEnvironmentChoiceTests {
    private let environments = [
        FeatureEnvironment(id: "mac", name: "MacBook Pro", endpoint: ""),
        FeatureEnvironment(id: "studio", name: "Studio", endpoint: "", isActive: true),
        FeatureEnvironment(id: "linux", name: "Linux Box", endpoint: ""),
    ]

    @Test func keepsTheServerTheReaderPicked() {
        #expect(AutomationEnvironmentChoice.initialEnvironmentID(requested: "linux", environments: environments) == "linux")
    }

    @Test func fallsBackToTheActiveServerNotTheFirst() {
        #expect(AutomationEnvironmentChoice.initialEnvironmentID(requested: nil, environments: environments) == "studio")
        #expect(AutomationEnvironmentChoice.initialEnvironmentID(requested: "gone", environments: environments) == "studio")
    }

    @Test func fallsBackToTheFirstWithNoActiveServer() {
        let inactive = environments.map { FeatureEnvironment(id: $0.id, name: $0.name, endpoint: "") }
        #expect(AutomationEnvironmentChoice.initialEnvironmentID(requested: nil, environments: inactive) == "mac")
        #expect(AutomationEnvironmentChoice.initialEnvironmentID(requested: nil, environments: []) == nil)
    }

    @Test func offersTheActiveServerFirst() {
        #expect(AutomationEnvironmentChoice.ordered(environments).map(\.id) == ["studio", "mac", "linux"])
    }

    @Test func movingServersForgetsTheOldServersChoices() {
        var draft = AutomationDraft()
        draft.title = "Nightly"
        draft.projectID = "project-1"
        draft.threadID = "thread-1"
        draft.modelSelection = ModelSelection(instanceId: "codex", model: "gpt")
        draft.clearEnvironmentScopedFields()
        #expect(draft.projectID.isEmpty)
        #expect(draft.threadID == nil)
        #expect(draft.modelSelection == nil)
        #expect(draft.title == "Nightly")
    }
}

/// Time and days are picked with system controls but still stored in the
/// wire's 24-hour "HH:MM" and Sunday-zero numbering.
struct AutomationScheduleEditingTests {
    private var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.locale = Locale(identifier: "en_US")
        calendar.timeZone = TimeZone(identifier: "UTC")!
        return calendar
    }

    @Test func pickedTimesAreStoredAsZeroPaddedTwentyFourHour() {
        var draft = AutomationDraft()
        let evening = calendar.date(from: DateComponents(year: 2026, month: 1, day: 5, hour: 18, minute: 5))!
        draft.setTimeOfDay(evening, calendar: calendar)
        #expect(draft.timeOfDay == "18:05")
        #expect(draft.isTimeOfDayValid)

        let shown = draft.timeOfDayDate(on: evening, calendar: calendar)
        #expect(calendar.component(.hour, from: shown) == 18)
        #expect(calendar.component(.minute, from: shown) == 5)
    }

    @Test func anUnreadableTimeOpensAtNine() {
        var draft = AutomationDraft()
        draft.timeOfDay = "25:99"
        let day = calendar.date(from: DateComponents(year: 2026, month: 1, day: 5))!
        #expect(calendar.component(.hour, from: draft.timeOfDayDate(on: day, calendar: calendar)) == 9)
    }

    @Test func theWeekFollowsTheCalendarsFirstDay() {
        var monday = calendar
        monday.firstWeekday = 2
        #expect(ScheduledTaskWeekday.ordered(calendar: monday).first == .monday)
        #expect(ScheduledTaskWeekday.ordered(calendar: calendar).first == .sunday)
        #expect(ScheduledTaskWeekday.ordered(calendar: monday).count == 7)
    }

    @Test func repeatReadsLikeClock() {
        #expect(ScheduledTaskWeekday.repeatSummary([], calendar: calendar) == "Never")
        #expect(ScheduledTaskWeekday.repeatSummary(Set(ScheduledTaskWeekday.allCases), calendar: calendar) == "Every Day")
        #expect(ScheduledTaskWeekday.repeatSummary([.monday, .tuesday, .wednesday, .thursday, .friday], calendar: calendar) == "Weekdays")
        #expect(ScheduledTaskWeekday.repeatSummary([.saturday, .sunday], calendar: calendar) == "Weekends")
        #expect(ScheduledTaskWeekday.repeatSummary([.friday, .monday], calendar: calendar) == "Mon, Fri")
    }
}
