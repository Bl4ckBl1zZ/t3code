import PhotosUI
import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// Why a compose sheet's send is off, shown inline in the pill so a send
/// button that cannot work never looks like it can. The action, when there is
/// one, is the way forward ("Retry", "Choose Branch"). An empty message turns
/// send off without drawing a row, for waits too short to explain.
struct FeatureComposerSendBlocker {
    var message: String
    var systemImage: String
    var actionTitle: String?
    var action: (() -> Void)?

    init(
        _ message: String,
        systemImage: String = "exclamationmark.circle",
        actionTitle: String? = nil,
        action: (() -> Void)? = nil
    ) {
        self.message = message
        self.systemImage = systemImage
        self.actionTitle = actionTitle
        self.action = action
    }
}

/// The glass composer shared by threads and the compose sheets.
///
/// One r=26 glass rect in two rows: the draft owns the first, and the second
/// holds the plus menu, the model chip, Plan, the context ring and a single
/// trailing slot that is the mic while the draft is empty, the ink send arrow
/// once there is something to send, and the ink stop circle while a turn runs.
struct FeatureComposerView: View {
    /// True while the file importer is on screen. Presenting it resigns the
    /// keyboard, and the composer needs to know a presentation it just opened
    /// is the reason focus went away.
    @State private var isPickingAttachment = false
    @State private var isFileDropTargeted = false
    @State private var fileDropError: String?
    /// The in-pill camera / photo-picker window. Files stay on the native
    /// document picker.
    @State private var mediaSurface: ComposerMediaSurface?
    /// Hands the plus menu's Files choice to the picker, which owns that
    /// presentation.
    @State private var requestedAttachmentSource: FeatureAttachmentSource?
    /// Whether the keyboard was up when a recording began, so it can be pinned
    /// open through the recording and restored after transcription.
    @State private var resumeFocusAfterVoice = false
    @State private var attachmentPreparation = FeatureAttachmentPreparationState()
    /// Images that failed to prepare, kept as retryable tiles in the strip.
    @State private var attachmentFailures: [FeatureAttachmentFailure] = []
    /// The task-settings sheet, and the screen it opens on.
    @State private var taskSettings: TaskSettingsEntry?
    /// Stop was tapped: the slot shows a spinner until the turn ends.
    @State private var stopRequested = false
    /// The draft the reader dismissed suggestions for with Esc. Suggestions come
    /// back as soon as the draft changes.
    @State private var dismissedSuggestionText: String?
    @State private var highlightedSuggestion = 0
    @State private var pathEntries: [FeatureComposerPathEntry] = []
    @State private var isPathSearchLoading = false
    @State private var pathSearchError: String?
    /// App-wide rather than per-composer: a dictation started here has to
    /// survive navigating away, which is the whole point of the transcript
    /// stash. The caret tracker stays per-composer because it follows this
    /// view's own text input.
    private let voice = VoiceComposerCoordinator.shared
    @State private var caret = VoiceComposerCaret()
    @SwiftUI.Environment(\.accessibilityReduceMotion) private var reduceMotion
    @SwiftUI.Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @SwiftUI.Environment(\.scenePhase) private var scenePhase
    @ScaledMetric(relativeTo: .body) private var slotCircleSize: CGFloat = 34
    @Binding private var storedText: String
    private var text: String {
        get { ReviewCommentContext.removingBlocks(from: AssistantCitation.removingMarkers(from: storedText)) }
        nonmutating set {
            storedText = ReviewCommentContext.replacingPlainText(in: storedText,
                with: AssistantCitation.replacingPlainText(in: storedText, with: newValue))
        }
    }
    private var textBinding: Binding<String> { Binding(get: { text }, set: { text = $0 }) }
    @Binding private var selection: FeatureSelection?
    @Binding private var attachments: [FeatureDraftAttachment]
    /// The thread's Plan/Build mode, or nil on a surface that has no mode to
    /// offer. A binding rather than a callback so a thread composer can write
    /// straight through to thread state while a compose sheet holds its own
    /// pending choice.
    private let interactionMode: Binding<FeatureInteractionMode>?

    private let providers: [FeatureProvider]
    private let providerSetup: ProviderSetupContext?
    private let threadSelection: FeatureSelection?
    private let materializesDefaultSelection: Bool
    private let isSending: Bool
    private let isWorking: Bool
    /// The turn in flight, rendered as a band across the top of the pill. Nil on
    /// a surface with no thread behind it — a compose sheet has nothing running.
    private let workingStatus: ThreadWorkingStatus?
    private let focused: FocusState<Bool>.Binding
    private let contextUsage: Double?
    private let forceExpanded: Bool
    private let readingHistory: Bool
    private let pendingApprovals: [FeatureApproval]
    private let pendingUserInputs: [FeatureUserInput]
    private let isResolvingRequest: Bool
    private let powerFeatures: FeatureComposerPowerFeatures
    private let sendBlocker: FeatureComposerSendBlocker?
    private let historyMessages: () -> [FeatureMessage]
    private let historyDraftKey: String?
    private let historyDraftStore: FeatureComposerDraftStore
    private let onWillStash: () async -> Void
    private let onDidStash: () -> Void
    private let externalFileDrop: ThreadFileDropBatch?
    private let onExternalFileDropConsumed: (UUID) -> Void
    @State private var historyGeneration = UUID()
    @State private var promptHistory = ComposerPromptHistory()
    @State private var stashedDrafts: [FeatureComposerStashEntry] = []
    @State private var showsStash = false
    @State private var isStashing = false
    @State private var historyError: ComposerHistoryError?
    private let onSend: () -> Void
    private let onStop: () -> Void
    private let onApprovalDecision: ((String, FeatureApprovalDecision) -> Void)?
    private let onUserInputSubmit: ((String, [String: FeatureInputAnswer], [String: [FeatureUploadAttachment]], Bool) -> Void)?

