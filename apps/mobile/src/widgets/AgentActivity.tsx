import { HStack, Image, Spacer, Text, VStack, ZStack } from "@expo/ui/swift-ui";
import type { ComponentProps } from "react";
import {
  activityBackgroundTint,
  font,
  foregroundStyle,
  frame,
  layoutPriority,
  lineLimit,
  padding,
  resizable,
  widgetURL,
} from "@expo/ui/swift-ui/modifiers";
import {
  createLiveActivity,
  type LiveActivityComponent,
  type LiveActivityLayout,
} from "expo-widgets";

type LiveActivityEnvironment = Parameters<LiveActivityComponent<AgentActivityProps>>[1];

export type AgentActivityPhase =
  | "starting"
  | "running"
  | "waiting_for_approval"
  | "waiting_for_input"
  | "completed"
  | "failed"
  | "stale";

export interface AgentActivityRowProps {
  readonly environmentId: string;
  readonly threadId: string;
  readonly projectTitle: string;
  readonly threadTitle: string;
  readonly modelTitle: string;
  readonly phase: AgentActivityPhase;
  readonly status: string;
  readonly updatedAt: string;
  readonly deepLink: string;
}

export interface AgentActivityProps {
  readonly title: string;
  readonly subtitle: string;
  readonly activeCount: number;
  readonly updatedAt: string;
  readonly activities: ReadonlyArray<AgentActivityRowProps>;
}

