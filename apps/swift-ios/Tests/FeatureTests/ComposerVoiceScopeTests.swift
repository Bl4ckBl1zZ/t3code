import Foundation
import Testing
@testable import T3Code

/// A transcript is stashed under the identity of the composer it was recorded
/// in. These pin that every compose surface has its own identity, so a New Chat
/// dictation can never surface in New Work or a project-less New Task.
@Suite("Composer voice scope")
struct ComposerVoiceScopeTests {
    @Test
    func eachSurfaceMapsToItsOwnIdentity() {
        #expect(FeatureComposerVoiceScope.thread(id: "env:thread-a").identity == "env:thread-a")
        #expect(FeatureComposerVoiceScope.newChat(environmentID: "env-1").identity == "new-chat:env-1")
        #expect(FeatureComposerVoiceScope.newWork(environmentID: "env-1").identity == "new-work:env-1")
        #expect(FeatureComposerVoiceScope.newTask(draftKey: "draft-9").identity == "new-task:draft-9")
    }

    @Test
    func anExplicitScopeWinsOverThePathScope() {
        let features = FeatureComposerPowerFeatures(
            pathSearchScopeID: "project-1",
            voiceScope: .newTask(draftKey: "project-1:draft")
        )
        #expect(features.voiceComposerIdentity == "new-task:project-1:draft")
    }

    /// A thread composer passes its thread as the path scope and no explicit
    /// scope, and keeps the identity it always had.
    @Test
    func aThreadComposerKeepsTheThreadIDAsItsIdentity() {
        let features = FeatureComposerPowerFeatures(pathSearchScopeID: "env:thread-a")
        #expect(features.resolvedVoiceScope == .thread(id: "env:thread-a"))
        #expect(features.voiceComposerIdentity == "env:thread-a")
    }

    @Test
    func chatAndWorkOnTheSameComputerDoNotShareAnIdentity() {
        let chat = FeatureComposerPowerFeatures(voiceScope: .newChat(environmentID: "env-1"))
        let work = FeatureComposerPowerFeatures(voiceScope: .newWork(environmentID: "env-1"))
        #expect(chat.voiceComposerIdentity != work.voiceComposerIdentity)
        #expect(chat.voiceComposerIdentity != FeatureComposerPowerFeatures.disabled.voiceComposerIdentity)
    }

    /// The round trip the bug report describes: dictate in New Chat, close the
    /// sheet before the transcript lands, then open New Work. The transcript is
    /// stashed for New Chat and New Work finds nothing.
    @MainActor
    @Test
    func aNewChatTranscriptIsOnlyHandedBackToNewChat() throws {
        let stash = VoiceTranscriptStash(now: { Date(timeIntervalSince1970: 1) })
        let chat = FeatureComposerVoiceScope.newChat(environmentID: "env-1").identity
        let work = FeatureComposerVoiceScope.newWork(environmentID: "env-1").identity

        let delivery = VoiceTranscriptInsertion.deliver(
            transcript: "Plan the offsite",
            anchor: VoiceComposerAnchor(identity: chat, draft: "", range: .zero),
            target: VoiceComposerTarget(identity: work, draft: "", range: .zero)
        )
        guard case let .stashed(identity, text) = delivery else {
            Issue.record("A transcript for another surface must be stashed, not inserted.")
            return
        }
        #expect(identity == chat)
        stash.put(identity: identity, text: text)

        #expect(stash.take(identity: work) == nil)
        #expect(stash.take(identity: FeatureComposerPowerFeatures.disabled.voiceComposerIdentity) == nil)
        #expect(stash.take(identity: chat)?.text == "Plan the offsite")
    }
}
