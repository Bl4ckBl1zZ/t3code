import SwiftUI

/// The dedicated T3 Work compose screen.
///
/// Work is the assistant surface — a directory-based Hermes conversation on
/// the server's own checkout — so nothing project- or git-shaped belongs here:
/// no project picker, no worktree/branch/origin row. What remains is the
/// question, a few starters, the machine it will run on, and the composer.
/// Which Hermes surface the conversation is being started for. Same rails,
/// different voice — and Chat marks its thread with the `"chat"` inbox role
/// so the workspaces stay separable.
public enum HermesComposeFlavor: Equatable, Sendable {
    case work
    case chat
}

public struct NewWorkConversationView: View {
    @SwiftUI.Environment(\.dismiss) private var dismiss
    @Bindable var model: FeatureRootModel
    let flavor: HermesComposeFlavor
    let submit: (NewTaskRequest) async -> FeatureThread?
    let onCreated: (FeatureThread) -> Void

    @State private var prompt = ""
    @State private var selection: FeatureSelection?
    @State private var attachments: [FeatureDraftAttachment] = []
    @State private var selectedEnvironmentID: String?
    @State private var isSubmitting = false
    @State private var submissionFailed = false
    @FocusState private var promptFocused: Bool

    public init(
        model: FeatureRootModel,
        flavor: HermesComposeFlavor = .work,
        submit: @escaping (NewTaskRequest) async -> FeatureThread?,
        onCreated: @escaping (FeatureThread) -> Void
    ) {
        self.model = model
        self.flavor = flavor
        self.submit = submit
        self.onCreated = onCreated
    }

    public var body: some View {
        // The composer is plain bottom content, not a `safeAreaInset`: inside
        // a sheet the inset's keyboard math can land short and sink the model
        // row under the keyboard, while ordinary layout avoidance never does.
        VStack(spacing: 0) {
            topBar

            ScrollView {
                VStack(spacing: 0) {
                    hero
                        .padding(.top, 64)
                    starters
                        .padding(.top, 64)
                }
            }
            .scrollIndicators(.hidden)
            .scrollDismissesKeyboard(.interactively)

            FeatureComposerView(
                text: $prompt,
                selection: $selection,
                attachments: $attachments,
                providers: targetProviders,
                threadSelection: defaultSelection,
                materializesDefaultSelection: false,
                isSending: isSubmitting,
                isWorking: false,
                focused: $promptFocused,
                onSend: startConversation,
                onStop: {},
                forceExpanded: true
            )
        }
        .background(T3Colors.background.ignoresSafeArea())
        .alert("Conversation not started", isPresented: $submissionFailed) {
            Button("OK") {}
        } message: {
            Text("Your message is still here. Check your connection and try again.")
        }
        .task {
            // Focus after the sheet's presentation has settled: grabbing it
            // mid-animation is what desynchronised the keyboard inset.
            try? await Task.sleep(for: .milliseconds(420))
            promptFocused = true
        }
    }

    // MARK: - Chrome

    private var topBar: some View {
        HStack {
            Button("Cancel") { dismiss() }
                .font(.body)
                .foregroundStyle(T3Colors.textSecondary)
                .disabled(isSubmitting)
            Spacer()
        }
        .padding(.horizontal, 16)
        .frame(height: 48)
    }

    private var hero: some View {
        VStack(spacing: 10) {
            Text(flavor == .chat ? "What's on your mind?" : "What can I help with?")
        }
        .font(T3Typography.threadHeading1.weight(.regular))
        .tracking(-0.35)
        .foregroundStyle(T3Colors.textPrimary)
        .multilineTextAlignment(.center)
        .frame(maxWidth: .infinity)
        .overlay(alignment: .bottom) {
            environmentLine
                .offset(y: 31)
        }
        .accessibilityElement(children: .contain)
    }

