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
    @State private var amount: Int? = 2
    @State private var unit = CustomSnooze.Unit.hours

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker("Snooze by", selection: $mode) {
                        Text("Date & time").tag(CustomSnooze.Mode.date)
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
                            "Wake on",
                            selection: $date,
                            in: Date.now...,
                            displayedComponents: [.date, .hourAndMinute]
                        )
                    } footer: {
                        Text("Uses this device's time zone.")
                    }
                case .duration:
                    Section {
                        TextField("Amount", value: $amount, format: .number)
                            .keyboardType(.numberPad)
                            .accessibilityIdentifier("custom-snooze-amount")
                        Picker("Unit", selection: $unit) {
                            Text("Minutes").tag(CustomSnooze.Unit.minutes)
                            Text("Hours").tag(CustomSnooze.Unit.hours)
                            Text("Days").tag(CustomSnooze.Unit.days)
                        }
                    } footer: {
                        Text(durationFooter)
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(T3Colors.background)
            .navigationTitle(threadCount > 1 ? "Snooze \(threadCount) threads" : "Snooze until")
            .navigationBarTitleDisplayMode(.inline)
            .t3NavigationChrome()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Snooze") {
                        // Resolved on tap, so a sheet left open still counts a
                        // duration from confirmation and rejects a passed date.
                        guard let wake = resolvedWake(now: .now) else { return }
                        onSnooze(wake)
                        dismiss()
                    }
                    .disabled(resolvedWake(now: .now) == nil)
                }
            }
        }
        .presentationDetents([.medium, .large])
    }

    private func resolvedWake(now: Date) -> Date? {
        switch mode {
        case .date: CustomSnooze.wake(date: date, now: now)
        case .duration: amount.flatMap { CustomSnooze.wake(amount: $0, unit: unit, now: now) }
        }
    }

    private var durationFooter: String {
        guard let wake = resolvedWake(now: .now) else { return "Enter a whole number above zero." }
        return "Wakes \(wake.formatted(date: .abbreviated, time: .shortened)). A day is 24 hours from when you tap Snooze."
    }
}
