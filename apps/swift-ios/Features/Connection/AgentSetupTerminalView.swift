import SwiftUI

struct AgentSetupTerminalView: View {
    @SwiftUI.Environment(\.dismiss) private var dismiss
    let session: any FeatureAgentSetupTerminal
    @State private var buffer = ""
    @State private var cursor = FeatureTerminalOutputCursor()
    @State private var running = false
    @State private var focusRequest = 0
    @State private var fontSize = 13
    @State private var error: String?
    @State private var lastSequence: Int?

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 10) {
                Text("Review the command, then press Enter to run it.").font(T3Typography.supporting).foregroundStyle(T3Colors.textSecondary).padding(.horizontal)
                Text(session.command).font(.caption.monospaced()).textSelection(.enabled).padding(.horizontal)
                if let error { Text(error).font(T3Typography.supporting).foregroundStyle(T3Colors.textSecondary).padding(.horizontal) }
                GhosttyTerminalSurface(terminalKey: session.id, buffer: buffer, outputCursor: cursor, fontSize: CGFloat(fontSize), isRunning: running, focusRequest: focusRequest,
                    onInput: { data in Task { do { try await session.write(data) } catch { self.error = error.localizedDescription } } },
                    onResize: { columns, rows in Task { try? await session.resize(columns: columns, rows: rows) } },
                    onClear: { Task { try? await session.clear() } },
                    onFontSizeStep: { fontSize = min(24, max(9, fontSize + $0)) })
            }
            .background(T3Colors.background)
            .navigationTitle("Agent setup")
            .navigationBarTitleDisplayMode(.inline)
            .t3NavigationChrome()
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Close") { dismiss() } } }
        }
        .task {
            do {
                let events = try await session.start()
                for try await event in events {
                    guard !Task.isCancelled else { break }
                    consume(event)
                }
            } catch {
                if !Task.isCancelled { self.error = error.localizedDescription }
                await session.close()
            }
        }
        .onDisappear { Task { await session.close() } }
    }

    private func consume(_ event: TerminalEvent) {
        if let snapshot = event.snapshot {
            buffer = snapshot.history
            cursor = FeatureTerminalOutputCursor(byteOffset: buffer.utf8.count)
            running = snapshot.status == .running || snapshot.status == .starting
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
            case "exited", "closed": running = false
            case "error": running = false; error = event.message
            default: break
            }
        }
        if buffer.utf8.count > 512 * 1024 { buffer = String(decoding: buffer.utf8.suffix(512 * 1024), as: UTF8.self) }
    }
}
