import Foundation
import XCTest

@testable import T3Code

/// Ports apps/mobile/src/lib/microphonePriority.test.ts.
final class MicrophonePriorityTests: XCTestCase {
    private let iPhone = MicrophoneInput(uid: "Built-In Microphone", name: "iPhone Microphone", type: "MicrophoneBuiltIn")
    private let airPods = MicrophoneInput(uid: "airpods", name: "Julius’s AirPods Pro", type: "BluetoothHFP")
    private let bose = MicrophoneInput(uid: "bose", name: "Julius’s Bose QC", type: "BluetoothHFP")
    private let civic = MicrophoneInput(uid: "civic", name: "Honda Civic", type: "BluetoothHFP")
    private let carPlay = MicrophoneInput(uid: "carplay", name: "CarPlay", type: "CarAudio")
    private let usb = MicrophoneInput(uid: "usb", name: "Shure MV7", type: "USBAudio")

    private func keys(_ order: [MicrophoneEntry]) -> [String] { order.map(\.key) }

    func testDefaultOrderListsEveryKindOnceWithCarPlayBelowBuiltIn() {
        XCTAssertEqual(
            keys(MicrophonePriority.order()),
            ["kind:wired", "kind:bluetooth", "kind:builtIn", "kind:carPlay"]
        )
    }

    func testSavedOrderIsKeptAndMissingKindsFollowTheirDevices() {
        let saved: [MicrophoneEntry] = [
            .kind(.builtIn),
            .device(.bluetooth, uid: "airpods", name: "AirPods"),
            .kind(.builtIn),
        ]
        XCTAssertEqual(
            keys(MicrophonePriority.order(saved)),
            ["kind:wired", "kind:builtIn", "airpods", "kind:bluetooth", "kind:carPlay"]
        )
    }

    func testNewDeviceIsListedJustAboveItsKindAndBuiltInStaysAKind() {
        let order = MicrophonePriority.remember(MicrophonePriority.order(), inputs: [iPhone, carPlay, airPods])
        XCTAssertEqual(
            keys(order),
            ["kind:wired", "airpods", "kind:bluetooth", "kind:builtIn", "kind:carPlay"]
        )
    }

    func testRememberRefreshesRenamedDevicesAndIsStableOtherwise() {
        let order = MicrophonePriority.remember(MicrophonePriority.order(), inputs: [airPods])
        XCTAssertEqual(MicrophonePriority.remember(order, inputs: [airPods, iPhone]), order)

        let renamed = MicrophonePriority.remember(
            order,
            inputs: [MicrophoneInput(uid: "airpods", name: "AirPods Max", type: "BluetoothHFP")]
        )
        XCTAssertEqual(
            renamed.first { $0.key == "airpods" },
            .device(.bluetooth, uid: "airpods", name: "AirPods Max")
        )
    }

    func testUnlistedDevicesRankAtTheirKindAheadOfDevicesListedBelow() {
        // Built-in, Bose, Wired, other Bluetooth, AirPods, CarPlay.
        let order: [MicrophoneEntry] = [
            .kind(.builtIn),
            .device(.bluetooth, uid: "bose", name: bose.name),
            .kind(.wired),
            .kind(.bluetooth),
            .device(.bluetooth, uid: "airpods", name: airPods.name),
            .kind(.carPlay),
        ]
        XCTAssertEqual(MicrophonePriority.preferredInput([airPods, civic], order: order), civic)
        XCTAssertEqual(MicrophonePriority.preferredInput([airPods, bose], order: order), bose)
        XCTAssertEqual(MicrophonePriority.preferredInput([airPods, usb], order: order), usb)
        XCTAssertEqual(MicrophonePriority.preferredInput([airPods, carPlay], order: order), airPods)
        XCTAssertEqual(MicrophonePriority.preferredInput([airPods, iPhone], order: order), iPhone)
    }

    func testUnknownInputKindsAreLeftToIOS() {
        let virtual = MicrophoneInput(uid: "x", name: "x", type: "Virtual")
        XCTAssertNil(MicrophonePriority.preferredInput([virtual], order: MicrophonePriority.order()))
    }

    func testStoredOrderRoundTripsAndBadStorageFallsBackToDefault() {
        let order = MicrophonePriority.remember(MicrophonePriority.order(), inputs: [airPods, usb])
        XCTAssertEqual(MicrophonePriority.decode(MicrophonePriority.encode(order)), order)
        XCTAssertEqual(MicrophonePriority.decode("not json"), MicrophonePriority.order())
    }
}
