import Foundation

// Ported from packages/shared/src/voiceInput.ts (`insertVoiceTranscript`) and
// the completion handler in apps/mobile/src/features/voice/useVoiceComposer.ts.

/// UTF-16 offsets, because that is what `UITextInput` selections are measured
/// in and what the shared TypeScript implementation uses.
public struct VoiceTextRange: Sendable, Equatable {
    public var start: Int
    public var end: Int

    public init(start: Int, end: Int) {
        self.start = start
        self.end = end
    }

    public init(caret: Int) {
        self.init(start: caret, end: caret)
    }

    public static let zero = VoiceTextRange(caret: 0)
}

public struct VoiceInsertionResult: Sendable, Equatable {
    public let text: String
    public let caret: Int
}

/// Where a finished transcript ended up.
public enum VoiceTranscriptDelivery: Sendable, Equatable {
    /// Recording started without an anchor, so there is no insertion point.
    case discarded
    /// The composer moved to a different conversation mid-transcription.
    case stashed(identity: String, text: String)
    case inserted(VoiceInsertionResult)
}

public enum VoiceTranscriptInsertion {
    /// Punctuation that already reads as attached to the preceding word, so no
    /// separating space is added before it. Mirrors `[\s,.;:!?)]`.
    private static let closingPunctuation: Set<Character> = [",", ".", ";", ":", "!", "?", ")"]

    public static func insert(
        draft: String,
        range: VoiceTextRange,
        cleanedText: String
    ) -> VoiceInsertionResult {
        let length = draft.utf16.count
        let start = min(max(range.start, 0), length)
        let end = min(max(range.end, start), length)
        let startIndex = String.Index(utf16Offset: start, in: draft)
        let endIndex = String.Index(utf16Offset: end, in: draft)
        let before = String(draft[..<startIndex])
        let after = String(draft[endIndex...])

        let inserted = boundaryPaddedInsertion(
            before: before,
            after: after,
            transcript: cleanedText
        )
        return VoiceInsertionResult(
            text: before + inserted + after,
            // An empty transcript still collapses the selection, exactly as the
            // shared implementation does: the range is replaced by nothing.
            caret: start + inserted.utf16.count
        )
    }

    private static func boundaryPaddedInsertion(
        before: String,
        after: String,
        transcript: String
    ) -> String {
        let normalized = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalized.isEmpty else { return "" }
        let needsLeadingSpace = !before.isEmpty
            && !(before.last?.isWhitespace ?? false)
            && !(normalized.first.map {
                $0.isWhitespace || closingPunctuation.contains($0)
            } ?? false)
        let needsTrailingSpace = !after.isEmpty
            && !(after.first?.isWhitespace ?? false)
            && !(normalized.last.map { $0.isWhitespace || $0 == "(" } ?? false)
        return (needsLeadingSpace ? " " : "") + normalized + (needsTrailingSpace ? " " : "")
    }
}

/// What the composer looked like when recording began.
///
/// Captured on start rather than on stop because a recording that ends on its
/// own — the duration cap, an interruption — still needs an insertion point.
public struct VoiceComposerAnchor: Sendable, Equatable {
    public let identity: String
    public let draft: String
    public let range: VoiceTextRange

    public init(identity: String, draft: String, range: VoiceTextRange) {
        self.identity = identity
        self.draft = draft
        self.range = range
    }
}

/// The composer state a transcript is being delivered into.
public struct VoiceComposerTarget: Sendable, Equatable {
    public let identity: String
    public let draft: String
    public let range: VoiceTextRange

    public init(identity: String, draft: String, range: VoiceTextRange) {
        self.identity = identity
        self.draft = draft
        self.range = range
    }
}

public extension VoiceTranscriptInsertion {
    /// Ported from `useVoiceComposer`'s `onCompleted`.
    ///
    /// A transcript belongs to the composer it was recorded against. If that
    /// composer is no longer the active one, the text is stashed under its
    /// identity instead of being pushed into whatever draft happens to be on
    /// screen. If the draft changed while transcription was in flight, the
    /// anchored range is stale and the live caret wins.
    static func deliver(
        transcript: String,
        anchor: VoiceComposerAnchor?,
        target: VoiceComposerTarget
    ) -> VoiceTranscriptDelivery {
        guard let anchor else { return .discarded }
        guard anchor.identity == target.identity else {
            return .stashed(identity: anchor.identity, text: transcript)
        }
        let range = target.draft == anchor.draft
            ? anchor.range
            : VoiceTextRange(caret: target.range.end)
        return .inserted(
            insert(draft: target.draft, range: range, cleanedText: transcript)
        )
    }
}