    /// Which machine hosts the conversation. A menu only when more than one
    /// environment can actually run Hermes.
    private var environmentLine: some View {
        Menu {
            ForEach(availableTargets, id: \.environmentID) { candidate in
                Button {
                    selectedEnvironmentID = candidate.environmentID
                    selection = nil
                } label: {
                    if candidate.environmentID == activeTarget?.environmentID {
                        Label(environmentName(candidate.environmentID), systemImage: "checkmark")
                    } else {
                        Text(environmentName(candidate.environmentID))
                    }
                }
            }
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "server.rack")
                    .font(.system(size: 11, weight: .medium))
                Text("on \(activeTarget.map { environmentName($0.environmentID) } ?? "…")")
                if availableTargets.count > 1 {
                    Image(systemName: "chevron.down")
                        .font(.system(size: 8, weight: .bold))
                }
            }
            .font(T3Typography.supporting)
            .foregroundStyle(T3Colors.textTertiary)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(isSubmitting || availableTargets.count < 2)
        .accessibilityLabel("Computer")
        .accessibilityValue(activeTarget.map { environmentName($0.environmentID) } ?? "None")
    }

    /// Assistant starters: tap to seed the draft. Deliberately a seed, not a
    /// send — the point is a running start, not a canned conversation.
    @ViewBuilder
    private var starters: some View {
        VStack(spacing: 8) {
            if flavor == .chat {
                starterChip("Talk through an idea", systemImage: "bubble.left.and.bubble.right")
                starterChip("Research something for me", systemImage: "magnifyingglass")
                starterChip("Help me decide", systemImage: "arrow.triangle.branch")
            } else {
                starterChip("Research a topic and summarize it", systemImage: "magnifyingglass")
                starterChip("Plan out a piece of work", systemImage: "list.bullet.rectangle")
                starterChip("Draft a message or document", systemImage: "square.and.pencil")
            }
        }
        .padding(.horizontal, 28)
    }

    private func starterChip(_ text: String, systemImage: String) -> some View {
        Button {
            if prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                prompt = text + ": "
            }
            promptFocused = true
        } label: {
            HStack(spacing: 9) {
                Image(systemName: systemImage)
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(T3Colors.textTertiary)
                Text(text)
                    .font(T3Typography.control)
                    .foregroundStyle(T3Colors.textSecondary)
                    .lineLimit(1)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 14)
            .frame(minHeight: 44)
            .background(T3Colors.surface, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .stroke(T3Colors.border, lineWidth: 1)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(isSubmitting)
    }

    // MARK: - Targets

    private struct WorkTarget {
        let environmentID: String
        let target: HermesConversationTarget
    }

    /// One resolvable Hermes target per environment, in saved-environment
    /// order — same resolution the launch itself uses, so this screen can
    /// never offer a machine the send would then reject.
    private var availableTargets: [WorkTarget] {
        model.client.workspaceServerConfigs().compactMap { config in
            MobileWorkspaceRouting.resolveHermesConversationTarget(
                projects: workspaceProjects,
                serverConfigs: [config],
                requiredEnvironmentID: config.environmentID
            ).map { WorkTarget(environmentID: config.environmentID, target: $0) }
        }
    }

    private var activeTarget: WorkTarget? {
        if let selectedEnvironmentID,
           let chosen = availableTargets.first(where: { $0.environmentID == selectedEnvironmentID }) {
            return chosen
        }
        return availableTargets.first
    }

    private var workspaceProjects: [MobileWorkspaceProject] {
        model.snapshot.projects.map { project in
            MobileWorkspaceProject(
                environmentID: project.environmentID,
                project: OrchestrationProject(
                    id: project.id,
                    title: project.name,
                    workspaceRoot: project.path,
                    repositoryIdentity: nil,
                    defaultModelSelection: nil,
                    faviconPath: nil,
                    scripts: project.scripts,
                    createdAt: "",
                    updatedAt: "",
                    deletedAt: nil
                )
            )
        }
    }

    private func environmentName(_ id: String) -> String {
        model.snapshot.environments.first { $0.id == id }?.name ?? "this computer"
    }

    // MARK: - Selection

    /// Hermes is the T3 Work and T3 Chat assistant and the only thing these
    /// two surfaces run on, so the picker lists Hermes and nothing else. The
    /// coding providers are a Code concern; offering them here would let a
    /// conversation start on a harness this screen cannot route to.
    private var targetProviders: [FeatureProvider] {
        ModelOptions.scoped(environmentProviders, to: .hermesOnly)
    }

    private var environmentProviders: [FeatureProvider] {
        guard let target = activeTarget else { return model.snapshot.providers }
        return model.snapshot.providersByEnvironment?[target.environmentID]
            ?? model.snapshot.providers
    }

    /// Hermes resolves its own default model; the picker starts there and the
    /// user can still switch between Hermes models.
    private var defaultSelection: FeatureSelection? {
        guard let target = activeTarget else { return nil }
        return FeatureSelection(
            providerID: target.target.modelSelection.instanceId,
            modelID: target.target.modelSelection.model
        )
    }

    // MARK: - Submit

    private func startConversation() {
        let trimmed = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !isSubmitting,
              let target = activeTarget,
              !trimmed.isEmpty || !attachments.isEmpty else {
            return
        }
        promptFocused = false
        isSubmitting = true
        // Directory-based on purpose: Work has no branch to pick and the
        // server rejects a worktree strategy for the backing project.
        let request = NewTaskRequest(
            projectID: target.target.project.project.id,
            prompt: trimmed,
            selection: selection ?? defaultSelection,
            runtimeMode: .fullAccess,
            interactionMode: .standard,
            workspaceMode: .local,
            branch: nil,
            worktreePath: nil,
            startFromOrigin: false,
            attachments: attachments
        )
        Task { @MainActor in
            let thread = await submit(request)
            isSubmitting = false
            if let thread {
                if flavor == .chat,
                   let assigner = model.client as? any FeatureThreadRoleAssigning {
                    // Best-effort: an older server rejects the value and the
                    // conversation simply lives in Work instead of Chat.
                    try? await assigner.setWorkInboxRole(threadID: thread.id, role: "chat")
                }
                onCreated(thread)
            } else {
                submissionFailed = true
            }
        }
    }
}
