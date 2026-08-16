import ActivityKit
import Foundation

enum T3AgentActivityPhase: String, Codable, Hashable, Sendable {
    case starting
    case running
    case waitingForApproval = "waiting_for_approval"
    case waitingForInput = "waiting_for_input"
    case completed
    case failed
    case stale

    var systemImage: String {
        switch self {
        case .starting:
            "circle.dotted"
        case .running:
            "arrow.trianglehead.2.clockwise.rotate.90"
        case .waitingForApproval:
            "exclamationmark.circle.fill"
        case .waitingForInput:
            "questionmark.circle.fill"
        case .completed:
            "checkmark.circle.fill"
        case .failed:
            "xmark.octagon.fill"
        case .stale:
            "clock.arrow.circlepath"
        }
    }
}

/// Mirrors `RelayAgentActivityAggregateRow` in packages/contracts/src/relay.ts.
struct T3RelayAgentActivityAggregateRow: Codable, Hashable, Identifiable, Sendable {
    var environmentId: String
    var threadId: String
    var projectTitle: String
    var threadTitle: String
    var modelTitle: String
    var phase: T3AgentActivityPhase
    var status: String
    var updatedAt: String
    var deepLink: String

    var id: String { "\(environmentId):\(threadId)" }

    /// The two phases the card exists to interrupt for.
    var needsAttention: Bool {
        phase == .waitingForApproval || phase == .waitingForInput
    }

    /// When the row entered its current phase. SwiftUI renders a date-styled
    /// `Text` live, so the card keeps counting between pushes instead of looking
    /// frozen for the minutes an agent can sit silent — and it costs no APNs
    /// budget. Reads as "blocked for 4 min".
    var phaseSince: Date? {
        T3AgentActivityTimestamp.parse(updatedAt)
    }

    /// Generate the native query route rather than trusting a web-shaped path.
    var nativeDeepLinkURL: URL? {
        var components = URLComponents()
        components.scheme = T3SharedContainer.urlScheme
        components.host = "threads"
        components.queryItems = [
            URLQueryItem(name: "environment", value: environmentId),
            URLQueryItem(name: "thread", value: threadId),
        ]
        return components.url
    }
}

/// Mirrors `RelayAgentActivityAggregateState` in packages/contracts/src/relay.ts.
struct T3RelayAgentActivityAggregateState: Codable, Hashable, Sendable {
    var title: String
    var subtitle: String
    var activeCount: Int
    var updatedAt: String
    var activities: [T3RelayAgentActivityAggregateRow]

    var attentionFirstActivities: [T3RelayAgentActivityAggregateRow] {
        activities.sorted { left, right in
            let leftPriority = left.phase.presentationPriority
            let rightPriority = right.phase.presentationPriority
            return leftPriority == rightPriority
                ? left.updatedAt > right.updatedAt
                : leftPriority < rightPriority
        }
    }
}

/// This exact type and state envelope are part of the relay/APNs protocol.
/// The relay sends `attributes-type: LiveActivityAttributes`, empty attributes,
/// and `{ name: "AgentActivity", props: "<aggregate JSON>" }` as content state.
struct LiveActivityAttributes: ActivityAttributes, Hashable {
    struct ContentState: Codable, Hashable, Sendable {
        var name: String
        var props: String

        var aggregate: T3RelayAgentActivityAggregateState? {
            guard name == LiveActivityAttributes.activityName,
                  let data = props.data(using: .utf8)
            else {
                return nil
            }
            return try? JSONDecoder().decode(T3RelayAgentActivityAggregateState.self, from: data)
        }

        init(name: String, props: String) {
            self.name = name
            self.props = props
        }

        init(aggregate: T3RelayAgentActivityAggregateState) throws {
            name = LiveActivityAttributes.activityName
            props = String(decoding: try JSONEncoder().encode(aggregate), as: UTF8.self)
        }
    }

    static let activityName = "AgentActivity"
}

extension T3AgentActivityPhase {
    fileprivate var presentationPriority: Int {
        switch self {
        case .waitingForApproval, .waitingForInput: 0
        case .failed: 1
        case .starting, .running: 2
        case .completed, .stale: 3
        }
    }
}

