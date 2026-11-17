import { CameraView, useCameraPermissions, type CameraType } from "expo-camera";
import * as Haptics from "expo-haptics";
import { Image } from "expo-image";
import { useGT } from "gt-react-native";
import { useRef, useState } from "react";
import { Linking, Pressable, StyleSheet, View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { ComposerOverlayButton } from "./ComposerOverlayButton";

export interface ComposerCapturedPhoto {
  readonly uri: string;
}

export function ComposerCameraPanel(props: {
  readonly width: number;
  readonly height: number;
  readonly captured: ComposerCapturedPhoto | null;
  readonly onBack: () => void;
  readonly onCapture: (photo: ComposerCapturedPhoto) => void;
}) {
  const gt = useGT();
  const camera = useRef<CameraView>(null);
  const [permission, requestPermission] = useCameraPermissions({ request: true });
  const [facing, setFacing] = useState<CameraType>("back");
  const [ready, setReady] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const granted = permission?.granted === true;

  const capture = async () => {
    if (capturing || !ready || props.captured !== null) return;
    setCapturing(true);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    // The photo stays in the app's cache; nothing is written to the photo library.
    const photo = await camera.current
      ?.takePictureAsync({ quality: 0.9, exif: false })
      .catch(() => undefined);
    setCapturing(false);
    if (photo) props.onCapture({ uri: photo.uri });
  };

  return (
    <View style={{ width: props.width, height: props.height }} className="bg-black">
      {granted ? (
        <CameraView
          ref={camera}
          active={props.captured === null}
          animateShutter={false}
          facing={facing}
          mirror={facing === "front"}
          onCameraReady={() => setReady(true)}
          style={StyleSheet.absoluteFill}
        />
      ) : permission !== null ? (
        <View className="flex-1 items-center justify-center gap-4 px-8">
          <SymbolView name="camera" size={34} tintColor="#ffffff" type="monochrome" />
          <Text className="text-center text-[15px] text-white">
            {gt("Allow camera access to take photos here.")}
          </Text>
          <Pressable
            accessibilityRole="button"
            className="rounded-full bg-white px-5 py-2.5 active:opacity-80"
            onPress={() =>
              permission.canAskAgain ? void requestPermission() : void Linking.openSettings()
            }
          >
            <Text className="text-[15px] font-t3-bold text-black">
              {permission.canAskAgain ? gt("Allow Camera") : gt("Open Settings")}
            </Text>
          </Pressable>
        </View>
      ) : null}
      {props.captured !== null ? (
        <Image
          source={{ uri: props.captured.uri }}
          contentFit="cover"
          style={StyleSheet.absoluteFill}
        />
      ) : null}
      <View
        pointerEvents="box-none"
        className="absolute inset-x-0 bottom-0 flex-row items-center justify-between px-5 pb-5"
      >
        <ComposerOverlayButton
          accessibilityLabel={gt("Back")}
          symbol="chevron.left"
          onPress={props.onBack}
        />
        {granted ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={gt("Take photo")}
            disabled={!ready || capturing || props.captured !== null}
            onPress={() => void capture()}
            className="size-[74px] items-center justify-center rounded-full border-4 border-white/90 active:opacity-80"
          >
            <View className="size-[60px] rounded-full bg-white" />
          </Pressable>
        ) : null}
        {granted ? (
          <ComposerOverlayButton
            accessibilityLabel={gt("Switch camera")}
            symbol="camera.rotate"
            onPress={() => setFacing((current) => (current === "back" ? "front" : "back"))}
          />
        ) : (
          <View className="size-[48px]" />
        )}
      </View>
    </View>
  );
}
