import {
  IconAdjustmentsHorizontal,
  IconAlertCircle,
  IconAlertTriangle,
  IconArchive,
  IconArrowBackUp,
  IconArrowDownCircle,
  IconArrowRightCircle,
  IconArrowUp,
  IconArrowUpCircle,
  IconArrowUpRight,
  IconArrowUpRightCircle,
  IconArrowsMaximize,
  IconBellRinging,
  IconBolt,
  IconCamera,
  IconCameraRotate,
  IconChartBar,
  IconCheck,
  IconChevronDown,
  IconCode,
  IconChevronLeft,
  IconChevronRight,
  IconChevronUp,
  IconCircleCheck,
  IconCircleXFilled,
  IconClock,
  IconCopy,
  IconDeviceDesktop,
  IconDots,
  IconDotsCircleHorizontal,
  IconEdit,
  IconExternalLink,
  IconEye,
  IconFileText,
  IconFilter,
  IconFolder,
  IconFolderOpen,
  IconFolderPlus,
  IconGitBranch,
  IconHammer,
  IconGitMerge,
  IconGitPullRequest,
  IconInfoCircle,
  IconKey,
  IconKeyboard,
  IconKeyboardHide,
  IconLayoutColumns,
  IconLayoutSidebar,
  IconLetterSpacing,
  IconLink,
  IconMessage,
  IconMicrophone,
  IconMinus,
  IconMoon,
  IconNetwork,
  IconPalette,
  IconPaperclip,
  IconPhoto,
  IconPin,
  IconPinnedOff,
  IconPlayerPlay,
  IconPlayerStopFilled,
  IconPlus,
  IconQrcode,
  IconRefresh,
  IconSearch,
  IconServer,
  IconSettings,
  IconSparkles,
  IconSun,
  IconLayoutSidebarRight,
  IconTerminal2,
  IconTextDecrease,
  IconTextIncrease,
  IconTool,
  IconTrash,
  IconTypography,
  IconUserCircle,
  IconWaveSine,
  IconWifiOff,
  IconWorld,
  IconX,
  type Icon,
} from "@tabler/icons-react-native";
import { Platform } from "react-native";
import { SymbolView as ExpoSymbolView, type SFSymbol, type SymbolViewProps } from "expo-symbols";
import Animated, { ReduceMotion, ZoomIn, ZoomOut } from "react-native-reanimated";

const ANDROID_ICON_BY_SF_SYMBOL: Partial<Record<SFSymbol, Icon>> = {
  "arrow.branch": IconGitBranch,
  "arrow.clockwise": IconRefresh,
  "arrow.down.circle": IconArrowDownCircle,
  "arrow.right.circle": IconArrowRightCircle,
  "arrow.triangle.branch": IconGitBranch,
  "arrow.triangle.pull": IconGitPullRequest,
  "arrow.triangle.2.circlepath.camera": IconCameraRotate,
  "arrow.turn.left.up": IconArrowBackUp,
  "arrow.up": IconArrowUp,
  "arrow.up.circle": IconArrowUpCircle,
  "arrow.up.left.and.arrow.down.right": IconArrowsMaximize,
  "arrow.up.right": IconArrowUpRight,
  "arrow.up.right.circle": IconArrowUpRightCircle,
  "arrow.uturn.backward": IconArrowBackUp,
  archivebox: IconArchive,
  "archivebox.fill": IconArchive,
  "bell.badge": IconBellRinging,
  "bolt.circle": IconBolt,
  "bolt.horizontal.circle": IconBolt,
  camera: IconCamera,
  "chart.bar.xaxis": IconChartBar,
  checkmark: IconCheck,
  "checkmark.circle": IconCircleCheck,
  clock: IconClock,
  "chevron.down": IconChevronDown,
  "chevron.left": IconChevronLeft,
  "chevron.left.forwardslash.chevron.right": IconCode,
  "chevron.right": IconChevronRight,
  "chevron.up": IconChevronUp,
  desktopcomputer: IconDeviceDesktop,
  "doc.on.doc": IconCopy,
  "doc.text": IconFileText,
  ellipsis: IconDots,
  moon: IconMoon,
  "ellipsis.circle": IconDotsCircleHorizontal,
  "exclamationmark.triangle": IconAlertTriangle,
  eye: IconEye,
  folder: IconFolder,
  "folder.badge.plus": IconFolderPlus,
  "folder.fill": IconFolder,
  gearshape: IconSettings,
  globe: IconWorld,
  "info.circle": IconInfoCircle,
  key: IconKey,
  link: IconLink,
  "line.3.horizontal.decrease": IconFilter,
  "line.3.horizontal.decrease.circle": IconFilter,
  "line.3.horizontal.decrease.circle.fill": IconFilter,
  magnifyingglass: IconSearch,
  mic: IconMicrophone,
  paintbrush: IconPalette,
  paperclip: IconPaperclip,
  "person.crop.circle": IconUserCircle,
  photo: IconPhoto,
  "photo.on.rectangle": IconPhoto,
  pin: IconPin,
  "pin.slash": IconPinnedOff,
  play: IconPlayerPlay,
  plus: IconPlus,
  "qrcode.viewfinder": IconQrcode,
  "point.3.connected.trianglepath.dotted": IconNetwork,
  "point.topleft.down.curvedto.point.bottomright.up": IconGitMerge,
  safari: IconExternalLink,
  "server.rack": IconServer,
  "sidebar.left": IconLayoutSidebar,
  "sidebar.right": IconLayoutSidebarRight,
  "slider.horizontal.3": IconAdjustmentsHorizontal,
  "square.and.pencil": IconEdit,
  "square.split.2x1": IconLayoutColumns,
  "sun.max": IconSun,
  "stop.fill": IconPlayerStopFilled,
  terminal: IconTerminal2,
  "text.bubble": IconMessage,
  "text.word.spacing": IconLetterSpacing,
  "textformat.size": IconTypography,
  "textformat.size.larger": IconTextIncrease,
  "textformat.size.smaller": IconTextDecrease,
  trash: IconTrash,
  "wand.and.stars": IconSparkles,
  waveform: IconWaveSine,
  "wifi.slash": IconWifiOff,
  xmark: IconX,
  "xmark.circle.fill": IconCircleXFilled,
};

