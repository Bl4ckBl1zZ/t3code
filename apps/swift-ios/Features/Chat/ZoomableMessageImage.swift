import SwiftUI

/// Keeps zoom inside the current image; fitted pages leave swipes to the gallery.
struct ZoomableMessageImage: View {
    let image: Image
    var isCurrentPage = true
    @State private var scale: CGFloat = 1
    @State private var settledScale: CGFloat = 1
    @State private var offset: CGSize = .zero
    @State private var settledOffset: CGSize = .zero

    var body: some View {
        GeometryReader { geometry in
            image.resizable().scaledToFit()
                .frame(width: geometry.size.width, height: geometry.size.height)
                .scaleEffect(scale).offset(offset)
                .contentShape(Rectangle())
                .gesture(MagnifyGesture().onChanged { value in
                    scale = min(8, max(1, settledScale * value.magnification))
                    offset = bounded(offset, in: geometry.size)
                }.onEnded { _ in
                    settledScale = scale
                    settledOffset = offset
                })
                .highPriorityGesture(DragGesture().onChanged { value in
                    offset = bounded(CGSize(width: settledOffset.width + value.translation.width,
                                            height: settledOffset.height + value.translation.height),
                                     in: geometry.size)
                }.onEnded { _ in settledOffset = offset }, including: scale > 1 ? .all : .none)
                .onTapGesture(count: 2) {
                    if scale > 1 { reset() } else { scale = 2; settledScale = 2 }
                }
                .accessibilityLabel("Image")
                .accessibilityValue("\(Int(scale * 100)) percent zoom")
                .accessibilityAdjustableAction { direction in
                    scale = min(8, max(1, scale + (direction == .increment ? 1 : -1)))
                    settledScale = scale
                    offset = bounded(offset, in: geometry.size)
                    settledOffset = offset
                }
                .accessibilityAction(named: "Fit image", reset)
        }
        .clipped()
        .overlay(alignment: .topTrailing) {
            Button("Fit image", systemImage: "arrow.down.right.and.arrow.up.left") { reset() }
                .font(T3Typography.supportingStrong)
                .padding(10)
                .background(T3Colors.surface, in: Capsule())
                .padding(8)
                .opacity(scale > 1 ? 1 : 0)
                .allowsHitTesting(scale > 1)
                .accessibilityHidden(scale <= 1)
        }
        .onChange(of: isCurrentPage) { reset() }
    }

    private func bounded(_ value: CGSize, in size: CGSize) -> CGSize {
        CGSize(width: min(size.width * (scale - 1) / 2, max(-size.width * (scale - 1) / 2, value.width)),
               height: min(size.height * (scale - 1) / 2, max(-size.height * (scale - 1) / 2, value.height)))
    }

    private func reset() {
        scale = 1; settledScale = 1; offset = .zero; settledOffset = .zero
    }
}
