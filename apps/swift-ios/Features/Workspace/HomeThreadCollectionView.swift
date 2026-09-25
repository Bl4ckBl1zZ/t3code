import SwiftUI
import UIKit

/// A recycled, diffable Home surface. SwiftUI still owns the surrounding shell,
/// while UIKit keeps row creation and updates proportional to visible threads.
struct HomeThreadCollectionView: UIViewRepresentable {
    let presentation: HomePresentation
    /// Change requests arrive on their own subscription, long after the
    /// presentation is built, so they are overlaid onto row contexts here
    /// rather than folded into it — a PR landing must not rebuild every shelf.
    let changeRequests: [String: FeaturePullRequest]
    /// Only T3 Work splits its active block into inbox sections, so the rows a
    /// workspace shows and the dividers between them are decided together.
    let workspace: MobileWorkspace
    let query: String
    let selectedThreadID: String?
    let forceRichRows: Bool
    let isSnoozedExpanded: Bool
    let isSettledExpanded: Bool
    let isArchiveExpanded: Bool
    let settledLimit: Int
    let confirmThreadUnpin: Bool
    let onOpen: (String) -> Void
    let onToggleSnoozed: () -> Void
    let onToggleSettled: () -> Void
    let onToggleArchive: () -> Void
    let onShowMoreSettled: () -> Void
    let onRename: (FeatureThread) -> Void
    let onArchive: (FeatureThread, Bool) -> Void
    let onSettle: (FeatureThread, Bool) -> Void
    let onSnooze: (FeatureThread, Date?) -> Void
    let onPin: (FeatureThread, Bool) -> Void
    /// Asks; the caller confirms before anything is deleted.
    let onDelete: (FeatureThread) -> Void
    /// Both are slow server round trips whose result is a pasteboard write or a
    /// streamed title, so the row hands them off rather than awaiting anything.
    let onCopyHandoffScript: (FeatureThread) -> Void
    /// The pasteboard copies that need no server: path, branch, thread id. The
    /// value itself comes from ``ThreadCopy``; the row only says which one.
    let onCopy: (FeatureThread, ThreadCopyTarget) -> Void
    let onRegenerateTitle: (FeatureThread) -> Void

    var draftKeys: Set<String> = []
    var isSelecting = false
    var batchSelection: Set<String> = []
    var onToggleSelection: (String) -> Void = { _ in }
    /// A two-finger pan started selecting rows.
    var onBeginSelection: () -> Void = {}
    var onDiscardDraft: (FeatureThread) -> Void = { _ in }
    var onDropFiles: ((FeatureThread, [NSItemProvider]) -> Bool)? = nil
    var onCustomSnooze: (FeatureThread) -> Void = { _ in }
    /// The leading Snooze swipe: the caller offers the presets.
    var onSnoozeRequest: (FeatureThread) -> Void = { _ in }
    /// The row's Auto-settle behavior choice: true returns the thread to the
    /// usual settlement rules, false keeps it out of Settled.
    var onSetAutoSettle: (FeatureThread, Bool) -> Void = { _, _ in }
    /// Message-content matches for the current query, by thread id. Title
    /// matching already happened in `presentation`; these add the excerpt.
    var contentMatches: [String: FeatureThreadSearchMatch] = [:]
    /// True while message search for the current query has not answered yet.
    var isSearchingContent = false
    /// Handoff scripts being generated, by thread id.
    var generatingHandoffIDs: Set<String> = []

    /// False for a tab that is not on screen: its list keeps its rows and scroll
    /// position but skips every update and stops its clock until it is shown.
    var isActive = true
    /// Redacted stand-ins while the first snapshot is on its way.
    var isPlaceholder = false
    /// The list's subtitle, as its first row, where the navigation bar has no
    /// subtitle of its own (before iOS 26).
    var subtitle: String?
    var banner: HomeConnectionBanner?
    var onReconnect: () -> Void = {}
    var onOpenConnections: () -> Void = {}
    /// What the list offers when it has no rows at all.
    var emptyState: HomeEmptyState?
    var onEmptyAction: (HomeEmptyState.Action) -> Void = { _ in }
    var onRefresh: (() async -> Void)?
    /// iPad and other regular-width windows: arrow keys move the selection,
    /// and on iOS 26 the list leaves the floating glass sidebar unpainted.
    var isRegularWidth = false

    func makeCoordinator() -> Coordinator {
        Coordinator(parent: self)
    }

    func makeUIView(context: Context) -> UICollectionView {
        var configuration = UICollectionLayoutListConfiguration(appearance: .plain)
        configuration.backgroundColor = T3Colors.uiBackground
        configuration.showsSeparators = false
        configuration.headerMode = .none
        configuration.footerMode = .none
        configuration.leadingSwipeActionsConfigurationProvider = { [weak coordinator = context.coordinator] indexPath in
            coordinator?.leadingSwipeActions(at: indexPath)
        }
        configuration.trailingSwipeActionsConfigurationProvider = { [weak coordinator = context.coordinator] indexPath in
            coordinator?.trailingSwipeActions(at: indexPath)
        }

        let collectionView = HomeListCollectionView(
            frame: .zero,
            collectionViewLayout: UICollectionViewCompositionalLayout.list(using: configuration)
        )
        collectionView.alwaysBounceVertical = true
        collectionView.keyboardDismissMode = .interactive
        collectionView.allowsMultipleSelectionDuringEditing = true
        collectionView.allowsFocus = true
        collectionView.delegate = context.coordinator
        collectionView.dropDelegate = context.coordinator
        if onRefresh != nil {
            let refreshControl = UIRefreshControl()
            refreshControl.addTarget(
                context.coordinator,
                action: #selector(Coordinator.refresh(_:)),
                for: .valueChanged
            )
            collectionView.refreshControl = refreshControl
        }
        context.coordinator.configure(collectionView)
        context.coordinator.themeRefresh = T3ThemeRefresh { [weak collectionView, weak coordinator = context.coordinator] in
            guard let collectionView else { return }
            coordinator?.applyChrome(to: collectionView)
        }
        return collectionView
    }

    func updateUIView(_ collectionView: UICollectionView, context: Context) {
        context.coordinator.update(parent: self, collectionView: collectionView)
    }

    static func dismantleUIView(_ collectionView: UICollectionView, coordinator: Coordinator) {
        coordinator.invalidateTimer()
        collectionView.delegate = nil
        collectionView.dropDelegate = nil
    }

