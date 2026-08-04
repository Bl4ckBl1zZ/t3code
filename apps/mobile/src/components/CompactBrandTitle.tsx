import Constants from "expo-constants";
import type {
  NativeStackHeaderItem,
  NativeStackNavigationOptions,
} from "@react-navigation/native-stack";
import type { MenuAction } from "@react-native-menu/menu";
import { Platform, Pressable, View } from "react-native";

import { AppText as Text } from "./AppText";
import { SymbolView } from "./AppSymbol";
import { ControlPillMenu } from "./ControlPill";
import { T3Wordmark } from "./T3Wordmark";
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
 * Compact brand lockup sized for native navigation bars. When `workspaceMenu`
 * is provided the entire lockup becomes the workspace-switcher trigger: any
 * tap on it opens the T3 Work / T3 Code menu.
 */
export function CompactBrandTitle(
  props: {
    readonly nativeLeadingItem?: boolean;
    readonly workspace?: MobileWorkspace;
    readonly workspaceMenu?: CompactBrandWorkspaceMenu;
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

  const menu = props.workspaceMenu;
  const workspace = menu?.workspace ?? props.workspace;
  const workspaceLabel = workspace === "work" ? "Work" : "Code";

  const lockup = (
    <>
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
      {menu ? (
        <SymbolView name="chevron.down" size={12} tintColor={mutedColor} type="monochrome" />
      ) : null}
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
    </>
  );

  if (menu) {
    return (
      <ControlPillMenu
        actions={workspaceMenuActions(menu.workspace)}
        onPressAction={({ nativeEvent }) => {
          if (nativeEvent.event === "workspace:work") menu.onWorkspaceChange("work");
          if (nativeEvent.event === "workspace:code") menu.onWorkspaceChange("code");
        }}
      >
        <Pressable
          accessibilityLabel={`Switch workspace. Current workspace: T3 ${workspaceLabel}`}
          accessibilityRole="button"
          style={{
            alignItems: "center",
            flexDirection: "row",
            gap: 6,
            marginLeft: titleOffset,
          }}
        >
          {lockup}
        </Pressable>
      </ControlPillMenu>
    );
  }

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
      {lockup}
    </View>
  );
}

function workspaceMenuActions(workspace: MobileWorkspace): MenuAction[] {
  return [
    {
      id: "workspace:work",
      title: "T3 Work",
      subtitle: "Create, learn, and explore",
      state: workspace === "work" ? ("on" as const) : undefined,
    },
    {
      id: "workspace:code",
      title: "T3 Code",
      subtitle: "Build, debug, and ship",
      state: workspace === "code" ? ("on" as const) : undefined,
    },
  ];
}

export function renderCompactBrandTitle() {
  return <CompactBrandTitle />;
}

// The iOS 26 Mail-style bottom toolbar drops every toolbar item that is sent
// alongside the native `mailSearchToolbar` item, so the Home workspace
// switcher cannot live there on Liquid Glass. The brand lockup itself is the
// menu trigger in the navigation bar's leading items.
export function renderCompactBrandHeaderItems(
  workspaceMenu?: CompactBrandWorkspaceMenu,
): NativeStackHeaderItem[] {
  return [
    {
      element: <CompactBrandTitle nativeLeadingItem workspaceMenu={workspaceMenu} />,
      hidesSharedBackground: true,
      type: "custom",
    },
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
    headerTitle: () => <CompactBrandTitle workspaceMenu={workspaceMenu} />,
    headerTitleStyle: fallbackTitleStyle,
    title: "Threads",
  };
}
