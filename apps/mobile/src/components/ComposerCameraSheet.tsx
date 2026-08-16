import { CameraView, useCameraPermissions } from "expo-camera";
import * as Haptics from "expo-haptics";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Linking,
  Modal,
  Pressable,
  useWindowDimensions,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  composerImageFromCameraCapture,
  type DraftComposerImageAttachment,
} from "../lib/composerImages";
import { SymbolView } from "./AppSymbol";
import { AppText as Text } from "./AppText";

/**
 * In-app camera for composer attachments: the chat stays visible above a
 * rounded viewfinder card that slides up from the bottom, with back / shutter /
 * flip controls overlaid on the preview. Capturing hands the photo back as a
 * ready draft attachment and closes the sheet.
 */
export function ComposerCameraSheet(props: {
  readonly visible: boolean;
  /** Current draft attachment count, for the per-message slot limit. */
  readonly existingCount: number;
  readonly onClose: () => void;
  readonly onCapture: (image: DraftComposerImageAttachment) => void;
}) {
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const [permission, requestPermission] = useCameraPermissions();
  const [facing, setFacing] = useState<"back" | "front">("back");
  const [isCapturing, setIsCapturing] = useState(false);
  const cameraRef = useRef<CameraView>(null);

  // Ask as soon as the sheet opens so the viewfinder can start immediately
  // after the system prompt instead of behind an extra tap.
  useEffect(() => {
    if (props.visible && permission !== null && !permission.granted && permission.canAskAgain) {
      void requestPermission();
    }
  }, [permission, props.visible, requestPermission]);

  const handleCapture = useCallback(async () => {
    const camera = cameraRef.current;
    if (!camera || isCapturing) {
      return;
    }
    setIsCapturing(true);
    try {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      const photo = await camera.takePictureAsync({ base64: true, quality: 0.85 });
      const base64 = photo.base64;
      if (!base64) {
        Alert.alert("Couldn't attach photo", "The captured photo could not be read.");
        return;
      }
      const result = composerImageFromCameraCapture({
        base64,
        uri: photo.uri,
        existingCount: props.existingCount,
      });
      if (result.image === null) {
        Alert.alert("Couldn't attach photo", result.error ?? "Please try again.");
        return;
      }
      props.onCapture(result.image);
      props.onClose();
    } catch {
      Alert.alert("Couldn't attach photo", "Taking the photo failed. Please try again.");
    } finally {
      setIsCapturing(false);
    }
  }, [isCapturing, props.existingCount, props.onCapture, props.onClose]);

  const permissionDenied = permission !== null && !permission.granted && !permission.canAskAgain;

  return (
    <Modal
      visible={props.visible}
      transparent
      animationType="slide"
      statusBarTranslucent
      onRequestClose={props.onClose}
    >
      <View className="flex-1 justify-end">
        {/* The chat stays visible behind the top gap; tapping it dismisses. */}
        <Pressable accessible={false} className="flex-1" onPress={props.onClose} />
        <View
          className="mx-1 overflow-hidden rounded-[36px] bg-black"
          style={{ height: Math.round(windowHeight * 0.68), marginBottom: insets.bottom + 4 }}
        >
          {props.visible && permission?.granted ? (
            <CameraView ref={cameraRef} facing={facing} style={{ flex: 1 }} />
          ) : (
            <View className="flex-1 items-center justify-center gap-4 px-8">
              {permissionDenied ? (
                <>
                  <Text className="text-center text-base text-white">
                    Allow camera access to take photos for this chat.
                  </Text>
                  <Pressable
                    accessibilityRole="button"
                    className="rounded-full bg-white/15 px-5 py-2.5 active:opacity-60"
                    onPress={() => void Linking.openSettings()}
                  >
                    <Text className="text-base font-t3-bold text-white">Open Settings</Text>
                  </Pressable>
                </>
              ) : (
                <ActivityIndicator color="#ffffff" />
              )}
            </View>
          )}

          {/* Controls overlaid on the viewfinder: back, shutter, flip. */}
          <View className="absolute inset-x-0 bottom-0 flex-row items-center justify-between px-7 pb-6">
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close camera"
              className="size-12 items-center justify-center rounded-full bg-black/45 active:opacity-60"
              onPress={props.onClose}
            >
              <SymbolView name="chevron.left" size={18} tintColor="#ffffff" type="monochrome" />
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Take photo"
              disabled={!permission?.granted || isCapturing}
              className="size-[76px] items-center justify-center rounded-full border-4 border-white/50 active:opacity-80"
              onPress={() => void handleCapture()}
            >
              <View className="size-[62px] rounded-full bg-white">
                {isCapturing ? (
                  <View className="flex-1 items-center justify-center">
                    <ActivityIndicator color="#000000" />
                  </View>
                ) : null}
              </View>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Flip camera"
              disabled={!permission?.granted}
              className="size-12 items-center justify-center rounded-full bg-black/45 active:opacity-60"
              onPress={() => setFacing((current) => (current === "back" ? "front" : "back"))}
            >
              <SymbolView
                name="arrow.triangle.2.circlepath.camera"
                size={18}
                tintColor="#ffffff"
                type="monochrome"
              />
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}
