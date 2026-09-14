import { useState } from "react";
import { Alert, Pressable, View } from "react-native";
import { Image } from "expo-image";
import { File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import { AppText as Text } from "../../components/AppText";
import { uuidv4 } from "../../lib/uuid";

/** Preview bytes arrive through the environment, keeping local artifact paths off the phone. */
export function HermesArtifactPreview({
  content,
  path,
}: {
  content: string | null;
  path: string | null;
}) {
  const [busy, setBusy] = useState(false);
  if (!content) return <Text>No preview available.</Text>;
  if (!content.startsWith("data:")) return <Text selectable>{content}</Text>;
  const share = async () => {
    if (busy) return;
    setBusy(true);
    let file: File | null = null;
    try {
      if (!(await Sharing.isAvailableAsync())) {
        Alert.alert("Sharing unavailable", "This device does not support sharing files.");
        return;
      }
      const match = /^data:([^;,]+)(;base64)?,([\s\S]*)$/u.exec(content);
      if (!match) throw new Error("Hermes returned an unsupported file preview.");
      const label = (path?.split(/[\\/]/u).at(-1) ?? "artifact").replace(/[^a-zA-Z0-9._-]/gu, "_");
      file = new File(Paths.cache, `${uuidv4()}-${label}`);
      file.write(match[2] ? (match[3] ?? "") : decodeURIComponent(match[3] ?? ""), {
        encoding: match[2] ? "base64" : "utf8",
      });
      await Sharing.shareAsync(file.uri, {
        mimeType: match[1] ?? "application/octet-stream",
        dialogTitle: "Save or share artifact",
      });
    } catch (error) {
      Alert.alert(
        "Could not share artifact",
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      if (file?.exists) file.delete();
      setBusy(false);
    }
  };
  return (
    <View className="gap-3">
      {content.startsWith("data:image/") ? (
        <Image
          source={{ uri: content }}
          contentFit="contain"
          style={{ height: 280, width: "100%" }}
          accessibilityLabel={path ?? "Generated image"}
        />
      ) : (
        <Text>File ready to save or share.</Text>
      )}
      <Pressable
        accessibilityRole="button"
        disabled={busy}
        onPress={() => {
          void share();
        }}
        className="rounded-xl bg-card p-3"
      >
        <Text>{busy ? "Preparing file…" : "Save or share file"}</Text>
      </Pressable>
    </View>
  );
}
