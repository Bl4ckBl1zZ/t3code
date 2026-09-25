import AVFoundation
import PhotosUI
import SwiftUI
import UIKit

// The in-chat media window: instead of full-screen system pickers, the
// composer pill morphs into a tall card that hosts either a live camera or the
// system photo picker, inline. Taking a photo freezes it in the window and
// collapses the card into the attachment thumbnail; picked photos are added
// with the window's own "Add Photos" button. Files keep the native document
// picker.

/// What the composer pill is currently morphed into.
enum ComposerMediaSurface: Equatable {
    case camera
    case photoLibrary
}

// MARK: - Camera

/// The capture pipeline, off the main thread. `@unchecked Sendable` because
/// every mutable member is confined to `queue`.
final class ComposerCameraEngine: NSObject, AVCapturePhotoCaptureDelegate,
    @unchecked Sendable {
    let session = AVCaptureSession()

    private let queue = DispatchQueue(label: "t3.composer.camera")
    private let output = AVCapturePhotoOutput()
    private var position: AVCaptureDevice.Position = .back
    private var configured = false
    private let onPhoto: @Sendable (Data) -> Void
    private let onFailure: @Sendable () -> Void

    init(
        onPhoto: @escaping @Sendable (Data) -> Void,
        onFailure: @escaping @Sendable () -> Void
    ) {
        self.onPhoto = onPhoto
        self.onFailure = onFailure
    }

    func start() {
        queue.async {
            self.configureIfNeeded()
            if !self.session.isRunning { self.session.startRunning() }
        }
    }

    func stop() {
        queue.async {
            if self.session.isRunning { self.session.stopRunning() }
        }
    }

    func flip() {
        queue.async {
            self.position = self.position == .back ? .front : .back
            self.session.beginConfiguration()
            self.attachInput()
            self.session.commitConfiguration()
        }
    }

    func capture() {
        queue.async {
            guard self.session.isRunning else {
                self.onFailure()
                return
            }
            self.output.capturePhoto(with: AVCapturePhotoSettings(), delegate: self)
        }
    }

    private func configureIfNeeded() {
        guard !configured else { return }
        configured = true
        session.beginConfiguration()
        session.sessionPreset = .photo
        attachInput()
        if session.canAddOutput(output) { session.addOutput(output) }
        session.commitConfiguration()
    }

    private func attachInput() {
        for input in session.inputs { session.removeInput(input) }
        guard let device = AVCaptureDevice.default(
            .builtInWideAngleCamera,
            for: .video,
            position: position
        ), let input = try? AVCaptureDeviceInput(device: device) else { return }
        if session.canAddInput(input) { session.addInput(input) }
    }

    func photoOutput(
        _ output: AVCapturePhotoOutput,
        didFinishProcessingPhoto photo: AVCapturePhoto,
        error: Error?
    ) {
        guard error == nil, let data = photo.fileDataRepresentation() else {
            onFailure()
            return
        }
        onPhoto(data)
    }
}

private struct ComposerCameraPreview: UIViewRepresentable {
    let session: AVCaptureSession

    final class PreviewView: UIView {
        override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
        var previewLayer: AVCaptureVideoPreviewLayer {
            // Guaranteed by `layerClass`.
            layer as! AVCaptureVideoPreviewLayer
        }
    }

    func makeUIView(context: Context) -> PreviewView {
        let view = PreviewView()
        view.previewLayer.session = session
        view.previewLayer.videoGravity = .resizeAspectFill
        return view
    }

    func updateUIView(_ view: PreviewView, context: Context) {}
}

/// The camera occupying the media window: live preview, shutter, flip, close.
/// A taken photo freezes in place; the composer collapses the window into the
/// attachment thumbnail a beat later.
///
/// The card is always dark, like every camera, so the permission copy and the
/// glass controls stay legible over the black backdrop in light mode too. The
/// close button is there in every state: a denied permission is a way out plus
/// a way to Settings, never a dead end.
struct ComposerCameraWindow: View {
    let onClose: () -> Void
    /// Fired once per shot, after the freeze has had a moment to read.
    let onCapture: (Data) -> Void