    @MainActor
    final class Coordinator: NSObject, UICollectionViewDelegate, UICollectionViewDropDelegate {
        private enum Section: Hashable {
            case main
        }

        private var parent: HomeThreadCollectionView
        private var dataSource: UICollectionViewDiffableDataSource<Section, HomeCollectionItem.ID>?
        private var registration: UICollectionView.CellRegistration<HomeCollectionCell, HomeCollectionItem.ID>?
        private var itemsByID: [HomeCollectionItem.ID: HomeCollectionItem] = [:]
        private var selectedThreadID: String?
        private weak var collectionView: UICollectionView?
        private var timer: Timer?
        var themeRefresh: T3ThemeRefresh?
        private var timerTick = 0
        private var timerInterval: TimeInterval = 0
        private var hasLoaded = false

        init(parent: HomeThreadCollectionView) {
            self.parent = parent
            selectedThreadID = parent.selectedThreadID
        }

        func configure(_ collectionView: UICollectionView) {
            self.collectionView = collectionView

            let registration = UICollectionView.CellRegistration<HomeCollectionCell, HomeCollectionItem.ID> {
                [weak self] cell, _, identifier in
                self?.configure(cell, identifier: identifier, now: .now)
            }
            self.registration = registration

            dataSource = UICollectionViewDiffableDataSource<Section, HomeCollectionItem.ID>(
                collectionView: collectionView
            ) { [weak self] collectionView, indexPath, identifier in
                guard let self, let registration = self.registration else { return nil }
                return collectionView.dequeueConfiguredReusableCell(
                    using: registration,
                    for: indexPath,
                    item: identifier
                )
            }

            update(parent: parent, collectionView: collectionView)
        }

        func update(parent: HomeThreadCollectionView, collectionView: UICollectionView) {
            // A hidden tab keeps what it last showed. Rebuilding its rows on
            // every change to another tab's list would triple the work of each
            // snapshot for rows nobody can see.
            guard parent.isActive || !hasLoaded else {
                invalidateTimer()
                return
            }
            hasLoaded = true
            let previousItems = itemsByID
            let previousSelection = selectedThreadID
            let previousParent = self.parent
            self.parent = parent
            selectedThreadID = parent.selectedThreadID
            applyChrome(to: collectionView)

            var seenIdentifiers = Set<HomeCollectionItem.ID>()
            let items = parent.collectionItems.filter { item in
                seenIdentifiers.insert(item.id).inserted
            }
            itemsByID = Dictionary(uniqueKeysWithValues: items.map { ($0.id, $0) })
            // After items land: picks 1 Hz when a working thread is present,
            // 60s otherwise, and is a no-op when the interval is unchanged.
            startTimer()

            if collectionView.isEditing != parent.isSelecting {
                collectionView.isEditing = parent.isSelecting
            }

            guard let dataSource else { return }
            let currentIdentifiers = dataSource.snapshot().itemIdentifiers
            let newIdentifiers = items.map(\.id)

            if currentIdentifiers == newIdentifiers {
                let changed = newIdentifiers.filter { id in
                    if previousItems[id] != itemsByID[id] { return true }
                    guard case let .thread(thread, _, _, _, _) = itemsByID[id] else { return false }
                    let key = FeatureComposerDraftStore.threadKey(thread)
                    // Selection mode changes what VoiceOver says about a row,
                    // even though UIKit draws the check itself.
                    return previousParent.isSelecting != parent.isSelecting
                        || previousParent.batchSelection.contains(thread.id) != parent.batchSelection.contains(thread.id)
                        || previousParent.draftKeys.contains(key) != parent.draftKeys.contains(key)
                }
                let selectionChanged = [previousSelection, selectedThreadID]
                    .compactMap { $0.map(HomeCollectionItem.ID.thread) }
                    .filter { newIdentifiers.contains($0) }
                let identifiers = Array(Set(changed + selectionChanged))
                if !identifiers.isEmpty {
                    var snapshot = dataSource.snapshot()
                    snapshot.reconfigureItems(identifiers)
                    dataSource.apply(snapshot, animatingDifferences: false)
                }
            } else {
                var snapshot = NSDiffableDataSourceSnapshot<Section, HomeCollectionItem.ID>()
                snapshot.appendSections([.main])
                snapshot.appendItems(newIdentifiers, toSection: .main)
                // Opening a shelf or paging it is the user's own gesture, so
                // rows slide in; everything else (a turn landing, a row
                // re-sorting) updates in place rather than moving under a
                // reading eye.
                let isUserDisclosure = previousParent.isSnoozedExpanded != parent.isSnoozedExpanded
                    || previousParent.isSettledExpanded != parent.isSettledExpanded
                    || previousParent.isArchiveExpanded != parent.isArchiveExpanded
                    || previousParent.settledLimit != parent.settledLimit
                dataSource.apply(
                    snapshot,
                    animatingDifferences: isUserDisclosure && !UIAccessibility.isReduceMotionEnabled
                )
            }

            synchronizeSelection(in: collectionView)
        }

        func invalidateTimer() {
            timer?.invalidate()
            timer = nil
        }

        /// Background and keyboard behavior, which follow the window's width.
        func applyChrome(to collectionView: UICollectionView) {
            let background: UIColor
            if #available(iOS 26, *), parent.isRegularWidth {
                background = .clear
            } else {
                background = T3Colors.uiBackground
            }
            if collectionView.backgroundColor != background {
                collectionView.backgroundColor = background
            }
            if collectionView.selectionFollowsFocus != parent.isRegularWidth {
                collectionView.selectionFollowsFocus = parent.isRegularWidth
            }
        }

        /// Arrow keys open threads as they pass, as in Mail; landing on a shelf
        /// heading must not toggle it.
        func collectionView(
            _ collectionView: UICollectionView,
            selectionFollowsFocusForItemAt indexPath: IndexPath
        ) -> Bool {
            guard case .thread = item(at: indexPath) else { return false }
            return !collectionView.isEditing
        }

        @objc func refresh(_ sender: UIRefreshControl) {
            guard let onRefresh = parent.onRefresh else {
                sender.endRefreshing()
                return
            }
            Task { @MainActor in
                await onRefresh()
                sender.endRefreshing()
            }
        }

