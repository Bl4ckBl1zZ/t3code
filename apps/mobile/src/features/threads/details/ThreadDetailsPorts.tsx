import type { EnvironmentId, ProjectScript, ThreadId } from "@t3tools/contracts";
import { useCallback, useMemo } from "react";
import { Alert, Pressable, View } from "react-native";

import { SymbolView } from "../../../components/AppSymbol";
import { copyTextWithHaptic } from "../../../lib/copyTextWithHaptic";
import { tryOpenExternalUrl } from "../../../lib/openExternalUrl";
import { useThemeColor } from "../../../lib/useThemeColor";
import { useThreadEndpoints, type MobileThreadEndpoint } from "../../../state/use-thread-endpoints";
import {
  PORTS_LIVE_TINT,
  portEndpointIcon,
  portEndpointLabel,
  portEndpointSubtitle,
} from "../threadPortsMenu";
import { DetailsDivider, DetailsRow, DetailsSection } from "./detailsRows";

/**
 * Same ceiling as the desktop panel: past a handful of rows the section stops
 * being glanceable.
 */
const VISIBLE_PORT_LIMIT = 4;

const EMPTY_PINNED_URLS: ReadonlyArray<string> = Object.freeze([]);

/**
 * Dev servers this thread is running. Hidden entirely when nothing is serving
 * and nothing is pinned, so the heading never sits there dead.
 */
export function ThreadDetailsPorts(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly scripts: ReadonlyArray<ProjectScript>;
  readonly pinnedPreviewUrl: string | null | undefined;
}) {
  const iconSubtleColor = useThemeColor("--color-icon-subtle");
  const endpoints = useThreadEndpoints({
    environmentId: props.environmentId,
    threadId: props.threadId,
    declaredUrls: useMemo(
      () =>
        props.scripts
          .map((script) => script.previewUrl)
          .filter((url): url is string => typeof url === "string" && url.trim().length > 0),
      [props.scripts],
    ),
    pinnedUrls: useMemo(
      () =>
        typeof props.pinnedPreviewUrl === "string" && props.pinnedPreviewUrl.trim().length > 0
          ? [props.pinnedPreviewUrl]
          : EMPTY_PINNED_URLS,
      [props.pinnedPreviewUrl],
    ),
  });

  const openEndpoint = useCallback(async (endpoint: MobileThreadEndpoint) => {
    if (endpoint.reachability.kind === "unreachable") {
      Alert.alert("Cannot open this port", endpoint.reachability.reason);
      return;
    }
    // A stale row is a server that stopped answering. Opening it would hand the
    // user a connection error with no explanation of why.
    if (endpoint.status === "stale") {
      Alert.alert(
        "Port no longer responding",
        "This server has stopped. Start it again to open it.",
      );
      return;
    }
    const opened = await tryOpenExternalUrl(endpoint.reachability.url, "dev-server");
    if (!opened) {
      Alert.alert("Could not open port", "No app on this device could open that address.");
    }
  }, []);

  const copyEndpointUrl = useCallback((endpoint: MobileThreadEndpoint) => {
    // Copy the reachable form when there is one; otherwise the announced URL is
    // still useful to paste somewhere that can reach it.
    const url =
      endpoint.reachability.kind === "reachable" ? endpoint.reachability.url : endpoint.url;
    copyTextWithHaptic(url, { target: "port URL" });
  }, []);

  if (endpoints.length === 0) return null;

  const visible = endpoints.slice(0, VISIBLE_PORT_LIMIT);

  return (
    <DetailsSection
      title="Ports"
      footer={
        endpoints.length > VISIBLE_PORT_LIMIT
          ? `+${endpoints.length - VISIBLE_PORT_LIMIT} more`
          : null
      }
    >
      {visible.map((endpoint, index) => (
        <View key={endpoint.key}>
          {index > 0 ? <DetailsDivider /> : null}
          <DetailsRow
            icon={portEndpointIcon(endpoint)}
            iconTint={endpoint.status === "live" ? PORTS_LIVE_TINT : undefined}
            title={portEndpointLabel(endpoint, props.scripts)}
            subtitle={portEndpointSubtitle(endpoint)}
            onPress={() => void openEndpoint(endpoint)}
            trailing={
              <Pressable
                accessibilityLabel={`Copy ${portEndpointLabel(endpoint, props.scripts)} URL`}
                accessibilityRole="button"
                className="h-9 w-9 items-center justify-center rounded-full bg-subtle"
                hitSlop={4}
                onPress={() => copyEndpointUrl(endpoint)}
              >
                <SymbolView
                  name="doc.on.doc"
                  size={14}
                  tintColor={iconSubtleColor}
                  type="monochrome"
                />
              </Pressable>
            }
          />
        </View>
      ))}
    </DetailsSection>
  );
}