    init(
        text: Binding<String>,
        selection: Binding<FeatureSelection?>,
        attachments: Binding<[FeatureDraftAttachment]>,
        interactionMode: Binding<FeatureInteractionMode>? = nil,
        providers: [FeatureProvider],
        providerSetup: ProviderSetupContext? = nil,
        threadSelection: FeatureSelection?,
        materializesDefaultSelection: Bool = true,
        isSending: Bool,
        isWorking: Bool,
        workingStatus: ThreadWorkingStatus? = nil,
        focused: FocusState<Bool>.Binding,
        onSend: @escaping () -> Void,
        onStop: @escaping () -> Void,
        contextUsage: Double? = nil,
        forceExpanded: Bool = false,
        readingHistory: Bool = false,
        pendingApprovals: [FeatureApproval] = [],
        pendingUserInputs: [FeatureUserInput] = [],
        isResolvingRequest: Bool = false,
        powerFeatures: FeatureComposerPowerFeatures = .disabled,
        sendBlocker: FeatureComposerSendBlocker? = nil,
        historyMessages: @escaping () -> [FeatureMessage] = { [] },
        historyDraftKey: String? = nil,
        historyDraftStore: FeatureComposerDraftStore = .shared,
        onWillStash: @escaping () async -> Void = {},
        onDidStash: @escaping () -> Void = {},
        externalFileDrop: ThreadFileDropBatch? = nil,
        onExternalFileDropConsumed: @escaping (UUID) -> Void = { _ in },
        onApprovalDecision: ((String, FeatureApprovalDecision) -> Void)? = nil,
        onUserInputSubmit: ((String, [String: FeatureInputAnswer], [String: [FeatureUploadAttachment]], Bool) -> Void)? = nil
    ) {
        _storedText = text
        _selection = selection
        _attachments = attachments
        self.interactionMode = interactionMode
        self.providers = providers
        self.providerSetup = providerSetup
        self.threadSelection = threadSelection
        self.materializesDefaultSelection = materializesDefaultSelection
        self.isSending = isSending
        self.isWorking = isWorking
        self.workingStatus = workingStatus
        self.focused = focused
        self.onSend = onSend
        self.onStop = onStop
        self.contextUsage = contextUsage
        self.forceExpanded = forceExpanded
        self.readingHistory = readingHistory
        self.pendingApprovals = pendingApprovals
        self.pendingUserInputs = pendingUserInputs
        self.isResolvingRequest = isResolvingRequest
        self.powerFeatures = powerFeatures
        self.sendBlocker = sendBlocker
        self.historyMessages = historyMessages
        self.historyDraftKey = historyDraftKey
        self.historyDraftStore = historyDraftStore
        self.onWillStash = onWillStash
        self.onDidStash = onDidStash
        self.externalFileDrop = externalFileDrop
        self.onExternalFileDropConsumed = onExternalFileDropConsumed
        self.onApprovalDecision = onApprovalDecision
        self.onUserInputSubmit = onUserInputSubmit
    }

    // The body is staged in three pieces only so the type checker can follow
    // the modifier chain: content and its presentations, then the voice and
    // focus choreography, then lifecycle.
    var body: some View {
        voiceBehavior
            .onChange(of: composerTrigger?.query) { highlightedSuggestion = 0 }
            .onChange(of: isWorking) { _, working in
                if !working { stopRequested = false }
            }
            // A stop that never lands (the request failed, the turn is already
            // over) must not leave a lying spinner in the slot.
            .task(id: stopRequested) {
                guard stopRequested else { return }
                try? await Task.sleep(for: .seconds(8))
                guard !Task.isCancelled else { return }
                stopRequested = false
            }
            .task(id: pathSearchRequest) {
                await updatePathSearch()
            }
            .onAppear {
                caret.startTracking()
                attachVoice()
                // The picker used to own this: mounting it was what materialized
                // a missing selection. The composer keeps the rule running
                // whether or not a model surface is ever opened.
                materializeModelSelection()
            }
            .onDisappear {
                historyGeneration = UUID()
                caret.stopTracking()
                voice.detach(identity: powerFeatures.voiceComposerIdentity)
            }
            .onChange(of: providers) { materializeModelSelection() }
            .onChange(of: selection) { materializeModelSelection() }
            .onChange(of: powerFeatures.voiceComposerIdentity) { attachVoice() }
            .onChange(of: voice.state) { voice.surfaceFailureAlert() }
            .alert(
                voice.alert?.title ?? "",
                isPresented: Binding(
                    get: { voice.alert != nil },
                    set: { if !$0 { voice.alert = nil } }
                ),
                presenting: voice.alert
            ) { alert in
                voiceAlertActions(alert)
            } message: { alert in
                Text(alert.message)
            }
    }

    private var content: some View {
        VStack(spacing: 8) {
            if !AssistantCitation.matches(in: storedText).isEmpty {
                AssistantCitationChips(text: $storedText).disabled(isSending || isStashing)
            }
            if !ReviewCommentContext.matches(in: storedText).isEmpty {
                ReviewCommentContextChips(text: $storedText).disabled(isSending || isStashing)
            }
            composerSurface
        }
            // The Files presentation hangs off a view that never leaves the
            // tree: presenting resigns the keyboard, and anything that tore
            // the host down on that focus loss would dismiss the importer.
            .background {
                FeatureImageAttachmentPicker(
                    attachments: $attachments,
                    preparationState: $attachmentPreparation,
                    isPresentingSource: $isPickingAttachment,
                    requestedSource: $requestedAttachmentSource,
                    showsControl: false,
                    isEnabled: imagesAllowed
                )
            }
            .onDrop(of: [UTType.data], isTargeted: $isFileDropTargeted, perform: receiveDroppedFiles)
            .alert("Couldn’t Attach Files", isPresented: Binding(get: { fileDropError != nil }, set: { if !$0 { fileDropError = nil } })) {
                Button("OK") { fileDropError = nil }
            } message: { Text(fileDropError ?? "") }
            .task(id: readyExternalFileDropID) { await receiveExternalFileDrop() }
            .task(id: historyDraftKey) {
                historyGeneration = UUID()
                promptHistory = ComposerPromptHistory()
                stashedDrafts = []
                showsStash = false
                attachmentFailures = []
                guard let historyDraftKey else { stashedDrafts = []; return }
                do {
                    let saved = try await historyDraftStore.stashEntries(for: historyDraftKey)
                    guard !Task.isCancelled, self.historyDraftKey == historyDraftKey else { return }
                    stashedDrafts = saved
                }
                catch { historyError = ComposerHistoryError("Couldn’t Load Stashed Drafts", error) }
            }
            .sheet(isPresented: $showsStash) {
                ComposerStashSheet(entries: stashedDrafts, busy: isStashing, error: historyError?.message,
                    restore: { entry in mutateStash(restoring: entry.id) },
                    remove: { entry in removeStash(entry.id) })
            }
            .sheet(item: $taskSettings, onDismiss: { focused.wrappedValue = true }) { entry in
                TaskSettingsSheet(
                    selection: $selection,
                    providers: providers,
                    threadSelection: threadSelection,
                    materializesDefaultSelection: materializesDefaultSelection,
                    setupContext: providerSetup,
                    entry: entry
                )
            }
            .alert(historyError?.title ?? "", isPresented: Binding(get: { historyError != nil && !showsStash }, set: { if !$0 { historyError = nil } })) {
                Button("OK") { historyError = nil }
            } message: { Text(historyError?.message ?? "") }
            .overlay(alignment: .top) {
                if showsCommandMenu, let trigger = composerTrigger {
                    FeatureComposerCommandPopover(
                        triggerKind: trigger.kind,
                        items: commandMenuItems,
                        highlightedIndex: highlightedSuggestion,
                        isLoading: isPathSearchLoading,
                        errorMessage: pathSearchError,
                        pathSearchAvailable: powerFeatures.searchPaths != nil,
                        onSelect: selectCommandItem,
                        onRetry: retryPathSearch
                    )
                    .alignmentGuide(.top) { dimensions in
                        dimensions[.bottom] + 8
                    }
                }
            }
    }