        func collectionView(_ collectionView: UICollectionView, canHandle session: UIDropSession) -> Bool {
            parent.onDropFiles != nil && !parent.isSelecting && session.localDragSession == nil &&
                session.items.contains { ThreadFileDropBatch.supportedType($0.itemProvider) != nil }
        }

        private func fileDropTarget(_ collectionView: UICollectionView, session: UIDropSession) -> (IndexPath, FeatureThread)? {
            guard !parent.isSelecting,
                let indexPath = collectionView.indexPathForItem(at: session.location(in: collectionView)),
                case let .thread(thread, _, _, _, _) = item(at: indexPath), !thread.isArchived else { return nil }
            return (indexPath, thread)
        }

        func collectionView(_ collectionView: UICollectionView, dropSessionDidUpdate session: UIDropSession, withDestinationIndexPath destinationIndexPath: IndexPath?) -> UICollectionViewDropProposal {
            guard fileDropTarget(collectionView, session: session) != nil else { return UICollectionViewDropProposal(operation: .forbidden) }
            return UICollectionViewDropProposal(operation: .copy, intent: .insertIntoDestinationIndexPath)
        }

        func collectionView(_ collectionView: UICollectionView, performDropWith coordinator: UICollectionViewDropCoordinator) {
            guard let (indexPath, thread) = fileDropTarget(collectionView, session: coordinator.session),
                parent.onDropFiles?(thread, coordinator.items.map { $0.dragItem.itemProvider }) == true else { return }
            for item in coordinator.items { coordinator.drop(item.dragItem, toItemAt: indexPath) }
        }

        func collectionView(_ collectionView: UICollectionView, shouldSelectItemAt indexPath: IndexPath) -> Bool {
            guard let item = item(at: indexPath) else { return false }
            switch item {
            case .thread, .shelfHeader, .showMoreSettled:
                return true
            case let .banner(banner):
                return banner.opensConnections && !collectionView.isEditing
            case .empty, .searchEmpty, .searchStatus, .workSectionHeader, .sectionTitle,
                 .subtitle, .placeholder:
                return false
            }
        }

        func collectionView(_ collectionView: UICollectionView, didSelectItemAt indexPath: IndexPath) {
            guard let item = item(at: indexPath) else { return }
            switch item {
            case let .thread(thread, _, _, _, _):
                if collectionView.isEditing {
                    if !parent.batchSelection.contains(thread.id) {
                        parent.onToggleSelection(thread.id)
                    }
                    return
                }
                let previousSelection = selectedThreadID
                selectedThreadID = thread.id
                parent.onOpen(thread.id)
                refreshSelection(
                    in: collectionView,
                    ids: [previousSelection, thread.id].compactMap { $0 }
                )
            case let .shelfHeader(shelf, _, _):
                collectionView.deselectItem(at: indexPath, animated: false)
                toggle(shelf)
            case .showMoreSettled:
                collectionView.deselectItem(at: indexPath, animated: false)
                parent.onShowMoreSettled()
            case .banner:
                collectionView.deselectItem(at: indexPath, animated: true)
                parent.onOpenConnections()
            case .empty, .searchEmpty, .searchStatus, .workSectionHeader, .sectionTitle,
                 .subtitle, .placeholder:
                collectionView.deselectItem(at: indexPath, animated: false)
            }
        }

        func collectionView(_ collectionView: UICollectionView, didDeselectItemAt indexPath: IndexPath) {
            guard collectionView.isEditing,
                  case let .thread(thread, _, _, _, _) = item(at: indexPath),
                  parent.batchSelection.contains(thread.id) else { return }
            parent.onToggleSelection(thread.id)
        }

        /// Two-finger pan selection, as in Mail and Files. Only thread rows
        /// start it; UIKit enters editing mode on its own once it begins.
        func collectionView(
            _ collectionView: UICollectionView,
            shouldBeginMultipleSelectionInteractionAt indexPath: IndexPath
        ) -> Bool {
            guard case .thread = item(at: indexPath) else { return false }
            return true
        }

        func collectionView(
            _ collectionView: UICollectionView,
            didBeginMultipleSelectionInteractionAt indexPath: IndexPath
        ) {
            if !parent.isSelecting { parent.onBeginSelection() }
        }

        func collectionView(
            _ collectionView: UICollectionView,
            contextMenuConfigurationForItemAt indexPath: IndexPath,
            point: CGPoint
        ) -> UIContextMenuConfiguration? {
            guard !collectionView.isEditing,
                  case let .thread(thread, _, _, isArchived, _) = item(at: indexPath) else {
                return nil
            }

            return UIContextMenuConfiguration(identifier: nil, previewProvider: nil) { [weak self] _ in
                guard let self else { return nil }
                return UIMenu(children: self.menuActions(for: thread, isArchived: isArchived))
            }
        }

        /// Pin and Snooze, as Messages and Mail put their keep-it actions on
        /// the leading edge. A full swipe pins.
        func leadingSwipeActions(at indexPath: IndexPath) -> UISwipeActionsConfiguration? {
            guard !parent.isSelecting,
                  case let .thread(thread, _, _, isArchived, _) = item(at: indexPath),
                  !isArchived else {
                return nil
            }
            var actions: [UIContextualAction] = []
            if thread.canTogglePin {
                let isPinned = thread.pinnedAt != nil
                let pin = UIContextualAction(style: .normal, title: isPinned ? "Unpin" : "Pin") {
                    [weak self] _, _, finish in
                    guard let self else {
                        finish(false)
                        return
                    }
                    self.parent.onPin(thread, !isPinned)
                    // A pending unpin confirmation closes the swipe without
                    // committing it, so cancelling leaves the row in place.
                    finish(!(isPinned && self.parent.confirmThreadUnpin))
                }
                pin.image = UIImage(systemName: isPinned ? "pin.slash.fill" : "pin.fill")
                pin.backgroundColor = .systemOrange
                actions.append(pin)
            }
            if Self.canSnooze(thread, in: parent.workspace) {
                let isSnoozed = thread.isEffectivelySnoozed(at: .now)
                let snooze = UIContextualAction(style: .normal, title: isSnoozed ? "Unsnooze" : "Snooze") {
                    [weak self] _, _, finish in
                    if isSnoozed {
                        self?.parent.onSnooze(thread, nil)
                    } else {
                        self?.parent.onSnoozeRequest(thread)
                    }
                    finish(true)
                }
                snooze.image = UIImage(systemName: isSnoozed ? "bell.fill" : "moon.zzz.fill")
                snooze.backgroundColor = .systemIndigo
                actions.append(snooze)
            }
            guard !actions.isEmpty else { return nil }
            let configuration = UISwipeActionsConfiguration(actions: actions)
            configuration.performsFirstActionWithFullSwipe = true
            return configuration
        }

