import { useNavigation } from "@react-navigation/native";
import { Image } from "expo-image";
import { useGT } from "gt-react-native";
import { useEffect, useRef, useState } from "react";
import { BackHandler, Pressable, StyleSheet, useWindowDimensions, View } from "react-native";
import { OverKeyboardView } from "react-native-keyboard-controller";
import Animated, {
  Easing,
  Extrapolation,
  interpolate,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { scheduleOnRN } from "react-native-worklets";

import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { GlassBackdrop } from "../../components/ui/GlassBackdrop";
import { beginComposerAttachmentFlight, type WindowRect } from "../../lib/composerAttachmentFlight";
import type { ComposerMediaAsset } from "../../lib/composerImages";
import type { ComposerAddMediaAssets } from "../../state/use-composer-attachment-actions";
import { ComposerCameraPanel, type ComposerCapturedPhoto } from "./ComposerCameraPanel";
import { ComposerPhotoGridPanel } from "./ComposerPhotoGridPanel";
import { composerAttachmentMenuLayout } from "./composerAttachmentMenuLayout";

type Panel = "menu" | "camera" | "photos";

const MENU_RADIUS = 30;
const PANEL_RADIUS = 34;
// Time a captured photo waits for its composer thumbnail to lay out before it flies to the + button.
const FLIGHT_TARGET_WAIT_MS = 600;
const OPEN_SPRING = { dampingRatio: 0.78, duration: 380, reduceMotion: ReduceMotion.System };
const MORPH_SPRING = { dampingRatio: 1, duration: 480, reduceMotion: ReduceMotion.System };
const CLOSE_TIMING = { duration: 180, reduceMotion: ReduceMotion.System };
const FLIGHT_TIMING = {
  duration: 520,
  easing: Easing.bezier(0.32, 0.72, 0, 1),
  reduceMotion: ReduceMotion.System,
};

export function ComposerAttachmentMenu(props: {
  readonly anchor: WindowRect;
  readonly supportsFiles: boolean;
  readonly onPickMedia: () => Promise<void>;
  readonly onPickFiles: () => Promise<void>;
  readonly onAddMediaAssets: ComposerAddMediaAssets;
  /** `after` runs once the overlay is gone, so system pickers and alerts are not hidden under it. */
  readonly onDismissed: (after?: () => void) => void;
}) {
  const gt = useGT();
  const navigation = useNavigation();
  const window = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const items: ReadonlyArray<{
    readonly id: Panel | "files";
    readonly label: string;
    readonly symbol: AppSymbolName;
  }> = [
    { id: "camera", label: gt("Camera"), symbol: "camera" },
    { id: "photos", label: gt("Photos"), symbol: "photo" },
    ...(props.supportsFiles
      ? [{ id: "files" as const, label: gt("Files"), symbol: "paperclip" as const }]
      : []),
  ];
  const layout = composerAttachmentMenuLayout({
    window,
    insets,
    anchor: props.anchor,
    rows: items.length,
  });
  const { left, menu, panel, origin } = layout;

  const [content, setContent] = useState<Panel>("menu");
  const [closing, setClosing] = useState(false);
  const [captured, setCaptured] = useState<ComposerCapturedPhoto | null>(null);
  const pendingAfter = useRef<(() => void) | undefined>(undefined);
  const endFlight = useRef<(() => void) | undefined>(undefined);
  const appear = useSharedValue(0);
  const expand = useSharedValue(0);
  const flightX = useSharedValue(0);
  const flightY = useSharedValue(0);
  const flightWidth = useSharedValue(0);
  const flightHeight = useSharedValue(0);
  const flightRadius = useSharedValue(PANEL_RADIUS);
  const flightOpacity = useSharedValue(0);
  const flightProgress = useSharedValue(0);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- starts the native open animation once the overlay mounts
  useEffect(() => {
    appear.set(withSpring(1, OPEN_SPRING));
  }, [appear]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- an overlay torn down mid-flight must still reveal the attached photo's thumbnail
  useEffect(() => () => endFlight.current?.(), []);

  const finishDismiss = () => props.onDismissed(pendingAfter.current);
  const dismiss = (after?: () => void) => {
    if (closing) return;
    pendingAfter.current = after;
    setClosing(true);
    appear.set(
      withTiming(0, CLOSE_TIMING, () => {
        scheduleOnRN(finishDismiss);
      }),
    );
  };

  const backToMenu = () => {
    expand.set(
      withSpring(0, MORPH_SPRING, (finished) => {
        if (finished) scheduleOnRN(setContent, "menu");
      }),
    );
  };
  const open = (id: Panel | "files") => {
    if (id === "files") {
      dismiss(() => void props.onPickFiles());
      return;
    }
    setContent(id);
    expand.set(withSpring(1, MORPH_SPRING));
  };
  const goBack = () => (content === "menu" ? dismiss() : backToMenu());

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Android's hardware back steps out of the overlay
  useEffect(() => {
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      goBack();
      return true;
    });
    return () => subscription.remove();
  });

  const { onDismissed } = props;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the overlay floats above every screen, so leaving this one closes it
  useEffect(() => navigation.addListener("blur", () => onDismissed()), [navigation, onDismissed]);

  const addAssets = async (assets: ReadonlyArray<ComposerMediaAsset>, unreadable: number) => {
    const error =
      unreadable === 0
        ? undefined
        : unreadable === 1
          ? "A photo could not be read from your library."
          : `${unreadable} photos could not be read from your library.`;
    const result = await props.onAddMediaAssets(assets, { error }).catch(() => null);
    dismiss(result?.showProblems);
  };

  const capture = async (photo: ComposerCapturedPhoto) => {
    // The flying copy mounts hidden over the frozen frame now, so it is decoded before takeoff.
    flightX.set(left);
    flightY.set(panel.top);
    flightWidth.set(panel.width);
    flightHeight.set(panel.height);
    flightRadius.set(PANEL_RADIUS);
    flightOpacity.set(0);
    setCaptured(photo);
    let resolveTarget: (rect: WindowRect | null) => void = () => undefined;
    const target = new Promise<WindowRect | null>((resolve) => {
      resolveTarget = resolve;
    });
    const result = await props
      .onAddMediaAssets(
        [{ uri: photo.uri, type: "image", mimeType: "image/jpeg", fileName: "photo.jpg" }],
        {
          beforeAppend: ([attachmentId]) => {
            if (attachmentId) {
              endFlight.current = beginComposerAttachmentFlight(attachmentId, resolveTarget);
            }
          },
        },
      )
      .catch(() => null);
    if (result === null || result.attachmentIds.length === 0) {
      endFlight.current?.();
      dismiss(result?.showProblems);
      return;
    }
    const timeout = setTimeout(() => resolveTarget(null), FLIGHT_TARGET_WAIT_MS);
    const rect = await target;
    clearTimeout(timeout);
    const destination = rect ?? props.anchor;
    const land = () => {
      endFlight.current?.();
      props.onDismissed(result.showProblems);
    };
    flightOpacity.set(1);
    setClosing(true);
    appear.set(withTiming(0, CLOSE_TIMING));
    flightX.set(withTiming(destination.x, FLIGHT_TIMING));
    flightY.set(withTiming(destination.y, FLIGHT_TIMING));
    flightWidth.set(withTiming(destination.width, FLIGHT_TIMING));
    flightHeight.set(withTiming(destination.height, FLIGHT_TIMING));
    // Composer thumbnails round their corners to about a fifth of their size.
    flightRadius.set(withTiming(rect ? rect.width * 0.22 : destination.width / 2, FLIGHT_TIMING));
    flightOpacity.set(withTiming(rect ? 1 : 0, FLIGHT_TIMING));
    // Reanimated completes at once when a value already equals its target, so land on a 0 → 1 run.
    flightProgress.set(0);
    flightProgress.set(
      withTiming(1, FLIGHT_TIMING, () => {
        scheduleOnRN(land);
      }),
    );
  };

  const containerStyle = useAnimatedStyle(() => {
    const e = expand.value;
    const geometry = (from: number, to: number) =>
      interpolate(e, [0, 1], [from, to], Extrapolation.CLAMP);
    const top = geometry(menu.top, panel.top);
    const width = geometry(menu.width, panel.width);
    const height = geometry(menu.height, panel.height);
    const scale = interpolate(appear.value, [0, 1], [0.35, 1]);
    // Scale about the + button rather than the container's centre.
    const originX = origin.x - left;
    const originY = origin.y - top;
    return {
      top,
      width,
      height,
      borderRadius: geometry(MENU_RADIUS, PANEL_RADIUS),
      opacity: interpolate(appear.value, [0, 0.55], [0, 1], Extrapolation.CLAMP),
      transform: [
        { translateX: (1 - scale) * (originX - width / 2) },
        { translateY: (1 - scale) * (originY - height / 2) },
        { scale },
      ],
    };
  });
  const menuStyle = useAnimatedStyle(() => ({
    opacity: interpolate(expand.value, [0, 0.3], [1, 0], Extrapolation.CLAMP),
  }));
  const panelStyle = useAnimatedStyle(() => ({
    opacity: interpolate(expand.value, [0.12, 0.55], [0, 1], Extrapolation.CLAMP),
  }));
  const flightStyle = useAnimatedStyle(() => ({
    left: flightX.value,
    top: flightY.value,
    width: flightWidth.value,
    height: flightHeight.value,
    borderRadius: flightRadius.value,
    opacity: flightOpacity.value,
  }));

  return (
    <OverKeyboardView visible>
      <View
        style={StyleSheet.absoluteFill}
        pointerEvents={closing || captured !== null ? "none" : "auto"}
      >
        <Pressable
          accessibilityLabel={gt("Close")}
          accessibilityRole="button"
          style={StyleSheet.absoluteFill}
          onPress={() => dismiss()}
        />
        <Animated.View
          accessibilityViewIsModal
          className="absolute overflow-hidden border border-border"
          style={[{ left, borderCurve: "continuous" }, containerStyle]}
        >
          <GlassBackdrop />
          <Animated.View
            pointerEvents={content === "menu" ? "auto" : "none"}
            className="absolute left-0 top-0 py-3"
            style={[{ width: menu.width, height: menu.height }, menuStyle]}
          >
            {items.map((item) => (
              <Pressable
                key={item.id}
                accessibilityRole="menuitem"
                onPress={() => open(item.id)}
                className="h-[60px] flex-row items-center gap-3.5 px-3.5 active:opacity-60"
              >
                <View className="size-[40px] items-center justify-center rounded-full bg-subtle-strong">
                  <SymbolView
                    name={item.symbol}
                    size={19}
                    weight="medium"
                    tintColorClassName="accent-icon"
                    type="monochrome"
                  />
                </View>
                <Text className="text-[17px] text-foreground">{item.label}</Text>
              </Pressable>
            ))}
          </Animated.View>
          {content !== "menu" ? (
            <Animated.View className="absolute left-0 top-0" style={panelStyle}>
              {content === "camera" ? (
                <ComposerCameraPanel
                  width={panel.width}
                  height={panel.height}
                  captured={captured}
                  onBack={backToMenu}
                  onCapture={(photo) => void capture(photo)}
                />
              ) : (
                <ComposerPhotoGridPanel
                  width={panel.width}
                  height={panel.height}
                  onBack={backToMenu}
                  onOpenLibrary={() => dismiss(() => void props.onPickMedia())}
                  onAdd={addAssets}
                />
              )}
            </Animated.View>
          ) : null}
        </Animated.View>
        {captured !== null ? (
          <Animated.View
            pointerEvents="none"
            className="absolute overflow-hidden"
            style={[{ borderCurve: "continuous" }, flightStyle]}
          >
            <Image
              source={{ uri: captured.uri }}
              contentFit="cover"
              allowDownscaling={false}
              style={StyleSheet.absoluteFill}
            />
          </Animated.View>
        ) : null}
      </View>
    </OverKeyboardView>
  );
}
