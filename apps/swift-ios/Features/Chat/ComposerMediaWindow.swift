import AVFoundation
import Photos
import SwiftUI
import UIKit

// The in-chat media window: instead of full-screen system pickers, the
// composer pill morphs into a tall card that hosts either a live camera or the
// photo library grid. Taking a photo freezes it in the window and collapses
// the card into the attachment thumbnail; the grid confirms by being slid
// down. Files keep the native document picker.

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

    init(onPhoto: @escaping @Sendable (Data) -> Void) {
        self.onPhoto = onPhoto
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
            guard self.session.isRunning else { return }
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
        guard error == nil, let data = photo.fileDataRepresentation() else { return }
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

/// The camera occupying the media window: live preview, shutter, flip, back.
/// A taken photo freezes in place; the composer collapses the window into the
/// attachment thumbnail a beat later.
struct ComposerCameraWindow: View {
    let onClose: () -> Void
    /// Fired once per shot, after the freeze has had a moment to read.
    let onCapture: (Data) -> Void

    @State private var engine: ComposerCameraEngineBox?
    @State private var capturedImage: UIImage?
    @State private var authorization: AVAuthorizationStatus = .notDetermined

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
                Image(uiImage: capturedImage)
                    .resizable()
                    .scaledToFill()
                    .transition(.opacity)
            } else if authorization == .denied || authorization == .restricted {
                mediaPermissionPrompt(
                    title: "Camera access is off",
                    message: "Allow camera access in Settings to take photos here."
                )
            } else if let engine {
                ComposerCameraPreview(session: engine.engine.session)
            }

            if capturedImage == nil, authorization == .authorized {
                controls
            }
        }
        .clipped()
        .task { await startCamera() }
        .onDisappear { engine?.engine.stop() }
        .accessibilityIdentifier("composer-camera-window")
    }

    private var controls: some View {
        VStack {
            Spacer()
            ZStack {
                HStack {
                    mediaRoundButton(systemImage: "chevron.left", label: "Close camera") {
                        onClose()
                    }
                    Spacer()
                    mediaRoundButton(
                        systemImage: "arrow.trianglehead.2.clockwise.rotate.90",
                        label: "Switch camera"
                    ) {
                        engine?.engine.flip()
                    }
                }

                Button {
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
            .padding(.horizontal, 18)
            .padding(.bottom, 16)
        }
    }

    private func startCamera() async {
        let status = AVCaptureDevice.authorizationStatus(for: .video)
        if status == .notDetermined {
            _ = await AVCaptureDevice.requestAccess(for: .video)
        }
        authorization = AVCaptureDevice.authorizationStatus(for: .video)
        guard authorization == .authorized, engine == nil else { return }

        let box = ComposerCameraEngineBox(
            engine: ComposerCameraEngine { data in
                Task { @MainActor in
                    guard capturedImage == nil else { return }
                    withAnimation(.easeOut(duration: 0.18)) {
                        capturedImage = UIImage(data: data)
                    }
                    // Let the freeze land before the window collapses into the
                    // attachment thumbnail.
                    try? await Task.sleep(for: .milliseconds(450))
                    onCapture(data)
                }
            }
        )
        engine = box
        box.engine.start()
    }
}

// MARK: - Photo library

/// The photo grid occupying the media window. Multi-select; sliding the window
/// down is the confirmation.
struct ComposerPhotoLibraryWindow: View {
    /// How many more images the draft can take.
    let maximumSelectable: Int
    /// The selected images' original data, in selection order. Empty means the
    /// window was dismissed without picking anything.
    let onConfirm: ([Data]) -> Void

    @State private var assets: [PHAsset] = []
    @State private var selectedIDs: [String] = []
    @State private var authorization: PHAuthorizationStatus = .notDetermined
    @State private var isLoadingSelection = false
    @State private var dragOffset: CGFloat = 0

    private let imageManager = PHCachingImageManager()

    private var selectedAssets: [PHAsset] {
        selectedIDs.compactMap { id in assets.first { $0.localIdentifier == id } }
    }

    var body: some View {
        VStack(spacing: 0) {
            grabber

            if authorization == .denied || authorization == .restricted {
                mediaPermissionPrompt(
                    title: "Photos access is off",
                    message: "Allow photo access in Settings to pick images here."
                )
                .frame(maxHeight: .infinity)
            } else {
                grid
            }
        }
        .background(T3Colors.background)
        .overlay {
            if isLoadingSelection {
                ZStack {
                    T3Colors.background.opacity(0.6)
                    ProgressView()
                }
            }
        }
        .offset(y: max(0, dragOffset))
        .task { await loadLibrary() }
        .accessibilityIdentifier("composer-photo-window")
    }

    /// The whole header is the dismiss handle: drag it down past the threshold
    /// and the window confirms whatever is selected.
    private var grabber: some View {
        VStack(spacing: 7) {
            Capsule()
                .fill(T3Colors.subtleStrong)
                .frame(width: 38, height: 5)
            Text(grabberHint)
                .font(T3Typography.supporting)
                .foregroundStyle(T3Colors.textSecondary)
                .contentTransition(.numericText())
                .animation(.easeOut(duration: 0.15), value: selectedIDs.count)
        }
        .frame(maxWidth: .infinity)
        .frame(height: 52)
        .contentShape(Rectangle())
        .gesture(
            // Global space, not local: the drag offsets this very view, so a
            // local-space translation would chase its own movement and jitter.
            DragGesture(minimumDistance: 6, coordinateSpace: .global)
                .onChanged { value in
                    dragOffset = value.translation.height
                }
                .onEnded { value in
                    if value.translation.height > 96 {
                        confirm()
                    } else {
                        withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) {
                            dragOffset = 0
                        }
                    }
                }
        )
        .accessibilityLabel(grabberHint)
        .accessibilityHint("Swipe down to confirm")
        .accessibilityAction { confirm() }
    }

    private var grabberHint: String {
        selectedIDs.isEmpty
            ? "Slide down to close"
            : "Slide down to add \(selectedIDs.count) photo\(selectedIDs.count == 1 ? "" : "s")"
    }

    private var grid: some View {
        GeometryReader { proxy in
            let columns = 3
            let spacing: CGFloat = 2
            let side = (proxy.size.width - spacing * CGFloat(columns - 1)) / CGFloat(columns)
            ScrollView {
                LazyVGrid(
                    columns: Array(
                        repeating: GridItem(.fixed(side), spacing: spacing),
                        count: columns
                    ),
                    spacing: spacing
                ) {
                    ForEach(assets, id: \.localIdentifier) { asset in
                        photoCell(asset, side: side)
                    }
                }
            }
            .scrollIndicators(.hidden)
        }
    }

    private func photoCell(_ asset: PHAsset, side: CGFloat) -> some View {
        let order = selectedIDs.firstIndex(of: asset.localIdentifier)
        return Button {
            toggle(asset)
        } label: {
            ComposerPhotoThumbnail(asset: asset, side: side, manager: imageManager)
                .overlay {
                    if order != nil {
                        Rectangle()
                            .fill(Color.black.opacity(0.32))
                    }
                }
                .overlay(alignment: .topTrailing) {
                    if let order {
                        Text("\(order + 1)")
                            .font(.system(size: 12, weight: .bold))
                            .foregroundStyle(.white)
                            .frame(width: 22, height: 22)
                            .background(T3Colors.accent, in: Circle())
                            .overlay { Circle().stroke(.white, lineWidth: 1.5) }
                            .padding(5)
                    }
                }
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(order == nil ? "Photo" : "Photo, selected")
    }

    private func toggle(_ asset: PHAsset) {
        if let index = selectedIDs.firstIndex(of: asset.localIdentifier) {
            selectedIDs.remove(at: index)
            return
        }
        guard selectedIDs.count < maximumSelectable else { return }
        selectedIDs.append(asset.localIdentifier)
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
    }

    private func loadLibrary() async {
        let status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
        if status == .notDetermined {
            _ = await PHPhotoLibrary.requestAuthorization(for: .readWrite)
        }
        authorization = PHPhotoLibrary.authorizationStatus(for: .readWrite)
        guard authorization == .authorized || authorization == .limited else { return }

        let options = PHFetchOptions()
        options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
        options.fetchLimit = 600
        let fetched = PHAsset.fetchAssets(with: .image, options: options)
        var rows: [PHAsset] = []
        rows.reserveCapacity(fetched.count)
        fetched.enumerateObjects { asset, _, _ in rows.append(asset) }
        assets = rows
    }

    private func confirm() {
        guard !isLoadingSelection else { return }
        let picks = selectedAssets
        guard !picks.isEmpty else {
            onConfirm([])
            return
        }
        isLoadingSelection = true
        Task { @MainActor in
            var datas: [Data] = []
            for asset in picks {
                if let data = await Self.imageData(for: asset) {
                    datas.append(data)
                }
            }
            isLoadingSelection = false
            onConfirm(datas)
        }
    }

    private static func imageData(for asset: PHAsset) async -> Data? {
        await withCheckedContinuation { continuation in
            let options = PHImageRequestOptions()
            options.isNetworkAccessAllowed = true
            options.deliveryMode = .highQualityFormat
            var resumed = false
            PHImageManager.default().requestImageDataAndOrientation(
                for: asset,
                options: options
            ) { data, _, _, _ in
                guard !resumed else { return }
                resumed = true
                continuation.resume(returning: data)
            }
        }
    }
}

/// One grid thumbnail, resolved through the caching manager.
private struct ComposerPhotoThumbnail: View {
    let asset: PHAsset
    let side: CGFloat
    let manager: PHCachingImageManager

    @State private var image: UIImage?

    var body: some View {
        ZStack {
            T3Colors.subtle
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
            }
        }
        .frame(width: side, height: side)
        .clipped()
        // `clipped` trims pixels, not hit-testing: without this, the
        // scaled-to-fill overflow of every thumbnail steals taps from the
        // cells beside it.
        .contentShape(Rectangle())
        .task(id: asset.localIdentifier) {
            let scale = UIScreen.main.scale
            let target = CGSize(width: side * scale, height: side * scale)
            let options = PHImageRequestOptions()
            options.isNetworkAccessAllowed = true
            options.deliveryMode = .opportunistic
            manager.requestImage(
                for: asset,
                targetSize: target,
                contentMode: .aspectFill,
                options: options
            ) { result, _ in
                if let result {
                    Task { @MainActor in image = result }
                }
            }
        }
    }
}

// MARK: - Shared chrome

private func mediaPermissionPrompt(title: String, message: String) -> some View {
    VStack(spacing: 10) {
        Text(title)
            .font(T3Typography.control.weight(.semibold))
            .foregroundStyle(T3Colors.textPrimary)
        Text(message)
            .font(T3Typography.supporting)
            .foregroundStyle(T3Colors.textSecondary)
            .multilineTextAlignment(.center)
        Button("Open Settings") {
            guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
            UIApplication.shared.open(url)
        }
        .font(T3Typography.supporting.weight(.semibold))
        .buttonStyle(.bordered)
    }
    .padding(24)
}

private func mediaRoundButton(
    systemImage: String,
    label: String,
    action: @escaping () -> Void
) -> some View {
    Button(action: action) {
        Image(systemName: systemImage)
            .font(.system(size: 16, weight: .semibold))
            .foregroundStyle(.white)
            .frame(width: 44, height: 44)
            .background(.black.opacity(0.45), in: Circle())
    }
    .buttonStyle(.plain)
    .accessibilityLabel(label)
}
