import Testing

@testable import T3Code

/// `/feedback` is the one composer command that does not go to the agent, so
/// what counts as the command — and what counts as ordinary text that merely
/// starts with the word — is worth pinning down.
@Suite("Provider feedback command")
struct ProviderFeedbackCommandTests {
    @Test
    func bareCommandIsRecognisedWithNoReason() {
        #expect(ProviderFeedbackCommand.parse("/feedback")?.reason == nil)
        #expect(ProviderFeedbackCommand.parse("  /FEEDBACK  ") != nil)
    }

    @Test
    func trailingTextBecomesTheReason() {
        #expect(
            ProviderFeedbackCommand.parse("  /feedback  it stopped early  ")
                == .init(reason: "it stopped early")
        )
    }

    @Test
    func multilineReasonsSurvive() {
        #expect(
            ProviderFeedbackCommand.parse("/feedback\nline one\nline two")
                == .init(reason: "line one\nline two")
        )
    }

    @Test
    func ordinaryMessagesAreLeftAlone() {
        // No leading slash, a different command, and words that merely start
        // with the command's name all stay ordinary messages.
        #expect(ProviderFeedbackCommand.parse("feedback please") == nil)
        #expect(ProviderFeedbackCommand.parse("/feedbackloop is broken") == nil)
        #expect(ProviderFeedbackCommand.parse("/feedback-ci") == nil)
        #expect(ProviderFeedbackCommand.parse("/review") == nil)
        #expect(ProviderFeedbackCommand.parse("tell me about /feedback") == nil)
    }

    @Test
    func onlyProvidersThatAdvertiseItClaimTheCommand() {
        #expect(!ProviderFeedbackCommand.isSupported(by: []))
        #expect(
            !ProviderFeedbackCommand.isSupported(by: [
                FeatureProviderSlashCommand(name: "review", description: nil),
            ])
        )
        #expect(
            ProviderFeedbackCommand.isSupported(by: [
                FeatureProviderSlashCommand(name: "Feedback", description: nil),
            ])
        )
    }
}
