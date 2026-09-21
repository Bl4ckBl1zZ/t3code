@preconcurrency import AVFoundation
import SwiftUI
import UIKit

/// Full-screen camera for the QR code T3 Code shows on the computer. Only a
/// code that carries a server address and a pairing code ends the scan;
/// anything else shows a hint and keeps the camera running.
struct QRCodeScannerView: View {
    let onScan: (ConnectionDetails) -> Void
    let onPaste: (String) -> Void

    @SwiftUI.Environment(\.dismiss) private var dismiss
    @State private var availability = QRScannerAvailability.checking
    @State private var hasTorch = false
    @State private var isTorchOn = false
    @State private var feedback: QRScanFeedback?
    @State private var lastRejectedCode: String?

    /// False on the Simulator and for iPad apps running on a Mac, where the
    /// scan option is hidden instead of leading to "Camera Unavailable".
    static let isCameraAvailable = AVCaptureDevice.default(for: .video) != nil

    var body: some View {
        NavigationStack {
            ZStack {
                Color.black.ignoresSafeArea()

                QRScannerCameraView(
                    availability: $availability,
                    hasTorch: $hasTorch,
                    isTorchOn: isTorchOn,
                    onCode: handle(code:)
                )
                .ignoresSafeArea()

                switch availability {
                case .checking:
                    EmptyView()
                case .ready:
                    readyOverlay
                case .denied:
                    ContentUnavailableView {
                        Label("Camera Access Is Off", systemImage: "camera.fill")
                    } description: {
                        Text("Allow camera access in Settings to scan a pairing code, or paste the link instead.")
                    } actions: {
                        Button("Open Settings") {
                            guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
                            UIApplication.shared.open(url)
                        }
                        .t3ProminentButtonStyle()
                        pasteButton
                    }
                case .unavailable:
                    ContentUnavailableView {
                        Label("Camera Unavailable", systemImage: "camera.slash.fill")
                    } description: {
                        Text("Paste the connection link instead.")
                    } actions: {
                        pasteButton
                    }
                }
            }
            .navigationTitle("Scan QR Code")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(.hidden, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    if #available(iOS 26, *) {
                        Button(role: .close) { dismiss() }
                    } else {
                        Button("Cancel") { dismiss() }
                    }
                }
                if hasTorch, availability == .ready {
                    ToolbarItem(placement: .primaryAction) {
                        Button {
                            isTorchOn.toggle()
                        } label: {
                            Label(
                                isTorchOn ? "Turn Off Flashlight" : "Turn On Flashlight",
                                systemImage: isTorchOn ? "flashlight.on.fill" : "flashlight.off.fill"
                            )
                        }
                    }
                }
            }
        }
        .preferredColorScheme(.dark)
    }

    private var readyOverlay: some View {
        VStack(spacing: 16) {
            Spacer()
            if let feedback {
                Label(feedback.message, systemImage: feedback.systemImage)
                    .font(T3Typography.control.weight(.semibold))
                    .foregroundStyle(.white)
                    .symbolRenderingMode(.hierarchical)
                    .padding(.horizontal, 18)
                    .padding(.vertical, 12)
                    .t3GlassEffect(in: Capsule())
                    .t3GlassRim(in: Capsule())
                    .transition(.opacity)
            }
            Text("Point your camera at the QR code in T3 Code on your computer.")
                .font(T3Typography.threadBody)
                .foregroundStyle(.white.opacity(0.85))
                .multilineTextAlignment(.center)
                .frame(maxWidth: 420)
            pasteButton
                .padding(.bottom, 8)
        }
        .padding(.horizontal, 32)
        .padding(.bottom, 16)
        .background {
            LinearGradient(
                colors: [.black.opacity(0.45), .clear, .clear, .black.opacity(0.55)],
                startPoint: .top,
                endPoint: .bottom
            )
            .ignoresSafeArea()
            .allowsHitTesting(false)
        }
        .animation(.easeOut(duration: 0.2), value: feedback)
        .task(id: feedback) {
            // A rejected code's hint fades once the camera has moved on.
            guard feedback == .notPairingCode else { return }
            try? await Task.sleep(for: .seconds(2))
            if !Task.isCancelled { feedback = nil }
        }
    }

    private var pasteButton: some View {
        PasteButton(payloadType: String.self) { strings in
            guard let value = strings.first(where: { !$0.isEmpty }) else { return }
            Task { @MainActor in onPaste(value) }
        }
        .labelStyle(.titleAndIcon)
        .buttonBorderShape(.capsule)
        .controlSize(.large)
        .tint(.white)
    }

    /// Returns true when the code ends the scan.
    @MainActor
    private func handle(code value: String) -> Bool {
        guard feedback != .found else { return false }
        guard let details = ConnectionDetailsParser.scannedPairingCode(value) else {
            if value != lastRejectedCode {
                lastRejectedCode = value
                feedback = .notPairingCode
                PlatformHapticEngine.shared.play(.warning)
            }
            return false
        }
        feedback = .found
        PlatformHapticEngine.shared.play(.success)
        Task { @MainActor in
            // Long enough to see the highlight settle on the code.
            try? await Task.sleep(for: .milliseconds(350))
            onScan(details)
        }
        return true
    }
}

