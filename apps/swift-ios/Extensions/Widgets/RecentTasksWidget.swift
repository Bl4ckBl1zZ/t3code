import SwiftUI
import WidgetKit

private struct T3TaskWidgetEntry: TimelineEntry {
    var date: Date
    var snapshot: T3TaskWidgetSnapshot
}

private struct T3TaskWidgetProvider: TimelineProvider {
    func placeholder(in _: Context) -> T3TaskWidgetEntry {
        T3TaskWidgetEntry(date: Date(), snapshot: .preview)
    }

    func getSnapshot(in context: Context, completion: @escaping (T3TaskWidgetEntry) -> Void) {
        let snapshot = context.isPreview ? T3TaskWidgetSnapshot.preview : T3TaskWidgetSnapshotStore.load()
        completion(T3TaskWidgetEntry(date: Date(), snapshot: snapshot))
    }

    func getTimeline(in _: Context, completion: @escaping (Timeline<T3TaskWidgetEntry>) -> Void) {
        let now = Date()
        let snapshot = T3TaskWidgetSnapshotStore.load()
        let entry = T3TaskWidgetEntry(date: now, snapshot: snapshot)
        completion(Timeline(entries: [entry], policy: .after(snapshot.nextRefresh(after: now))))
    }
}

struct T3RecentTasksWidget: Widget {
    private let kind = "T3RecentTasksWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: T3TaskWidgetProvider()) { entry in
            T3TaskWidgetView(entry: entry)
                .containerBackground(Color(uiColor: .systemBackground), for: .widget)
        }
        .configurationDisplayName("T3 Code Tasks")
        .description("See active and recent T3 Code tasks at a glance.")
        .supportedFamilies([
            .systemSmall, .systemMedium, .systemLarge,
            .accessoryRectangular, .accessoryInline, .accessoryCircular,
        ])
    }
}

private struct T3TaskWidgetView: View {
    @Environment(\.widgetFamily) private var family
    @Environment(\.widgetRenderingMode) private var renderingMode
    let entry: T3TaskWidgetEntry

    var body: some View {
        switch family {
        case .systemMedium:
            listView(limit: 3)
        case .systemLarge:
            listView(limit: 6)
        case .accessoryRectangular:
            rectangularView
        case .accessoryInline:
            inlineView
        case .accessoryCircular:
            circularView
        default:
            smallView
        }
    }

    private var orderedTasks: [T3RelayAgentActivityAggregateRow] {
        entry.snapshot.tasks.sorted { left, right in
            let leftPriority = left.phase.widgetPriority
            let rightPriority = right.phase.widgetPriority
            return leftPriority == rightPriority
                ? left.updatedAt > right.updatedAt
                : leftPriority < rightPriority
        }
    }

