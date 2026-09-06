import SwiftUI
import UIKit

struct FeatureComposerView: View {
    /// True while the attachment picker has a camera, photo, or file source on
    /// screen. Presenting any of them resigns the keyboard; without this the
    /// resulting focus loss would collapse the footer, and the composer needs
    /// to know a presentation it just opened is the reason focus went away.
    @State private var isPickingAttachment = false
    /// The in-pill attachment menu the plus morphs the composer into.
    @State private var isAttachMenuOpen = false
    /// The in-pill camera / photo-library window. Files stay on the native
    /// document picker.
    @State private var mediaSurface: ComposerMediaSurface?
    /// Hands the menu's choice to the picker, which owns the presentations.
    @State private var requestedAttachmentSource: FeatureAttachmentSource?
    /// Whether the keyboard was up when a recording began, so it can be pinned
    /// open through the recording and restored after transcription.
    @State private var resumeFocusAfterVoice = false
    @State private var attachmentPreparation = FeatureAttachmentPreparationState()
    /// The task-settings sheet: model plus every option the model publishes.
    @State private var isPresentingTaskSettings = false
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
    @Binding private var text: String
    @Binding private var selection: FeatureSelection?
    @Binding private var attachments: [FeatureDraftAttachment]
    /// The thread's Plan/Build mode, or nil on a surface that has no mode to
    /// offer. A binding rather than a callback so a thread composer can write
    /// straight through to thread state while a compose sheet holds its own
    /// pending choice.
    private let interactionMode: Binding<FeatureInteractionMode>?

    private let providers: [FeatureProvider]
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
    private let pendingApprovals: [FeatureApproval]
    private let pendingUserInputs: [FeatureUserInput]
    private let isResolvingRequest: Bool
    private let powerFeatures: FeatureComposerPowerFeatures
    private let historyMessages: () -> [FeatureMessage]
    private let historyDraftKey: String?
    private let historyDraftStore: FeatureComposerDraftStore
    private let onWillStash: () async -> Void
    private let onDidStash: () -> Void
    @State private var historyGeneration = UUID()
    @State private var promptHistory = ComposerPromptHistory()
    @State private var stashedDraft: FeatureComposerDraft?
    @State private var isStashing = false
    @State private var historyError: String?
    private let onSend: () -> Void
    private let onStop: () -> Void
    private let onApprovalDecision: ((String, FeatureApprovalDecision) -> Void)?
    private let onUserInputSubmit: ((String, [String: FeatureInputAnswer]) -> Void)?

    init(
        text: Binding<String>,
        selection: Binding<FeatureSelection?>,
        attachments: Binding<[FeatureDraftAttachment]>,
        interactionMode: Binding<FeatureInteractionMode>? = nil,
        providers: [FeatureProvider],
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
        pendingApprovals: [FeatureApproval] = [],
        pendingUserInputs: [FeatureUserInput] = [],
        isResolvingRequest: Bool = false,
        powerFeatures: FeatureComposerPowerFeatures = .disabled,
        historyMessages: @escaping () -> [FeatureMessage] = { [] },
        historyDraftKey: String? = nil,
        historyDraftStore: FeatureComposerDraftStore = .shared,
        onWillStash: @escaping () async -> Void = {},
        onDidStash: @escaping () -> Void = {},
        onApprovalDecision: ((String, FeatureApprovalDecision) -> Void)? = nil,
        onUserInputSubmit: ((String, [String: FeatureInputAnswer]) -> Void)? = nil
    ) {
        _text = text
        _selection = selection
        _attachments = attachments
        self.interactionMode = interactionMode
        self.providers = providers
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
        self.pendingApprovals = pendingApprovals
        self.pendingUserInputs = pendingUserInputs
        self.isResolvingRequest = isResolvingRequest
        self.powerFeatures = powerFeatures
        self.historyMessages = historyMessages
        self.historyDraftKey = historyDraftKey
        self.historyDraftStore = historyDraftStore
        self.onWillStash = onWillStash
        self.onDidStash = onDidStash
        self.onApprovalDecision = onApprovalDecision
        self.onUserInputSubmit = onUserInputSubmit
    }

