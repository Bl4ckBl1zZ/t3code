import SwiftUI
import UIKit

/// Runs a provider's install or sign-in command on the computer in a live
/// terminal. The subtitle carries the process state; closing while the
/// command runs asks first, because it ends the command.
struct AgentSetupTerminalView: View {
    @SwiftUI.Environment(\.dismiss) private var dismiss
    let session: any FeatureAgentSetupTerminal
    var title = "Agent Setup"
    var machineName: String?
    @State private var buffer = ""
    @State private var cursor = FeatureTerminalOutputCursor()
    @State private var phase = AgentSetupTerminalPhase.starting
    @State private var focusRequest = 0
    @State private var fontSize = 13
    @State private var error: String?
    @State private var lastSequence: Int?
    @State private var confirmingClose = false

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 12) {
                commandBlock
                if let error {
                    Label(error, systemImage: "exclamationmark.triangle.fill")
                        .font(T3Typography.supporting)
                        .foregroundStyle(T3Colors.danger)
                        .padding(.horizontal)
                }
                GhosttyTerminalSurface(terminalKey: session.id, buffer: buffer, outputCursor: cursor, fontSize: CGFloat(fontSize), isRunning: phase == .running, focusRequest: focusRequest,
                    onInput: { data in Task { do { try await session.write(data) } catch { self.error = error.localizedDescription } } },
                    onResize: { columns, rows in Task { try? await session.resize(columns: columns, rows: rows) } },
                    onClear: { Task { try? await session.clear() } },
                    onFontSizeStep: { fontSize = min(24, max(9, fontSize + $0)) })
            }
            .padding(.top, 8)
            .background(T3Colors.background)
            .navigationBarTitleDisplayMode(.inline)
            .t3NavigationChrome()
            .toolbar {
                ToolbarItem(placement: .principal) {
                    VStack(spacing: 0) {
                        Text(title).font(T3Typography.navigationTitle).foregroundStyle(T3Colors.textPrimary)
                        Text([machineName, phase.label].compactMap { $0 }.joined(separator: " · "))
                            .font(.caption)
                            .foregroundStyle(phase.color)
                    }
                    .accessibilityElement(children: .combine)
                }
                ToolbarItem(placement: .cancellationAction) {
                    if #available(iOS 26, *) {
                        Button(role: .close, action: requestClose)
                    } else {
                        Button("Close", action: requestClose)
                    }
                }
                if phase.isDone {
                    ToolbarItem(placement: .confirmationAction) {
                        T3SheetConfirmButton(confirmation: T3SheetConfirmation(title: "Done") { dismiss() })
                    }
                }
            }
            .confirmationDialog(
                "Stop the command?",
                isPresented: $confirmingClose,
                titleVisibility: .visible
            ) {
                Button("Stop and Close", role: .destructive) { dismiss() }
                Button("Keep Running", role: .cancel) {}
            } message: {
                Text("Closing ends the command on \(machineName ?? "your computer").")
            }
        }
        .interactiveDismissDisabled(phase == .running)
        .task {
            do {
                let events = try await session.start()
                for try await event in events {
                    guard !Task.isCancelled else { break }
                    consume(event)
                }
            } catch {
                if !Task.isCancelled {
                    self.error = error.localizedDescription
                    phase = .failed
                }
                await session.close()
            }
        }
        .onDisappear { Task { await session.close() } }
    }

    private var commandBlock: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("Command")
                    .font(T3Typography.supportingStrong)
                    .foregroundStyle(T3Colors.textSecondary)
                Spacer()
                Button {
                    UIPasteboard.general.string = session.command
                    T3HUD.show("Copied", systemImage: "doc.on.doc")
                } label: {
                    Label("Copy Command", systemImage: "doc.on.doc")
                        .labelStyle(.iconOnly)
                }
                .buttonStyle(.borderless)
                .tint(T3Colors.accent)
            }
            Text(session.command)
                .font(T3Typography.code)
                .foregroundStyle(T3Colors.textPrimary)
                .textSelection(.enabled)
            Text("Review the command, then press Return to run it.")
                .font(T3Typography.supporting)
                .foregroundStyle(T3Colors.textSecondary)
        }
        .padding(12)
        .background(T3Colors.surface, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .padding(.horizontal)
    }

    private func requestClose() {
        if phase == .running {
            confirmingClose = true
        } else {
            dismiss()
        }
    }

    private func consume(_ event: TerminalEvent) {
        if let snapshot = event.snapshot {
            buffer = snapshot.history
            cursor = FeatureTerminalOutputCursor(byteOffset: buffer.utf8.count)
            phase = snapshot.status == .running || snapshot.status == .starting ? .running : .finished
            lastSequence = snapshot.sequence
            focusRequest += 1
        } else {
            if let sequence = event.sequence, let lastSequence, sequence <= lastSequence { return }
            if let sequence = event.sequence { lastSequence = sequence }
            switch event.type {
            case "output":
                let data = event.data ?? ""
                cursor.byteOffset += data.utf8.count
                buffer += data
            case "cleared": buffer = ""; cursor = FeatureTerminalOutputCursor()
            case "exited", "closed": phase = .finished
            case "error": phase = .failed; error = event.message
            default: break
            }
        }
        if buffer.utf8.count > 512 * 1024 { buffer = String(decoding: buffer.utf8.suffix(512 * 1024), as: UTF8.self) }
    }
}

private enum AgentSetupTerminalPhase: Equatable {
    case starting
    case running
    case finished
    case failed

    var label: String {
        switch self {
        case .starting: "Starting…"
        case .running: "Running"
        case .finished: "Finished"
        case .failed: "Failed"
        }
    }

    var color: Color {
        switch self {
        case .starting, .running: T3Colors.textTertiary
        case .finished: T3Colors.success
        case .failed: T3Colors.danger
        }
    }

    var isDone: Bool {
        self == .finished || self == .failed
    }
}