    @State private var engine: ComposerCameraEngineBox?
    @State private var capturedImage: UIImage?
    @State private var authorization: AVAuthorizationStatus = .notDetermined
    @State private var captureFailed = false
    @State private var failureCount = 0

    /// `@State` needs an identity-stable wrapper for the engine, whose init
    /// captures a closure over this view's state.
    @MainActor
    final class ComposerCameraEngineBox {
        let engine: ComposerCameraEngine
        init(engine: ComposerCameraEngine) { self.engine = engine }
    }

    var body: some View {
        ZStack {
            Color.black

            if let capturedImage {
                // Pinned to the window's frame: a fill image otherwise sizes
                // the window to the photo's aspect and pushes past the card.
                Image(uiImage: capturedImage)
                    .resizable()
                    .scaledToFill()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .clipped()
                    .transition(.opacity)
            } else if authorization == .denied || authorization == .restricted {
                ContentUnavailableView {
                    Label("Camera Access Is Off", systemImage: "camera")
                } description: {
                    Text("Allow camera access in Settings to take photos here.")
                } actions: {
                    Button("Open Settings", action: openSettings)
                        .t3ProminentButtonStyle()
                }
            } else if let engine {
                ComposerCameraPreview(session: engine.engine.session)
            } else {
                // Under the system permission prompt: a static spinner rather
                // than an empty black box.
                ProgressView()
                    .tint(.white)
            }

            if capturedImage == nil {
                controls
            }
        }
        .clipped()
        .environment(\.colorScheme, .dark)
        .t3SensoryFeedback(.error, trigger: failureCount)
        .task { await startCamera() }
        .onDisappear { engine?.engine.stop() }
        .accessibilityIdentifier("composer-camera-window")
    }

    private var controls: some View {
        VStack {
            HStack {
                mediaGlassButton(systemImage: "xmark", label: "Close camera", action: onClose)
                Spacer()
            }
            Spacer()
            if authorization == .authorized {
                if captureFailed {
                    Text("Couldn’t take photo")
                        .font(T3Typography.supportingStrong)
                        .foregroundStyle(.white)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 6)
                        .t3GlassEffect(.clear, in: Capsule())
                        .padding(.bottom, 10)
                        .accessibilityAddTraits(.isStaticText)
                }
                ZStack {
                    HStack {
                        Spacer()
                        mediaGlassButton(
                            systemImage: "arrow.trianglehead.2.clockwise.rotate.90",
                            label: "Switch camera"
                        ) {
                            engine?.engine.flip()
                        }
                    }

                    Button {
                        captureFailed = false
                        PlatformHapticEngine.shared.playImpact(.medium)
                        engine?.engine.capture()
                    } label: {
                        Circle()
                            .fill(.white)
                            .frame(width: 64, height: 64)
                            .overlay {
                                Circle()
                                    .stroke(Color.white.opacity(0.4), lineWidth: 4)
                                    .padding(-6)
                            }
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Take photo")
                    .accessibilityIdentifier("composer-camera-shutter")
                }
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 16)
    }

    private func openSettings() {
        guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
        UIApplication.shared.open(url)
    }

    private func startCamera() async {
        let status = AVCaptureDevice.authorizationStatus(for: .video)
        if status == .notDetermined {
            _ = await AVCaptureDevice.requestAccess(for: .video)
        }
        authorization = AVCaptureDevice.authorizationStatus(for: .video)
        guard authorization == .authorized, engine == nil else { return }

        let box = ComposerCameraEngineBox(
            engine: ComposerCameraEngine(
                onPhoto: { data in
                    Task { @MainActor in
                        guard capturedImage == nil else { return }
                        withAnimation(.easeOut(duration: 0.18)) {
                            capturedImage = UIImage(data: data)
                        }
                        // Let the freeze land before the window collapses into
                        // the attachment thumbnail.
                        try? await Task.sleep(for: .milliseconds(450))
                        onCapture(data)
                    }
                },
                onFailure: {
                    Task { @MainActor in
                        captureFailed = true
                        failureCount += 1
                    }
                }
            )
        )
        engine = box
        box.engine.start()
    }
}

// MARK: - Photo library

/// The system photo picker, inline in the media window.
///
/// It runs out of process, so it needs no photo-library permission and shows
/// the whole library — albums, search and all — while the app only ever sees
/// the photos that were picked. Selection is ordered and capped by the picker
/// itself; the ink button confirms.
///
/// The picker's own Add and Cancel are hidden, so selection has to be
/// continuous: a non-continuous picker only reports its selection when its
/// own Add is tapped, which would leave the ink button disabled forever.
struct ComposerPhotoLibraryWindow: View {
    /// How many more images the draft can take.
    let maximumSelectable: Int
    let onClose: () -> Void
    /// The picked items, in selection order.
    let onConfirm: ([PhotosPickerItem]) -> Void