    var body: some View {
        composerSurface
            .task(id: historyDraftKey) {
                historyGeneration = UUID()
                promptHistory = ComposerPromptHistory()
                guard let historyDraftKey else { stashedDraft = nil; return }
                do {
                    let saved = try await historyDraftStore.stashedDraft(for: historyDraftKey)
                    guard !Task.isCancelled, self.historyDraftKey == historyDraftKey else { return }
                    stashedDraft = saved
                }
                catch { historyError = error.localizedDescription }
            }
            .alert("Prompt history", isPresented: Binding(get: { historyError != nil }, set: { if !$0 { historyError = nil } })) {
                Button("OK") { historyError = nil }
            } message: { Text(historyError ?? "") }
            .overlay(alignment: .top) {
                if showsCommandMenu, let trigger = composerTrigger {
                    FeatureComposerCommandPopover(
                        triggerKind: trigger.kind,
                        items: commandMenuItems,
                        isLoading: isPathSearchLoading,
                        errorMessage: pathSearchError,
                        pathSearchAvailable: powerFeatures.searchPaths != nil,
                        onSelect: selectCommandItem
                    )
                    .alignmentGuide(.top) { dimensions in
                        dimensions[.bottom] + 8
                    }
                }
            }
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
                    isAttachMenuOpen = false
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
            .task(id: pathSearchRequest) {
                await updatePathSearch()
            }
            .onAppear {
                caret.startTracking()
                attachVoice()
            }
            .onDisappear {
                caret.stopTracking()
                voice.detach(identity: powerFeatures.voiceComposerIdentity)
            }
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

    /// Points the shared coordinator at this composer. Reading and writing the
    /// draft goes through the binding rather than a snapshot, because a
    /// transcript can land long after the recording started.
    private func attachVoice() {
        voice.attach(
            identity: powerFeatures.voiceComposerIdentity,
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
            Button("Try again") { voice.retry() }
        case .failureRetry:
            Button("Discard", role: .cancel) { voice.cancelRecording() }
            Button("Retry") { voice.retry() }
        }
    }

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
                    onSubmit: { answers in
                        onUserInputSubmit(input.id, answers)
                    }
                )
            } else {
                editor
            }
        }
        // Liquid Glass rather than a solid fill: the transcript scrolls behind
        // the pill and refracts through it.
        .t3GlassEffect(.regular, in: composerShape)
        .overlay {
            composerShape
                .stroke(T3Colors.inputBorder, lineWidth: 1)
        }
        .clipShape(composerShape)
        // Scoped to the two values that swap the pill's content — recording
        // strip and attachment menu — so both halves of each swap change in a
        // single transaction.
        .animation(VoiceMorph.appearance(reduceMotion: reduceMotion), value: voice.state.isBusy)
        .animation(VoiceMorph.appearance(reduceMotion: reduceMotion), value: isAttachMenuOpen)
        .animation(VoiceMorph.appearance(reduceMotion: reduceMotion), value: mediaSurface)
    }

    @ViewBuilder
    private var editor: some View {
        if let mediaSurface {
            composerMediaWindow(mediaSurface)
        } else {
            editorContent
        }
    }

    /// The pill morphed into the media card: camera or photo grid at chat
    /// width. Taking a photo (or sliding the grid down) collapses the card
    /// back into the composer with the picks landing in the attachment strip.
    private func composerMediaWindow(_ surface: ComposerMediaSurface) -> some View {
        Group {
            switch surface {
            case .camera:
                ComposerCameraWindow(
                    onClose: { closeMediaWindow() },
                    onCapture: { data in
                        appendImageData([data])
                        closeMediaWindow()
                    }
                )
            case .photoLibrary:
                ComposerPhotoLibraryWindow(
                    maximumSelectable: max(0, 8 - attachments.count),
                    onConfirm: { datas in
                        appendImageData(datas)
                        closeMediaWindow()
                    }
                )
            }
        }
        .frame(height: min(560, UIScreen.main.bounds.height * 0.55))
        .frame(maxWidth: .infinity)
        .transition(.opacity)
    }

    private func closeMediaWindow() {
        withAnimation(VoiceMorph.appearance(reduceMotion: reduceMotion)) {
            mediaSurface = nil
        }
    }

    /// Runs captured/picked image data through the same processor the pickers
    /// use, with the same preparation bookkeeping.
    private func appendImageData(_ datas: [Data]) {
        guard !datas.isEmpty else { return }
        let firstOrdinal = attachments.count + attachmentPreparation.pendingItemCount + 1
        let operation = attachmentPreparation.begin(itemCount: datas.count)
        Task { @MainActor in
            defer { attachmentPreparation.finish(operation) }
            for (offset, data) in datas.enumerated() {
                guard attachments.count < 8 else { break }
                if let attachment = try? await Task.detached(priority: .userInitiated, operation: {
                    try FeatureImageProcessor.attachment(from: data, ordinal: firstOrdinal + offset)
                }).value {
                    attachments.append(attachment)
                }
            }
        }
    }

    private var editorContent: some View {
        VStack(spacing: 0) {
            if !attachments.isEmpty {
                FeatureAttachmentStrip(attachments: $attachments)
                    .padding(.horizontal, 12)
                    .padding(.top, 10)
            }

            if imageAttachmentCount > 0, !imagesAllowed {
                Label("Choose a model that accepts images", systemImage: "exclamationmark.circle")
                    .font(T3Typography.supporting)
                    .foregroundStyle(T3Colors.warning)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 15)
                    .padding(.top, 8)
            }

            if attachmentPreparation.isPreparing {
                Label(attachmentPreparation.statusLabel, systemImage: "hourglass")
                    .font(T3Typography.supporting)
                    .foregroundStyle(T3Colors.textSecondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 15)
                    .padding(.top, 8)
                    .accessibilityIdentifier("attachment-preparing")
            }

            if isAttachMenuOpen {
                attachmentMenuList
                    .transition(
                        reduceMotion
                            ? .opacity
                            : .opacity.combined(
                                with: .scale(scale: 0.8, anchor: .bottomLeading)
                            )
                    )
            }

            composerRow

            // Always present: the settings summary is the composer's identity,
            // not editing chrome — hiding it on focus loss or mid-recording
            // reads as the control randomly vanishing. Unconditional also means
            // no structural change during a push-to-talk hold, which is what
            // keeps the hold from being cancelled out from under the user.
            composerFooter
        }
    }

    /// The pill's one row: plus, draft, mic, send. While Voice Input is busy
    /// the plus and the draft give way to the recording strip, but they stay in
    /// the hierarchy at zero opacity — removing the focused field would dismiss
    /// the keyboard under the user mid-recording, and the strip is exactly the
    /// state that has to survive that.
    private var composerRow: some View {
        HStack(alignment: .bottom, spacing: 2) {
            // The plus sits outside the draft row so it stays visible — as the
            // close X — while the pill is morphed into the attachment card. It
            // collapses (never leaves the tree) while recording.
            FeatureImageAttachmentPicker(
                attachments: $attachments,
                preparationState: $attachmentPreparation,
                isPresentingSource: $isPickingAttachment,
                requestedSource: $requestedAttachmentSource,
                onToggleMenu: { isAttachMenuOpen.toggle() },
                isMenuOpen: isAttachMenuOpen,
                isEnabled: imagesAllowed
            )
            .frame(width: voice.state.isBusy ? 0 : T3Metrics.minimumTapTarget)
            .opacity(voice.state.isBusy ? 0 : 1)
            .allowsHitTesting(!voice.state.isBusy)
            .clipped()

            ZStack(alignment: .bottom) {
                inputRow
                    // Not zero: at zero UIKit treats the focused field as
                    // hidden and resigns it, which is the keyboard closing
                    // mid-recording. 0.02 is invisible and keeps it live.
                    .opacity(pillContentHidden ? 0.02 : 1)
                    .allowsHitTesting(!pillContentHidden)

                if voice.state.isBusy {
                    VoiceRecordingStrip(voice: voice)
                        .transition(.opacity)
                }
            }

            // The trailing controls collapse instead of leaving the tree: the
            // mic hosts the push-to-talk gesture, and removing views beside it
            // mid-hold gives SwiftUI a reason to reset that gesture — which is
            // a recording that never gets its release.
            if voice.isAvailable {
                VoiceMicButton(voice: voice)
            }

            sendButton
                .frame(width: sendButtonHidden ? 0 : T3Metrics.minimumTapTarget)
                .opacity(sendButtonHidden ? 0 : 1)
                .allowsHitTesting(!sendButtonHidden)
                .clipped()
        }
        .padding(.leading, 6)
        .padding(.trailing, 6)
        .padding(.vertical, 5)
    }

    /// While recording, the mic itself is the send circle; while the attachment
    /// menu is up, the row belongs to the menu.
    private var sendButtonHidden: Bool {
        voice.state.isBusy || isAttachMenuOpen
    }

    /// The plus and the draft stay in the hierarchy while the recording strip
    /// or attachment menu covers them: the picker's presentations hang off the
    /// plus, and removing the focused field would dismiss the keyboard.
    private var pillContentHidden: Bool {
        voice.state.isBusy || isAttachMenuOpen
    }

    private var inputRow: some View {
        TextField(
            isWorking ? "Message to queue…" : "Ask anything…",
            text: $text,
            axis: .vertical
        )
        .disabled(isStashing)
        .onKeyPress(keys: [.upArrow, .downArrow], phases: .down) { press in
            guard press.modifiers.isEmpty, historyAvailable,
                  caret.canRecallHistory(backward: press.key == .upArrow),
                  let recalled = promptHistory.step(backward: press.key == .upArrow,
                    entries: ComposerPromptHistory.entries(historyMessages()), current: text) else { return .ignored }
            text = recalled
            caret.moveCaret(to: recalled.utf16.count)
            return .handled
        }
        .font(T3Typography.composer)
        .lineLimit(1...7)
        // Ideal height, not proposed height: with the attachment strip in the
        // pill and the keyboard up (the new-thread sheet), the field's height
        // proposal gets squeezed and a vertical TextField answers that by
        // collapsing to one scrolling line. Fixing the vertical size keeps it
        // at content height, and the lineLimit ceiling above keeps a pasted
        // wall of text to seven lines that scroll within the field.
        .fixedSize(horizontal: false, vertical: true)
        .focused(focused)
        // Return is always editing input. Sending is deliberately button-only.
        .submitLabel(.return)
        .padding(.leading, 4)
        .padding(.vertical, 12)
    }

    /// The card the pill morphs into when the plus is tapped: a vertical list
    /// of sources, each a circular icon chip beside its label, growing up out
    /// of the composer with the plus (now an X) still at the bottom-left.
    private var attachmentMenuList: some View {
        VStack(alignment: .leading, spacing: 4) {
            attachmentMenuOption(
                "Camera",
                systemImage: "camera",
                source: .camera,
                enabled: imagesAllowed && FeatureAttachmentSource.cameraAvailable
            )
            attachmentMenuOption(
                "Photos",
                systemImage: "photo",
                source: .photoLibrary,
                enabled: imagesAllowed
            )
            attachmentMenuOption(
                "Files",
                systemImage: "paperclip",
                source: .files,
                enabled: true
            )
        }
        .padding(.horizontal, 12)
        .padding(.top, 16)
        .padding(.bottom, 2)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityIdentifier("attachment-menu")
    }

    private func attachmentMenuOption(
        _ title: String,
        systemImage: String,
        source: FeatureAttachmentSource,
        enabled: Bool
    ) -> some View {
        Button {
            isAttachMenuOpen = false
            switch source {
            case .camera:
                // In-pill capture: the card morphs into the camera window.
                mediaSurface = .camera
            case .photoLibrary:
                mediaSurface = .photoLibrary
            case .files:
                requestedAttachmentSource = source
            }
        } label: {
            HStack(spacing: 16) {
                Image(systemName: systemImage)
                    .font(.system(size: 17, weight: .medium))
                    .frame(width: 44, height: 44)
                    .background(T3Colors.subtleStrong, in: Circle())
                Text(title)
                    .font(.title3)
                    .lineLimit(1)
            }
            .foregroundStyle(T3Colors.textPrimary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, 6)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .opacity(enabled ? 1 : 0.35)
        .accessibilityLabel("Add from \(title)")
    }

    private var composerFooter: some View {
        HStack(spacing: 6) {
            historyMenu
            settingsTrigger
                .frame(maxWidth: .infinity, alignment: .leading)

            // The meter is a readout, not a setting, so it stays on the row
            // rather than moving behind the sheet. Never squeezed: it keeps its
            // ideal width and the trigger label is what truncates.
            if let contextUsage {
                FeatureContextMeter(usage: contextUsage)
                    .fixedSize(horizontal: true, vertical: false)
            }

            if showsInteractionModeToggle {
                interactionModeToggle
                    .fixedSize(horizontal: true, vertical: false)
            }
        }
        .padding(.horizontal, 12)
        .padding(.bottom, 8)
    }

    private var historyAvailable: Bool {
        !isSending && !isStashing && !voice.state.isBusy && !showsCommandMenu
            && pendingApprovals.isEmpty && pendingUserInputs.isEmpty && !isAttachMenuOpen
    }

    private var historyMenu: some View {
        Menu {
            if let historyDraftKey {
                Button(stashedDraft == nil ? "Stash draft" : (text.isEmpty && attachments.isEmpty ? "Restore stashed draft" : "Swap with stashed draft")) {
                    let current = FeatureComposerDraft(text: text, attachments: attachments)
                    let generation = historyGeneration
                    isStashing = true
                    Task {
                        defer { isStashing = false; onDidStash() }
                        await onWillStash()
                        do {
                            let restored = try await historyDraftStore.swapStash(current, for: historyDraftKey)
                            guard generation == historyGeneration else { return }
                            stashedDraft = current.text.isEmpty && current.attachments.isEmpty ? nil : current
                            text = restored.text
                            attachments = restored.attachments
                            promptHistory = ComposerPromptHistory()
                        } catch { historyError = error.localizedDescription }
                    }
                }.disabled(stashedDraft == nil && text.isEmpty && attachments.isEmpty)
            }
            let entries = ComposerPromptHistory.entries(historyMessages())
            if !entries.isEmpty {
                Section("Recent prompts") {
                    ForEach(entries.suffix(20).reversed()) { entry in
                        Button(String(entry.prompt.prefix(100))) {
                            text = promptHistory.select(entry)
                            focused.wrappedValue = true
                            caret.moveCaret(to: text.utf16.count)
                        }.disabled(!text.isEmpty && text != promptHistory.position?.prompt)
                    }
                }
            } else { Text("No sent prompts in this thread") }
        } label: {
            Image(systemName: "clock.arrow.circlepath")
                .frame(width: T3Metrics.minimumTapTarget, height: T3Metrics.minimumTapTarget)
        }
        .disabled(!historyAvailable)
        .accessibilityLabel("Prompt history and stash")
        .accessibilityIdentifier("composer-history")
    }

    /// Plan and Build are one tap apart, in the corner opposite the model.
    /// Hidden entirely for providers that ignore the mode — a switch that
    /// changes nothing is worse than no switch.
    private var showsInteractionModeToggle: Bool {
        interactionMode != nil && activeProvider?.supportsPlanMode == true
    }

    private var isPlanMode: Bool {
        interactionMode?.wrappedValue == .plan
    }

    private var interactionModeToggle: some View {
        Button {
            guard let interactionMode else { return }
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            interactionMode.wrappedValue = isPlanMode ? .standard : .plan
        } label: {
            HStack(spacing: 4) {
                Image(systemName: isPlanMode ? "list.bullet.clipboard" : "hammer")
                    .font(.system(size: 10, weight: .bold))
                    .contentTransition(.symbolEffect(.replace))
                Text(isPlanMode ? "Plan" : "Build")
            }
            .font(T3Typography.supportingStrong)
            // Plan is the mode that changes what the agent is allowed to do, so
            // it is the one that reads as switched on; Build is the quiet
            // default the composer normally sits in.
            .foregroundStyle(isPlanMode ? T3Colors.accent : T3Colors.textSecondary)
            .padding(.horizontal, 9)
            .padding(.vertical, 5)
            .background {
                Capsule().fill(isPlanMode ? T3Colors.accent.opacity(0.14) : T3Colors.subtle)
            }
            .overlay {
                Capsule().stroke(
                    isPlanMode ? T3Colors.accent.opacity(0.45) : T3Colors.border,
                    lineWidth: 1
                )
            }
            .frame(height: T3Metrics.minimumTapTarget)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .animation(VoiceMorph.appearance(reduceMotion: reduceMotion), value: isPlanMode)
        .accessibilityLabel("Agent mode")
        .accessibilityValue(isPlanMode ? "Plan" : "Build")
        .accessibilityHint(isPlanMode ? "Switches to build mode" : "Switches to plan mode")
        .accessibilityIdentifier("composer-interaction-mode")
    }

    /// One control for the model and everything it publishes. A single trigger
    /// is what lets the row show the full summary — the old inline chips fought
    /// the model name for width, so a long name truncated the setting the user
    /// actually came to read.
    private var settingsTrigger: some View {
        Button {
            isPresentingTaskSettings = true
        } label: {
            HStack(spacing: 5) {
                providerMark
                Text(settingsSummary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Image(systemName: "chevron.up.chevron.down")
                    .font(.system(size: 8, weight: .bold))
                    .fixedSize()
            }
            .font(T3Typography.supportingStrong)
            .foregroundStyle(T3Colors.textSecondary)
            .frame(minHeight: T3Metrics.minimumTapTarget, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Task settings")
        .accessibilityValue(settingsSummary)
        .sheet(isPresented: $isPresentingTaskSettings) {
            TaskSettingsSheet(
                selection: $selection,
                providers: providers,
                threadSelection: threadSelection,
                materializesDefaultSelection: materializesDefaultSelection
            )
        }
        // The picker used to own this: mounting it was what materialized a
        // missing selection. It lives behind the sheet now, so the composer has
        // to keep the rule running whether or not the sheet is ever opened.
        .onAppear(perform: materializeModelSelection)
        .onChange(of: providers) { materializeModelSelection() }
        .onChange(of: selection) { materializeModelSelection() }
    }

    @ViewBuilder
    private var providerMark: some View {
        if let provider = activeProvider {
            ProviderIcon(
                driver: provider.driver,
                providerID: provider.id,
                fallbackName: provider.name,
                size: 14
            )
        } else {
            Image(systemName: "cpu")
                .font(.system(size: 10, weight: .semibold))
                .frame(width: 14, height: 14)
        }
    }

    private var activeProvider: FeatureProvider? {
        guard let active = activeSelection else { return nil }
        return providers.first { $0.id == active.providerID }
    }

    private var settingsSummary: String {
        TaskSettingsOptions.summary(
            modelName: activeModel?.name,
            model: activeModel,
            selections: activeSelection?.options ?? []
        )
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

    private var activeModel: FeatureModel? {
        guard let active = activeSelection,
              let provider = providers.first(where: { $0.id == active.providerID }) else {
            return nil
        }
        return provider.models.first { $0.id == active.modelID }
    }

    /// Send only: the mic beside it owns everything voice. Inverted rather than
    /// tinted — the filled circle is the composer's single strongest element,
    /// like the reference.
    private var sendButton: some View {
        Button(action: performPrimaryAction) {
            Group {
                if isSending {
                    ProgressView()
                        .controlSize(.small)
                        .tint(T3Colors.primaryActionForeground)
                } else {
                    Image(systemName: showsStop ? "stop.fill" : "arrow.up")
                        .font(.system(size: showsStop ? 12 : 15, weight: .bold))
                }
            }
            .foregroundStyle(showsStop ? Color.white : T3Colors.primaryActionForeground)
            .frame(width: 34, height: 34)
            .background(showsStop ? T3Colors.danger : T3Colors.primaryAction, in: Circle())
        }
        .buttonStyle(.plain)
        .disabled(submitDisabled)
        .opacity(submitDisabled ? 0.35 : 1)
        .frame(width: T3Metrics.minimumTapTarget, height: T3Metrics.minimumTapTarget)
        .contentShape(Rectangle())
        .accessibilityLabel(showsStop ? "Stop agent" : "Send")
        .accessibilityIdentifier(showsStop ? "thread-stop" : "message-send")
    }

    private var composerShape: RoundedRectangle {
        // The pill relaxes into a card while it hosts the attachment menu or
        // the media window.
        RoundedRectangle(
            cornerRadius: isAttachMenuOpen || mediaSurface != nil ? 32 : 27,
            style: .continuous
        )
    }

    private var isExpanded: Bool {
        forceExpanded
            || isPickingAttachment
            || focused.wrappedValue
            || !textIsEmpty
            || !attachments.isEmpty
            || attachmentPreparation.isPreparing
    }

    private var showsStop: Bool {
        isWorking && textIsEmpty && attachments.isEmpty
    }

    private var submitDisabled: Bool {
        isSending || (!showsStop && !canSend)
    }

    private var textIsEmpty: Bool {
        text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var canSend: Bool {
        guard composerTrigger?.kind != .model else { return false }
        return FeatureComposerSubmissionEligibility.canSend(
            text: text,
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
            query: query
        )
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

    private func performPrimaryAction() {
        if showsStop {
            onStop()
        } else if FeatureComposerSubmissionPolicy.allowsSend(for: .explicitButton),
                  canSend {
            onSend()
        }
    }

}

private struct FeatureComposerPathSearchRequest: Hashable {
    let scopeID: String
    let query: String
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

private struct FeatureContextMeter: View {
    let usage: Double

    var body: some View {
        ZStack {
            Circle()
                .stroke(T3Colors.border, lineWidth: 2)
            Circle()
                .trim(from: 0, to: clampedUsage)
                .stroke(
                    T3Colors.textSecondary,
                    style: StrokeStyle(lineWidth: 2, lineCap: .round)
                )
                .rotationEffect(.degrees(-90))
        }
        .frame(width: 18, height: 18)
        .frame(width: 30, height: T3Metrics.minimumTapTarget)
        .accessibilityElement()
        .accessibilityLabel("Context used")
        .accessibilityValue("\(Int((clampedUsage * 100).rounded())) percent")
    }

    private var clampedUsage: Double {
        min(max(usage, 0), 1)
    }
}
