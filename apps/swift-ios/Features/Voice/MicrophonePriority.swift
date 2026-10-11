import Foundation

// Ported from apps/mobile/src/lib/microphonePriority.ts.
//
// The order voice input picks a microphone in. An entry is either a kind,
// which covers every connected microphone of that kind not listed by name, or
// a device remembered the first time dictation saw it connected. iOS lists
// only connected inputs, and only while a recording session is active, so a
// device cannot be listed before then.

enum MicrophoneKind: String, Codable, CaseIterable, Sendable {
    case wired
    case bluetooth
    case builtIn
    case carPlay

    /// Kinds that list their devices by name. A phone has one built-in
    /// microphone, and CarPlay is the car.
    var listsDevices: Bool { self == .wired || self == .bluetooth }

    fileprivate var rank: Int { Self.allCases.firstIndex(of: self) ?? 0 }

    /// Raw values of `AVAudioSession.Port`. A car without CarPlay connects as a
    /// Bluetooth headset, so it is a Bluetooth device.
    init?(portType: String) {
        switch portType {
        case "MicrophoneWired", "USBAudio", "LineIn": self = .wired
        case "BluetoothHFP", "BluetoothLE": self = .bluetooth
        case "MicrophoneBuiltIn": self = .builtIn
        case "CarAudio": self = .carPlay
        default: return nil
        }
    }
}

/// A connected input as the audio session describes it.
struct MicrophoneInput: Equatable, Sendable {
    /// iOS's port identifier, stable across reconnects of the same device.
    let uid: String
    let name: String
    /// `AVAudioSession.Port` raw value.
    let type: String
}

struct MicrophoneEntry: Codable, Hashable, Sendable {
    let kind: MicrophoneKind
    /// Set for a remembered device; nil for the row covering its whole kind.
    let uid: String?
    let name: String?

    static func kind(_ kind: MicrophoneKind) -> MicrophoneEntry {
        MicrophoneEntry(kind: kind, uid: nil, name: nil)
    }

    static func device(_ kind: MicrophoneKind, uid: String, name: String) -> MicrophoneEntry {
        MicrophoneEntry(kind: kind, uid: uid, name: name)
    }

    var isDevice: Bool { uid != nil }

    var key: String { uid ?? "kind:\(kind.rawValue)" }
}

enum MicrophonePriority {
    static let storageKey = "swift-ios.voice.microphones"

    /// The saved order with each kind listed once. A missing kind goes after the
    /// devices of that kind, else above the first kind ranked below it by
    /// default, which puts CarPlay below the built-in microphone.
    static func order(_ saved: [MicrophoneEntry] = []) -> [MicrophoneEntry] {
        var order: [MicrophoneEntry] = []
        var keys = Set<String>()
        for entry in saved {
            let row = entry.isDevice && entry.kind.listsDevices && entry.name != nil
                ? entry
                : .kind(entry.kind)
            guard keys.insert(row.key).inserted else { continue }
            order.append(row)
        }
        for kind in MicrophoneKind.allCases where !keys.contains("kind:\(kind.rawValue)") {
            let lastDevice = order.lastIndex { $0.kind == kind }
            let below = order.firstIndex { !$0.isDevice && $0.kind.rank > kind.rank }
            let index = lastDevice.map { $0 + 1 } ?? below ?? order.endIndex
            order.insert(.kind(kind), at: index)
        }
        return order
    }

    /// Lists connected wired and Bluetooth microphones by name and refreshes
    /// renamed ones. A new device goes just above its kind, keeping the rank it
    /// had while unlisted.
    static func remember(_ order: [MicrophoneEntry], inputs: [MicrophoneInput]) -> [MicrophoneEntry] {
        var next = order
        for input in inputs {
            guard let kind = MicrophoneKind(portType: input.type), kind.listsDevices else { continue }
            let device = MicrophoneEntry.device(kind, uid: input.uid, name: input.name)
            if let index = next.firstIndex(where: { $0.key == input.uid }) {
                next[index] = device
            } else {
                let kindRow = next.firstIndex { $0.key == "kind:\(kind.rawValue)" } ?? next.endIndex
                next.insert(device, at: kindRow)
            }
        }
        return next
    }

    /// The connected input of the first entry that has one, or nil to leave the
    /// route to iOS.
    static func preferredInput(_ inputs: [MicrophoneInput], order: [MicrophoneEntry]) -> MicrophoneInput? {
        let listed = Set(order.compactMap(\.uid))
        for entry in order {
            let match = inputs.first { input in
                if let uid = entry.uid { return input.uid == uid }
                return MicrophoneKind(portType: input.type) == entry.kind && !listed.contains(input.uid)
            }
            if let match { return match }
        }
        return nil
    }

    // MARK: - Storage

    static func decode(_ json: String) -> [MicrophoneEntry] {
        guard let data = json.data(using: .utf8),
              let saved = try? JSONDecoder().decode([MicrophoneEntry].self, from: data) else {
            return order()
        }
        return order(saved)
    }

    static func encode(_ order: [MicrophoneEntry]) -> String {
        guard let data = try? JSONEncoder().encode(order) else { return "" }
        return String(decoding: data, as: UTF8.self)
    }

    /// Remembers newly connected devices and returns the input to record from.
    /// Read when recording starts so a change in Settings applies to the next
    /// recording.
    @MainActor
    static func selectInput(_ inputs: [MicrophoneInput], defaults: UserDefaults = .standard) -> MicrophoneInput? {
        let known = decode(defaults.string(forKey: storageKey) ?? "")
        let next = remember(known, inputs: inputs)
        if next != known {
            defaults.set(encode(next), forKey: storageKey)
        }
        return preferredInput(inputs, order: next)
    }
}