enum T3AgentActivityTimestamp {
    /// The relay emits fractional seconds; `Date.ISO8601Format()` (used by the
    /// local projection) does not. Both have to parse or the elapsed counter
    /// silently disappears from locally armed cards.
    static func parse(_ value: String) -> Date? {
        fractionalParser.date(from: value) ?? plainParser.date(from: value)
    }

    private static let fractionalParser: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private static let plainParser = ISO8601DateFormatter()
}

/// Status tints mirror the web sidebar's pills
/// (apps/web/src/components/Sidebar.logic.ts `resolveThreadStatusPill`): amber
/// for approval, indigo for input, sky for working, emerald for completed.
///
/// On iPhone the Live Activity sits on a dark material, but macOS (iPhone
/// Mirroring / Mac notification center) renders it on a light one — so each
/// tint carries the web palette's light (-600) and dark (-300) variant and the
/// view picks off the color scheme.
enum T3AgentActivityTint: String, Hashable, Sendable {
    case amber
    case indigo
    case red
    case emerald
    case sky
    /// SwiftUI's semantic `.secondary`, used when the always-on display asks for
    /// the dimmest possible card.
    case neutral

    /// 0xRRGGBB. `nil` means "use the semantic secondary label color".
    func rgb(isLightScheme: Bool) -> UInt32? {
        switch self {
        case .amber: isLightScheme ? 0xD9_7706 : 0xFC_D34D
        case .indigo: isLightScheme ? 0x4F_46E5 : 0xA5_B4FC
        case .red: isLightScheme ? 0xDC_2626 : 0xFC_A5A5
        case .emerald: isLightScheme ? 0x05_9669 : 0x6E_E7B7
        case .sky: isLightScheme ? 0x02_84C7 : 0x7D_D3FC
        case .neutral: nil
        }
    }

    static func forPhase(
        _ phase: T3AgentActivityPhase?,
        isLuminanceReduced: Bool = false
    ) -> T3AgentActivityTint {
        guard !isLuminanceReduced else { return .neutral }
        switch phase {
        case .waitingForApproval: return .amber
        case .waitingForInput: return .indigo
        case .failed: return .red
        case .completed: return .emerald
        case .starting, .running, .stale, .none: return .sky
        }
    }
}

/// Washes the whole lock-screen card in the phase color when a human is blocked
/// or work broke. `activityBackgroundTint` is the only edge-to-edge surface a
/// Live Activity gets, so it reads from across a room in a way colored text does
/// not. Translucent so it tints whatever material the OS supplies rather than
/// fighting it.
enum T3AgentActivityBackgroundTint: String, Hashable, Sendable {
    case amber
    case indigo
    case red

    /// 0xAARRGGBB, matching the RN card's `#33`/`#40` alpha per color scheme.
    func argb(isLightScheme: Bool) -> UInt32 {
        let alpha: UInt32 = isLightScheme ? 0x33 : 0x40
        let rgb: UInt32 = switch self {
        case .amber: 0xF5_9E0B
        case .indigo: 0x63_66F1
        case .red: 0xEF_4444
        }
        return (alpha << 24) | rgb
    }

    /// Only the blocked and broken phases wash the card; a running or completed
    /// agent is informational and keeps the plain system material.
    static func forPhase(
        _ phase: T3AgentActivityPhase?,
        isLuminanceReduced: Bool
    ) -> T3AgentActivityBackgroundTint? {
        // The always-on display wants the dimmest possible card.
        guard !isLuminanceReduced else { return nil }
        switch phase {
        case .waitingForApproval: return .amber
        case .waitingForInput: return .indigo
        case .failed: return .red
        default: return nil
        }
    }
}

