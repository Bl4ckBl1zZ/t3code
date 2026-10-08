import SwiftUI

/// Settle or Reopen, Snooze or Unsnooze, and Mark as Read or Unread, inside the
/// chat's Thread Actions menu. Built from the Home row menu's own rules
/// (``ThreadRowMenuActions``), so the chat offers exactly what the list does,
/// and run through the root model, so Undo and read state behave the same.
///
/// The user stays in the thread after each one, as on web's chat header. The
/// status line under the transcript then offers the way back (Wake now,
/// Un-settle); a thread marked unread stays unread while it sits open, and
/// reads again once reopened or once something new happens in it.
struct ThreadChatLifecycleActions: View {
    let thread: FeatureThread
    let model: FeatureRootModel
    /// False in a Chat conversation, which has no parking shelves.
    let offersParking: Bool
    let onCustomSnooze: () -> Void

    static let actionIDs: Set<String> = [
        ThreadRowMenuActions.settleActionID,
        ThreadRowMenuActions.unsettleActionID,
        ThreadRowMenuActions.snoozeActionID,
        ThreadRowMenuActions.unsnoozeActionID,
        ThreadRowMenuActions.markReadActionID,
        ThreadRowMenuActions.markUnreadActionID,
    ]

    /// The Home row's actions this menu carries, in the row's order. Pin,
    /// naming, copy and archive have their own places in the chat.
    static func actions(_ context: ThreadRowMenuContext, now: Date) -> [ThreadRowMenuAction] {
        ThreadRowMenuActions.homeRowActions(context, now: now).filter { actionIDs.contains($0.id) }
    }

    var body: some View {
        let now = Date.now
        let context = ThreadRowMenuContext(
            thread: thread,
            isArchived: thread.isArchived,
            offersParking: offersParking,
            now: now,
            changeRequest: model.changeRequestsByThreadID[thread.id]
        )
        ForEach(Self.actions(context, now: now)) { action in
            if action.children.isEmpty || action.disabled {
                button(action)
            } else {
                Menu {
                    ForEach(ThreadRowMenu.sections(action.children), id: \.first?.id) { section in
                        Section {
                            ForEach(section) { button($0) }
                        }
                    }
                } label: {
                    label(action)
                }
            }
        }
    }

    private func button(_ action: ThreadRowMenuAction) -> some View {
        Button(role: action.destructive ? .destructive : nil) {
            perform(action.id)
        } label: {
            label(action)
        }
        .disabled(action.disabled)
    }

    @ViewBuilder
    private func label(_ action: ThreadRowMenuAction) -> some View {
        if let symbol = action.symbol {
            Label {
                Text(action.title)
                if let subtitle = action.subtitle { Text(subtitle) }
            } icon: {
                Image(systemName: symbol)
            }
        } else {
            Text(action.title)
            if let subtitle = action.subtitle { Text(subtitle) }
        }
    }

    private func perform(_ actionID: String) {
        let id = thread.id
        switch actionID {
        case ThreadRowMenuActions.settleActionID:
            Task { await model.setSettled(id, settled: true) }
        case ThreadRowMenuActions.unsettleActionID:
            Task { await model.setSettled(id, settled: false) }
        case ThreadRowMenuActions.unsnoozeActionID:
            Task { await model.setSnoozed(id, until: nil) }
        case let presetID where presetID.hasPrefix(SnoozePresets.actionIDPrefix):
            // Recomputed at tap time, like the row menu.
            guard let until = SnoozePresets.snoozedUntil(actionID: presetID) else { return }
            Task { await model.setSnoozed(id, until: until) }
        case CustomSnooze.actionID:
            onCustomSnooze()
        case ThreadRowMenuActions.markReadActionID:
            Task { await model.markThreadRead(id) }
        case ThreadRowMenuActions.markUnreadActionID:
            Task { await model.markThreadUnread(id) }
        default:
            break
        }
    }
}