        /// Settle (or Reopen, or Restore) is outermost and takes a full swipe,
        /// like Mail's Archive. Delete sits inside it, tap-only, and asks first.
        func trailingSwipeActions(at indexPath: IndexPath) -> UISwipeActionsConfiguration? {
            guard !parent.isSelecting else { return nil }
            guard case let .thread(thread, _, _, isArchived, _) = item(at: indexPath) else {
                return nil
            }

            let delete = UIContextualAction(style: .normal, title: "Delete") { [weak self] _, _, finish in
                self?.parent.onDelete(thread)
                // The row stays until the deletion is confirmed.
                finish(false)
            }
            delete.image = UIImage(systemName: "trash")
            delete.backgroundColor = .systemRed

            let primaryAction: UIContextualAction
            if isArchived {
                primaryAction = UIContextualAction(style: .normal, title: "Restore") {
                    [weak self] _, _, finish in
                    self?.parent.onArchive(thread, false)
                    finish(true)
                }
                primaryAction.image = UIImage(systemName: "arrow.uturn.backward")
                primaryAction.backgroundColor = .systemBlue
            } else if parent.workspace == .chat || !thread.canShelveSettled {
                // Chat has no parking, and a thread the Settled shelf may not
                // claim (no capability, or Work's Main thread, whose settle the
                // server refuses) has nothing to settle into.
                let configuration = UISwipeActionsConfiguration(actions: [delete])
                configuration.performsFirstActionWithFullSwipe = false
                return configuration
            } else {
                let isSettled = thread.isEffectivelySettled(
                    at: .now,
                    changeRequest: parent.changeRequests[thread.id]
                )
                primaryAction = UIContextualAction(
                    style: .normal,
                    title: isSettled ? "Reopen" : "Settle"
                ) { [weak self] _, _, finish in
                    self?.parent.onSettle(thread, !isSettled)
                    finish(true)
                }
                primaryAction.image = UIImage(
                    systemName: isSettled ? "arrow.counterclockwise" : "checkmark"
                )
                primaryAction.backgroundColor = isSettled ? .systemBlue : .systemGreen
            }

            let configuration = UISwipeActionsConfiguration(actions: [primaryAction, delete])
            configuration.performsFirstActionWithFullSwipe = true
            return configuration
        }

        private static func canSnooze(_ thread: FeatureThread, in workspace: MobileWorkspace) -> Bool {
            HomeBatchAvailability.canSnooze(thread, in: workspace)
        }

        private func configure(
            _ cell: HomeCollectionCell,
            identifier: HomeCollectionItem.ID,
            now: Date
        ) {
            guard let item = itemsByID[identifier] else { return }
            let parent = parent
            cell.contentConfiguration = UIHostingConfiguration {
                HomeCollectionCellContent(
                    item: item,
                    isSelected: identifier.threadID == selectedThreadID,
                    now: now,
                    hasDraft: hasDraft(item),
                    onReconnect: parent.onReconnect,
                    onEmptyAction: parent.onEmptyAction
                )
            }
            .margins(.all, 0)

            cell.backgroundConfiguration = UIBackgroundConfiguration.clear()
            if case .thread = item {
                cell.accessories = [.multiselect(displayed: .whenEditing)]
            } else {
                cell.accessories = []
            }
            cell.tintColor = T3Colors.uiTextPrimary
            configureAccessibility(cell, item: item)
        }

        private func hasDraft(_ item: HomeCollectionItem) -> Bool {
            guard case let .thread(thread, _, _, _, _) = item else { return false }
            return parent.draftKeys.contains(FeatureComposerDraftStore.threadKey(thread))
        }

        private func configureAccessibility(_ cell: HomeCollectionCell, item: HomeCollectionItem) {
            // Interactive rows (the banner's Reconnect, an empty state's
            // action) keep their SwiftUI elements; every other row speaks as
            // one element composed here.
            switch item {
            case .banner, .empty:
                cell.isAccessibilityElement = false
                cell.contentView.accessibilityElementsHidden = false
                cell.onAccessibilityActivate = nil
                return
            default:
                cell.contentView.accessibilityElementsHidden = true
            }
            switch item {
            case let .thread(thread, context, style, _, _):
                cell.isAccessibilityElement = true
                cell.accessibilityTraits = (parent.isSelecting ? parent.batchSelection.contains(thread.id) : selectedThreadID == thread.id)
                    ? [.button, .selected]
                    : .button
                cell.accessibilityLabel = thread.title + (hasDraft(item) ? ", unsent draft" : "")
                    + (context.searchExcerpt.map { ", \($0.speaker) \($0.match.snippet)" } ?? "")
                // The row's own style decides what it says: a Chat row has no
                // project or account worth reading on every row.
                cell.accessibilityValue = FeatureThreadRow.accessibilityValue(
                    thread: thread,
                    context: context,
                    style: style,
                    now: .now
                )
                cell.accessibilityHint = parent.isSelecting
                    ? "Toggles selection"
                    : FeatureThreadRow.accessibilityHint(for: style)
                cell.onAccessibilityActivate = { [weak self] in
                    guard let self else { return }
                    if self.parent.isSelecting {
                        self.parent.onToggleSelection(thread.id)
                        return
                    }
                    let previousSelection = self.selectedThreadID
                    self.selectedThreadID = thread.id
                    self.parent.onOpen(thread.id)
                    if let collectionView = self.collectionView {
                        self.refreshSelection(
                            in: collectionView,
                            ids: [previousSelection, thread.id].compactMap { $0 }
                        )
                    }
                }
            case let .shelfHeader(shelf, count, isExpanded):
                cell.isAccessibilityElement = true
                cell.accessibilityTraits = [.header, .button]
                cell.accessibilityLabel = "\(shelf.title), \(count) \(count == 1 ? "thread" : "threads")"
                cell.accessibilityValue = isExpanded ? "Expanded" : "Collapsed"
                cell.accessibilityHint = nil
                cell.onAccessibilityActivate = { [weak self] in self?.toggle(shelf) }
            case let .workSectionHeader(header):
                // A Work section is structure, not a control: it reads as a
                // heading and has nothing to activate.
                cell.isAccessibilityElement = true
                cell.accessibilityTraits = .header
                cell.accessibilityLabel = header.label
                cell.accessibilityValue = nil
                cell.accessibilityHint = nil
                cell.onAccessibilityActivate = nil
            case let .sectionTitle(title):
                cell.isAccessibilityElement = true
                cell.accessibilityTraits = .header
                cell.accessibilityLabel = title
                cell.accessibilityValue = nil
                cell.accessibilityHint = nil
                cell.onAccessibilityActivate = nil
            case let .showMoreSettled(remaining):
                cell.isAccessibilityElement = true
                cell.accessibilityTraits = .button
                cell.accessibilityLabel = "Show \(remaining) more settled threads"
                cell.accessibilityValue = nil
                cell.accessibilityHint = nil
                cell.onAccessibilityActivate = { [weak self] in
                    self?.parent.onShowMoreSettled()
                }
            case let .searchEmpty(query, isSearchingContent):
                cell.isAccessibilityElement = true
                cell.accessibilityTraits = .staticText
                cell.accessibilityLabel = isSearchingContent
                    ? "Searching messages"
                    : "No results for \(query)"
                cell.accessibilityValue = nil
                cell.accessibilityHint = nil
                cell.onAccessibilityActivate = nil
            case let .searchStatus(text), let .subtitle(text):
                cell.isAccessibilityElement = true
                cell.accessibilityTraits = .staticText
                cell.accessibilityLabel = text
                cell.accessibilityValue = nil
                cell.accessibilityHint = nil
                cell.onAccessibilityActivate = nil
            case let .placeholder(index):
                // One announcement for the whole stack of stand-ins.
                cell.isAccessibilityElement = index == 0
                cell.accessibilityTraits = .staticText
                cell.accessibilityLabel = "Loading threads"
                cell.accessibilityValue = nil
                cell.accessibilityHint = nil
                cell.onAccessibilityActivate = nil
            case .banner, .empty:
                break
            }
        }

