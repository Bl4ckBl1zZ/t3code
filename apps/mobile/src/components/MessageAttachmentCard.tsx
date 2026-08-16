/**
 * A sent attachment in the thread feed.
 *
 * The feed used to render every attachment through the image path, so a PDF
 * resolved its signed URL, handed it to <Image>, failed to decode, and sat on a
 * spinner forever. Only images and videos get a thumbnail; everything else gets
 * a card naming the file and, once the server has materialized it, the path it
 * was written to inside the project.
 */
import type { ChatAttachment, EnvironmentId } from "@t3tools/contracts";
import { formatAttachmentSize, middleTruncateFileName } from "@t3tools/shared/composerAttachments";
import { ActivityIndicator, Image, TouchableOpacity, View } from "react-native";

import { useAssetUrl } from "../state/assets";
import { SymbolView } from "./AppSymbol";
import { AppText } from "./AppText";

/** SymbolView maps these SF Symbols onto Tabler icons on Android. */
function symbolForAttachment(attachment: ChatAttachment) {
  if (attachment.type === "pdf") return "doc.richtext" as const;
  if (attachment.type === "video") return "film" as const;
  if (attachment.mimeType.startsWith("audio/")) return "waveform" as const;
  if (attachment.mimeType.includes("zip") || attachment.mimeType.includes("tar")) {
    return "doc.zipper" as const;
  }
  return "doc" as const;
}

export function MessageAttachmentCard(props: {
  readonly environmentId: EnvironmentId;
  readonly attachment: ChatAttachment;
  readonly className: string;
  readonly onPressImage: (uri: string, headers?: Record<string, string>) => void;
  readonly onPressWorkspacePath?: ((workspacePath: string) => void) | undefined;
}) {
  const { attachment } = props;
  const isRenderable = attachment.type === "image";

  if (isRenderable) {
    return (
      <MessageAttachmentImage
        environmentId={props.environmentId}
        attachmentId={attachment.id}
        className={props.className}
        onPressImage={props.onPressImage}
      />
    );
  }

  const workspacePath = attachment.workspacePath;
  const body = (
    <View className="flex-row items-center gap-2.5 rounded-[14px] bg-black/10 px-3 py-2.5 dark:bg-white/10">
      <SymbolView name={symbolForAttachment(attachment)} size={20} className="opacity-70" />
      <View className="min-w-0 flex-1">
        <AppText numberOfLines={1} className="text-[13px]">
          {middleTruncateFileName(attachment.name, 32)}
        </AppText>
        <AppText className="text-[11px] opacity-60">
          {formatAttachmentSize(attachment.sizeBytes)}
          {workspacePath === undefined ? "" : ` · ${workspacePath}`}
        </AppText>
      </View>
    </View>
  );

  if (workspacePath === undefined || props.onPressWorkspacePath === undefined) {
    return <View className={props.className}>{body}</View>;
  }

  return (
    <TouchableOpacity
      activeOpacity={0.7}
      accessibilityRole="button"
      accessibilityLabel={`Open ${workspacePath}`}
      className={props.className}
      onPress={() => props.onPressWorkspacePath?.(workspacePath)}
    >
      {body}
    </TouchableOpacity>
  );
}

function MessageAttachmentImage(props: {
  readonly environmentId: EnvironmentId;
  readonly attachmentId: string;
  readonly className: string;
  readonly onPressImage: (uri: string, headers?: Record<string, string>) => void;
}) {
  const uri = useAssetUrl(props.environmentId, {
    _tag: "attachment",
    attachmentId: props.attachmentId,
  });

  if (uri === null) {
    return (
      <View className={`${props.className} items-center justify-center`}>
        <ActivityIndicator />
      </View>
    );
  }

  return (
    <TouchableOpacity activeOpacity={0.7} onPress={() => props.onPressImage(uri)}>
      <Image source={{ uri }} className={props.className} resizeMode="cover" />
    </TouchableOpacity>
  );
}
