import Foundation
import XCTest

@testable import T3Code

/// Covers the automation editor's form state. Ports the `draftFromTask`,
/// `draftSchedule`, and `canSave` behaviour of
/// apps/mobile/src/features/settings/automations/AutomationEditSheet.tsx, plus
/// the launch-settings preservation the same file's `save()` relies on.
final class AutomationDraftTests: XCTestCase {
    private static let storedSelection = ModelSelection(instanceId: "codex", model: "gpt-5.6-sol")

    /// Something no mobile form can produce, so a test that finds it in the
    /// upsert has proved the value round-tripped rather than been rebuilt.
    private static let foreignLaunch = FeatureScheduledTaskLaunch(
        workspaceStrategy: .object([
            "type": .string("existing-worktree"),
            "path": .string("/srv/checkouts/nightly"),
        ]),
        modelSelection: storedSelection,
        runtimeMode: "approval-required",
        interactionMode: "plan"
    )

    private func task(
        schedule: ScheduledTaskSchedule = .fixedTime(timeOfDay: "09:00"),
        enabled: Bool = true,
        threadID: String? = "thread-7",
        launch: FeatureScheduledTaskLaunch = AutomationDraftTests.foreignLaunch
    ) -> FeatureScheduledTask {
        FeatureScheduledTask(
            id: "task-1",
            title: "Nightly triage",
            prompt: "Summarise anything that failed overnight.",
            enabled: enabled,
            schedule: schedule,
            projectID: "project-9",
            threadID: threadID,
            launch: launch,
            nextRunAt: "2026-08-02T21:00:00.000Z",
            lastRunStatus: .succeeded,
            runCount: 12
        )
    }

    private func completeDraft() -> AutomationDraft {
        var draft = AutomationDraft()
        draft.title = "Nightly triage"
        draft.prompt = "Summarise anything that failed overnight."
        draft.projectID = "project-9"
        draft.modelSelection = Self.storedSelection
        return draft
    }

    // MARK: - Loading an existing automation

    func testEditingAnAutomationLoadsEveryFieldTheFormOwns() {
        let draft = AutomationDraft(task: task(enabled: false))
        XCTAssertEqual(draft.title, "Nightly triage")
        XCTAssertEqual(draft.prompt, "Summarise anything that failed overnight.")
        XCTAssertFalse(draft.isEnabled)
        XCTAssertEqual(draft.projectID, "project-9")
        XCTAssertEqual(draft.threadID, "thread-7")
        XCTAssertEqual(draft.modelSelection, Self.storedSelection)
        XCTAssertEqual(draft.scheduleMode, .fixed)
        XCTAssertEqual(draft.timeOfDay, "09:00")
    }

    /// An absent weekday list means "every day", and the picker has to show
    /// that as all seven selected — showing none would read as "never".
    func testAScheduleWithoutWeekdaysLoadsAsEveryDaySelected() {
        let everyDay = AutomationDraft(task: task(schedule: .fixedTime(timeOfDay: "09:00")))
        XCTAssertEqual(everyDay.weekdays, Set(ScheduledTaskWeekday.allCases))

        let emptyList = AutomationDraft(
            task: task(schedule: .fixedTime(timeOfDay: "09:00", weekdays: []))
        )
        XCTAssertEqual(emptyList.weekdays, Set(ScheduledTaskWeekday.allCases))
    }

    func testAScheduleWithWeekdaysLoadsExactlyThoseDays() {
        let draft = AutomationDraft(
            task: task(schedule: .fixedTime(timeOfDay: "07:30", weekdays: [.monday, .thursday]))
        )
        XCTAssertEqual(draft.weekdays, [.monday, .thursday])
        XCTAssertEqual(draft.timeOfDay, "07:30")
    }

    func testAnIntervalScheduleLoadsAsWholeMinutes() {
        let draft = AutomationDraft(task: task(schedule: .interval(everyMs: 45 * 60_000)))
        XCTAssertEqual(draft.scheduleMode, .interval)
        XCTAssertEqual(draft.intervalMinutes, "45")
    }