        private func synchronizeSelection(in collectionView: UICollectionView) {
            // While selecting, the collection view's own selection is the
            // batch; otherwise it is the one open thread.
            let wanted: Set<String> = collectionView.isEditing
                ? parent.batchSelection
                : selectedThreadID.map { [$0] } ?? []
            for indexPath in collectionView.indexPathsForSelectedItems ?? [] {
                guard let id = dataSource?.itemIdentifier(for: indexPath)?.threadID,
                      wanted.contains(id) else {
                    collectionView.deselectItem(at: indexPath, animated: false)
                    continue
                }
            }
            let selected = Set(collectionView.indexPathsForSelectedItems ?? [])
            for id in wanted {
                guard let indexPath = dataSource?.indexPath(for: .thread(id)),
                      !selected.contains(indexPath) else { continue }
                collectionView.selectItem(at: indexPath, animated: false, scrollPosition: [])
            }
        }

        private func refreshSelection(in collectionView: UICollectionView, ids: [String]) {
            for id in ids {
                guard let indexPath = dataSource?.indexPath(for: .thread(id)),
                      let cell = collectionView.cellForItem(at: indexPath) as? HomeCollectionCell else {
                    continue
                }
                configure(cell, identifier: .thread(id), now: .now)
            }
        }

        private func item(at indexPath: IndexPath) -> HomeCollectionItem? {
            guard let identifier = dataSource?.itemIdentifier(for: indexPath) else { return nil }
            return itemsByID[identifier]
        }

        private func toggle(_ shelf: HomeShelf) {
            switch shelf {
            case .snoozed: parent.onToggleSnoozed()
            case .settled: parent.onToggleSettled()
            case .archived: parent.onToggleArchive()
            case .active: break
            }
        }

        /// The menu is decided by ``ThreadRowMenuActions`` and only rendered
        /// here: which items exist, in what order, and which are disabled is the
        /// part worth testing without UIKit.
        private func menuActions(for thread: FeatureThread, isArchived: Bool) -> [UIMenuElement] {
            let now = Date.now
            let context = ThreadRowMenuContext(
                isArchived: isArchived,
                canTogglePin: thread.canTogglePin,
                isPinned: thread.pinnedAt != nil,
                isSettled: thread.canShelveSettled && thread.isEffectivelySettled(
                    at: now,
                    changeRequest: parent.changeRequests[thread.id]
                ),
                isSnoozed: thread.canShelveSnoozed && thread.isEffectivelySnoozed(at: now),
                canSnooze: thread.state != .queued
                    && thread.state != .waitingForApproval
                    && thread.state != .waitingForInput,
                offersParking: parent.workspace != .chat,
                settlementSupported: thread.canShelveSettled,
                snoozeSupported: thread.canShelveSnoozed,
                autoSettleSupported: thread.supportsAutoSettleOptOut == true,
                autoSettleEnabled: thread.autoSettleDisabledAt == nil,
                hasWorktreePath: ThreadCopy.value(for: .path, on: thread) != nil,
                hasBranch: ThreadCopy.value(for: .branch, on: thread) != nil,
                titleRegenerationSupported: thread.canRegenerateTitle,
                isRegeneratingTitle: thread.isRegeneratingTitle,
                canArchive: thread.canArchive,
                isGeneratingHandoffScript: parent.generatingHandoffIDs.contains(thread.id),
                snoozedUntil: thread.snoozedUntil
            )

            // One inline `UIMenu` per section, so the separators the menu data
            // asks for are the rules UIKit draws between groups. The lifecycle
            // trio (pin, settle, snooze) is the top row of medium buttons.
            let sections = ThreadRowMenu.sections(ThreadRowMenuActions.homeRowActions(context, now: now))
            var menus: [UIMenuElement] = sections.map { section in
                let menu = UIMenu(
                    title: "",
                    options: .displayInline,
                    children: section.map { menuElement(for: $0, on: thread) }
                )
                if let first = section.first, Self.lifecycleActionIDs.contains(first.id) {
                    menu.preferredElementSize = .medium
                }
                return menu
            }

            let select = UIAction(title: "Select", image: UIImage(systemName: "checkmark.circle")) { [weak self] _ in
                self?.parent.onToggleSelection(thread.id)
            }
            var destructive: [UIMenuElement] = []
            if parent.draftKeys.contains(FeatureComposerDraftStore.threadKey(thread)) {
                destructive.append(UIAction(title: "Discard Draft", image: UIImage(systemName: "eraser"), attributes: .destructive) { [weak self] _ in
                    self?.parent.onDiscardDraft(thread)
                })
            }
            // Select joins its own group above the archive-and-delete group;
            // Discard Draft sits beside Delete, the other thing that throws
            // work away.
            let lastIndex = menus.count - 1
            if lastIndex >= 0, let last = menus[lastIndex] as? UIMenu {
                var children = last.children
                children.insert(contentsOf: destructive, at: max(0, children.count - 1))
                menus[lastIndex] = UIMenu(title: "", options: .displayInline, children: children)
                menus.insert(UIMenu(title: "", options: .displayInline, children: [select]), at: lastIndex)
            } else {
                menus.append(UIMenu(title: "", options: .displayInline, children: [select] + destructive))
            }
            return menus
        }

