import SwiftUI
import UIKit

/// The Work / Code / Chat switcher's segmented control.
///
/// SwiftUI's `.pickerStyle(.segmented)` exposes neither the segment font nor the
/// control's height — both come from `UISegmentedControl`'s defaults, which size
/// the switcher like a settings row rather than like the header's primary
/// control. Hosting the same `UISegmentedControl` SwiftUI would have used keeps
/// the system's thumb, its slide animation and its material, and adds the two
/// knobs the SwiftUI style withholds.
struct WorkspaceSegmentedControl: UIViewRepresentable {
    let titles: [String]
    @Binding var selectedIndex: Int
    /// Font for both states: a segmented control sizes itself from its titles,
    /// so this is what actually makes the control taller and wider.
    let font: UIFont
    /// Height to draw at. `UISegmentedControl` fills whatever frame it is given,
    /// so this wins over the intrinsic height the font asks for.
    let height: CGFloat
    /// Breathing room added to each segment beyond what the title needs.
    let segmentPadding: CGFloat

    func makeUIView(context: Context) -> UISegmentedControl {
        let control = UISegmentedControl(items: titles)
        control.selectedSegmentIndex = selectedIndex
        control.addTarget(
            context.coordinator,
            action: #selector(Coordinator.selectionChanged(_:)),
            for: .valueChanged
        )
        // Without this the control happily stretches to fill the header row.
        control.setContentHuggingPriority(.required, for: .horizontal)
        applyStyle(to: control)
        return control
    }

    func updateUIView(_ control: UISegmentedControl, context: Context) {
        context.coordinator.selectedIndex = $selectedIndex
        applyStyle(to: control)
        if control.selectedSegmentIndex != selectedIndex {
            control.selectedSegmentIndex = selectedIndex
        }
    }

    /// Reported instead of the intrinsic size so the font drives the width while
    /// ``height`` drives the height. Clamped to the proposal because the iPad
    /// sidebar is narrower than the switcher's ideal width once the search and
    /// settings buttons have taken their share.
    func sizeThatFits(
        _ proposal: ProposedViewSize,
        uiView: UISegmentedControl,
        context: Context
    ) -> CGSize? {
        let ideal = uiView.intrinsicContentSize.width
            + segmentPadding * CGFloat(titles.count)
        guard let proposed = proposal.width else {
            return CGSize(width: ideal, height: height)
        }
        return CGSize(width: min(ideal, proposed), height: height)
    }

    private func applyStyle(to control: UISegmentedControl) {
        let attributes: [NSAttributedString.Key: Any] = [.font: font]
        control.setTitleTextAttributes(attributes, for: .normal)
        control.setTitleTextAttributes(attributes, for: .selected)
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(selectedIndex: $selectedIndex)
    }

    final class Coordinator: NSObject {
        var selectedIndex: Binding<Int>

        init(selectedIndex: Binding<Int>) {
            self.selectedIndex = selectedIndex
        }

        @objc func selectionChanged(_ sender: UISegmentedControl) {
            selectedIndex.wrappedValue = sender.selectedSegmentIndex
        }
    }
}
