import Constants from "expo-constants";
import type {
  NativeStackHeaderItem,
  NativeStackNavigationOptions,
} from "@react-navigation/native-stack";
import { Platform, View } from "react-native";

import { AppText as Text } from "./AppText";
import { T3Wordmark } from "./T3Wordmark";
import { withNativeGlassHeaderItem } from "../features/layout/native-glass-header-items";
import { IPAD_HOME_TITLE_OFFSET } from "../lib/layoutMetrics";
import { resolveMobileStageLabel } from "../lib/mobileBranding";
import type { MobileWorkspace } from "../lib/mobileWorkspace";
import { useThemeColor } from "../lib/useThemeColor";
import { NATIVE_LIQUID_GLASS_SUPPORTED } from "../native/native-glass";

// Native leading items inherit different UIKit margins than title views.
const IOS_NATIVE_LEADING_TITLE_OFFSET = -6;
const IPAD_NATIVE_LEADING_TITLE_OFFSET = 7;

export type CompactBrandWorkspaceMenu = {
  readonly workspace: MobileWorkspace;
  readonly onWorkspaceChange: (workspace: MobileWorkspace) => void;
};

/**
 * Compact brand lockup sized for native navigation bars.
 */
export function CompactBrandTitle(
  props: {
    readonly nativeLeadingItem?: boolean;
    readonly workspace?: MobileWorkspace;
  } = {},
) {
  const iconColor = useThemeColor("--color-icon");
  const mutedColor = useThemeColor("--color-foreground-muted");
  const subtleColor = useThemeColor("--color-subtle");
  const stageLabel = resolveMobileStageLabel(Constants.expoConfig?.extra?.appVariant);
  const titleOffset =
    Platform.OS !== "ios"
      ? 0
      : props.nativeLeadingItem
        ? Platform.isPad
          ? IPAD_NATIVE_LEADING_TITLE_OFFSET
          : IOS_NATIVE_LEADING_TITLE_OFFSET
        : Platform.isPad
          ? IPAD_HOME_TITLE_OFFSET
          : 0;

  const workspaceLabel = props.workspace === "work" ? "Work" : "Code";

  return (
    <View
      aria-level={1}
      accessibilityLabel={`T3 ${workspaceLabel}, Threads`}
      accessible
      role="heading"
      style={{
        alignItems: "center",
        flexDirection: "row",
        gap: 6,
        marginLeft: titleOffset,
      }}
    >
      <T3Wordmark color={iconColor} height={15} />
      <Text
        style={{
          color: mutedColor,
          fontFamily: "DMSans-Medium",
          fontSize: 21,
          letterSpacing: -0.5,
        }}
      >
        {workspaceLabel}
      </Text>
      <View
        style={{
          backgroundColor: subtleColor,
          borderRadius: 999,
          paddingHorizontal: 6,
          paddingVertical: 2,
        }}
      >
        <Text
          style={{
            color: mutedColor,
            fontFamily: "DMSans-Bold",
            fontSize: 9,
            letterSpacing: 0.9,
            textTransform: "uppercase",
          }}
        >
          {stageLabel}
        </Text>
      </View>
    </View>
  );
}

export function renderCompactBrandTitle() {
  return <CompactBrandTitle />;
}

// The iOS 26 Mail-style bottom toolbar drops every toolbar item that is sent
// alongside the native `mailSearchToolbar` item, so the Home workspace
// switcher cannot live there on Liquid Glass. It rides next to the brand
// lockup in the navigation bar's leading items instead.
function workspaceSwitcherHeaderItem(menu: CompactBrandWorkspaceMenu): NativeStackHeaderItem {
  return withNativeGlassHeaderItem(
    {
      type: "menu",
      label: "",
      accessibilityLabel: `Switch workspace. Current workspace: T3 ${menu.workspace === "work" ? "Work" : "Code"}`,
      icon: { type: "sfSymbol" as const, name: "chevron.up.chevron.down" as never },
      sharesBackground: false,
      variant: "plain",
      menu: {
        title: "Workspace",
        items: [
          {
            type: "action" as const,
            label: "T3 Work",
            description: "Create, learn, and explore",
            state: menu.workspace === "work" ? ("on" as const) : undefined,
            onPress: () => menu.onWorkspaceChange("work"),
          },
          {
            type: "action" as const,
            label: "T3 Code",
            description: "Build, debug, and ship",
            state: menu.workspace === "code" ? ("on" as const) : undefined,
            onPress: () => menu.onWorkspaceChange("code"),
          },
        ],
      },
    },
    { hidesSharedBackground: true },
  );
}

export function renderCompactBrandHeaderItems(
  workspaceMenu?: CompactBrandWorkspaceMenu,
): NativeStackHeaderItem[] {
  return [
    {
      element: <CompactBrandTitle nativeLeadingItem workspace={workspaceMenu?.workspace} />,
      hidesSharedBackground: true,
      type: "custom",
    },
    ...(workspaceMenu ? [workspaceSwitcherHeaderItem(workspaceMenu)] : []),
  ];
}

export function getCompactBrandHeaderOptions(
  fallbackTitleStyle?: NativeStackNavigationOptions["headerTitleStyle"],
  workspaceMenu?: CompactBrandWorkspaceMenu,
): NativeStackNavigationOptions {
  if (Platform.OS === "ios" && NATIVE_LIQUID_GLASS_SUPPORTED) {
    return {
      headerTitle: "Threads",
      headerTitleStyle: { color: "transparent", fontSize: 18, fontWeight: "800" },
      title: "Threads",
      unstable_headerLeftItems: () => renderCompactBrandHeaderItems(workspaceMenu),
    };
  }

  return {
    headerTitle: () => <CompactBrandTitle workspace={workspaceMenu?.workspace} />,
    headerTitleStyle: fallbackTitleStyle,
    title: "Threads",
  };
}