        private static let lifecycleActionIDs: Set<String> = [
            ThreadRowMenuActions.pinActionID,
            ThreadRowMenuActions.unpinActionID,
            ThreadRowMenuActions.settleActionID,
            ThreadRowMenuActions.unsettleActionID,
            ThreadRowMenuActions.snoozeActionID,
            ThreadRowMenuActions.unsnoozeActionID,
        ]

        private func menuElement(
            for action: ThreadRowMenuAction,
            on thread: FeatureThread
        ) -> UIMenuElement {
            // A disabled submenu renders as a plain disabled row: it keeps its
            // slot (hiding it would make the menu jump between renders of the
            // same row) without disclosing choices that cannot fire.
            if !action.children.isEmpty, !action.disabled {
                return UIMenu(
                    title: action.title,
                    image: action.symbol.flatMap { UIImage(systemName: $0) },
                    children: ThreadRowMenu.sections(action.children).map { section in
                        UIMenu(
                            title: "",
                            options: .displayInline,
                            children: section.map { menuElement(for: $0, on: thread) }
                        )
                    }
                )
            }
            let element = UIAction(
                title: action.title,
                subtitle: action.subtitle,
                image: action.symbol.flatMap { UIImage(systemName: $0) },
                attributes: action.destructive ? .destructive : []
            ) { [weak self] _ in
                self?.perform(action.id, on: thread)
            }
            if action.disabled { element.attributes.insert(.disabled) }
            if let checked = action.checked { element.state = checked ? .on : .off }
            return element
        }

        private func perform(_ actionID: String, on thread: FeatureThread) {
            switch actionID {
            case ThreadRowMenuActions.renameActionID:
                parent.onRename(thread)
            // Archive and restore are two ids rather than one flipping title, so
            // the row never has to re-derive which direction it is going.
            case ThreadRowMenuActions.archiveActionID:
                parent.onArchive(thread, true)
            case ThreadRowMenuActions.restoreActionID:
                parent.onArchive(thread, false)
            case ThreadRowMenuActions.pinActionID:
                parent.onPin(thread, true)
            case ThreadRowMenuActions.unpinActionID:
                parent.onPin(thread, false)
            case ThreadRowMenuActions.settleActionID:
                parent.onSettle(thread, true)
            case ThreadRowMenuActions.unsettleActionID:
                parent.onSettle(thread, false)
            case let presetID where presetID.hasPrefix(SnoozePresets.actionIDPrefix):
                // Recomputed at tap time, so a menu that sat open never
                // snoozes to the stale clock its labels were built from.
                guard let until = SnoozePresets.snoozedUntil(actionID: presetID) else { break }
                parent.onSnooze(thread, until)
            case CustomSnooze.actionID:
                parent.onCustomSnooze(thread)
            case ThreadRowMenuActions.unsnoozeActionID:
                parent.onSnooze(thread, nil)
            case ThreadRowMenuActions.autoSettleEnabledActionID:
                parent.onSetAutoSettle(thread, true)
            case ThreadRowMenuActions.autoSettleDisabledActionID:
                parent.onSetAutoSettle(thread, false)
            case ThreadRowMenuActions.copyHandoffScriptActionID:
                parent.onCopyHandoffScript(thread)
            case ThreadRowMenu.regenerateTitleActionID:
                parent.onRegenerateTitle(thread)
            case ThreadRowMenuActions.deleteActionID:
                parent.onDelete(thread)
            default:
                // The pasteboard copies share one arm: they differ only in
                // which field of the row they read.
                if let target = ThreadCopyTarget(actionID: actionID) {
                    parent.onCopy(thread, target)
                }
            }
        }

        /// Working rows show a live per-second duration, so they need a 1 Hz
        /// tick. Without any, relative ages only change by the minute, and the
        /// timer idles down to match instead of waking the main thread every
        /// second for the lifetime of the sidebar.
        private func startTimer() {
            let interval: TimeInterval = itemsByID.values.contains {
                if case let .thread(thread, _, _, _, _) = $0 {
                    return thread.homeStatus == .working
                }
                return false
            } ? 1 : 60

            if timer != nil, timerInterval == interval { return }
            invalidateTimer()
            timerInterval = interval
            timerTick = 0
            timer = Timer.scheduledTimer(withTimeInterval: interval, repeats: true) { [weak self] _ in
                MainActor.assumeIsolated {
                    self?.refreshVisibleTimes()
                }
            }
            timer?.tolerance = interval * 0.12
        }