    /// Rows written before the one-minute write minimum can still be
    /// sub-minute. They load as one minute rather than as zero, so re-saving
    /// cannot produce a schedule the server would reject.
    func testALegacySubMinuteIntervalLoadsAsAtLeastOneMinute() {
        let draft = AutomationDraft(task: task(schedule: .interval(everyMs: 15_000)))
        XCTAssertEqual(draft.intervalMinutes, "1")
    }

    // MARK: - Schedule derivation

    func testEveryDaySelectedOmitsTheWeekdayListEntirely() {
        var draft = completeDraft()
        draft.weekdays = Set(ScheduledTaskWeekday.allCases)
        draft.timeOfDay = "09:00"
        XCTAssertEqual(draft.schedule, .fixedTime(timeOfDay: "09:00", weekdays: nil))
    }

    func testPartialWeekdaySelectionsAreSentSundayFirst() {
        var draft = completeDraft()
        draft.weekdays = [.friday, .monday, .sunday]
        XCTAssertEqual(
            draft.schedule,
            .fixedTime(timeOfDay: "09:00", weekdays: [.sunday, .monday, .friday])
        )
    }

    /// An automation with no selected day would never fire, which is worse than
    /// refusing the save.
    func testNoSelectedWeekdayIsNotASavableSchedule() {
        var draft = completeDraft()
        draft.weekdays = []
        XCTAssertNil(draft.schedule)
        XCTAssertFalse(draft.isComplete)
    }

    func testAMalformedTimeIsNotASavableSchedule() {
        var draft = completeDraft()
        for value in ["9:00", "24:00", "09:60", "0900", ""] {
            draft.timeOfDay = value
            XCTAssertNil(draft.schedule, "\(value) should not produce a schedule")
            XCTAssertFalse(draft.isTimeOfDayValid, "\(value) should read as invalid")
        }
    }

    func testIntervalMinutesBecomeMilliseconds() {
        var draft = completeDraft()
        draft.scheduleMode = .interval
        draft.intervalMinutes = "30"
        XCTAssertEqual(draft.schedule, .interval(everyMs: 30 * 60_000))
    }

    func testAnIntervalBelowOneMinuteIsNotSavable() {
        var draft = completeDraft()
        draft.scheduleMode = .interval
        for value in ["0", "-5", "", "abc"] {
            draft.intervalMinutes = value
            XCTAssertNil(draft.schedule, "\(value) should not produce a schedule")
            XCTAssertFalse(draft.isIntervalValid, "\(value) should read as invalid")
        }
    }

    // MARK: - Completeness

    func testAnEmptyDraftIsNotComplete() {
        XCTAssertFalse(AutomationDraft().isComplete)
    }

    func testWhitespaceOnlyTitlesAndPromptsDoNotCountAsFilledIn() {
        var draft = completeDraft()
        draft.title = "   "
        XCTAssertFalse(draft.isComplete)

        draft = completeDraft()
        draft.prompt = "\n  \n"
        XCTAssertFalse(draft.isComplete)
    }

    func testAProjectIsRequired() {
        var draft = completeDraft()
        draft.projectID = ""
        XCTAssertFalse(draft.isComplete)
    }

    /// Completeness deliberately excludes the model: an environment with no
    /// authenticated provider should hear why on save rather than face a Save
    /// button that never enables.
    func testAMissingModelStillLeavesTheDraftComplete() {
        var draft = completeDraft()
        draft.modelSelection = nil
        XCTAssertTrue(draft.isComplete)
        XCTAssertNil(draft.upsert(editing: nil))
    }

    // MARK: - Weekday toggling

    func testTogglingAWeekdayAddsThenRemovesIt() {
        var draft = AutomationDraft()
        XCTAssertFalse(draft.weekdays.contains(.sunday))
        draft.toggle(.sunday)
        XCTAssertTrue(draft.weekdays.contains(.sunday))
        draft.toggle(.sunday)
        XCTAssertFalse(draft.weekdays.contains(.sunday))
    }

