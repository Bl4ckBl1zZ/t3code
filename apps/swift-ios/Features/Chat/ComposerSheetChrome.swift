import SwiftUI

// Chrome shared by the composer's surfaces.
//
// Backgrounds for the lists inside the composer's partial-detent sheets (task
// settings, model list, stashed drafts, base branch): on iOS 26 those sheets
// float as glass, so the list only hides its own opaque backdrop and rows keep
// the system cell fill. Earlier systems keep the opaque palette list the
// grouped-list helpers draw.

extension View {
    /// The list backdrop inside a partial-detent sheet.
    @ViewBuilder
    func t3SheetListBackground() -> some View {
        if #available(iOS 26, *) {
            scrollContentBackground(.hidden)
        } else {
            t3GroupedListBackground()
        }
    }

    /// The row fill inside a partial-detent sheet's list.
    @ViewBuilder
    func t3SheetRow() -> some View {
        if #available(iOS 26, *) {
            self
        } else {
            t3GroupedRow()
        }
    }
}

/// A vertical scroll view exactly as tall as its content, up to a cap. The
/// composer's approval detail and suggestion list use it so short content
/// stays compact and long content scrolls instead of pushing the pill off
/// screen. The content's height is measured rather than inferred from the
/// scroll view, which on its own takes whatever height it is offered.
struct ComposerCappedScrollView<Content: View>: View {
    let maximumHeight: CGFloat
    @ViewBuilder var content: Content

    @State private var contentHeight: CGFloat = 0

    var body: some View {
        ScrollView {
            content
                .onGeometryChange(for: CGFloat.self) { proxy in
                    proxy.size.height
                } action: { height in
                    contentHeight = height
                }
        }
        .scrollBounceBehavior(.basedOnSize)
        .frame(height: min(contentHeight, maximumHeight))
    }
}
