import Testing

@testable import T3Code

struct TaskSettingsOptionsTests {
    @Test
    func rowsCoverEveryPublishedOptionInCatalogOrder() {
        let rows = TaskSettingsOptions.rows(
            for: model(options: [effortDescriptor, verbosityToggle]),
            selections: [FeatureModelOptionSelection(id: "effort", value: .string("high"))]
        )

        #expect(rows.map(\.id) == ["effort", "verbose"])
        #expect(rows[0].valueLabel == "High")
        #expect(rows[0].selectedChoiceID == "high")
        #expect(rows[1].valueLabel == "Off")
        #expect(rows[1].isEnabled == false)
    }

    @Test
    func selectRowsWithoutChoicesAreDropped() {
        // A picker with nothing in it is a dead end, so the row never appears.
        let empty = FeatureModelOptionDescriptor(id: "empty", label: "Empty", kind: .select)
        let rows = TaskSettingsOptions.rows(
            for: model(options: [empty, verbosityToggle]),
            selections: []
        )

        #expect(rows.map(\.id) == ["verbose"])
    }

    @Test
    func unsetSelectFallsBackToTheDescriptorDefault() {
        let rows = TaskSettingsOptions.rows(for: model(options: [effortDescriptor]), selections: [])

        #expect(rows[0].selectedChoiceID == "medium")
        #expect(rows[0].valueLabel == "Medium")
    }

    @Test
    func noModelMeansNoRows() {
        #expect(TaskSettingsOptions.rows(for: nil, selections: []).isEmpty)
    }

    @Test
    func summaryJoinsTheModelWithItsResolvedOptions() {
        let summary = TaskSettingsOptions.summary(
            modelName: "Sonnet 5",
            model: model(options: [effortDescriptor]),
            selections: [FeatureModelOptionSelection(id: "effort", value: .string("high"))]
        )

        #expect(summary == "Sonnet 5 · High")
    }

    @Test
    func summaryFallsBackToTheModelAloneAndThenToACallToAction() {
        #expect(
            TaskSettingsOptions.summary(modelName: "Sonnet 5", model: model(options: []), selections: [])
                == "Sonnet 5"
        )
        // An empty trigger would read as a broken control rather than an
        // unconfigured one.
        #expect(TaskSettingsOptions.summary(modelName: nil, model: nil, selections: []) == "Choose model")
        #expect(TaskSettingsOptions.summary(modelName: "", model: nil, selections: []) == "Choose model")
    }

    @Test
    func booleanRowsReportTheStoredValue() {
        let rows = TaskSettingsOptions.rows(
            for: model(options: [verbosityToggle]),
            selections: [FeatureModelOptionSelection(id: "verbose", value: .boolean(true))]
        )

        #expect(rows[0].isEnabled)
        #expect(rows[0].valueLabel == "On")
    }

    // MARK: Fixtures

    private var effortDescriptor: FeatureModelOptionDescriptor {
        FeatureModelOptionDescriptor(
            id: "effort",
            label: "Reasoning effort",
            kind: .select,
            choices: [
                FeatureModelOptionChoice(id: "low", label: "Low"),
                FeatureModelOptionChoice(id: "medium", label: "Medium", isDefault: true),
                FeatureModelOptionChoice(id: "high", label: "High"),
            ]
        )
    }

    private var verbosityToggle: FeatureModelOptionDescriptor {
        FeatureModelOptionDescriptor(id: "verbose", label: "Verbose", kind: .boolean)
    }

    private func model(options: [FeatureModelOptionDescriptor]) -> FeatureModel {
        FeatureModel(id: "model", name: "Sonnet 5", options: options)
    }
}