private enum QRScanFeedback: Equatable {
    case found
    case notPairingCode

    var message: String {
        switch self {
        case .found: "T3 pairing code"
        case .notPairingCode: "Not a T3 pairing code"
        }
    }

    var systemImage: String {
        switch self {
        case .found: "checkmark.circle.fill"
        case .notPairingCode: "exclamationmark.triangle.fill"
        }
    }
}

private enum QRScannerAvailability: Equatable {
    case checking
    case ready
    case denied
    case unavailable
}

private struct QRScannerCameraView: UIViewControllerRepresentable {
    @Binding var availability: QRScannerAvailability
    @Binding var hasTorch: Bool
    let isTorchOn: Bool
    let onCode: @MainActor (String) -> Bool

    func makeCoordinator() -> Coordinator {
        Coordinator(availability: $availability, hasTorch: $hasTorch, onCode: onCode)
    }

    func makeUIViewController(context: Context) -> QRScannerViewController {
        let controller = QRScannerViewController()
        context.coordinator.attach(to: controller)
        return controller
    }

    func updateUIViewController(_ controller: QRScannerViewController, context: Context) {
        context.coordinator.onCode = onCode
        controller.setTorch(isTorchOn)
    }

    static func dismantleUIViewController(
        _ controller: QRScannerViewController,
        coordinator: Coordinator
    ) {
        controller.stop()
    }

    @MainActor
    final class Coordinator: NSObject, AVCaptureMetadataOutputObjectsDelegate {
        private var availability: Binding<QRScannerAvailability>
        private var hasTorch: Binding<Bool>
        var onCode: @MainActor (String) -> Bool
        private weak var controller: QRScannerViewController?
        private var didScan = false

        init(
            availability: Binding<QRScannerAvailability>,
            hasTorch: Binding<Bool>,
            onCode: @escaping @MainActor (String) -> Bool
        ) {
            self.availability = availability
            self.hasTorch = hasTorch
            self.onCode = onCode
        }

        func attach(to controller: QRScannerViewController) {
            self.controller = controller
            controller.prepare(delegate: self) { [weak self] nextAvailability, hasTorch in
                self?.availability.wrappedValue = nextAvailability
                self?.hasTorch.wrappedValue = hasTorch
            }
        }

        nonisolated func metadataOutput(
            _ output: AVCaptureMetadataOutput,
            didOutput metadataObjects: [AVMetadataObject],
            from connection: AVCaptureConnection
        ) {
            guard let object = metadataObjects.first as? AVMetadataMachineReadableCodeObject,
                  let value = object.stringValue
            else {
                return
            }
            Task { @MainActor [weak self] in
                guard let self, !didScan else { return }
                controller?.highlight(object)
                if onCode(value) {
                    didScan = true
                    controller?.stop()
                }
            }
        }
    }
}

