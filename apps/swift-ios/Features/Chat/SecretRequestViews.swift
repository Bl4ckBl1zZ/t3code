import SwiftUI

// An agent's `request_secret`, answered from the phone. Ports
// apps/web/src/components/chat/SecretRequestCard.tsx and
// packages/client-runtime/src/secretRequest.ts.
//
// Web answers inline in the timeline. Here the open request takes the
// composer's place, as approvals and questions do: it stays on screen beside
// the keyboard however far the transcript scrolls, and the work log row only
// records what was asked and how it ended.

/// One request the user can still answer from this thread.
struct PendingSecretRequest: Identifiable, Equatable {
    /// The projected row's id, unique within the thread.
    let id: String
    /// The item's own wire thread and id: what `secrets.answerRequest` takes.
    let sourceThreadID: String
    let turnItemID: String
    let label: String
    let reason: String
    let placeholder: String?
}

enum SecretRequestPresentation {
    static let privacyNote = "Stored securely, never shown to the agent"
    static let defaultPlaceholder = "Paste the secret"

    enum Display: Equatable {
        case pending
        /// Pending, but asked in another thread (a fork inherited it), which is
        /// the only place it can be answered.
        case pendingElsewhere
        case saved
        case declined
        case ended

        var label: String {
            switch self {
            case .pending: "Waiting for your answer"
            case .pendingElsewhere: "Waiting for an answer in the original thread"
            case .saved: "Saved securely and kept private"
            case .declined: "Declined"
            case .ended: "Request ended"
            }
        }
    }

    static func display(
        status: OrchestrationV2SecretRequestStatus,
        visibility: OrchestrationV2TurnItemVisibility
    ) -> Display {
        switch status {
        case .pending: visibility == .local ? .pending : .pendingElsewhere
        case .saved: .saved
        case .declined: .declined
        // A status this build predates is no longer answerable here.
        case .cancelled, .unknown: .ended
        }
    }

    /// Open requests, oldest first: the order the agent asked them in.
    static func pending(in items: [OrchestrationV2ProjectedTurnItem]) -> [PendingSecretRequest] {
        items.compactMap { projected in
            guard case let .secretRequest(label, reason, placeholder, status) = projected.item.payload,
                  display(status: status, visibility: projected.visibility) == .pending else { return nil }
            return PendingSecretRequest(
                id: projected.id,
                sourceThreadID: projected.item.base.threadId,
                turnItemID: projected.item.id,
                label: label,
                reason: reason.trimmingCharacters(in: .whitespacesAndNewlines),
                placeholder: placeholder?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfBlank
            )
        }
    }

    /// Save is offered only for something the server would keep.
    static func canSave(_ secret: String) -> Bool {
        !secret.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
}

private extension String {
    var nilIfBlank: String? { isEmpty ? nil : self }
}

/// The open request, in place of the editor.
///
/// The typed value lives only in this view's state and the RPC payload: never
/// in the draft store, the outbox, state restoration or a log, and it is
/// cleared once sent, when the request goes away, and when the panel leaves.
struct FeatureComposerSecretRequestPanel: View {
    let request: PendingSecretRequest
    let position: Int
    let total: Int
    let onAnswer: (SecretRequestAnswer) async throws -> Void

    private enum Action: Equatable { case save, decline }

    @State private var secret = ""
    @State private var isRevealed = false
    @State private var pendingAction: Action?
    @State private var errorMessage: String?
    @FocusState private var fieldFocused: Bool
    @SwiftUI.Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Label(request.label, systemImage: "key.fill")
                    .font(T3Typography.navigationTitle)
                    .foregroundStyle(T3Colors.textPrimary)
                    .lineLimit(2)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if total > 1 {
                    Text("\(position) of \(total)")
                        .font(T3Typography.supporting.monospacedDigit())
                        .foregroundStyle(T3Colors.textSecondary)
                }
            }

            if !request.reason.isEmpty {
                Text(request.reason)
                    .font(T3Typography.supporting)
                    .foregroundStyle(T3Colors.textSecondary)
                    .lineLimit(dynamicTypeSize.isAccessibilitySize ? 4 : 6)
                    .fixedSize(horizontal: false, vertical: true)
            }

            field

            if let errorMessage {
                Label(errorMessage, systemImage: "exclamationmark.circle")
                    .font(T3Typography.supporting)
                    .foregroundStyle(T3Colors.danger)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityLabel("Error: \(errorMessage)")
            }

            Label(SecretRequestPresentation.privacyNote, systemImage: "checkmark.shield")
                .font(T3Typography.supporting)
                .foregroundStyle(T3Colors.textTertiary)
                .fixedSize(horizontal: false, vertical: true)