    private var voiceBehavior: some View {
        content
            // Sits outside the composer's clip shape on purpose: the hold hint
            // floats in the conversation above the pill, and an overlay inside
            // the rounded surface would be cut off exactly where it matters.
            .overlay(alignment: .top) {
                if voice.holdActive, voice.state.isRecording {
                    VoiceReleaseHint(armed: voice.cancelArmed)
                        // A plain offset, not an alignment guide: the guide was
                        // silently ignored here and left the chip sitting on
                        // the pill's top edge. −56 clears the pill with a small
                        // gap so it floats over the transcript.
                        .offset(y: -56)
                        .transition(.opacity)
                }
            }
            // Without a transaction around the hold flipping on, the hint has a
            // transition it never gets to play.
            .animation(
                VoiceMorph.appearance(reduceMotion: reduceMotion),
                value: voice.holdActive
            )
            .onChange(of: voice.holdActive) { _, active in
                if active {
                    resumeFocusAfterVoice = resumeFocusAfterVoice || focused.wrappedValue
                } else if !voice.state.isBusy {
                    // The hold never became a recording (too short, cancelled
                    // before start): nothing will end later to restore for.
                    resumeFocusAfterVoice = false
                }
            }
            .padding(.horizontal, 12)
            .padding(.top, 12)
            .padding(.bottom, 10)
            // No backdrop on purpose: the pill is glass and the transcript
            // scrolls behind it.
            .onChange(of: voice.state.isBusy) { _, busy in
                if busy {
                    // Captured at recording start; `holdActive` alone is too
                    // early for hands-free taps and permission waits.
                    resumeFocusAfterVoice = resumeFocusAfterVoice || focused.wrappedValue
                } else if resumeFocusAfterVoice {
                    resumeFocusAfterVoice = false
                    focused.wrappedValue = true
                }
            }
            // The reference behaviour: recording must not take the keyboard
            // away. If anything in the swap resigns the field, put it back.
            .onChange(of: focused.wrappedValue) { _, isFocused in
                if !isFocused, voice.state.isBusy, resumeFocusAfterVoice {
                    Task { @MainActor in
                        await Task.yield()
                        focused.wrappedValue = true
                    }
                }
            }
    }

    /// Points the shared coordinator at this composer. Reading and writing the
    /// draft goes through the binding rather than a snapshot, because a
    /// transcript can land long after the recording started.
    private func attachVoice() {
        voice.attach(
            identity: powerFeatures.voiceComposerIdentity,
            destinationName: powerFeatures.resolvedVoiceScope?.destinationName ?? "its conversation",
            capability: powerFeatures.voice ?? FeatureVoiceCapability.current,
            readDraft: { text },
            writeDraft: { text = $0 },
            readRange: { caret.range(in: $0) },
            moveCaret: { offset in
                focused.wrappedValue = true
                caret.moveCaret(to: offset)
            }
        )
    }

    @ViewBuilder
    private func voiceAlertActions(_ alert: VoiceComposerAlert) -> some View {
        switch alert.kind {
        case .notice:
            Button("OK", role: .cancel) {}
        case .permissionBlocked:
            Button("Cancel", role: .cancel) {}
            Button("Open Settings") {
                guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
                UIApplication.shared.open(url)
            }
        case .permissionRetry:
            Button("Cancel", role: .cancel) {}
            // Retrying a retryable permission failure restarts the whole flow,
            // matching web.
            Button("Try Again") { voice.retry() }
        case .failureRetry:
            Button("Discard", role: .cancel) { voice.cancelRecording() }
            Button("Retry") { voice.retry() }
        }
    }

    // MARK: - Surface

