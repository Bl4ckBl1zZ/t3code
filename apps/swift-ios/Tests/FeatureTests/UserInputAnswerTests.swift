import Foundation
import Testing
@testable import T3Code

@Suite("User input answers")
struct UserInputAnswerTests {
    @Test
    func testCodableShapeMatchesProviderWireValues() throws {
        let encoder = JSONEncoder()
        let decoder = JSONDecoder()

        let textData = try encoder.encode(FeatureInputAnswer.text("Deploy"))
        let selectionsData = try encoder.encode(
            FeatureInputAnswer.selections(["Server", "Web"])
        )

        #expect(try decoder.decode(JSONValue.self, from: textData) == .string("Deploy"))
        #expect(
            try decoder.decode(JSONValue.self, from: selectionsData)
                == .array([.string("Server"), .string("Web")])
        )
        #expect(try decoder.decode(FeatureInputAnswer.self, from: textData) == .text("Deploy"))
        #expect(
            try decoder.decode(FeatureInputAnswer.self, from: selectionsData)
                == .selections(["Server", "Web"])
        )
    }

    @Test
    func testNativeJSONMappingPreservesStringAndArrayTypes() {
        #expect(FeatureInputAnswer.text("Deploy").jsonValue == .string("Deploy"))
        #expect(
            FeatureInputAnswer.selections(["Server", "Web"]).jsonValue
                == .array([.string("Server"), .string("Web")])
        )
    }

    @Test
    func testMultiSelectTogglesWithoutFlatteningSelections() {
        let first = FeatureInputAnswer.selections([])
            .togglingOption("Server", allowsMultiple: true)
        let second = first.togglingOption("Web", allowsMultiple: true)
        let deselected = second.togglingOption("Server", allowsMultiple: true)

        #expect(first == .selections(["Server"]))
        #expect(second == .selections(["Server", "Web"]))
        #expect(deselected == .selections(["Web"]))
        #expect(
            second.togglingOption("CLI", allowsMultiple: false)
                == .text("CLI")
        )
    }

    @Test
    func testAnswersNormalizeBeforeSubmission() {
        #expect(FeatureInputAnswer.text("  ship it  ").normalized == .text("ship it"))
        #expect(
            FeatureInputAnswer.selections([" Server ", "", "Server", "Web"]).normalized
                == .selections(["Server", "Web"])
        )
        #expect(FeatureInputAnswer.text("   ").normalized == nil)
        #expect(FeatureInputAnswer.selections([]).normalized == nil)
    }

    @Test
    func testMultiSelectCustomTextStaysInTheSelectionArray() {
        let question = FeatureInputQuestion(
            id: "surfaces",
            header: "Surfaces",
            question: "Where should this ship?",
            options: [
                .init(label: "Server", detail: "Backend"),
                .init(label: "Web", detail: "Browser"),
            ],
            allowsMultiple: true
        )
        let selected = FeatureInputAnswer.selections(["Server"])
        let withCustom = FeatureComposerCustomAnswer.replacingText(
            in: selected,
            with: "CLI",
            for: question
        )

        #expect(withCustom == .selections(["Server", "CLI"]))
        #expect(FeatureComposerCustomAnswer.text(in: withCustom, for: question) == "CLI")
        #expect(
            FeatureComposerCustomAnswer.replacingText(
                in: withCustom,
                with: "",
                for: question
            ) == .selections(["Server"])
        )
    }

    @Test
    func testDisplacedAnswerJoinsTheDraftWithoutLosingEitherSide() {
        #expect(
            FeatureComposerCustomAnswer.carryingDisplacedAnswer(
                "second half",
                into: "first half\n"
            ) == "first half\n\nsecond half"
        )
        #expect(
            FeatureComposerCustomAnswer.carryingDisplacedAnswer(
                "also rename the flag ",
                into: ""
            ) == "also rename the flag"
        )
    }

    @Test
    func testDisplacedAnswerLeavesTheDraftAloneWhenNothingWasTyped() {
        #expect(FeatureComposerCustomAnswer.carryingDisplacedAnswer("", into: "draft") == "draft")
        #expect(FeatureComposerCustomAnswer.carryingDisplacedAnswer("   ", into: "draft") == "draft")
        #expect(FeatureComposerCustomAnswer.carryingDisplacedAnswer("  ", into: "  ") == "  ")
    }

    @Test
    func testSingleSelectOptionDisplacesTypedTextButAnOptionDisplacesNothing() {
        let question = FeatureInputQuestion(
            id: "fix",
            header: "Fix",
            question: "How should this be fixed?",
            options: [
                .init(label: "Rename it", detail: "Rename the flag"),
                .init(label: "Leave it", detail: "No change"),
            ]
        )
        let typed = FeatureComposerCustomAnswer.replacingText(
            in: nil,
            with: "also rename the flag",
            for: question
        )

        // What `select` hands to the composer before `togglingOption` drops it.
        #expect(
            FeatureComposerCustomAnswer.text(in: typed, for: question) == "also rename the flag"
        )
        #expect(typed.togglingOption("Rename it", allowsMultiple: false) == .text("Rename it"))

        // Swapping one option for another displaces nothing: the reader never
        // typed the outgoing value, so there is no prose to rescue.
        let selected = FeatureInputAnswer.text("Rename it")
        #expect(FeatureComposerCustomAnswer.text(in: selected, for: question) == "")
    }

    @Test
    func testMultiSelectOptionKeepsCustomTextInPlaceSoNothingIsDisplaced() {
        let question = FeatureInputQuestion(
            id: "surfaces",
            header: "Surfaces",
            question: "Where should this ship?",
            options: [
                .init(label: "Server", detail: "Backend"),
                .init(label: "Web", detail: "Browser"),
            ],
            allowsMultiple: true
        )
        let withCustom = FeatureComposerCustomAnswer.replacingText(
            in: .selections(["Server"]),
            with: "CLI",
            for: question
        )
        let afterToggle = withCustom.togglingOption("Web", allowsMultiple: true)

        #expect(afterToggle == .selections(["Server", "CLI", "Web"]))
        #expect(FeatureComposerCustomAnswer.text(in: afterToggle, for: question) == "CLI")
    }
}
