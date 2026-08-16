import Observation
import SwiftUI
import UIKit

/// Tracks where the caret sits inside the focused composer so a transcript is
/// inserted at the insertion point rather than appended.
///
/// SwiftUI's `TextField`/`TextEditor` expose no selection binding before iOS
/// 18, and this target deploys to iOS 17, so the caret is read from the
/// first-responder text input that UIKit announces through its selection and
/// text-change notifications. When nothing has been observed — the composer is
/// not focused, or the platform routed the edit some other way — callers fall
/// back to the end of the draft, which is where an append would have gone
/// anyway.
@MainActor
@Observable
public final class VoiceComposerCaret {
    @ObservationIgnored
    private weak var responder: (any UITextInput)?
    @ObservationIgnored
    private var observers: [any NSObjectProtocol] = []
    private var trackedRange: VoiceTextRange?

    public init() {}

    deinit {
        let center = NotificationCenter.default
        for observer in observers { center.removeObserver(observer) }
    }

    /// The caret to insert at, clamped into `draft` and defaulting to its end.
    public func range(in draft: String) -> VoiceTextRange {
        let length = draft.utf16.count
        guard let trackedRange, trackedRange.start <= length, trackedRange.end <= length else {
            return VoiceTextRange(caret: length)
        }
        return trackedRange
    }

    public func startTracking() {
        guard observers.isEmpty else { return }
        let center = NotificationCenter.default
        // UIKit publishes no selection-change notification; that signal exists
        // only on UITextViewDelegate, which SwiftUI owns. So a bare caret move
        // (tapping elsewhere without typing) is not observed, and insertion
        // falls back to the last caret seen while editing, or end-of-draft.
        let names: [Notification.Name] = [
            UITextView.textDidChangeNotification,
            UITextView.textDidBeginEditingNotification,
            UITextField.textDidChangeNotification,
            UITextField.textDidBeginEditingNotification,
        ]
        observers = names.map { name in
            center.addObserver(forName: name, object: nil, queue: .main) { [weak self] notification in
                MainActor.assumeIsolated {
                    self?.capture(notification.object)
                }
            }
        }
    }

    public func stopTracking() {
        let center = NotificationCenter.default
        for observer in observers { center.removeObserver(observer) }
        observers = []
        responder = nil
        trackedRange = nil
    }

    /// Best-effort caret placement after an insertion. SwiftUI pushes the new
    /// string into the text view on the next update, so this runs after a yield;
    /// if the responder went away the system's own caret handling stands.
    public func moveCaret(to offset: Int) {
        Task { @MainActor [weak self] in
            await Task.yield()
            guard let self, let responder = self.responder else { return }
            guard let position = responder.position(
                from: responder.beginningOfDocument,
                offset: offset
            ) else { return }
            responder.selectedTextRange = responder.textRange(from: position, to: position)
            self.trackedRange = VoiceTextRange(caret: offset)
        }
    }

    private func capture(_ object: Any?) {
        // Only the focused input can own the composer's caret; a background
        // text view still posting change notifications must not steal it.
        guard let input = object as? any UITextInput,
              (object as? UIResponder)?.isFirstResponder == true else {
            return
        }
        responder = input
        guard let selection = input.selectedTextRange else {
            trackedRange = nil
            return
        }
        let start = input.offset(from: input.beginningOfDocument, to: selection.start)
        let end = input.offset(from: input.beginningOfDocument, to: selection.end)
        trackedRange = VoiceTextRange(start: start, end: max(start, end))
    }
}