    private var composerSurface: some View {
        VStack(spacing: 0) {
            // Above the swap below on purpose: the status describes the turn,
            // and the turn keeps running while an approval panel is up.
            if let workingStatus {
                ThreadWorkingStatusBar(status: workingStatus)
            }

            if let approval = pendingApprovals.first, let onApprovalDecision {
                FeatureComposerApprovalPanel(
                    approval: approval,
                    position: 1,
                    total: pendingApprovals.count,
                    isResponding: isResolvingRequest,
                    onDecision: { decision in
                        onApprovalDecision(approval.id, decision)
                    },
                    onCancelTurn: onStop
                )
            } else if let input = pendingUserInputs.first, let onUserInputSubmit {
                FeatureComposerUserInputPanel(
                    input: input,
                    isResponding: isResolvingRequest,
                    onSubmit: { answers, files, dismiss in
                        onUserInputSubmit(input.id, answers, files, dismiss)
                    },
                    // Through `text`, not `storedText`: the displaced answer is
                    // the reader's prose and belongs beside the draft's own, not
                    // after its citation and review-comment blocks.
                    onDisplaceCustomAnswer: { displaced in
                        text = FeatureComposerCustomAnswer.carryingDisplacedAnswer(
                            displaced,
                            into: text
                        )
                        T3HUD.show("Moved your answer to the draft", systemImage: "text.insert")
                    }
                )
            } else {
                editor
            }
        }
        // Liquid Glass rather than a solid fill: the transcript scrolls behind
        // the pill and refracts through it. Real glass has its own edge, so
        // the palette rim only draws on the pre-26 material.
        .t3GlassEffect(.regular, in: composerShape)
        .t3GlassRim(in: composerShape, color: T3Colors.inputBorder)
        .clipShape(composerShape)
        .overlay {
            if isFileDropTargeted {
                composerShape
                    .strokeBorder(T3Colors.accent, style: StrokeStyle(lineWidth: 2, dash: [6]))
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)
            }
        }
        // Scoped to the values that swap the pill's content — recording strip
        // and media window — so both halves of each swap change in a single
        // transaction.
        .animation(VoiceMorph.appearance(reduceMotion: reduceMotion), value: voice.state.isBusy)
        .animation(VoiceMorph.appearance(reduceMotion: reduceMotion), value: mediaSurface)
        .animation(scenePhase == .active && !reduceMotion ? .easeInOut(duration: 0.18) : nil, value: isRestingWhileReading)
    }

    private var composerShape: RoundedRectangle {
        // The pill relaxes into a card while it hosts the media window.
        RoundedRectangle(cornerRadius: mediaSurface != nil ? 32 : 26, style: .continuous)
    }

    @ViewBuilder
    private var editor: some View {
        if let mediaSurface {
            composerMediaWindow(mediaSurface)
        } else {
            editorContent
        }
    }

    private var editorContent: some View {
        VStack(spacing: 0) {
            if let sendBlocker, !sendBlocker.message.isEmpty {
                blockerRow(sendBlocker)
            }

            if hasStripContent {
                FeatureAttachmentStrip(
                    attachments: $attachments,
                    pendingCount: attachmentPreparation.pendingItemCount,
                    failures: attachmentFailures,
                    onRetry: retryFailure,
                    onRemoveFailure: { failure in
                        attachmentFailures.removeAll { $0.id == failure.id }
                    }
                )
                .padding(.horizontal, 12)
                .padding(.top, 10)
            }

            if imageAttachmentCount > 0, !imagesAllowed {
                HStack(spacing: 8) {
                    Label("Choose a model that accepts images", systemImage: "exclamationmark.circle")
                        .foregroundStyle(T3Colors.warning)
                    Spacer(minLength: 4)
                    Button("Change Model") { taskSettings = .models }
                        .buttonStyle(.borderless)
                        .fontWeight(.semibold)
                }
                .font(T3Typography.supporting)
                .padding(.horizontal, 16)
                .padding(.top, 8)
            }

            draftRow
            controlsRow
        }
    }

    private var hasStripContent: Bool {
        !attachments.isEmpty || attachmentPreparation.isPreparing || !attachmentFailures.isEmpty
    }

    private func blockerRow(_ blocker: FeatureComposerSendBlocker) -> some View {
        HStack(spacing: 8) {
            Image(systemName: blocker.systemImage)
                .foregroundStyle(T3Colors.warning)
                .accessibilityHidden(true)
            Text(blocker.message)
                .foregroundStyle(T3Colors.textSecondary)
                .frame(maxWidth: .infinity, alignment: .leading)
            if let title = blocker.actionTitle, let action = blocker.action {
                Button(title, action: action)
                    .buttonStyle(.borderless)
                    .fontWeight(.semibold)
                    .frame(minHeight: T3Metrics.minimumTapTarget)
            }
        }
        .font(T3Typography.supporting)
        .padding(.horizontal, 16)
        .padding(.top, 6)
        .frame(minHeight: 32)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("composer-send-blocker")
    }

    /// Row one: the draft. While Voice Input is busy the recording strip covers
    /// it, but the field stays in the hierarchy — removing the focused field
    /// would dismiss the keyboard under the user mid-recording. At least 44pt
    /// tall in both states, so the strip appearing never shifts row two (and
    /// the mic under the finger) down.
    private var draftRow: some View {
        ZStack(alignment: .leading) {
            inputRow
                // Not zero: at zero UIKit treats the focused field as hidden
                // and resigns it, which is the keyboard closing mid-recording.
                // 0.02 is invisible and keeps it live.
                .opacity(voice.state.isBusy ? 0.02 : 1)
                .allowsHitTesting(!voice.state.isBusy)

            if voice.state.isBusy {
                VoiceRecordingStrip(voice: voice)
                    .padding(.horizontal, 6)
                    .transition(.opacity)
            }
        }
        .frame(minHeight: T3Metrics.minimumTapTarget)
    }

    private var inputRow: some View {
        TextField(
            isWorking ? "Message to queue…" : "Ask anything…",
            text: textBinding,
            axis: .vertical
        )
        .disabled(isStashing)
        .onKeyPress(keys: [.upArrow, .downArrow], phases: .down) { press in
            guard press.modifiers.isEmpty else { return .ignored }
            if showsCommandMenu {
                let count = commandMenuItems.count
                guard count > 0 else { return .ignored }
                let step = press.key == .downArrow ? 1 : -1
                highlightedSuggestion = (highlightedSuggestion + step + count) % count
                return .handled
            }
            guard historyAvailable,
                  caret.canRecallHistory(backward: press.key == .upArrow),
                  let recalled = promptHistory.step(backward: press.key == .upArrow,
                    entries: historyEntries, current: storedText) else { return .ignored }
            storedText = recalled
            caret.moveCaret(to: text.utf16.count)
            return .handled
        }
        .onKeyPress(.return, phases: .down) { press in
            // ⌘↩ sends from a hardware keyboard; a bare Return stays a newline.
            if press.modifiers == .command {
                guard !showsStop, canSend else { return .ignored }
                performPrimaryAction()
                return .handled
            }
            guard press.modifiers.isEmpty, showsCommandMenu else { return .ignored }
            let items = commandMenuItems
            guard items.indices.contains(highlightedSuggestion) else { return .ignored }
            selectCommandItem(items[highlightedSuggestion])
            return .handled
        }
        .onKeyPress(.escape, phases: .down) { _ in
            guard showsCommandMenu else { return .ignored }
            dismissedSuggestionText = text
            return .handled
        }
        .onKeyPress(keys: ["s"], phases: .down) { press in
            guard press.modifiers == .command, historyDraftKey != nil, canStashDraft else { return .ignored }
            mutateStash()
            return .handled
        }
        .font(T3Typography.composer)
        .lineLimit(1...maximumDraftLines)
        // Ideal height, not proposed height: with the attachment strip in the
        // pill and the keyboard up (the new-thread sheet), the field's height
        // proposal gets squeezed and a vertical TextField answers that by
        // collapsing to one scrolling line. Fixing the vertical size keeps it
        // at content height, and the lineLimit ceiling above keeps a pasted
        // wall of text to seven lines that scroll within the field.
        .fixedSize(horizontal: false, vertical: true)
        .focused(focused)
        // Return is always editing input. Sending is the button or ⌘↩.
        .submitLabel(.return)
        .padding(.horizontal, 16)
        .padding(.top, 13)
        .padding(.bottom, 4)
    }

    private var maximumDraftLines: Int {
        if isRestingWhileReading { return 1 }
        return dynamicTypeSize.isAccessibilitySize ? 4 : 7
    }

    /// Row two: plus, model chip, Plan, then the context ring and the one
    /// trailing slot. While recording the leading controls dim in place rather
    /// than leaving, so nothing moves under the finger holding the mic.
    private var controlsRow: some View {
        HStack(spacing: 2) {
            HStack(spacing: 2) {
                plusMenu
                ComposerModelChip(
                    selection: $selection,
                    providers: providers,
                    threadSelection: threadSelection,
                    canSetUpAgents: providerSetup != nil,
                    onOpen: { taskSettings = $0 }
                )
                if showsInteractionModeToggle {
                    interactionModeToggle
                        .fixedSize()
                }
            }
            .opacity(voice.state.isBusy ? 0.4 : 1)
            .allowsHitTesting(!voice.state.isBusy)

            Spacer(minLength: 0)

            // The ring is a readout, not a setting; it gives way at
            // accessibility sizes, where the model name needs the room.
            if let contextUsage, !dynamicTypeSize.isAccessibilitySize {
                FeatureContextMeter(usage: contextUsage)
                    .fixedSize()
                    .opacity(voice.state.isBusy ? 0.4 : 1)
            }

            trailingSlot
        }
        .padding(.leading, 6)
        .padding(.trailing, 6)
        .padding(.top, 2)
        .padding(.bottom, 6)
    }

    // MARK: - Trailing slot

    /// One slot, three jobs. The mic and the send button both stay in the
    /// tree and collapse by width instead of swapping: the mic hosts the
    /// push-to-talk gesture, and removing views beside it mid-hold gives
    /// SwiftUI a reason to reset that gesture — which is a recording that
    /// never gets its release.
    private var trailingSlot: some View {
        HStack(spacing: 0) {
            if voice.isAvailable {
                VoiceMicButton(voice: voice)
                    .frame(width: showsMic ? T3Metrics.minimumTapTarget : 0)
                    .opacity(showsMic ? 1 : 0)
                    .allowsHitTesting(showsMic)
                    .clipped()
            }

            sendButton
                .frame(width: showsMic ? 0 : T3Metrics.minimumTapTarget)
                .opacity(showsMic ? 0 : 1)
                .allowsHitTesting(!showsMic)
                .clipped()
        }
        .animation(reduceMotion ? VoiceMorph.reduced : .snappy(duration: 0.22), value: showsMic)
    }

    /// The mic owns the slot while there is nothing to send and no turn to
    /// stop, and for the whole of a recording or transcription.
    private var showsMic: Bool {
        guard voice.isAvailable else { return false }
        if voice.state.isBusy { return true }
        return !hasDraftContent && !isWorking && !isSending
    }

    /// Send and stop share one ink circle; only the glyph changes. Stop is
    /// never white on the danger fill, which is a light pink in dark palettes.
    private var sendButton: some View {
        Button(action: performPrimaryAction) {
            ZStack {
                Circle()
                    .fill(T3Colors.primaryAction)
                if isSending || stopPending {
                    ProgressView()
                        .controlSize(.small)
                        .tint(T3Colors.primaryActionForeground)
                } else {
                    Image(systemName: showsStop ? "stop.fill" : "arrow.up")
                        .font(showsStop ? .footnote.weight(.bold) : .body.weight(.bold))
                        .foregroundStyle(T3Colors.primaryActionForeground)
                        .contentTransition(
                            reduceMotion ? ContentTransition.opacity : .symbolEffect(.replace)
                        )
                }
            }
            .frame(width: slotCircleSize, height: slotCircleSize)
            .frame(width: T3Metrics.minimumTapTarget, height: T3Metrics.minimumTapTarget)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(submitDisabled)
        .opacity(sendDimmed ? 0.35 : 1)
        .animation(reduceMotion ? nil : .snappy, value: showsStop)
        .accessibilityLabel(showsStop ? "Stop agent" : "Send")
        .accessibilityIdentifier(showsStop ? "thread-stop" : "message-send")
    }

    private var hasDraftContent: Bool {
        !textIsEmpty || !attachments.isEmpty
    }

    private var showsStop: Bool {
        isWorking && !hasDraftContent
    }

    private var stopPending: Bool {
        stopRequested && showsStop
    }

    private var submitDisabled: Bool {
        isSending || stopPending || (!showsStop && !canSend)
    }

    /// Dimmed only when there is nothing it could do. A send in flight keeps
    /// the full ink circle with a spinner in it.
    private var sendDimmed: Bool {
        !isSending && !stopPending && !showsStop && !canSend
    }

    private func performPrimaryAction() {
        if showsStop {
            guard !stopRequested else { return }
            stopRequested = true
            PlatformHapticEngine.shared.playImpact(.medium)
            onStop()
        } else if FeatureComposerSubmissionPolicy.allowsSend(for: .explicitButton),
                  canSend {
            onSend()
        }
    }

    // MARK: - Plus menu

    /// Attach sources first, then prompt history and the stash.
    private var plusMenu: some View {
        Menu {
            Section {
                if FeatureAttachmentSource.cameraAvailable {
                    Button { openMedia(.camera) } label: {
                        Label("Camera", systemImage: "camera")
                        if let reason = attachReason(needsImages: true) { Text(reason) }
                    }
                    .disabled(!canAttach(needsImages: true))
                }
                Button { openMedia(.photoLibrary) } label: {
                    Label("Photos", systemImage: "photo.on.rectangle")
                    if let reason = attachReason(needsImages: true) { Text(reason) }
                }
                .disabled(!canAttach(needsImages: true))
                Button { requestedAttachmentSource = .files } label: {
                    Label("Files", systemImage: "folder")
                    if let reason = attachReason(needsImages: false) { Text(reason) }
                }
                .disabled(!canAttach(needsImages: false))
            }

            Section {
                recentPromptsMenu
                if historyDraftKey != nil {
                    Button { mutateStash() } label: {
                        Label("Stash Draft", systemImage: "bookmark")
                    }
                    .disabled(!canStashDraft)
                    if !stashedDrafts.isEmpty {
                        Button { showsStash = true } label: {
                            Label("Stashed Drafts", systemImage: "tray.full")
                            Text(stashedDrafts.count == 1 ? "1 draft" : "\(stashedDrafts.count) drafts")
                        }
                        .disabled(!historyAvailable)
                        .accessibilityIdentifier("composer-stash")
                    }
                }
            }
        } label: {
            Image(systemName: "plus")
                .font(.body.weight(.medium))
                .foregroundStyle(T3Colors.textPrimary)
                .frame(width: slotCircleSize, height: slotCircleSize)
                .t3GlassEffect(.regular, interactive: true, in: Circle())
                .t3GlassRim(in: Circle())
                .frame(width: T3Metrics.minimumTapTarget, height: T3Metrics.minimumTapTarget)
                .contentShape(Rectangle())
        }
        .menuOrder(.fixed)
        .disabled(isSending || isStashing)
        .accessibilityLabel("Add")
        .accessibilityHint("Attach photos or files, recall a recent prompt, or stash this draft")
        .accessibilityIdentifier("image-attachment-picker")
    }

    @ViewBuilder
    private var recentPromptsMenu: some View {
        let entries = historyEntries.suffix(20).reversed()
        if entries.isEmpty {
            Button {} label: {
                Label("Recent Prompts", systemImage: "clock.arrow.circlepath")
                Text("None yet")
            }
            .disabled(true)
        } else {
            Menu {
                ForEach(entries) { entry in
                    Button {
                        recall(entry)
                    } label: {
                        Text(String(AssistantCitation.plainText(entry.prompt).prefix(160)))
                        if let date = entry.date {
                            Text(date, format: .relative(presentation: .named))
                        }
                    }
                    .disabled(!storedText.isEmpty && storedText != promptHistory.position?.prompt)
                }
            } label: {
                Label("Recent Prompts", systemImage: "clock.arrow.circlepath")
            }
            .disabled(!historyAvailable)
            .accessibilityIdentifier("composer-history")
        }
    }

    private func recall(_ entry: ComposerPromptHistory.Entry) {
        storedText = promptHistory.select(entry)
        focused.wrappedValue = true
        caret.moveCaret(to: text.utf16.count)
    }

    private var remainingAttachmentSlots: Int {
        max(0, 8 - attachments.count - attachmentPreparation.pendingItemCount)
    }

    private func canAttach(needsImages: Bool) -> Bool {
        attachReason(needsImages: needsImages) == nil && !voice.state.isBusy
    }

    /// Why an attach source is off, as the menu item's subtitle.
    private func attachReason(needsImages: Bool) -> String? {
        if attachments.count >= 8 { return "8 of 8 attached" }
        if remainingAttachmentSlots == 0 || attachmentPreparation.isPreparing { return "Preparing…" }
        if needsImages, !imagesAllowed { return "Model doesn’t accept images" }
        return nil
    }

    private func openMedia(_ surface: ComposerMediaSurface) {
        withAnimation(VoiceMorph.appearance(reduceMotion: reduceMotion)) {
            mediaSurface = surface
        }
    }

    // MARK: - Media window

    /// The pill morphed into the media card: camera or the system photo picker
    /// at chat width. Taking a photo or adding picks collapses the card back
    /// into the composer, with the picks landing in the attachment strip.
    private func composerMediaWindow(_ surface: ComposerMediaSurface) -> some View {
        Group {
            switch surface {
            case .camera:
                ComposerCameraWindow(
                    onClose: closeMediaWindow,
                    onCapture: { data in
                        appendImageData([data])
                        closeMediaWindow()
                    }
                )
            case .photoLibrary:
                ComposerPhotoLibraryWindow(
                    maximumSelectable: remainingAttachmentSlots,
                    onClose: closeMediaWindow,
                    onConfirm: { items in
                        closeMediaWindow()
                        appendPhotoItems(items)
                    }
                )
            }
        }
        .containerRelativeFrame(.vertical) { length, _ in min(560, length * 0.55) }
        .frame(maxWidth: .infinity)
        .transition(.opacity)
    }

    private func closeMediaWindow() {
        withAnimation(VoiceMorph.appearance(reduceMotion: reduceMotion)) {
            mediaSurface = nil
        }
    }

    // MARK: - Image intake

    /// Runs captured image data through the same processor the pickers use.
    /// An image that fails becomes a retryable tile rather than disappearing.
    private func appendImageData(_ datas: [Data]) {
        let accepted = Array(datas.prefix(remainingAttachmentSlots))
        guard !accepted.isEmpty else { return }
        let firstOrdinal = attachments.count + attachmentPreparation.pendingItemCount + 1
        let operation = attachmentPreparation.begin(itemCount: accepted.count)
        let generation = historyGeneration
        Task { @MainActor in
            defer { attachmentPreparation.finish(operation) }
            for (offset, data) in accepted.enumerated() {
                await prepareImage(data, ordinal: firstOrdinal + offset, generation: generation)
            }
        }
    }

    /// Loads each pick's bytes from Photos, then prepares them in selection
    /// order. The card has already closed; spinner tiles stand in meanwhile.
    private func appendPhotoItems(_ items: [PhotosPickerItem]) {
        let accepted = Array(items.prefix(remainingAttachmentSlots))
        guard !accepted.isEmpty else { return }
        let firstOrdinal = attachments.count + attachmentPreparation.pendingItemCount + 1
        let operation = attachmentPreparation.begin(itemCount: accepted.count)
        let generation = historyGeneration
        Task { @MainActor in
            defer { attachmentPreparation.finish(operation) }
            for (offset, item) in accepted.enumerated() {
                let data: Data
                do {
                    guard let loaded = try await item.loadTransferable(type: Data.self) else {
                        throw FeatureImageAttachmentError.invalidImage
                    }
                    data = loaded
                } catch {
                    guard generation == historyGeneration else { return }
                    attachmentFailures.append(
                        FeatureAttachmentFailure(source: .photo(item), message: error.localizedDescription)
                    )
                    continue
                }
                await prepareImage(data, ordinal: firstOrdinal + offset, generation: generation)
            }
        }
    }

    private func prepareImage(_ data: Data, ordinal: Int, generation: UUID) async {
        do {
            let attachment = try await Task.detached(priority: .userInitiated) {
                try FeatureImageProcessor.attachment(from: data, ordinal: ordinal)
            }.value
            guard generation == historyGeneration, attachments.count < 8 else { return }
            attachments.append(attachment)
        } catch {
            guard generation == historyGeneration else { return }
            attachmentFailures.append(
                FeatureAttachmentFailure(source: .data(data), message: error.localizedDescription)
            )
        }
    }

    private func retryFailure(_ failure: FeatureAttachmentFailure) {
        guard remainingAttachmentSlots > 0 else { return }
        attachmentFailures.removeAll { $0.id == failure.id }
        switch failure.source {
        case let .data(data): appendImageData([data])
        case let .photo(item): appendPhotoItems([item])
        }
    }

    // MARK: - File drops

    private var readyExternalFileDropID: UUID? {
        guard !isSending, !isStashing, !voice.state.isBusy,
            externalFileDrop?.draftKey == historyDraftKey else { return nil }
        return externalFileDrop?.id
    }

    private func receiveExternalFileDrop() async {
        guard readyExternalFileDropID != nil, let batch = externalFileDrop else { return }
        let remaining = max(0, 8 - attachments.count - attachmentPreparation.pendingItemCount)
        let accepted = min(remaining, batch.providers.count - batch.nextIndex)
        let endIndex = batch.nextIndex + accepted
        let operation = attachmentPreparation.begin(itemCount: accepted)
        defer { attachmentPreparation.finish(operation) }
        var failures: [String] = []
        while batch.nextIndex < endIndex {
            let index = batch.nextIndex
            let provider = batch.providers[index]
            do {
                guard let type = ThreadFileDropBatch.supportedType(provider) else { throw CocoaError(.fileReadUnsupportedScheme) }
                let attachment = try await FeatureDroppedAttachment.load(provider, typeIdentifier: type)
                guard !Task.isCancelled, historyDraftKey == batch.draftKey else { return }
                guard batch.nextIndex == index else { continue }
                guard attachments.count < 8 else { break }
                attachments.append(attachment)
                batch.advance(expectedIndex: index)
            } catch {
                guard !Task.isCancelled, historyDraftKey == batch.draftKey else { return }
                failures.append(error.localizedDescription)
                batch.advance(expectedIndex: index)
            }
        }
        guard !Task.isCancelled else { return }
        if !batch.isComplete || batch.omittedCount > 0 {
            failures.append("A message can contain up to 8 attachments. Extra files were not added.")
        }
        batch.finish()
        onExternalFileDropConsumed(batch.id)
        if !failures.isEmpty { fileDropError = failures.joined(separator: "\n") }
        focused.wrappedValue = true
    }

    /// Resolve each provider while its temporary file is valid, then append only
    /// to the composer that accepted the drop. The existing upload queue owns sending.
    private func receiveDroppedFiles(_ providers: [NSItemProvider]) -> Bool {
        guard !isSending, !isStashing, !voice.state.isBusy else { return false }
        let remaining = max(0, 8 - attachments.count - attachmentPreparation.pendingItemCount)
        let accepted = providers.compactMap { provider -> (NSItemProvider, String)? in
            guard let type = provider.registeredTypeIdentifiers.first(where: {
                UTType($0)?.conforms(to: .data) == true
            }) else { return nil }
            return (provider, type)
        }
        guard !accepted.isEmpty else { return false }
        guard remaining > 0 else {
            fileDropError = "A message can contain up to 8 attachments."
            return false
        }
        let destination = historyDraftKey
        let generation = historyGeneration
        let operation = attachmentPreparation.begin(itemCount: min(remaining, accepted.count))
        Task { @MainActor in
            defer { attachmentPreparation.finish(operation) }
            for (provider, type) in accepted.prefix(remaining) {
                do {
                    let attachment = try await FeatureDroppedAttachment.load(provider, typeIdentifier: type)
                    guard historyDraftKey == destination, historyGeneration == generation else { return }
                    guard attachments.count < 8 else { break }
                    attachments.append(attachment)
                } catch {
                    guard historyDraftKey == destination, historyGeneration == generation else { return }
                    fileDropError = error.localizedDescription
                }
            }
            if accepted.count > remaining {
                fileDropError = "Only the first \(remaining) files were added. A message can contain up to 8 attachments."
            }
        }
        return true
    }

    // MARK: - History and stash

    /// Recent prompts are parsed out of the whole transcript, so they are
    /// memoized on the message list instead of re-parsed on every keystroke's
    /// body evaluation.
    private final class HistoryMemo {
        var key: String?
        var entries: [ComposerPromptHistory.Entry] = []
    }

    @State private var historyMemo = HistoryMemo()

    private var historyEntries: [ComposerPromptHistory.Entry] {
        let messages = historyMessages()
        let key = "\(messages.count):\(messages.last?.id ?? "")"
        if historyMemo.key == key { return historyMemo.entries }
        let entries = ComposerPromptHistory.entries(messages)
        historyMemo.key = key
        historyMemo.entries = entries
        return entries
    }

    private var historyAvailable: Bool {
        !isSending && !isStashing && !voice.state.isBusy && !showsCommandMenu
            && pendingApprovals.isEmpty && pendingUserInputs.isEmpty
    }

    private var canStashDraft: Bool {
        historyAvailable && (!storedText.isEmpty || !attachments.isEmpty)
    }

    private func mutateStash(restoring id: String? = nil) {
        guard let historyDraftKey, historyAvailable else { return }
        let current = FeatureComposerDraft(text: storedText, attachments: attachments)
        let generation = historyGeneration
        isStashing = true
        Task {
            defer { isStashing = false; onDidStash() }
            await onWillStash()
            do {
                let restored: FeatureComposerDraft
                if let id { restored = try await historyDraftStore.restoreStash(id: id, replacing: current, for: historyDraftKey) }
                else {
                    _ = try await historyDraftStore.stashDraft(current, for: historyDraftKey)
                    restored = FeatureComposerDraft()
                }
                let entries = try await historyDraftStore.stashEntries(for: historyDraftKey)
                guard generation == historyGeneration else { return }
                stashedDrafts = entries
                storedText = restored.text
                attachments = restored.attachments
                promptHistory = ComposerPromptHistory()
                showsStash = false
                if id == nil { T3HUD.show("Draft stashed", systemImage: "bookmark.fill") }
            } catch {
                historyError = ComposerHistoryError(
                    id == nil ? "Couldn’t Stash Draft" : "Couldn’t Restore Draft",
                    error
                )
            }
        }
    }

    private func removeStash(_ id: String) {
        guard let historyDraftKey, !isStashing else { return }
        let generation = historyGeneration
        isStashing = true
        Task {
            defer { isStashing = false }
            do {
                let entries = try await historyDraftStore.removeStash(id: id, for: historyDraftKey)
                guard generation == historyGeneration else { return }
                stashedDrafts = entries
            } catch { historyError = ComposerHistoryError("Couldn’t Remove Draft", error) }
        }
    }

    // MARK: - Plan

    /// Hidden entirely for providers that ignore the mode — a switch that
    /// changes nothing is worse than no switch.
    private var showsInteractionModeToggle: Bool {
        interactionMode != nil && activeProvider?.supportsPlanMode == true
    }

    private var isPlanMode: Bool {
        interactionMode?.wrappedValue == .plan
    }

    /// Plan is the mode that changes what the agent is allowed to do, so it is
    /// the one that reads as switched on; Build is the quiet default.
    private var interactionModeToggle: some View {
        Toggle(
            isOn: Binding(
                get: { isPlanMode },
                set: { interactionMode?.wrappedValue = $0 ? .plan : .standard }
            )
        ) {
            Text("Plan")
        }
        .toggleStyle(ComposerCapsuleToggleStyle())
        .t3SensoryFeedback(.selection, trigger: isPlanMode)
        .accessibilityLabel("Plan mode")
        .accessibilityHint("The agent proposes a plan before it changes anything")
        .accessibilityIdentifier("composer-interaction-mode")
    }

    // MARK: - Model

    private var activeProvider: FeatureProvider? {
        guard let active = activeSelection else { return nil }
        return providers.first { $0.id == active.providerID }
    }

    private func materializeModelSelection() {
        guard let resolved = ComposerModelSelectionMaterializer.resolved(
            selection: selection,
            providers: providers,
            threadSelection: threadSelection,
            materializesDefaultSelection: materializesDefaultSelection
        ) else {
            return
        }
        guard selection != resolved.value else { return }
        selection = resolved.value
    }

    private var activeSelection: FeatureSelection? { selection ?? threadSelection }

    // MARK: - State

    /// Compact only the draft's line count. The editor, controls and mic never leave the tree.
    private var isRestingWhileReading: Bool {
        readingHistory && !forceExpanded && !focused.wrappedValue
            && !voice.state.isBusy && !isPickingAttachment
            && mediaSurface == nil && attachments.isEmpty && !attachmentPreparation.isPreparing
            && pendingApprovals.isEmpty && pendingUserInputs.isEmpty && !isSending && !isStashing
    }

    private var isExpanded: Bool {
        forceExpanded
            || isPickingAttachment
            || focused.wrappedValue
            || !textIsEmpty
            || !attachments.isEmpty
            || attachmentPreparation.isPreparing
    }

    private var textIsEmpty: Bool {
        storedText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var canSend: Bool {
        guard composerTrigger?.kind != .model, sendBlocker == nil else { return false }
        return FeatureComposerSubmissionEligibility.canSend(
            text: storedText,
            attachmentCount: attachments.count,
            imagesAllowed: imagesAllowed,
            isSending: isSending,
            preparationState: attachmentPreparation,
            imageAttachmentCount: imageAttachmentCount
        )
    }

    private var imageAttachmentCount: Int {
        attachments.filter {
            ComposerAttachments.classify(mimeType: $0.mimeType, name: $0.filename) == .image
        }.count
    }

    private var imagesAllowed: Bool {
        DailyUXModelOptions.supportsImages(
            selection: selection ?? threadSelection,
            providers: providers
        )
    }

    // MARK: - Suggestions

    /// Trigger detection walks the whole draft with character indices and is
    /// read from several computed properties per body evaluation, so one parse
    /// per keystroke is memoized instead of four.
    private final class TriggerMemo {
        var text: String?
        var trigger: FeatureComposerTrigger?
    }

    @State private var triggerMemo = TriggerMemo()

    private var composerTrigger: FeatureComposerTrigger? {
        if triggerMemo.text == text { return triggerMemo.trigger }
        let trigger = FeatureComposerTriggerParser.detect(in: text)
        triggerMemo.text = text
        triggerMemo.trigger = trigger
        return trigger
    }

    private var commandMenuItems: [FeatureComposerMenuItem] {
        guard let composerTrigger else { return [] }
        return FeatureComposerMenuBuilder.items(
            trigger: composerTrigger,
            providers: providers,
            currentSelection: selection,
            threadSelection: threadSelection,
            powerFeatures: powerFeatures,
            pathEntries: pathEntries
        )
    }

    private var showsCommandMenu: Bool {
        isExpanded
            && pendingApprovals.isEmpty
            && pendingUserInputs.isEmpty
            && composerTrigger != nil
            && dismissedSuggestionText != text
    }

    private var pathSearchRequest: FeatureComposerPathSearchRequest? {
        guard let trigger = composerTrigger,
              trigger.kind == .path,
              powerFeatures.searchPaths != nil else {
            return nil
        }
        let query = trigger.query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return nil }
        return FeatureComposerPathSearchRequest(
            scopeID: powerFeatures.pathSearchScopeID,
            query: query,
            attempt: pathSearchAttempt
        )
    }

    @State private var pathSearchAttempt = 0

    private func retryPathSearch() {
        pathSearchAttempt += 1
    }

    @MainActor
    private func updatePathSearch() async {
        guard let request = pathSearchRequest, let searchPaths = powerFeatures.searchPaths else {
            pathEntries = []
            isPathSearchLoading = false
            pathSearchError = nil
            return
        }

        pathEntries = []
        pathSearchError = nil
        isPathSearchLoading = true
        do {
            try await Task.sleep(for: .milliseconds(140))
            let result = try await searchPaths(request.query)
            guard !Task.isCancelled else { return }
            pathEntries = result
            isPathSearchLoading = false
        } catch is CancellationError {
            return
        } catch {
            guard !Task.isCancelled else { return }
            pathSearchError = "Couldn’t search files."
            isPathSearchLoading = false
        }
    }

    private func selectCommandItem(_ item: FeatureComposerMenuItem) {
        guard let trigger = composerTrigger else { return }
        let replacement: String
        switch item {
        case .modelCommand:
            replacement = "/model "
        case let .model(nextSelection, _, _):
            selection = nextSelection
            replacement = ""
        case let .providerCommand(command):
            replacement = "/\(command.name) "
        case let .skill(skill):
            replacement = "$\(skill.name) "
        case let .path(entry):
            replacement = FeatureComposerFileLinkSerializer.markdownLink(for: entry.path) + " "
        }
        text = FeatureComposerTriggerParser.replacing(
            trigger.range,
            in: text,
            with: replacement
        )
        pathEntries = []
        pathSearchError = nil
        Task { @MainActor in
            await Task.yield()
            focused.wrappedValue = true
        }
    }
}