        private func refreshVisibleTimes() {
            guard let collectionView, let dataSource else { return }
            timerTick = (timerTick + 1) % 60
            let refreshRelativeAges = timerInterval >= 60 || timerTick == 0
            let now = Date.now

            for indexPath in collectionView.indexPathsForVisibleItems {
                guard let identifier = dataSource.itemIdentifier(for: indexPath),
                      case let .thread(thread, _, _, _, _) = itemsByID[identifier],
                      refreshRelativeAges || thread.homeStatus == .working,
                      let cell = collectionView.cellForItem(at: indexPath) as? HomeCollectionCell else {
                    continue
                }
                configure(cell, identifier: identifier, now: now)
            }
        }
    }

    /// The row this workspace's list is made of.
    ///
    /// Only Code's row names a project and a branch, because only Code's threads
    /// have either. Work and Chat share one backing checkout, so the same three
    /// fields would repeat down the whole list.
    private var primaryRowStyle: FeatureThreadRow.Style {
        switch workspace {
        case .code: .rich
        case .work: .inbox
        case .chat: .conversation
        }
    }

    /// The parked and archived shelves. Code compacts them to a slim row, which
    /// leads with the project favicon — no use to a workspace whose rows all
    /// share one project, so Work and Chat keep their own row there instead.
    private var shelfRowStyle: FeatureThreadRow.Style {
        guard workspace == .code else { return primaryRowStyle }
        return forceRichRows ? .rich : .slim
    }

    private func rowContext(for thread: FeatureThread) -> HomeThreadRowContext {
        var context = presentation.rowContexts[thread.id] ?? .fallback
        context.pullRequest = changeRequests[thread.id]
        return context
    }

    private func row(_ thread: FeatureThread, style: FeatureThreadRow.Style, isArchived: Bool = false) -> HomeCollectionItem {
        .thread(thread, rowContext(for: thread), style, isArchived, forceRichRows)
    }

    /// Rows that lead the list whatever it holds: the subtitle (before iOS 26)
    /// and the connection banner.
    private var leadingItems: [HomeCollectionItem] {
        var items: [HomeCollectionItem] = []
        if let subtitle, !subtitle.isEmpty { items.append(.subtitle(subtitle)) }
        if let banner { items.append(.banner(banner)) }
        return items
    }

    var collectionItems: [HomeCollectionItem] {
        var items = leadingItems
        if isPlaceholder {
            return items + (0..<6).map(HomeCollectionItem.placeholder)
        }

        let normalizedQuery = query.trimmingCharacters(in: .whitespacesAndNewlines)
        if !normalizedQuery.isEmpty {
            let titleMatches = presentation.searchTitleResults
            let messageMatches = presentation.searchMessageResults
            if titleMatches.isEmpty, messageMatches.isEmpty {
                return items + [.searchEmpty(normalizedQuery, isSearchingContent)]
            }
            func result(_ thread: FeatureThread) -> HomeCollectionItem {
                var context = rowContext(for: thread)
                context.searchExcerpt = contentMatches[thread.id].map {
                    HomeThreadSearchExcerpt(match: $0, query: normalizedQuery)
                }
                context.showsArchivedBadge = thread.isArchived
                return .thread(thread, context, primaryRowStyle, thread.isArchived, forceRichRows)
            }
            items.append(contentsOf: titleMatches.map(result))
            if !messageMatches.isEmpty {
                items.append(.sectionTitle("Messages"))
                items.append(contentsOf: messageMatches.map(result))
            }
            // A slow environment must not look like one that has finished.
            if isSearchingContent {
                items.append(.searchStatus("Still searching messages…"))
            }
            return items
        }

        let mainStyle = primaryRowStyle
        let shelvesAreEmpty = presentation.snoozed.isEmpty
            && presentation.settled.isEmpty
            && presentation.archived.isEmpty
        if presentation.pinned.isEmpty, presentation.active.isEmpty, shelvesAreEmpty {
            if let emptyState { items.append(.empty(emptyState)) }
            return items
        }

        if !presentation.pinned.isEmpty {
            items.append(.sectionTitle("Pinned"))
            items.append(contentsOf: presentation.pinned.map { row($0, style: mainStyle) })
        }
        if workspace == .work {
            // `\.workInboxRole` rather than the closure's nil default: without
            // the role every row lands in Needs You / Active and the Main
            // section never appears at all.
            let groups = WorkInboxSections.groups(
                active: presentation.active,
                workInboxRole: \.workInboxRole
            )
            for group in groups {
                items.append(.workSectionHeader(group.header))
                items.append(contentsOf: group.rows.map { row($0, style: mainStyle) })
            }
        } else if !presentation.active.isEmpty {
            if !presentation.pinned.isEmpty {
                items.append(.sectionTitle(workspace == .chat ? "Recent" : "Active"))
            }
            items.append(contentsOf: presentation.active.map { row($0, style: mainStyle) })
        }

        // Chat has neither parking shelf: a conversation is either in the list
        // or deleted. Empty shelves are not drawn at all.
        if workspace != .chat {
            if !presentation.snoozed.isEmpty {
                items.append(.shelfHeader(.snoozed, presentation.snoozed.count, isSnoozedExpanded))
                if isSnoozedExpanded {
                    items.append(contentsOf: presentation.snoozed.map { row($0, style: shelfRowStyle) })
                }
            }
            if !presentation.settled.isEmpty {
                items.append(.shelfHeader(.settled, presentation.settled.count, isSettledExpanded))
                if isSettledExpanded {
                    items.append(contentsOf: presentation.settled.prefix(settledLimit).map { row($0, style: shelfRowStyle) })
                    if presentation.settled.count > settledLimit {
                        items.append(.showMoreSettled(presentation.settled.count - settledLimit))
                    }
                }
            }
        }

        if !presentation.archived.isEmpty {
            items.append(.shelfHeader(.archived, presentation.archived.count, isArchiveExpanded))
            if isArchiveExpanded {
                items.append(contentsOf: presentation.archived.map { row($0, style: shelfRowStyle, isArchived: true) })
            }
        }
        return items
    }
}

/// Registers itself as its view controller's content scroll view, so the
/// navigation bar's large title collapses and the tab bar minimizes as it
/// scrolls. SwiftUI only does that for its own scroll views.
private final class HomeListCollectionView: UICollectionView {
    override func didMoveToWindow() {
        super.didMoveToWindow()
        guard window != nil else { return }
        var responder: UIResponder? = next
        while let current = responder, !(current is UIViewController) {
            responder = current.next
        }
        (responder as? UIViewController)?.setContentScrollView(self)
    }
}

private final class HomeCollectionCell: UICollectionViewListCell {
    var onAccessibilityActivate: (() -> Void)?

    override func accessibilityActivate() -> Bool {
        guard let onAccessibilityActivate else { return super.accessibilityActivate() }
        onAccessibilityActivate()
        return true
    }

    override func prepareForReuse() {
        super.prepareForReuse()
        onAccessibilityActivate = nil
    }
}

enum HomeShelf: String, Hashable {
    case active
    case snoozed
    case settled
    case archived

    var title: String {
        rawValue.capitalized
    }
}