    @State private var selection: [PhotosPickerItem] = []

    var body: some View {
        PhotosPicker(
            selection: $selection,
            maxSelectionCount: max(1, maximumSelectable),
            selectionBehavior: .continuousAndOrdered,
            matching: .images,
            // The composer re-encodes every upload to JPEG anyway, so asking
            // Photos for a compatible representation avoids shipping a
            // ProRAW/HEIF original across XPC first.
            preferredItemEncoding: .compatible
        ) {
            Text("Choose Photos")
        }
        .photosPickerStyle(.inline)
        .photosPickerDisabledCapabilities(.selectionActions)
        .photosPickerAccessoryVisibility(.hidden, edges: .all)
        .t3SensoryFeedback(.selection, trigger: selection.count)
        .overlay(alignment: .bottom) { windowControls }
        .accessibilityIdentifier("composer-photo-window")
    }

    /// Cancel at the left, confirm at the right, floating over the picker.
    private var windowControls: some View {
        T3GlassContainer(spacing: 12) {
            HStack(spacing: 12) {
                mediaGlassButton(
                    systemImage: "xmark",
                    label: "Close without adding photos",
                    prominence: .regular,
                    action: onClose
                )
                .accessibilityIdentifier("composer-photo-cancel")

                Spacer(minLength: 0)

                Button {
                    onConfirm(selection)
                } label: {
                    Text(confirmTitle)
                        .contentTransition(.numericText())
                        .animation(.easeOut(duration: 0.15), value: selection.count)
                }
                .t3ProminentButtonStyle()
                .disabled(selection.isEmpty)
                .accessibilityHint(limitHint)
                .accessibilityIdentifier("composer-photo-done")
            }
        }
        .padding(.horizontal, 16)
        .padding(.bottom, 16)
    }

    private var confirmTitle: String {
        switch selection.count {
        case 0: "Add Photos"
        case 1: "Add 1 Photo"
        default: "Add \(selection.count) Photos"
        }
    }

    private var limitHint: String {
        let limit = max(1, maximumSelectable)
        return limit == 1 ? "Up to 1 photo" : "Up to \(limit) photos"
    }
}

// MARK: - Shared chrome

/// A round glass control floating over the camera or picker.
private func mediaGlassButton(
    systemImage: String,
    label: String,
    prominence: T3Glass.Prominence = .clear,
    action: @escaping () -> Void
) -> some View {
    Button(action: action) {
        Image(systemName: systemImage)
            .font(.body.weight(.semibold))
            .foregroundStyle(prominence == .clear ? Color.white : T3Colors.textPrimary)
            .frame(width: T3Metrics.minimumTapTarget, height: T3Metrics.minimumTapTarget)
            .contentShape(Circle())
    }
    .buttonStyle(.plain)
    .t3GlassEffect(prominence, interactive: true, in: Circle())
    .accessibilityLabel(label)
}