/// A stash or history failure, titled for the operation that failed.
private struct ComposerHistoryError {
    let title: String
    let message: String

    init(_ title: String, _ error: Error) {
        self.title = title
        self.message = error.localizedDescription
    }
}

/// Plan as a capsule: neutral when off, an accent wash when on.
private struct ComposerCapsuleToggleStyle: ToggleStyle {
    func makeBody(configuration: Configuration) -> some View {
        Button {
            configuration.isOn.toggle()
        } label: {
            configuration.label
                .font(T3Typography.supportingStrong)
                .foregroundStyle(configuration.isOn ? T3Colors.accent : T3Colors.textSecondary)
                .padding(.horizontal, 10)
                .padding(.vertical, 5)
                .background(
                    Capsule().fill(configuration.isOn ? T3Colors.accent.opacity(0.16) : T3Colors.subtleStrong)
                )
                .frame(minHeight: T3Metrics.minimumTapTarget)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityValue(configuration.isOn ? "On" : "Off")
        .accessibilityAddTraits(configuration.isOn ? .isSelected : [])
    }
}

private struct FeatureComposerPathSearchRequest: Hashable {
    let scopeID: String
    let query: String
    let attempt: Int
}

enum FeatureComposerSubmissionEligibility {
    /// `imageAttachmentCount` defaults to every attachment: only images need a
    /// vision-capable model, while PDFs, video and generic files are read off
    /// disk by the agent and send on any model.
    static func canSend(
        text: String,
        attachmentCount: Int,
        imagesAllowed: Bool,
        isSending: Bool,
        preparationState: FeatureAttachmentPreparationState,
        imageAttachmentCount: Int? = nil
    ) -> Bool {
        let hasText = !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        let hasAttachments = attachmentCount > 0
        let hasImages = (imageAttachmentCount ?? attachmentCount) > 0
        return !isSending
            && !preparationState.isPreparing
            && (hasText || hasAttachments)
            && (!hasImages || imagesAllowed)
    }
}

enum FeatureComposerSubmissionIntent: Equatable {
    case explicitButton
    case returnKey
}

enum FeatureComposerSubmissionPolicy {
    static func allowsSend(for intent: FeatureComposerSubmissionIntent) -> Bool {
        intent == .explicitButton
    }
}

/// How full the model's context window is. A readout rather than a setting:
/// tapping it shows the exact figure, and it turns the warning color once
/// the thread is close to the point where the provider starts compacting.
private struct FeatureContextMeter: View {
    let usage: Double

    @State private var showsDetail = false

    var body: some View {
        Button {
            showsDetail = true
        } label: {
            ZStack {
                Circle()
                    .stroke(T3Colors.border, lineWidth: 2)
                Circle()
                    .trim(from: 0, to: clampedUsage)
                    .stroke(
                        isNearlyFull ? T3Colors.warning : T3Colors.textSecondary,
                        style: StrokeStyle(lineWidth: 2, lineCap: .round)
                    )
                    .rotationEffect(.degrees(-90))
            }
            .frame(width: 18, height: 18)
            .frame(width: 32, height: T3Metrics.minimumTapTarget)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .popover(isPresented: $showsDetail) {
            Text("\(percent)% of context used")
                .font(T3Typography.control)
                .foregroundStyle(T3Colors.textPrimary)
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
                .presentationCompactAdaptation(.popover)
        }
        .accessibilityLabel("Context used")
        .accessibilityValue("\(percent) percent")
    }

    private var clampedUsage: Double {
        min(max(usage, 0), 1)
    }

    private var percent: Int {
        Int((clampedUsage * 100).rounded())
    }

    private var isNearlyFull: Bool {
        clampedUsage > 0.85
    }
}
