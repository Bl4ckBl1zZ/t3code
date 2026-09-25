import CoreTransferable
import SwiftUI
import UniformTypeIdentifiers

extension View {
    /// Routes images pasted into the draft field (the edit menu's Paste, or ⌘V)
    /// to `onPaste` as their encoded bytes, in clipboard order. Text keeps the
    /// field's own paste.
    ///
    /// SwiftUI's paste destination reaches iOS in 27 and exists only in the
    /// iOS 27 SDK (Swift 6.4); earlier systems and older Xcodes paste text only.
    @ViewBuilder
    func composerImagePaste(_ onPaste: @escaping ([Data]) -> Void) -> some View {
        #if compiler(>=6.4)
        if #available(iOS 27, *) {
            pasteDestination(for: ComposerPastedImage.self) { images in
                onPaste(images.map(\.data))
            }
        } else {
            self
        }
        #else
        self
        #endif
    }
}

/// Any image on the clipboard, as the bytes it was copied in. The composer
/// re-encodes every image to JPEG, so the source format doesn't matter here.
private struct ComposerPastedImage: Transferable {
    let data: Data

    static var transferRepresentation: some TransferRepresentation {
        DataRepresentation(importedContentType: .image) { ComposerPastedImage(data: $0) }
    }
}