/// Everything the Live Activity presentations render, derived once from the
/// aggregate so the banner, Dynamic Island, and Smart Stack card cannot disagree.
///
/// Ported from `apps/mobile/src/widgets/AgentActivity.tsx`.
struct T3AgentActivityPresentation: Hashable, Sendable {
    /// Attention-first, capped for the presentations that list rows.
    var rows: [T3RelayAgentActivityAggregateRow]
    /// The blocked agent the card escalates to, if any. Failures deliberately do
    /// not escalate: they are informational, and the row list still reports them
    /// (with the red background tint).
    var escalatedRow: T3RelayAgentActivityAggregateRow?
    /// Whatever the presentation should lead with: blocked, else broken, else the
    /// highest-priority row.
    var heroRow: T3RelayAgentActivityAggregateRow?
    var activeCount: Int
    var attentionCount: Int
    var hasFailure: Bool
    /// With nothing active the aggregate only carries recently finished work, so
    /// "0 active agents" reads as broken. Lead with the outcome instead.
    var isAllDone: Bool
    /// "Done" / "Failed" — a failure anywhere dominates a newer success.
    var doneLabel: String
    /// "Waiting on you" when escalated, else "5 active agents" / the outcome.
    var headline: String
    /// "1 needs attention", or empty.
    var attentionSuffix: String
    /// Short form for tight spots (expanded center, watch card).
    var summary: String
    /// "+2 more waiting on you" / "+3 other agents running", or empty.
    var footer: String
    /// Compact status word for the Dynamic Island.
    var shortStatus: String
    var subtitle: String
    /// Headline count leans on the accent when a human is actually blocked.
    var headerTint: T3AgentActivityTint
    var heroTint: T3AgentActivityTint
    var backgroundTint: T3AgentActivityBackgroundTint?
    var deepLinkURL: URL?

    var isEscalated: Bool { escalatedRow != nil }

    init(
        state: LiveActivityAttributes.ContentState,
        isLuminanceReduced: Bool = false
    ) {
        self.init(aggregate: state.aggregate, isLuminanceReduced: isLuminanceReduced)
    }

    init(
        aggregate: T3RelayAgentActivityAggregateState?,
        isLuminanceReduced: Bool = false
    ) {
        let activities = aggregate?.activities ?? []
        rows = aggregate?.attentionFirstActivities ?? []
        activeCount = aggregate?.activeCount ?? 0

        let attentionIndices = activities.indices.filter { activities[$0].needsAttention }
        let escalatedIndex = attentionIndices.first
        let escalated = escalatedIndex.map { activities[$0] }
        let failed = activities.first { $0.phase == .failed }
        escalatedRow = escalated
        heroRow = escalated ?? failed ?? rows.first
        attentionCount = attentionIndices.count
        hasFailure = failed != nil

        isAllDone = activeCount == 0
        doneLabel = failed != nil ? "Failed" : "Done"
        let outcomeLabel = failed != nil ? "Agent work failed" : "Agent work completed"
        let agentWord = activeCount == 1 ? "agent" : "agents"
        let agentsLabel = isAllDone ? outcomeLabel : "\(activeCount) active \(agentWord)"
        attentionSuffix = attentionIndices.isEmpty
            ? ""
            : "\(attentionIndices.count) need\(attentionIndices.count == 1 ? "s" : "") attention"
        let activeLabel = isAllDone ? doneLabel : "\(activeCount) active"
        summary = attentionSuffix.isEmpty ? activeLabel : attentionSuffix

        // A blocked agent stops the card being a list and makes it a single
        // large row; everything else keeps the multi-row status list.
        headline = escalated != nil ? "Waiting on you" : agentsLabel

        // The rest of the fleet demoted to a count.
        let otherAttention = max(attentionIndices.count - 1, 0)
        let othersRunning = activities.indices.count { index in
            index != escalatedIndex
                && (activities[index].phase == .running || activities[index].phase == .starting)
        }
        if otherAttention > 0 {
            footer = "+\(otherAttention) more waiting on you"
        } else if othersRunning > 0 {
            footer = "+\(othersRunning) other agent\(othersRunning == 1 ? "" : "s") running"
        } else {
            footer = ""
        }

        if let escalated {
            shortStatus = escalated.phase == .waitingForApproval ? "Approval" : "Input"
        } else if aggregate == nil {
            shortStatus = "Updating"
        } else if activeCount > 0 {
            shortStatus = "\(activeCount) active"
        } else {
            shortStatus = doneLabel
        }
        subtitle = aggregate?.subtitle ?? "Waiting for the latest task status."

        heroTint = .forPhase(heroRow?.phase, isLuminanceReduced: isLuminanceReduced)
        headerTint = .forPhase(
            escalated?.phase ?? failed?.phase ?? heroRow?.phase,
            isLuminanceReduced: isLuminanceReduced
        )
        backgroundTint = .forPhase(heroRow?.phase, isLuminanceReduced: isLuminanceReduced)

        // Any registered scheme variant routes back to this app; taps are
        // delivered to the widget's containing app.
        deepLinkURL = (escalated ?? rows.first)?.nativeDeepLinkURL
    }
}
