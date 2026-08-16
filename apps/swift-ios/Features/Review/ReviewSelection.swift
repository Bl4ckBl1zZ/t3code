import Foundation
import Observation

// Ported from apps/mobile/src/features/review/reviewState.ts (the per-thread
// selected-section and selected-file atoms), the effect in ReviewSheet.tsx that
// consumes the preselected file, and the section-fallback effect in
// useReviewSections.ts.
//
// A changed-files row in the thread feed can open the review already pointed at
// one file. That is a handoff between two screens with a load in between: the
// review does not have the diff yet when the request arrives, so the request has
// to survive until the diff parses and then be spent exactly once. Spending it
// unconditionally — before checking whether the file is even in this diff — is
// what stops a stale path re-triggering on every later parse.

/// What one thread's review is pointed at.
public struct ReviewSelection: Equatable, Sendable {
    /// The review section (working tree, or one turn's checkpoint). `nil` until
    /// the sections load and the fallback resolves.
    public var sectionID: String?
    /// A file preselected from outside the review, consumed once. Held as a path
    /// rather than a file id because the feed row that sets it has a path and no
    /// parsed diff to resolve an id against.
    public var filePath: String?

    public init(sectionID: String? = nil, filePath: String? = nil) {
        self.sectionID = sectionID
        self.filePath = filePath
    }

    public var isEmpty: Bool {
        sectionID == nil && filePath == nil
    }
}

/// Review selection for every thread, with the rules that clear it.
///
/// A value type so the rules are testable without a view: the observable store
/// below is a thin wrapper.
public struct ReviewSelectionState: Equatable, Sendable {
    public private(set) var selectionsByThreadID: [String: ReviewSelection] = [:]

    public init() {}

    public func selection(for threadID: String) -> ReviewSelection {
        selectionsByThreadID[threadID] ?? ReviewSelection()
    }

    /// Points the review at a section. Called by the feed's "Open diff" with the
    /// checkpoint's section, and by the review's own section picker.
    public mutating func selectSection(_ sectionID: String?, for threadID: String) {
        update(threadID) { $0.sectionID = sectionID }
    }

    /// Arms the one-shot file preselection. `nil` disarms it.
    public mutating func selectFile(_ filePath: String?, for threadID: String) {
        update(threadID) { $0.filePath = filePath }
    }

    /// Spends the preselected file against a parsed diff.
    ///
    /// Returns the file to scroll to, or `nil` when there is nothing to do yet
    /// or nothing to match. An empty `files` means the section's diff has not
    /// parsed — the request waits rather than being spent on a diff that cannot
    /// contain it. Once there *is* a diff the path is cleared whether or not it
    /// matched, so a file that is not in this section cannot re-trigger on every
    /// subsequent parse.
    public mutating func consumePreselectedFile(
        for threadID: String,
        files: [FeatureReviewFile]
    ) -> FeatureReviewFile? {
        guard let filePath = selection(for: threadID).filePath, !files.isEmpty else {
            return nil
        }
        update(threadID) { $0.filePath = nil }
        // A rename shows under its new path but may have been requested by the
        // old one, so both sides of the rename resolve to the same row.
        return files.first { $0.path == filePath || $0.previousPath == filePath }
    }

    /// Resolves which section the review shows, and remembers it.
    ///
    /// A stored section that the current list no longer contains — a checkpoint
    /// that scrolled out of the window, a thread whose turns were cleared —
    /// falls back to the first section rather than leaving the review blank.
    /// With no sections at all there is nothing to fall back onto, so the stored
    /// value is left untouched for the sections to arrive.
    @discardableResult
    public mutating func resolveSelectedSection(
        for threadID: String,
        availableSectionIDs: [String]
    ) -> String? {
        guard !availableSectionIDs.isEmpty else { return selection(for: threadID).sectionID }
        let current = selection(for: threadID).sectionID
        if let current, availableSectionIDs.contains(current) { return current }
        let fallback = availableSectionIDs[0]
        update(threadID) { $0.sectionID = fallback }
        return fallback
    }

    /// Drops a thread's selection. Deleting the thread is the only thing that
    /// should: the selection outlives leaving and re-entering the review, which
    /// is the whole point of keying it by thread.
    public mutating func forget(threadID: String) {
        selectionsByThreadID.removeValue(forKey: threadID)
    }

    private mutating func update(
        _ threadID: String,
        _ transform: (inout ReviewSelection) -> Void
    ) {
        var selection = selection(for: threadID)
        transform(&selection)
        if selection.isEmpty {
            selectionsByThreadID.removeValue(forKey: threadID)
        } else {
            selectionsByThreadID[threadID] = selection
        }
    }
}

/// App-lifetime review selection, shared by the thread feed (which arms it) and
/// the review screen (which spends it).
@MainActor
@Observable
public final class ReviewSelectionStore {
    public private(set) var state = ReviewSelectionState()

    public init() {}

    public func selection(for threadID: String) -> ReviewSelection {
        state.selection(for: threadID)
    }

    /// Opens the review pointed at a checkpoint's section and, when a file chip
    /// was tapped rather than the row itself, that file.
    public func openReview(
        threadID: String,
        sectionID: String?,
        filePath: String?
    ) {
        if let sectionID { state.selectSection(sectionID, for: threadID) }
        state.selectFile(filePath, for: threadID)
    }

    public func selectSection(_ sectionID: String?, for threadID: String) {
        state.selectSection(sectionID, for: threadID)
    }

    public func selectFile(_ filePath: String?, for threadID: String) {
        state.selectFile(filePath, for: threadID)
    }

    public func consumePreselectedFile(
        for threadID: String,
        files: [FeatureReviewFile]
    ) -> FeatureReviewFile? {
        state.consumePreselectedFile(for: threadID, files: files)
    }

    @discardableResult
    public func resolveSelectedSection(
        for threadID: String,
        availableSectionIDs: [String]
    ) -> String? {
        state.resolveSelectedSection(for: threadID, availableSectionIDs: availableSectionIDs)
    }

    public func forget(threadID: String) {
        state.forget(threadID: threadID)
    }
}