/// Internal rather than file-private so the list a workspace produces — which
/// dividers appear and where — is assertable without a collection view.
enum HomeCollectionItem: Equatable {
    enum ID: Hashable {
        case thread(String)
        case shelfHeader(HomeShelf)
        case workSectionHeader(MobileWorkInboxSection)
        case sectionTitle(String)
        case empty
        case showMoreSettled
        case searchEmpty
        case searchStatus
        case subtitle
        case banner
        case placeholder(Int)

        var threadID: String? {
            guard case let .thread(id) = self else { return nil }
            return id
        }
    }

    case thread(FeatureThread, HomeThreadRowContext, FeatureThreadRow.Style, Bool, Bool)
    case shelfHeader(HomeShelf, Int, Bool)
    case workSectionHeader(WorkInboxSectionHeader)
    /// A plain section heading: Pinned, Active, Messages.
    case sectionTitle(String)
    case empty(HomeEmptyState)
    case showMoreSettled(Int)
    /// The query, and whether message search may still add results.
    case searchEmpty(String, Bool)
    /// A footer while message search is still out.
    case searchStatus(String)
    case subtitle(String)
    case banner(HomeConnectionBanner)
    case placeholder(Int)

    var id: ID {
        switch self {
        case let .thread(thread, _, _, _, _): .thread(thread.id)
        case let .shelfHeader(shelf, _, _): .shelfHeader(shelf)
        case let .workSectionHeader(header): .workSectionHeader(header.section)
        case let .sectionTitle(title): .sectionTitle(title)
        case .empty: .empty
        case .showMoreSettled: .showMoreSettled
        case .searchEmpty: .searchEmpty
        case .searchStatus: .searchStatus
        case .subtitle: .subtitle
        case .banner: .banner
        case let .placeholder(index): .placeholder(index)
        }
    }
}

private struct HomeCollectionCellContent: View {
    let item: HomeCollectionItem
    let isSelected: Bool
    let now: Date
    var hasDraft = false
    var onReconnect: () -> Void = {}
    var onEmptyAction: (HomeEmptyState.Action) -> Void = { _ in }

    @ViewBuilder
    var body: some View {
        switch item {
        case let .thread(thread, context, style, _, allowsMultilineTitle):
            VStack(alignment: .leading, spacing: 0) {
                FeatureThreadRow(
                    thread: thread,
                    context: context,
                    isSelected: isSelected,
                    style: style,
                    now: now,
                    allowsMultilineTitle: allowsMultilineTitle,
                    hasDraft: hasDraft
                )
                .equatable()
                if let excerpt = context.searchExcerpt {
                    HomeThreadSearchExcerptText(excerpt: excerpt)
                        .padding(.horizontal, 18)
                        .padding(.bottom, 8)
                }
            }
            // A reused cell showing another thread is a new row, so a status
            // glyph only bounces when its own thread's status changes.
            .id(thread.id)
        case let .shelfHeader(shelf, count, isExpanded):
            HomeShelfHeader(title: shelf.title, count: count, isExpanded: isExpanded)
        case let .workSectionHeader(header):
            WorkInboxSectionDivider(header: header)
        case let .sectionTitle(title):
            HomeSectionTitle(title: title)
        case let .empty(state):
            ContentUnavailableView {
                Label(state.title, systemImage: state.systemImage)
            } description: {
                Text(state.message)
            } actions: {
                Button(state.actionTitle) { onEmptyAction(state.action) }
                    .t3ProminentButtonStyle()
            }
            .frame(maxWidth: .infinity, minHeight: 360)
        case let .showMoreSettled(remaining):
            Text("Show \(remaining) More")
                .font(T3Typography.homeMetadata.weight(.semibold))
                .foregroundStyle(T3Colors.accent)
                .padding(.horizontal, 18)
                .frame(maxWidth: .infinity, minHeight: T3Metrics.minimumTapTarget, alignment: .leading)
        case let .searchEmpty(query, isSearchingContent):
            Group {
                if isSearchingContent {
                    // Static: a waiting state, not a spinner.
                    Text("Searching messages…")
                        .font(T3Typography.supporting)
                        .foregroundStyle(T3Colors.textSecondary)
                } else {
                    ContentUnavailableView.search(text: query)
                }
            }
            .frame(maxWidth: .infinity, minHeight: 200)
        case let .searchStatus(text):
            Text(text)
                .font(T3Typography.supporting)
                .foregroundStyle(T3Colors.textTertiary)
                .padding(.horizontal, 18)
                .frame(maxWidth: .infinity, minHeight: T3Metrics.minimumTapTarget, alignment: .leading)
        case let .subtitle(text):
            Text(text)
                .font(.subheadline)
                .foregroundStyle(T3Colors.textSecondary)
                .padding(.horizontal, 20)
                .padding(.bottom, 6)
                .frame(maxWidth: .infinity, alignment: .leading)
        case let .banner(banner):
            HomeConnectionBannerRow(banner: banner, onReconnect: onReconnect)
        case let .placeholder(index):
            HomePlaceholderRow(index: index)
        }
    }
}

/// A plain heading between groups of rows: Pinned, Active, Messages.
private struct HomeSectionTitle: View {
    let title: String

    var body: some View {
        Text(title)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(T3Colors.textSecondary)
            .padding(.horizontal, 18)
            .padding(.top, 14)
            .padding(.bottom, 4)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// "You:" or "Agent:" plus the matched message, the query in bold.
private struct HomeThreadSearchExcerptText: View {
    let excerpt: HomeThreadSearchExcerpt

    var body: some View {
        Text(attributed)
            .font(T3Typography.supporting)
            .foregroundStyle(T3Colors.textSecondary)
            .lineLimit(2)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var attributed: AttributedString {
        var speaker = AttributedString(excerpt.speaker + " ")
        speaker.foregroundColor = excerpt.match.source == .user ? T3Colors.accent : T3Colors.success
        speaker.font = T3Typography.supportingStrong
        var snippet = AttributedString(excerpt.match.snippet)
        for range in excerpt.highlightedRanges {
            guard let lower = AttributedString.Index(range.lowerBound, within: snippet),
                  let upper = AttributedString.Index(range.upperBound, within: snippet) else { continue }
            snippet[lower..<upper].font = T3Typography.supportingStrong
            snippet[lower..<upper].foregroundColor = T3Colors.textPrimary
        }
        return speaker + snippet
    }
}
