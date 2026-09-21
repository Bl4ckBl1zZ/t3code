import SwiftUI

/// Snoozes one thread or a batch until a picked local date and time, or for a
/// duration counted from confirmation. Opened from Snooze → Custom… on a row and
/// from the selection bar; the caller owns the actual snooze.
struct CustomSnoozeSheet: View {
    let threadCount: Int
    let onSnooze: (Date) -> Void

    @SwiftUI.Environment(\.dismiss) private var dismiss
    @State private var mode = CustomSnooze.Mode.date
    @State private var date = CustomSnooze.initialDate()
    @State private var amount = 2
    @State private var unit = CustomSnooze.Unit.hours

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker("Snooze By", selection: $mode) {
                        Text("Date & Time").tag(CustomSnooze.Mode.date)
                        Text("Duration").tag(CustomSnooze.Mode.duration)
                    }
                    .pickerStyle(.segmented)
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets())
                }
                switch mode {
                case .date:
                    Section {
                        DatePicker(
                            "Wake On",
                            selection: $date,
                            in: Date.now...,
                            displayedComponents: [.date, .hourAndMinute]
                        )
                        .t3GroupedRow()
                    } footer: {
                        Text(wakeFooter(suffix: "Uses this device's time zone."))
                    }
                case .duration:
                    Section {
                        // A stepper rather than a number pad: the keyboard would
                        // cover most of a medium sheet.
                        LabeledContent("Amount") {
                            Stepper(value: $amount, in: 1...maximumAmount) {
                                Text("\(amount)")
                                    .monospacedDigit()
                                    .foregroundStyle(T3Colors.textPrimary)
                            }
                            .fixedSize()
                            .accessibilityIdentifier("custom-snooze-amount")
                        }
                        .t3GroupedRow()
                        Picker("Unit", selection: $unit) {
                            Text("Minutes").tag(CustomSnooze.Unit.minutes)
                            Text("Hours").tag(CustomSnooze.Unit.hours)
                            Text("Days").tag(CustomSnooze.Unit.days)
                        }
                        .t3GroupedRow()
                    } footer: {
                        Text(wakeFooter(suffix: "Counted from when you tap Snooze."))
                    }
                }
            }
            .t3GroupedListBackground()
            .navigationTitle(threadCount > 1 ? "Snooze \(threadCount) Threads" : "Snooze Until")
            .navigationBarTitleDisplayMode(.inline)
            .t3NavigationChrome()
            .t3SheetToolbar(
                .cancel,
                confirm: T3SheetConfirmation(
                    title: "Snooze",
                    isEnabled: resolvedWake(now: .now) != nil,
                    action: confirm
                )
            )
            .onChange(of: unit) { _, _ in amount = min(amount, maximumAmount) }
        }
        .presentationDetents([.medium, .large])
    }

    /// Enough range for a stepper without holding it down for a minute.
    private var maximumAmount: Int {
        switch unit {
        case .minutes: 59
        case .hours: 48
        case .days: 60
        }
    }

    private func confirm() {
        // Resolved on tap, so a sheet left open still counts a duration from
        // confirmation and rejects a passed date.
        guard let wake = resolvedWake(now: .now) else { return }
        onSnooze(wake)
        dismiss()
    }

    private func resolvedWake(now: Date) -> Date? {
        switch mode {
        case .date: CustomSnooze.wake(date: date, now: now)
        case .duration: CustomSnooze.wake(amount: amount, unit: unit, now: now)
        }
    }

    /// States when the thread wakes, in both modes.
    private func wakeFooter(suffix: String) -> String {
        guard let wake = resolvedWake(now: .now) else { return "Pick a time in the future." }
        let noun = threadCount > 1 ? "These threads wake" : "Wakes"
        return "\(noun) \(wake.formatted(date: .abbreviated, time: .shortened)). \(suffix)"
    }
}
