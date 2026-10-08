import CoreTransferable
import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// Writes a plan into the thread's workspace. Present only where the thread has
/// a workspace to write into; transcript cells read it from the environment
/// because a hosting configuration roots its own.
struct ProposedPlanWorkspaceSaver {
    /// Shown in the save prompt so the reader knows where a relative path lands.
    let workspaceRoot: String
    let save: @MainActor (_ relativePath: String, _ contents: String) async throws -> String
}

private struct ProposedPlanWorkspaceSaverKey: EnvironmentKey {
    static let defaultValue: ProposedPlanWorkspaceSaver? = nil
}

extension EnvironmentValues {
    var proposedPlanWorkspaceSaver: ProposedPlanWorkspaceSaver? {
        get { self[ProposedPlanWorkspaceSaverKey.self] }
        set { self[ProposedPlanWorkspaceSaverKey.self] = newValue }
    }
}

/// The plan as a `.md` file for the share sheet — iOS's stand-in for web's
/// "Download as markdown".
private struct ProposedPlanMarkdownFile: Transferable {
    let filename: String
    let contents: String

    static var transferRepresentation: some TransferRepresentation {
        DataRepresentation(exportedContentType: .markdownDocument) { Data($0.contents.utf8) }
            .suggestedFileName { $0.filename }
    }
}

private extension UTType {
    /// Declared by the system on every supported version; plain text otherwise.
    static let markdownDocument = UTType("net.daringfireball.markdown") ?? .utf8PlainText
}

/// Copy, Share and Save to Workspace for one plan, as the card and the plan
/// sheet both offer them.
struct ProposedPlanActionsMenu: View {
    let plan: ThreadProposedPlan
    var saver: ProposedPlanWorkspaceSaver?
    @State private var savePath = ""
    @State private var isPromptingSave = false
    @State private var isSaving = false
    @State private var saveFailure: String?

    var body: some View {
        Menu {
            Button("Copy Plan", systemImage: "doc.on.doc") {
                UIPasteboard.general.string = plan.exportedMarkdown
                T3HUD.show("Copied", systemImage: "doc.on.doc")
            }
            ShareLink(
                item: ProposedPlanMarkdownFile(filename: plan.filename, contents: plan.exportedMarkdown),
                preview: SharePreview(plan.filename, image: Image(systemName: "doc.text"))
            ) {
                Label("Share as Markdown", systemImage: "square.and.arrow.up")
            }
            if saver != nil {
                Button("Save to Workspace…", systemImage: "square.and.arrow.down") {
                    savePath = plan.filename
                    isPromptingSave = true
                }
                .disabled(isSaving)
            }
        } label: {
            Image(systemName: "ellipsis.circle")
                .font(.body.weight(.medium))
                .foregroundStyle(T3Colors.textSecondary)
                .frame(width: T3Metrics.minimumTapTarget, height: T3Metrics.minimumTapTarget)
                .contentShape(Rectangle())
        }
        .accessibilityLabel("Plan Actions")
        .alert("Save Plan to Workspace", isPresented: $isPromptingSave) {
            TextField("Path", text: $savePath)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            Button("Cancel", role: .cancel) {}
            Button("Save") { save() }
                .disabled(savePath.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        } message: {
            Text("A path relative to \(saver?.workspaceRoot ?? "the workspace").")
        }
        .alert("Couldn't Save Plan", isPresented: Binding(
            get: { saveFailure != nil },
            set: { if !$0 { saveFailure = nil } }
        )) {
            Button("OK") { saveFailure = nil }
        } message: {
            Text(saveFailure ?? "")
        }
    }

    private func save() {
        let path = savePath.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let saver, !path.isEmpty, !isSaving else { return }
        isSaving = true
        let contents = plan.exportedMarkdown
        Task {
            do {
                let written = try await saver.save(path, contents)
                T3HUD.show("Saved \(written)", systemImage: "checkmark.circle.fill")
            } catch is CancellationError {
            } catch {
                saveFailure = error.localizedDescription
            }
            isSaving = false
        }
    }
}

/// Expansion outlives a recycled cell, so a long plan the reader opened stays
/// open when it scrolls back into view.
@MainActor
enum ProposedPlanCardExpansion {
    static var expandedIDs = Set<String>()
}

/// A proposed plan in the transcript (web's `ProposedPlanCard`): its title, the
/// plan itself — a preview when long — and its actions.
struct ProposedPlanCard: View {
    let entry: ThreadProposedPlanEntry
    @SwiftUI.Environment(\.proposedPlanWorkspaceSaver) private var saver
    @State private var isExpanded: Bool

    init(entry: ThreadProposedPlanEntry) {
        self.entry = entry
        _isExpanded = State(initialValue: ProposedPlanCardExpansion.expandedIDs.contains(entry.plan.id))
    }

    private var plan: ThreadProposedPlan { entry.plan }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            header
            let text = isExpanded ? plan.displayedMarkdown : plan.collapsedPreview ?? plan.displayedMarkdown
            if !text.isEmpty {
                MarkdownMessageView(text, isStreaming: plan.isStreaming)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            if plan.collapsedPreview != nil {
                Button {
                    isExpanded.toggle()
                    if isExpanded {
                        ProposedPlanCardExpansion.expandedIDs.insert(plan.id)
                    } else {
                        ProposedPlanCardExpansion.expandedIDs.remove(plan.id)
                    }
                } label: {
                    Label(isExpanded ? "Collapse Plan" : "Expand Plan", systemImage: isExpanded ? "chevron.up" : "chevron.down")
                }
                .buttonStyle(.bordered)
                .buttonBorderShape(.capsule)
                .controlSize(.small)
                .tint(T3Colors.textPrimary)
                .frame(maxWidth: .infinity)
            }
        }
        .padding(.leading, 16)
        .padding([.trailing, .vertical], 12)
        .background(T3Colors.surface, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .strokeBorder(T3Colors.border, lineWidth: 1)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("proposed-plan-card")
    }

    private var header: some View {
        HStack(alignment: .center, spacing: 8) {
            Text("Plan")
                .font(T3Typography.supportingStrong)
                .foregroundStyle(entry.isSuperseded ? T3Colors.textSecondary : T3Colors.statusInput)
                .padding(.horizontal, 8)
                .padding(.vertical, 2)
                .background(
                    (entry.isSuperseded ? T3Colors.textSecondary : T3Colors.statusInput).opacity(0.14),
                    in: Capsule()
                )
            Text(plan.title ?? "Proposed plan")
                .font(T3Typography.threadHeading4)
                .foregroundStyle(entry.isSuperseded ? T3Colors.textSecondary : T3Colors.textPrimary)
                .lineLimit(3)
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityAddTraits(.isHeader)
            if let status {
                Text(status)
                    .font(T3Typography.supporting)
                    .foregroundStyle(T3Colors.textTertiary)
            }
            if !plan.isStreaming {
                ProposedPlanActionsMenu(plan: plan, saver: saver)
            }
        }
        .frame(minHeight: T3Metrics.minimumTapTarget)
    }

    /// Static text, never an animation: a drafting plan streams into view on
    /// its own.
    private var status: String? {
        if plan.isStreaming { return "Drafting…" }
        return entry.isSuperseded ? "Superseded" : nil
    }
}