    /// Most urgent task first. A small widget has one tap target, so the whole
    /// widget opens that task (or New Task when there is none).
    private var smallView: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let task = orderedTasks.first {
                HStack(spacing: 4) {
                    statusLabel(task)
                    Spacer(minLength: 4)
                    if orderedTasks.count > 1 {
                        Text("+\(orderedTasks.count - 1)")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.secondary)
                    }
                }
                Spacer(minLength: 0)
                Text(task.threadTitle)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.primary)
                    .lineLimit(3)
                    .privacySensitive()
                detailLine(task)
            } else {
                Spacer(minLength: 0)
                emptyState
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .widgetURL(orderedTasks.first?.nativeDeepLinkURL ?? T3WidgetURLs.newTask)
    }

    /// Medium and large: a count header with a real New Task link, then one
    /// link per task. Taps elsewhere open the most urgent task.
    private func listView(limit: Int) -> some View {
        let tasks = Array(orderedTasks.prefix(limit))
        return VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Text(summary)
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                Spacer(minLength: 6)
                Link(destination: T3WidgetURLs.newTask) {
                    Image(systemName: "plus")
                        .font(.footnote.weight(.bold))
                        .frame(width: 28, height: 28)
                        .background(.quaternary, in: Circle())
                }
                .accessibilityLabel("New Task")
            }
            if tasks.isEmpty {
                Spacer(minLength: 0)
                emptyState
                Spacer(minLength: 0)
            } else {
                ForEach(Array(tasks.enumerated()), id: \.element.id) { index, task in
                    Link(destination: task.nativeDeepLinkURL ?? T3WidgetURLs.newTask) {
                        taskRow(task)
                    }
                    if index < tasks.count - 1 {
                        Divider()
                    }
                }
                Spacer(minLength: 0)
            }
        }
        .widgetURL(orderedTasks.first?.nativeDeepLinkURL ?? T3WidgetURLs.newTask)
    }

    private func taskRow(_ task: T3RelayAgentActivityAggregateRow) -> some View {
        let isStale = task.isStale(at: entry.date)
        return HStack(spacing: 8) {
            Image(systemName: task.phase.systemImage)
                .font(.footnote.weight(.semibold))
                .foregroundStyle(phaseColor(task, isStale: isStale))
                .widgetAccentable()
                .frame(width: 18)
            VStack(alignment: .leading, spacing: 1) {
                Text(task.threadTitle)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                    .privacySensitive()
                detailLine(task)
            }
            Spacer(minLength: 6)
            Text(isStale ? "No update" : task.status)
                .font(.caption.weight(.semibold))
                .foregroundStyle(phaseColor(task, isStale: isStale))
                .widgetAccentable()
                .lineLimit(1)
        }
        .opacity(isStale ? 0.55 : 1)
    }

    /// "Project · 3 hr ago", so data that stopped updating reads as old.
    private func detailLine(_ task: T3RelayAgentActivityAggregateRow) -> some View {
        var parts = [task.projectTitle]
        if let since = task.phaseSince {
            parts.append(since.formatted(.relative(presentation: .named, unitsStyle: .abbreviated)))
        }
        return Text(parts.joined(separator: " · "))
            .font(.caption)
            .foregroundStyle(.secondary)
            .lineLimit(1)
            .privacySensitive()
    }

    private func statusLabel(_ task: T3RelayAgentActivityAggregateRow) -> some View {
        let isStale = task.isStale(at: entry.date)
        return Label(isStale ? "No update" : task.status, systemImage: task.phase.systemImage)
            .font(.caption.weight(.semibold))
            .foregroundStyle(phaseColor(task, isStale: isStale))
            .widgetAccentable()
            .lineLimit(1)
    }

    private var rectangularView: some View {
        Group {
            if let task = orderedTasks.first {
                VStack(alignment: .leading, spacing: 1) {
                    Label(task.isStale(at: entry.date) ? "No update" : task.status, systemImage: task.phase.systemImage)
                        .font(.caption.weight(.semibold))
                        .widgetAccentable()
                    Text(task.threadTitle)
                        .font(.caption)
                        .lineLimit(1)
                        .privacySensitive()
                    detailLine(task)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                Label(isNeverSynced ? "Open T3 Code" : "All done", systemImage: "square.and.pencil")
                    .font(.caption.weight(.semibold))
            }
        }
        .widgetURL(orderedTasks.first?.nativeDeepLinkURL ?? T3WidgetURLs.newTask)
    }

    /// Next to the date: "1 waiting · 2 working".
    private var inlineView: some View {
        Label(summary, systemImage: orderedTasks.first?.phase.systemImage ?? "checkmark.circle")
            .widgetURL(orderedTasks.first?.nativeDeepLinkURL ?? T3WidgetURLs.newTask)
    }

    /// The number of agents that need you or are working.
    private var circularView: some View {
        let active = orderedTasks.filter { $0.phase.isActive }
        return ZStack {
            AccessoryWidgetBackground()
            VStack(spacing: 0) {
                Image(systemName: orderedTasks.first?.phase.systemImage ?? "checkmark")
                    .font(.caption.weight(.semibold))
                    .widgetAccentable()
                Text("\(active.count)")
                    .font(.title3.weight(.semibold))
                    .contentTransition(.numericText())
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(summary)
        .widgetURL(orderedTasks.first?.nativeDeepLinkURL ?? T3WidgetURLs.newTask)
    }

    private var emptyState: some View {
        VStack(alignment: .leading, spacing: 4) {
            Label(isNeverSynced ? "Not connected" : "All done", systemImage: isNeverSynced ? "bolt.horizontal.circle" : "checkmark.circle")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.primary)
            Text(isNeverSynced ? "Open T3 Code to connect to your server." : "Tap to start a new task.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    /// "1 waiting · 2 working", or the outcome when nothing is active.
    private var summary: String {
        let waiting = orderedTasks.filter(\.needsAttention).count
        let working = orderedTasks.filter { $0.phase == .running || $0.phase == .starting }.count
        let failed = orderedTasks.filter { $0.phase == .failed }.count
        var parts: [String] = []
        if waiting > 0 { parts.append("\(waiting) waiting") }
        if working > 0 { parts.append("\(working) working") }
        if failed > 0 { parts.append("\(failed) failed") }
        if parts.isEmpty { return isNeverSynced ? "T3 Code" : "All done" }
        return parts.joined(separator: " · ")
    }

    /// A snapshot the app never wrote: nothing to report yet, as opposed to
    /// nothing happening.
    private var isNeverSynced: Bool {
        entry.snapshot.updatedAt.isEmpty
    }

    /// Phase colors carry the widget's whole signal in full color. On tinted
    /// and clear Home Screens the system flattens color, so the accentable
    /// glyph and status take the tint and everything else steps down by opacity.
    private func phaseColor(_ task: T3RelayAgentActivityAggregateRow, isStale: Bool) -> Color {
        if isStale { return .secondary }
        return renderingMode == .fullColor ? task.phase.tint : .primary
    }
}

private enum T3WidgetURLs {
    static let newTask = URL(string: "\(T3SharedContainer.urlScheme)://new-task")!
}

private extension T3AgentActivityPhase {
    var widgetPriority: Int {
        switch self {
        case .waitingForApproval, .waitingForInput: 0
        case .failed: 1
        case .starting, .running: 2
        case .completed, .stale: 3
        }
    }

    var isActive: Bool {
        switch self {
        case .starting, .running, .waitingForApproval, .waitingForInput: true
        case .completed, .failed, .stale: false
        }
    }
}

private extension T3TaskWidgetSnapshot {
    /// The next time the widget has to redraw: the regular refresh, or sooner
    /// when a working row is about to go stale, so it dims on time.
    func nextRefresh(after now: Date) -> Date {
        let regular = now.addingTimeInterval(15 * 60)
        let nextStale = tasks.compactMap(\.staleDeadline).filter { $0 > now }.min()
        return min(regular, nextStale ?? regular)
    }

    /// Gallery sample, timestamped now so its rows never read as stale.
    static var preview: T3TaskWidgetSnapshot {
        let now = Date().ISO8601Format()
        return T3TaskWidgetSnapshot(
            updatedAt: now,
            tasks: [
                T3RelayAgentActivityAggregateRow(
                    environmentId: "preview",
                    threadId: "one",
                    projectTitle: "t3code",
                    threadTitle: "Polish native task list",
                    modelTitle: "GPT-5.6 Sol",
                    phase: .running,
                    status: "Working",
                    updatedAt: now,
                    deepLink: "/preview/one"
                ),
                T3RelayAgentActivityAggregateRow(
                    environmentId: "preview",
                    threadId: "two",
                    projectTitle: "uploadthing",
                    threadTitle: "Review multipart recovery",
                    modelTitle: "Claude Opus 5",
                    phase: .waitingForApproval,
                    status: "Approval",
                    updatedAt: now,
                    deepLink: "/preview/two"
                ),
            ]
        )
    }
}