            actions
        }
        .padding(.horizontal, 14)
        .padding(.top, 14)
        .padding(.bottom, 12)
        .t3SensoryFeedback(.warning, trigger: request.id)
        .onChange(of: request.id) { reset() }
        .onDisappear { reset() }
        .accessibilityElement(children: .contain)
    }

    // MARK: - Field

    private var field: some View {
        HStack(spacing: 4) {
            Group {
                // Not a password field to the system: no content type, so iOS
                // offers no strong password and no "save to Passwords" prompt
                // for what is usually an API key. The Passwords AutoFill bar a
                // secure field gets still lets a stored key be filled in.
                if isRevealed {
                    TextField(placeholder, text: $secret)
                        .font(T3Typography.code)
                } else {
                    SecureField(placeholder, text: $secret)
                }
            }
            .textContentType(nil)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .keyboardType(.asciiCapable)
            .submitLabel(.done)
            .onSubmit { send(.save) }
            .focused($fieldFocused)
            .privacySensitive()
            .disabled(pendingAction != nil)
            .padding(.leading, 12)
            .frame(minHeight: T3Metrics.minimumTapTarget)
            .accessibilityLabel(request.label)
            .accessibilityHint("Secret value. \(SecretRequestPresentation.privacyNote).")

            Button {
                let wasFocused = fieldFocused
                isRevealed.toggle()
                // The two fields are different views; keep the keyboard up.
                if wasFocused { fieldFocused = true }
            } label: {
                Image(systemName: isRevealed ? "eye.slash" : "eye")
                    .foregroundStyle(T3Colors.textSecondary)
                    .frame(width: T3Metrics.minimumTapTarget, height: T3Metrics.minimumTapTarget)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(isRevealed ? "Hide secret" : "Show secret")
        }
        .background(T3Colors.input, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .strokeBorder(errorMessage == nil ? T3Colors.inputBorder : T3Colors.danger, lineWidth: 1)
        }
    }

    private var placeholder: String {
        request.placeholder ?? SecretRequestPresentation.defaultPlaceholder
    }

    // MARK: - Actions

    @ViewBuilder
    private var actions: some View {
        let layout = dynamicTypeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(spacing: 8))
            : AnyLayout(HStackLayout(spacing: 8))
        layout {
            actionButton("Decline", action: .decline)
                .buttonStyle(.bordered)
                .tint(T3Colors.textSecondary)
            actionButton("Save Securely", action: .save)
                .t3ProminentButtonStyle()
                .disabled(!SecretRequestPresentation.canSave(secret))
        }
        .buttonBorderShape(.capsule)
        .controlSize(.large)
        .disabled(pendingAction != nil)
    }

    private func actionButton(_ title: String, action: Action) -> some View {
        Button {
            send(action)
        } label: {
            ZStack {
                Text(title)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
                    .opacity(pendingAction == action ? 0 : 1)
                if pendingAction == action {
                    ProgressView().controlSize(.small)
                }
            }
            .frame(maxWidth: .infinity, minHeight: 30)
        }
        .accessibilityLabel(pendingAction == action ? "\(title), sending" : title)
    }

    private func send(_ action: Action) {
        guard pendingAction == nil else { return }
        let answer: SecretRequestAnswer
        switch action {
        case .save:
            guard SecretRequestPresentation.canSave(secret) else { return }
            answer = .save(secret)
        case .decline:
            answer = .decline
        }
        pendingAction = action
        errorMessage = nil
        let requestID = request.id
        Task {
            do {
                try await onAnswer(answer)
                guard requestID == request.id else { return }
                // The row turns to its answered line once the item updates.
                secret = ""
                fieldFocused = false
                PlatformHapticEngine.shared.play(.success)
            } catch is CancellationError {
            } catch {
                guard requestID == request.id else { return }
                let message = SecretRequestFailure.userMessage(for: error)
                errorMessage = message
                PlatformHapticEngine.shared.play(.error)
                AccessibilityNotification.Announcement(message).post()
            }
            if requestID == request.id { pendingAction = nil }
        }
    }

    private func reset() {
        secret = ""
        isRevealed = false
        pendingAction = nil
        errorMessage = nil
    }
}

/// The request in the work log: one line saying what was asked and how it
/// stands, the shape web gives answered requests.
struct SecretRequestTimelineRow: View {
    let label: String
    let display: SecretRequestPresentation.Display

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: symbol)
                .font(ChatTimelineStyle.bodyStrong)
                .foregroundStyle(display == .pending ? T3Colors.statusInput : T3Colors.textTertiary)
                .frame(width: 20)
                .accessibilityHidden(true)
            Text(line)
                .font(ChatTimelineStyle.body)
                .lineLimit(1)
                .truncationMode(.tail)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(minHeight: T3Metrics.minimumTapTarget)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Secret request, \(label): \(display.label)")
    }

    private var line: AttributedString {
        var name = AttributedString(label)
        name.foregroundColor = T3Colors.textPrimary
        var state = AttributedString(" · \(display.label)")
        state.foregroundColor = T3Colors.textSecondary
        return name + state
    }

    private var symbol: String {
        switch display {
        case .pending: "key.fill"
        case .pendingElsewhere: "lock"
        case .saved: "checkmark"
        case .declined, .ended: "minus"
        }
    }
}