@MainActor
private final class QRScannerViewController: UIViewController {
    private let captureSession = AVCaptureSession()
    private let sessionQueue = DispatchQueue(label: "codes.t3.swift-ios.qr-scanner")
    private var camera: AVCaptureDevice?
    private var previewLayer: AVCaptureVideoPreviewLayer?
    private var rotationCoordinator: AVCaptureDevice.RotationCoordinator?
    private var rotationObservation: NSKeyValueObservation?
    private let highlightLayer = CAShapeLayer()
    private var highlightHideWork: DispatchWorkItem?

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        highlightLayer.fillColor = UIColor.clear.cgColor
        highlightLayer.strokeColor = UIColor.white.cgColor
        highlightLayer.lineWidth = 3
        highlightLayer.lineJoin = .round
        highlightLayer.shadowColor = UIColor.white.cgColor
        highlightLayer.shadowOpacity = 0.35
        highlightLayer.shadowRadius = 12
        highlightLayer.shadowOffset = .zero
        view.layer.addSublayer(highlightLayer)
    }

    // SwiftUI does not reliably dismantle a representable the moment its
    // fullScreenCover dismisses, and backgrounding never dismantles it, so
    // stop the camera on disappear and resume it when the view returns.
    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        stop()
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        guard previewLayer != nil else { return }
        let session = captureSession
        sessionQueue.async {
            if !session.isRunning {
                session.startRunning()
            }
        }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        previewLayer?.frame = view.bounds
        highlightLayer.frame = view.bounds
    }

    func prepare(
        delegate: AVCaptureMetadataOutputObjectsDelegate,
        availabilityChanged: @escaping (QRScannerAvailability, Bool) -> Void
    ) {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            configure(delegate: delegate, availabilityChanged: availabilityChanged)
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
                Task { @MainActor in
                    guard let self else { return }
                    if granted {
                        self.configure(
                            delegate: delegate,
                            availabilityChanged: availabilityChanged
                        )
                    } else {
                        availabilityChanged(.denied, false)
                    }
                }
            }
        case .denied, .restricted:
            availabilityChanged(.denied, false)
        @unknown default:
            availabilityChanged(.unavailable, false)
        }
    }

    func stop() {
        let session = captureSession
        sessionQueue.async {
            if session.isRunning {
                session.stopRunning()
            }
        }
    }

    func setTorch(_ isOn: Bool) {
        guard let camera, camera.hasTorch, camera.isTorchAvailable,
              (camera.torchMode == .on) != isOn,
              (try? camera.lockForConfiguration()) != nil
        else { return }
        camera.torchMode = isOn ? .on : .off
        camera.unlockForConfiguration()
    }

    /// Outlines the detected code in preview coordinates, following it as it
    /// moves and clearing once it leaves the frame.
    func highlight(_ object: AVMetadataMachineReadableCodeObject) {
        guard let previewLayer,
              let transformed = previewLayer.transformedMetadataObject(for: object)
                as? AVMetadataMachineReadableCodeObject
        else { return }
        let corners = transformed.corners
        let path = UIBezierPath()
        if corners.count >= 4 {
            path.move(to: corners[0])
            corners.dropFirst().forEach(path.addLine(to:))
            path.close()
        } else {
            path.append(UIBezierPath(roundedRect: transformed.bounds, cornerRadius: 12))
        }
        highlightLayer.path = path.cgPath
        highlightLayer.isHidden = false

        highlightHideWork?.cancel()
        let hide = DispatchWorkItem { [weak self] in self?.highlightLayer.isHidden = true }
        highlightHideWork = hide
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6, execute: hide)
    }

    private func configure(
        delegate: AVCaptureMetadataOutputObjectsDelegate,
        availabilityChanged: @escaping (QRScannerAvailability, Bool) -> Void
    ) {
        guard let camera = AVCaptureDevice.default(for: .video),
              let input = try? AVCaptureDeviceInput(device: camera),
              captureSession.canAddInput(input)
        else {
            availabilityChanged(.unavailable, false)
            return
        }

        let output = AVCaptureMetadataOutput()
        guard captureSession.canAddOutput(output) else {
            availabilityChanged(.unavailable, false)
            return
        }

        captureSession.beginConfiguration()
        captureSession.sessionPreset = .high
        captureSession.addInput(input)
        captureSession.addOutput(output)
        output.setMetadataObjectsDelegate(delegate, queue: .main)
        output.metadataObjectTypes = [.qr]
        captureSession.commitConfiguration()

        let preview = AVCaptureVideoPreviewLayer(session: captureSession)
        preview.videoGravity = .resizeAspectFill
        preview.frame = view.bounds
        view.layer.insertSublayer(preview, at: 0)
        previewLayer = preview
        self.camera = camera
        followDeviceRotation(camera: camera, preview: preview)
        availabilityChanged(.ready, camera.hasTorch)

        let session = captureSession
        sessionQueue.async {
            session.startRunning()
        }
    }

    /// Keeps the preview upright as an iPad rotates. Without this the image
    /// stays in the sensor's orientation while the interface turns around it.
    private func followDeviceRotation(camera: AVCaptureDevice, preview: AVCaptureVideoPreviewLayer) {
        let coordinator = AVCaptureDevice.RotationCoordinator(device: camera, previewLayer: preview)
        rotationCoordinator = coordinator
        applyRotation(coordinator.videoRotationAngleForHorizonLevelPreview)
        rotationObservation = coordinator.observe(
            \.videoRotationAngleForHorizonLevelPreview,
            options: [.new]
        ) { [weak self] coordinator, _ in
            let angle = coordinator.videoRotationAngleForHorizonLevelPreview
            Task { @MainActor in self?.applyRotation(angle) }
        }
    }

    private func applyRotation(_ angle: CGFloat) {
        guard let connection = previewLayer?.connection,
              connection.isVideoRotationAngleSupported(angle)
        else { return }
        connection.videoRotationAngle = angle
    }
}
