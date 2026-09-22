import Observation
import SwiftUI

/// Undo for the lifecycle actions that move a thread out of view: archive,
/// settle, snooze and unpin. Mirrors the web sidebar's Undo notice.
///
/// An action claims its kind for one thread before it is sent, and offers its
/// undo once the server accepts it. Consecutive actions of the same kind share
/// one notice ("Settled 3 threads") and undo together. A reverse action on the
/// thread, such as reopening one whose settle is still undoable, retires the
/// claim so a stale undo never replays. Notices expire after five seconds.
@MainActor
@Observable
final class ThreadUndoCenter {
    enum Kind: Hashable {
        case archive, settle, snooze, pin
    }

    enum Action: String, Equatable {
        case archived = "Archived"
        case settled = "Settled"
        case snoozed = "Snoozed"
        case unpinned = "Unpinned"
    }

    struct Notice: Equatable {
        let action: Action
        let count: Int

        var title: String {
            count == 1 ? action.rawValue : "\(action.rawValue) \(count) threads"
        }
    }

    struct Claim {
        fileprivate let key: Key
        fileprivate let token: UInt64
    }

    fileprivate struct Key: Hashable {
        let kind: Kind
        let threadID: String
    }

    private struct Entry {
        let claim: Claim
        let action: Action
        let undo: @MainActor () async -> Void
    }

    private(set) var notice: Notice?
    @ObservationIgnored private var claims: [Key: UInt64] = [:]
    @ObservationIgnored private var entries: [Entry] = []
    @ObservationIgnored private var nextToken: UInt64 = 0
    @ObservationIgnored private var expiry: Task<Void, Never>?
    @ObservationIgnored private let lifetime: Duration

    init(lifetime: Duration = .seconds(5)) {
        self.lifetime = lifetime
    }

    /// Claims one kind of action on a thread before it is sent. A later claim
    /// of the same kind replaces it and expires the undo it offered.
    func begin(_ kind: Kind, threadID: String) -> Claim {
        nextToken &+= 1
        let key = Key(kind: kind, threadID: threadID)
        claims[key] = nextToken
        refresh()
        return Claim(key: key, token: nextToken)
    }

    func isCurrent(_ claim: Claim) -> Bool {
        claims[claim.key] == claim.token
    }

    /// Releases a claim whose action failed.
    func finish(_ claim: Claim) {
        guard isCurrent(claim) else { return }
        claims[claim.key] = nil
        refresh()
    }

    /// Expires only this kind of action on the thread.
    func invalidate(_ kind: Kind, threadID: String) {
        guard claims.removeValue(forKey: Key(kind: kind, threadID: threadID)) != nil else { return }
        refresh()
    }

    /// Offers the undo for an action the server accepted. Ignored when a
    /// reverse action retired the claim while this one was in flight.
    func offer(_ claim: Claim, action: Action, undo: @escaping @MainActor () async -> Void) {
        guard isCurrent(claim) else { return }
        entries.append(Entry(claim: claim, action: action, undo: undo))
        refresh()
        expiry?.cancel()
        expiry = Task { [weak self, lifetime] in
            try? await Task.sleep(for: lifetime)
            guard !Task.isCancelled else { return }
            self?.expireAll()
        }
    }

    /// Undoes the group the notice shows. False when nothing is left to undo.
    @discardableResult
    func undoLatest() async -> Bool {
        let group = latestGroup()
        guard !group.isEmpty else { return false }
        // Consume every claim before awaiting, so a second tap or shake cannot
        // restore the same group twice.
        for entry in group {
            claims[entry.claim.key] = nil
        }
        refresh()
        for entry in group {
            await entry.undo()
        }
        return true
    }

    /// Ends every pending undo now.
    func expireAll() {
        for entry in entries where isCurrent(entry.claim) {
            claims[entry.claim.key] = nil
        }
        entries.removeAll()
        refresh()
    }

    /// The trailing run of live entries that share the newest entry's action.
    private func latestGroup() -> [Entry] {
        let live = entries.filter { isCurrent($0.claim) }
        guard let latest = live.last else { return [] }
        return Array(live.reversed().prefix { $0.action == latest.action })
    }

    private func refresh() {
        entries.removeAll { !isCurrent($0.claim) }
        let group = latestGroup()
        let next = group.first.map { Notice(action: $0.action, count: group.count) }
        if next == nil {
            expiry?.cancel()
            expiry = nil
        }
        if notice != next { notice = next }
    }
}

/// The Undo notice floating at the bottom of Home. Also registers the undo
/// with the window's undo manager, so shake to undo and ⌘Z on a hardware
/// keyboard restore the same group.
struct ThreadUndoPill: View {
    let center: ThreadUndoCenter

    @SwiftUI.Environment(\.undoManager) private var undoManager
    @SwiftUI.Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        // The spacer keeps the view alive while no notice shows, so the undo
        // manager registration follows the notice in and out.
        VStack(spacing: 0) {
            Spacer(minLength: 0)
            if let notice = center.notice {
                pill(notice)
                    .transition(reduceMotion ? .opacity : .move(edge: .bottom).combined(with: .opacity))
            }
        }
        .animation(.easeOut(duration: 0.2), value: center.notice)
        .onAppear { register(center.notice) }
        .onChange(of: center.notice) { _, notice in register(notice) }
        .onDisappear { undoManager?.removeAllActions(withTarget: center) }
    }

    private func pill(_ notice: ThreadUndoCenter.Notice) -> some View {
        let shape = Capsule(style: .continuous)
        return HStack(spacing: 12) {
            Text(notice.title)
                .font(T3Typography.supporting)
                .foregroundStyle(T3Colors.textPrimary)
                .contentTransition(.numericText())
            Button("Undo") { Task { await center.undoLatest() } }
                .font(T3Typography.supportingStrong)
                .foregroundStyle(T3Colors.accent)
                .accessibilityHint("Restores the threads you just \(notice.action.rawValue.lowercased())")
        }
        .padding(.leading, 16)
        .padding(.trailing, 12)
        .frame(minHeight: T3Metrics.minimumTapTarget)
        .t3GlassEffect(.regular, in: shape)
        .t3GlassRim(in: shape)
        .padding(.bottom, 8)
        .accessibilityIdentifier("thread-undo-notice")
    }

    private func register(_ notice: ThreadUndoCenter.Notice?) {
        guard let undoManager else { return }
        undoManager.removeAllActions(withTarget: center)
        guard let notice else { return }
        undoManager.registerUndo(withTarget: center) { center in
            Task { await center.undoLatest() }
        }
        undoManager.setActionName(notice.title)
    }
}