    func testANewDraftDefaultsToWeekdaysAtNineInTheMorning() {
        let draft = AutomationDraft()
        XCTAssertEqual(draft.weekdays, [.monday, .tuesday, .wednesday, .thursday, .friday])
        XCTAssertEqual(draft.schedule, .fixedTime(timeOfDay: "09:00", weekdays: [
            .monday, .tuesday, .wednesday, .thursday, .friday,
        ]))
    }

    // MARK: - Upsert

    func testCreatingAnAutomationUsesMobilesWorktreeDefaultsAndIsAttributed() {
        guard let input = completeDraft().upsert(editing: nil) else {
            return XCTFail("A complete draft with a model should produce an upsert")
        }
        XCTAssertNil(input.id)
        XCTAssertEqual(input.creationSource, "mobile")
        XCTAssertEqual(input.launch.runtimeMode, "full-access")
        XCTAssertEqual(input.launch.interactionMode, "default")
        XCTAssertEqual(
            input.launch.workspaceStrategy,
            .object(["type": .string("worktree"), "baseRef": .string("main")])
        )
    }

    /// The form never renders the workspace strategy or the runtime and
    /// interaction modes, so editing a schedule on a phone must carry whatever
    /// an agent or the web client configured straight back out.
    func testEditingPreservesTheLaunchSettingsTheFormDoesNotRender() {
        let existing = task()
        var draft = AutomationDraft(task: existing)
        draft.timeOfDay = "18:45"

        guard let input = draft.upsert(editing: existing) else {
            return XCTFail("An edited draft should produce an upsert")
        }
        XCTAssertEqual(input.id, existing.id)
        XCTAssertEqual(input.launch.workspaceStrategy, Self.foreignLaunch.workspaceStrategy)
        XCTAssertEqual(input.launch.runtimeMode, "approval-required")
        XCTAssertEqual(input.launch.interactionMode, "plan")
        XCTAssertEqual(input.threadID, "thread-7")
        XCTAssertEqual(input.schedule, .fixedTime(timeOfDay: "18:45", weekdays: nil))
        // Only a create is attributed to mobile; an edit must not rewrite the
        // surface the automation was originally made on.
        XCTAssertNil(input.creationSource)
    }

    func testAModelChangeIsCarriedIntoAnOtherwisePreservedLaunch() {
        let existing = task()
        var draft = AutomationDraft(task: existing)
        let replacement = ModelSelection(instanceId: "claude", model: "opus-5")
        draft.modelSelection = replacement

        guard let input = draft.upsert(editing: existing) else {
            return XCTFail("An edited draft should produce an upsert")
        }
        XCTAssertEqual(input.launch.modelSelection, replacement)
        XCTAssertEqual(input.launch.runtimeMode, "approval-required")
    }

    func testTitleAndPromptAreTrimmedOnTheWayOut() {
        var draft = completeDraft()
        draft.title = "  Nightly triage  "
        draft.prompt = "\n Summarise anything that failed overnight. \n"

        guard let input = draft.upsert(editing: nil) else {
            return XCTFail("A complete draft should produce an upsert")
        }
        XCTAssertEqual(input.title, "Nightly triage")
        XCTAssertEqual(input.prompt, "Summarise anything that failed overnight.")
    }

    func testAnIncompleteDraftProducesNoUpsert() {
        var draft = completeDraft()
        draft.title = ""
        XCTAssertNil(draft.upsert(editing: nil))
    }

    // MARK: - Row presentation

    /// The list subtitle is what tells a reader whether an automation is doing
    /// anything, so the summary a task exposes has to carry the run state.
    func testATaskSummaryFeedsTheSharedSubtitleLabels() {
        let now = Date(timeIntervalSince1970: 1_785_000_000)
        let paused = task(schedule: .interval(everyMs: 30 * 60_000), enabled: false)
        XCTAssertEqual(
            ScheduledTaskLabels.subtitle(for: paused.summary, now: now),
            "Every 30 min · paused"
        )
    }

    func testARunningTaskReportsItselfAsRunning() {
        var running = task(schedule: .interval(everyMs: 60_000))
        running.lastRunStatus = .running
        XCTAssertTrue(running.isRunning)
        XCTAssertEqual(
            ScheduledTaskLabels.statusTone(running.lastRunStatus),
            .running
        )
    }
}
