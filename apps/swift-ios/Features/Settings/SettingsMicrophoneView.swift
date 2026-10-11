import AVFoundation
import SwiftUI
import UIKit

// Ported from apps/mobile/src/features/settings/SettingsMicrophoneRouteScreen.tsx.

/// Microphone kinds and remembered devices, in the order voice input prefers
/// them. Stored on this device. A device joins the list the first time it is
/// connected during dictation; until then its kind's row ranks it.
struct SettingsMicrophoneView: View {
    @AppStorage(MicrophonePriority.storageKey) private var storedOrder = ""
    @SwiftUI.Environment(\.scenePhase) private var scenePhase
    @State private var permission: AVAudioApplication.recordPermission?
    @State private var editMode: EditMode = .inactive

    private var entries: [MicrophoneEntry] { MicrophonePriority.decode(storedOrder) }

    var body: some View {
        SettingsForm {
            if let permission, permission != .granted {
                accessSection(permission)
            }
            Section {
                ForEach(entries, id: \.key) { entry in
                    MicrophoneRow(entry: entry)
                        .deleteDisabled(!entry.isDevice)
                }
                .onMove(perform: move)
                .onDelete(perform: forget)
            } header: {
                Text("Preferred Order")
            } footer: {
                Text("Voice input records from the first connected microphone in this list. Wired and Bluetooth devices are added by name after you use voice input with them connected; until then, the Other row ranks them.")
            }
        }
        .environment(\.editMode, $editMode)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button(editMode.isEditing ? "Done" : "Edit") {
                    withAnimation { editMode = editMode.isEditing ? .inactive : .active }
                }
            }
        }
        .navigationTitle("Microphone")
        .navigationBarTitleDisplayMode(.inline)
        .task(id: scenePhase) {
            // Re-read when the app returns from system Settings.
            guard scenePhase == .active else { return }
            permission = AVAudioApplication.shared.recordPermission
        }
    }

    private func accessSection(_ permission: AVAudioApplication.recordPermission) -> some View {
        let canAsk = permission == .undetermined
        return Section {
            Button {
                if canAsk {
                    AVAudioApplication.requestRecordPermission { _ in
                        Task { @MainActor in
                            self.permission = AVAudioApplication.shared.recordPermission
                        }
                    }
                } else if let url = URL(string: UIApplication.openSettingsURLString) {
                    UIApplication.shared.open(url)
                }
            } label: {
                SettingsTileLabel(
                    title: canAsk ? "Allow Microphone Access" : "Open Settings",
                    systemImage: "mic",
                    tint: .red
                )
            }
        } header: {
            Text("Microphone Access")
        } footer: {
            Text(canAsk
                ? "Voice input needs microphone access before it can record or list your microphones."
                : "Microphone access is off for T3 Code. Turn it on in Settings to use voice input.")
        }
    }

    /// Applies to the stored order, so a device recorded meanwhile is kept.
    private func move(from source: IndexSet, to destination: Int) {
        var next = MicrophonePriority.decode(storedOrder)
        next.move(fromOffsets: source, toOffset: destination)
        storedOrder = MicrophonePriority.encode(next)
        PlatformHapticEngine.shared.playSelection()
    }

    private func forget(at offsets: IndexSet) {
        let keys = Set(offsets.map { entries[$0].key })
        let next = MicrophonePriority.order(
            MicrophonePriority.decode(storedOrder).filter { !keys.contains($0.key) || !$0.isDevice }
        )
        storedOrder = MicrophonePriority.encode(next)
    }
}

private struct MicrophoneRow: View {
    let entry: MicrophoneEntry

    var body: some View {
        Label {
            VStack(alignment: .leading, spacing: 2) {
                Text(entry.name ?? Self.row(entry.kind))
                    .foregroundStyle(T3Colors.textPrimary)
                    .lineLimit(1)
                Text(entry.isDevice ? Self.label(entry.kind) : Self.description(entry.kind))
                    .font(.footnote)
                    .foregroundStyle(T3Colors.textSecondary)
                    .lineLimit(1)
            }
        } icon: {
            Image(systemName: Self.icon(entry.kind))
                .foregroundStyle(T3Colors.textSecondary)
        }
        .accessibilityElement(children: .combine)
    }

    /// Shown under a remembered device's name.
    static func label(_ kind: MicrophoneKind) -> String {
        switch kind {
        case .wired: "Wired"
        case .bluetooth: "Bluetooth"
        case .builtIn: "Built-in"
        case .carPlay: "CarPlay"
        }
    }

    static func row(_ kind: MicrophoneKind) -> String {
        switch kind {
        case .wired: "Other Wired"
        case .bluetooth: "Other Bluetooth"
        case .builtIn: "Built-in Microphone"
        case .carPlay: "CarPlay"
        }
    }

    static func description(_ kind: MicrophoneKind) -> String {
        switch kind {
        case .wired: "Headsets and USB microphones not listed"
        case .bluetooth: "AirPods, headsets, and cars not listed"
        case .builtIn: "The microphone on this device"
        case .carPlay: "The car’s microphone"
        }
    }

    static func icon(_ kind: MicrophoneKind) -> String {
        switch kind {
        case .wired: "cable.connector"
        case .bluetooth: "headphones"
        case .builtIn: "iphone"
        case .carPlay: "car"
        }
    }
}