// Callers can pass `{ ios, android }` names where `android` is a Material
// icon name (the raw expo-symbols contract). Resolve those here too so the
// android key keeps working through this wrapper — it wins over the SF map
// when both match (e.g. folder vs folder_open for expanded project groups).
const ANDROID_ICON_BY_MATERIAL_NAME: Record<string, Icon> = {
  auto_awesome: IconSparkles,
  bolt: IconBolt,
  build: IconTool,
  chat_bubble: IconMessage,
  check: IconCheck,
  close: IconX,
  construction: IconHammer,
  content_copy: IconCopy,
  edit: IconEdit,
  error: IconAlertCircle,
  folder: IconFolder,
  folder_open: IconFolderOpen,
  keyboard: IconKeyboard,
  keyboard_arrow_down: IconChevronDown,
  keyboard_arrow_up: IconChevronUp,
  keyboard_hide: IconKeyboardHide,
  public: IconWorld,
  remove: IconMinus,
  terminal: IconTerminal2,
  visibility: IconEye,
};

export type { SFSymbol } from "expo-symbols";
export type AppSymbolName = SymbolViewProps["name"];

export function SymbolView(props: SymbolViewProps) {
  if (Platform.OS !== "android") {
    return <ExpoSymbolView {...props} />;
  }

  const materialName = typeof props.name === "string" ? undefined : props.name.android;
  const sfSymbol = typeof props.name === "string" ? props.name : props.name.ios;
  const AndroidIcon =
    (materialName ? ANDROID_ICON_BY_MATERIAL_NAME[materialName] : undefined) ??
    (sfSymbol ? ANDROID_ICON_BY_SF_SYMBOL[sfSymbol] : undefined);

  if (!AndroidIcon) {
    return props.fallback ?? null;
  }

  return (
    <AndroidIcon
      accessibilityLabel={props.accessibilityLabel}
      color={props.tintColor}
      size={props.size}
      strokeWidth={2}
      style={props.style}
      testID={props.testID}
    />
  );
}

const symbolSwapEnter = ZoomIn.duration(140).reduceMotion(ReduceMotion.System);
const symbolSwapExit = ZoomOut.duration(100).reduceMotion(ReduceMotion.System);

/**
 * SymbolView that morphs when its symbol changes: the old glyph zooms out fast while the new
 * one zooms in, instead of snapping between frames. Use for stateful buttons whose icon
 * tracks a mode (mic → stop → send). Finite entering/exiting animations only, no loops.
 */
export function AnimatedSymbolSwap(props: SymbolViewProps) {
  const swapKey =
    typeof props.name === "string" ? props.name : (props.name.ios ?? props.name.android);
  return (
    <Animated.View key={swapKey} entering={symbolSwapEnter} exiting={symbolSwapExit}>
      <SymbolView {...props} />
    </Animated.View>
  );
}