// This function is serialized into the widget extension's JS bundle, so it
// must stay self-contained: no references to module-scope helpers, only the
// imported view/modifier factories.
export function AgentActivity(
  props: AgentActivityProps,
  environment: LiveActivityEnvironment,
): LiveActivityLayout {
  "widget";

  // Use SwiftUI's semantic label colors rather than fixed hex keyed off the
  // device color scheme. A Live Activity banner always renders over a dark
  // system material regardless of the device's light/dark setting, so
  // scheme-derived dark text read as unreadable dark-on-dark on the lock
  // screen. Semantic colors adapt to whatever material the OS places them on:
  // the dark LA banner and the (light or dark) home-screen widget alike.
  const primaryForeground = "primary";
  const secondaryForeground = "secondary";

  // Status tints mirror the web sidebar's pills
  // (apps/web/src/components/Sidebar.logic.ts resolveThreadStatusPill): amber
  // for approval, indigo for input, sky for working, emerald for completed.
  // On iPhone the LA sits on a dark material, but macOS (iPhone Mirroring /
  // Mac notification center) renders it on a light one — so pick the web
  // palette's light (-600) or dark (-300) variant off the color scheme.
  const isLightScheme = environment.colorScheme === "light";
  const phaseTint = (phase: AgentActivityPhase | undefined): string => {
    if (environment.isLuminanceReduced) {
      return secondaryForeground;
    }
    switch (phase) {
      case "waiting_for_approval":
        return isLightScheme ? "#d97706" : "#fcd34d"; // amber-600 / amber-300
      case "waiting_for_input":
        return isLightScheme ? "#4f46e5" : "#a5b4fc"; // indigo-600 / indigo-300
      case "failed":
        return isLightScheme ? "#dc2626" : "#fca5a5"; // red-600 / red-300
      case "completed":
        return isLightScheme ? "#059669" : "#6ee7b7"; // emerald-600 / emerald-300
      case "starting":
      case "running":
      default:
        return isLightScheme ? "#0284c7" : "#7dd3fc"; // sky-600 / sky-300
    }
  };

  // Wash the whole lock-screen card in the phase color when a human is blocked
  // or work broke. `activityBackgroundTint` is the only edge-to-edge surface a
  // Live Activity gets, so it reads from across a room in a way colored text
  // does not. Translucent (#AARRGGBB) so it tints whatever material the OS
  // supplies rather than fighting it, and skipped under reduced luminance,
  // where the always-on display wants the dimmest possible card.
  const phaseBackgroundTint = (phase: AgentActivityPhase | undefined): string | null => {
    if (environment.isLuminanceReduced) {
      return null;
    }
    switch (phase) {
      case "waiting_for_approval":
        return isLightScheme ? "#33f59e0b" : "#40f59e0b";
      case "waiting_for_input":
        return isLightScheme ? "#336366f1" : "#406366f1";
      case "failed":
        return isLightScheme ? "#33ef4444" : "#40ef4444";
      default:
        return null;
    }
  };

  // Order attention-first so whatever needs the user floats to the top of every
  // presentation, then failures, then in-flight work, then finished/stale.
  const phasePriority = (phase: AgentActivityPhase): number => {
    if (phase === "waiting_for_approval" || phase === "waiting_for_input") return 0;
    if (phase === "failed") return 1;
    if (phase === "running" || phase === "starting") return 2;
    return 3;
  };
  const ordered = [...props.activities].sort(
    (a, b) => phasePriority(a.phase) - phasePriority(b.phase),
  );
  const row0 = ordered[0];
  const row1 = ordered[1];
  const row2 = ordered[2];
  const row3 = ordered[3];
  const row4 = ordered[4];

  const attentionRows = props.activities.filter(
    (row) => row.phase === "waiting_for_approval" || row.phase === "waiting_for_input",
  );
  const attentionRow = attentionRows[0];
  const failedRow = props.activities.find((row) => row.phase === "failed");
  const heroRow = attentionRow ?? failedRow ?? row0;
  const tint = phaseTint(heroRow?.phase);
  // Headline count leans on the accent when a human is actually blocked.
  const headerTint = attentionRow
    ? phaseTint(attentionRow.phase)
    : failedRow
      ? phaseTint(failedRow.phase)
      : tint;

  // With nothing active the aggregate only carries recently finished work, so
  // "0 active agents" (and a lone "0" in the expanded island) read as broken.
  // Lead with the outcome instead. The outcome is derived here from the rows
  // rather than taken from the server subtitle (which keys off the newest
  // terminal row): every presentation — header text, tint, count slots,
  // minimal glyph — must agree, and a failure anywhere should dominate a
  // newer success.
  const allDone = props.activeCount === 0;
  const doneLabel = failedRow ? "Failed" : "Done";
  const outcomeLabel = failedRow ? "Agent work failed" : "Agent work completed";

  // Header copy: "5 active agents" + (", 1 needs attention"). The banner renders
  // the two parts in-line so the attention half can carry the accent color;
  // `summary` is the short form for tight spots (expanded center, watch card).
  const agentWord = props.activeCount === 1 ? "agent" : "agents";
  const agentsLabel = allDone ? outcomeLabel : `${props.activeCount} active ${agentWord}`;
  const attentionSuffix =
    attentionRows.length > 0
      ? `${attentionRows.length} need${attentionRows.length === 1 ? "s" : ""} attention`
      : "";
  const activeLabel = allDone ? doneLabel : `${props.activeCount} active`;
  const summary = attentionSuffix || activeLabel;

  // A blocked agent is the one state the card exists to interrupt for, so it
  // stops being a list and becomes a single large row. Everything else keeps
  // the multi-row status list. Failures don't escalate: they're informational,
  // and the row list still reports them (with the red background tint).
  const escalated = attentionRow ?? null;
  const escalatedHeadline = escalated ? "Waiting on you" : agentsLabel;
  const otherAttention = attentionRows.length - 1;
  const othersRunning = props.activities.filter(
    (row) => row !== escalated && (row.phase === "running" || row.phase === "starting"),
  ).length;
  const escalatedFooter =
    otherAttention > 0
      ? `+${otherAttention} more waiting on you`
      : othersRunning > 0
        ? `+${othersRunning} other agent${othersRunning === 1 ? "" : "s"} running`
        : "";

  // SwiftUI renders a date-styled Text live, so the card keeps counting between
  // pushes instead of looking frozen for the minutes an agent can sit silent —
  // and it costs no APNs budget. `updatedAt` is when the row entered its
  // current phase, so this reads as "blocked for 4 min".
  const phaseSince = (iso: string): Date | null => {
    const parsed = Date.parse(iso);
    return Number.isNaN(parsed) ? null : new Date(parsed);
  };

  // Any registered scheme variant routes back to this app; taps are delivered
  // to the widget's containing app, so the prod scheme is safe for all builds.
  const deepLinkRow = attentionRow ?? row0;
  const deepLink =
    deepLinkRow && deepLinkRow.deepLink.startsWith("/") && !deepLinkRow.deepLink.startsWith("//")
      ? `t3code://${deepLinkRow.deepLink.slice(1)}`
      : null;

  // A scannable status glyph per phase — reads faster than colored words and
  // ties the compact / expanded / banner / watch presentations together.
  type SFName = NonNullable<ComponentProps<typeof Image>["systemName"]>;
  const phaseSymbol = (phase: AgentActivityPhase): SFName => {
    switch (phase) {
      case "waiting_for_approval":
        return "exclamationmark.circle.fill";
      case "waiting_for_input":
        return "questionmark.circle.fill";
      case "failed":
        return "xmark.octagon.fill";
      case "completed":
        return "checkmark.circle.fill";
      case "starting":
        return "circle.dotted";
      case "stale":
        return "clock.arrow.circlepath";
      case "running":
      default:
        return "arrow.triangle.2.circlepath";
    }
  };

  // SF Symbols, like the logo, ignore frame/foregroundStyle applied directly to
  // the image; size + tint them through a container the resizable symbol fills.
  const renderGlyph = (systemName: SFName, size: number, color: string) => (
    <HStack modifiers={[frame({ width: size, height: size }), foregroundStyle(color)]}>
      <Image systemName={systemName} modifiers={[resizable()]} />
    </HStack>
  );

  // Single-line row used by every presentation: glyph, title, inline project,
  // status. The project and status carry layoutPriority(1) so when space runs
  // out it's the title that truncates, never the (short) project name or the
  // status label. Single-line keeps rows inside the expanded island's hard
  // height budget (~160pt) and lets the banner fit more agents.
  const renderCompactRow = (row: AgentActivityRowProps) => (
    <HStack spacing={7} alignment="center">
      <Text
        modifiers={[
          font({ weight: "semibold", size: 13 }),
          foregroundStyle(primaryForeground),
          lineLimit(1),
        ]}
      >
        {row.threadTitle}
      </Text>
      {/* No layoutPriority and no frame on the project: two bare texts take
          their ideal width when it fits and shrink proportionally only when it
          doesn't — so short rows never truncate, and long title + long project
          truncate together. (A maxWidth frame is greedy and reserved its full
          width even for short names; layoutPriority let the project starve the
          title.) */}
      <Text modifiers={[font({ size: 11 }), foregroundStyle(secondaryForeground), lineLimit(1)]}>
        {row.projectTitle}
      </Text>
      <Spacer minLength={8} />
      <Text
        modifiers={[
          font({ weight: "semibold", size: 11 }),
          foregroundStyle(phaseTint(row.phase)),
          layoutPriority(1),
        ]}
      >
        {row.status}
      </Text>
    </HStack>
  );

  // The branded T3 mark. `assetName` resolves the template image set bundled in
  // the widget extension's asset catalog. Image views only honor `resizable`
  // directly (frame/foregroundStyle are dropped), so we size it via a container
  // frame the resizable image fills and tint it through the container's
  // foreground style, which the template image inherits. The 3:2 frame matches
  // the glyph's aspect ratio so it never distorts.
  const renderLogo = (height: number, color: string) => (
    <HStack modifiers={[frame({ width: height * 1.5, height }), foregroundStyle(color)]}>
      <Image assetName="T3Mark" modifiers={[resizable()]} />
    </HStack>
  );

  // Live elapsed text for whichever row the presentation leads with.
  const renderElapsed = (row: AgentActivityRowProps, fontModifier: ReturnType<typeof font>) => {
    const since = phaseSince(row.updatedAt);
    if (!since) {
      return null;
    }
    return (
      <Text
        date={since}
        dateStyle="relative"
        modifiers={[fontModifier, foregroundStyle(secondaryForeground), lineLimit(1)]}
      />
    );
  };
  // Rendered once so the "·" separator can't dangle when a row carries a
  // timestamp we couldn't parse.
  const escalatedElapsed = escalated ? renderElapsed(escalated, font({ size: 12 })) : null;
  const heroElapsed = heroRow ? renderElapsed(heroRow, font({ textStyle: "caption2" })) : null;

  // The Smart Stack card is the whole tap target on watchOS; without this the
  // watch presentation was the one surface with no way into the thread.
  const smallModifiers = deepLink
    ? [padding({ all: 10 }), widgetURL(deepLink)]
    : [padding({ all: 10 })];
  const simplified = environment.levelOfDetail === "simplified";

  const backgroundTint = phaseBackgroundTint(heroRow?.phase);
  const bannerModifiers = [
    padding({ all: 14 }),
    ...(deepLink ? [widgetURL(deepLink)] : []),
    ...(backgroundTint ? [activityBackgroundTint(backgroundTint)] : []),
  ];

  return {
    banner: escalated ? (
      // Blocked: one agent, large enough to read without picking the phone up,
      // with the rest of the fleet demoted to a count.
      <VStack alignment="leading" spacing={9} modifiers={bannerModifiers}>
        <HStack spacing={7} alignment="center">
          {renderLogo(13, primaryForeground)}
          <Text
            modifiers={[
              font({ weight: "semibold", size: 13 }),
              foregroundStyle(headerTint),
              lineLimit(1),
            ]}
          >
            {escalatedHeadline}
          </Text>
          <Spacer minLength={0} />
        </HStack>
        <HStack spacing={10} alignment="center">
          {renderGlyph(phaseSymbol(escalated.phase), 24, headerTint)}
          <VStack alignment="leading" spacing={2}>
            <Text
              modifiers={[
                font({ weight: "semibold", size: 17 }),
                foregroundStyle(primaryForeground),
                lineLimit(1),
              ]}
            >
              {escalated.threadTitle}
            </Text>
            <HStack spacing={5} alignment="center">
              <Text
                modifiers={[font({ size: 12 }), foregroundStyle(secondaryForeground), lineLimit(1)]}
              >
                {escalated.projectTitle}
              </Text>
              {escalatedElapsed ? (
                <Text modifiers={[font({ size: 12 }), foregroundStyle(secondaryForeground)]}>
                  ·
                </Text>
              ) : null}
              {escalatedElapsed}
            </HStack>
          </VStack>
          <Spacer minLength={8} />
          <Text
            modifiers={[
              font({ weight: "semibold", size: 13 }),
              foregroundStyle(headerTint),
              layoutPriority(1),
            ]}
          >
            {escalated.status}
          </Text>
        </HStack>
        {escalatedFooter ? (
          <Text
            modifiers={[font({ size: 11 }), foregroundStyle(secondaryForeground), lineLimit(1)]}
          >
            {escalatedFooter}
          </Text>
        ) : null}
      </VStack>
    ) : (
      <VStack alignment="leading" spacing={6} modifiers={bannerModifiers}>
        {/* Logo pinned to the leading edge; the status texts centered across the
            full width (ZStack so the logo doesn't skew the centering). No footer —
            overflow beyond the visible rows is inferable from the count. */}
        <ZStack>
          <HStack spacing={0} alignment="center">
            {renderLogo(13, primaryForeground)}
            <Spacer minLength={0} />
          </HStack>
          <HStack spacing={6} alignment="center">
            <Spacer minLength={0} />
            <Text
              modifiers={[
                font({ weight: "semibold", size: 13 }),
                // The all-done header carries the outcome tint (emerald /
                // red) the way the Done/Failed status labels do.
                foregroundStyle(allDone ? headerTint : primaryForeground),
                lineLimit(1),
              ]}
            >
              {agentsLabel}
            </Text>
            {attentionSuffix ? (
              <Text modifiers={[font({ size: 13 }), foregroundStyle(secondaryForeground)]}>·</Text>
            ) : null}
            {attentionSuffix ? (
              <Text
                modifiers={[
                  font({ weight: "semibold", size: 13 }),
                  foregroundStyle(headerTint),
                  lineLimit(1),
                ]}
              >
                {attentionSuffix}
              </Text>
            ) : null}
            <Spacer minLength={0} />
          </HStack>
        </ZStack>
        {row0 ? renderCompactRow(row0) : null}
        {row1 ? renderCompactRow(row1) : null}
        {row2 ? renderCompactRow(row2) : null}
        {row3 ? renderCompactRow(row3) : null}
        {row4 ? renderCompactRow(row4) : null}
      </VStack>
    ),
    // Compact card for the watchOS Smart Stack + CarPlay (the `.small` family).
    // Text styles rather than fixed point sizes: the watch scales these with the
    // wearer's Dynamic Type setting, which fixed sizes ignore. Sized off the
    // hero row (whatever needs the user), not the arbitrary first row.
    bannerSmall: simplified ? (
      // The system asks for a simplified view when the card is being read at a
      // distance or with the wrist down. One glyph and one number survive that;
      // thread titles do not.
      <HStack spacing={8} alignment="center" modifiers={smallModifiers}>
        {renderGlyph(phaseSymbol(heroRow?.phase ?? "running"), 22, headerTint)}
        <Text
          modifiers={[
            font({ textStyle: "title2", weight: "bold" }),
            foregroundStyle(headerTint),
            lineLimit(1),
          ]}
        >
          {allDone
            ? doneLabel
            : `${attentionRows.length > 0 ? attentionRows.length : props.activeCount}`}
        </Text>
        <Spacer minLength={0} />
      </HStack>
    ) : (
      <VStack alignment="leading" spacing={4} modifiers={smallModifiers}>
        <HStack spacing={6} alignment="center">
          {renderLogo(14, primaryForeground)}
          <Text
            modifiers={[
              font({ textStyle: "caption", weight: "semibold" }),
              foregroundStyle(headerTint),
              lineLimit(1),
            ]}
          >
            {attentionRows.length > 0 ? summary : activeLabel}
          </Text>
          <Spacer minLength={4} />
        </HStack>
        {heroRow ? (
          <HStack spacing={6} alignment="center">
            {renderGlyph(phaseSymbol(heroRow.phase), 14, phaseTint(heroRow.phase))}
            <Text
              modifiers={[
                font({ textStyle: "headline" }),
                foregroundStyle(primaryForeground),
                lineLimit(1),
              ]}
            >
              {heroRow.threadTitle}
            </Text>
            <Spacer minLength={4} />
          </HStack>
        ) : null}
        {heroRow ? (
          <HStack spacing={5} alignment="center">
            <Text
              modifiers={[
                font({ textStyle: "caption2" }),
                foregroundStyle(secondaryForeground),
                lineLimit(1),
              ]}
            >
              {heroRow.projectTitle}
            </Text>
            {heroElapsed ? (
              <Text
                modifiers={[font({ textStyle: "caption2" }), foregroundStyle(secondaryForeground)]}
              >
                ·
              </Text>
            ) : null}
            {heroElapsed}
            <Spacer minLength={4} />
          </HStack>
        ) : null}
      </VStack>
    ),
    compactLeading: renderLogo(14, tint),
    // Glyph + bare count rather than a word: from iOS 27 the compact
    // presentation also renders in landscape, where it can't grow in width, and
    // "Approval" / "5 active" were the first things to get clipped. The glyph
    // carries the phase, the leading logo carries the brand.
    compactTrailing: attentionRow ? (
      <HStack spacing={3} alignment="center">
        {renderGlyph(phaseSymbol(attentionRow.phase), 12, tint)}
        {attentionRows.length > 1 ? (
          <Text modifiers={[font({ weight: "semibold", size: 11 }), foregroundStyle(tint)]}>
            {`${attentionRows.length}`}
          </Text>
        ) : null}
      </HStack>
    ) : (
      <Text modifiers={[font({ weight: "semibold", size: 11 }), foregroundStyle(tint)]}>
        {allDone ? doneLabel : `${props.activeCount}`}
      </Text>
    ),
    // The shared/minimal form is a ~22pt circle — a single signal reads there,
    // the wordmark does not. Show the blocking/outcome phase glyph, else the
    // mark (all-done shows the hero row's checkmark/cross).
    minimal:
      (attentionRow || failedRow || allDone) && heroRow
        ? renderGlyph(phaseSymbol(heroRow.phase), 13, phaseTint(heroRow.phase))
        : renderLogo(11, tint),
    expandedLeading: (
      <HStack spacing={5} alignment="center" modifiers={[padding({ leading: 4, vertical: 4 })]}>
        {renderLogo(15, tint)}
        <Text modifiers={[font({ weight: "bold", size: 13 }), foregroundStyle(tint)]}>
          {allDone ? doneLabel : `${props.activeCount}`}
        </Text>
      </HStack>
    ),
    // No center content: the phase glyphs + statuses in expandedBottom already
    // carry the attention signal, and the expanded island's height budget is
    // tight enough that a summary line there pushed the third row off.
    expandedCenter: null,
    // No trailing content: a timestamp is glanceable-lock-screen info, not
    // useful in a view the user is actively holding open — and the trailing
    // region hugs the island's corner radius, which clipped it anyway.
    expandedTrailing: null,
    expandedBottom: (
      // Vertical padding only: the expanded region provides its own horizontal
      // content margins, so `all` padding double-indented the rows.
      // Horizontal padding keeps both edges clear of the island's corner
      // curvature (right edge clipped status labels; titles hugged the left).
      <VStack
        alignment="leading"
        spacing={5}
        modifiers={
          deepLink
            ? [padding({ vertical: 2, horizontal: 8 }), widgetURL(deepLink)]
            : [padding({ vertical: 2, horizontal: 8 })]
        }
      >
        {row0 ? renderCompactRow(row0) : null}
        {row1 ? renderCompactRow(row1) : null}
        {row2 ? renderCompactRow(row2) : null}
      </VStack>
    ),
  };
}

export default createLiveActivity<AgentActivityProps>("AgentActivity", AgentActivity);
