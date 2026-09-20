import SwiftUI

/// A tool's own logo, drawn from the shared icon cache: the bitmap is decoded
/// once per URL, never during body evaluation or scrolling.
struct NativeToolLogo: View {
    let url: URL
    let fallback: String
    @State private var loaded: (url: URL, image: UIImage?)?

    private var image: UIImage? {
        loaded?.url == url ? loaded?.image : NativeIconImageStore.toolLogos.cachedImage(for: url)
    }

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image).resizable().scaledToFit()
            } else { Image(systemName: fallback) }
        }
        .frame(width: 16, height: 16)
        .accessibilityHidden(true)
        .task(id: url) {
            let image = await NativeIconImageStore.toolLogos.image(for: url)
            guard !Task.isCancelled else { return }
            loaded = (url, image)
        }
    }
}
