import { LegendList } from "@legendapp/list/react-native";
import { PROVIDER_SEND_TURN_MAX_ATTACHMENTS } from "@t3tools/contracts";
import { BlurView } from "expo-blur";
import { Image } from "expo-image";
import {
  getAssetInfoAsync,
  getAssetsAsync,
  usePermissions,
  type Asset,
} from "expo-media-library/legacy";
import { useGT } from "gt-react-native";
import { useEffect, useState } from "react";
import { ActivityIndicator, Linking, Platform, Pressable, StyleSheet, View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import type { ComposerMediaAsset } from "../../lib/composerImages";
import { ComposerOverlayButton } from "./ComposerOverlayButton";

const COLUMNS = 3;
const GAP = 2;
const PAGE_SIZE = 60;
const CONTROLS_HEIGHT = 92;

export function ComposerPhotoGridPanel(props: {
  readonly width: number;
  readonly height: number;
  readonly onBack: () => void;
  readonly onOpenLibrary: () => void;
  readonly onAdd: (assets: ReadonlyArray<ComposerMediaAsset>) => void;
}) {
  const gt = useGT();
  const [permission, requestPermission] = usePermissions({
    request: true,
    granularPermissions: ["photo"],
  });
  const [page, setPage] = useState<PhotoPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<ReadonlyArray<string>>([]);
  const [adding, setAdding] = useState(false);
  const granted = permission?.granted === true;
  const tile = Math.floor((props.width - GAP * (COLUMNS - 1)) / COLUMNS);

  const loadMore = async () => {
    if (loading || page === null || !page.hasNextPage) return;
    setLoading(true);
    setPage(await loadPhotoPage(page));
    setLoading(false);
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the first page from the photo library once access is granted
  useEffect(() => {
    if (!granted) return;
    let current = true;
    void loadPhotoPage(null).then((first) => {
      if (current) setPage(first);
    });
    return () => {
      current = false;
    };
  }, [granted]);

  const toggle = (asset: Asset) =>
    setSelected((current) =>
      current.includes(asset.id)
        ? current.filter((id) => id !== asset.id)
        : current.length < PROVIDER_SEND_TURN_MAX_ATTACHMENTS
          ? [...current, asset.id]
          : current,
    );

  const add = async () => {
    if (adding || page === null) return;
    setAdding(true);
    const chosen = selected.flatMap((id) => page.assets.find((asset) => asset.id === id) ?? []);
    const assets = await Promise.all(chosen.map(resolvePhoto));
    setAdding(false);
    props.onAdd(assets.flatMap((asset) => asset ?? []));
  };

  return (
    <View style={{ width: props.width, height: props.height }} className="bg-black">
      {granted ? (
        // oxlint-disable-next-line t3code/require-registered-list-scroll -- Lives in the over-keyboard attachment overlay; there is no navigation header to register with.
        <LegendList
          data={page?.assets ?? []}
          extraData={selected}
          keyExtractor={(asset) => asset.id}
          numColumns={COLUMNS}
          columnWrapperStyle={{ gap: GAP }}
          contentContainerStyle={{ paddingBottom: CONTROLS_HEIGHT }}
          estimatedItemSize={tile}
          recycleItems
          onEndReached={() => void loadMore()}
          onEndReachedThreshold={1}
          renderItem={({ item }) => {
            const order = selected.indexOf(item.id);
            return (
              <Pressable
                accessibilityRole="checkbox"
                accessibilityState={{ checked: order >= 0 }}
                accessibilityLabel={item.filename}
                onPress={() => toggle(item)}
                style={{ width: tile, height: tile }}
              >
                <Image
                  source={{ uri: item.uri }}
                  recyclingKey={item.id}
                  contentFit="cover"
                  style={StyleSheet.absoluteFill}
                />
                {order >= 0 ? (
                  <View className="absolute inset-0 items-end bg-black/25 p-1.5">
                    <View className="size-[24px] items-center justify-center rounded-full border-2 border-white bg-[#0a84ff]">
                      <Text className="text-[12px] font-t3-bold text-white">{order + 1}</Text>
                    </View>
                  </View>
                ) : null}
              </Pressable>
            );
          }}
        />
      ) : permission !== null ? (
        <View className="flex-1 items-center justify-center gap-4 px-8 pb-16">
          <SymbolView name="photo" size={34} tintColor="#ffffff" type="monochrome" />
          <Text className="text-center text-[15px] text-white">
            {gt("Allow photo access to see your recent photos here.")}
          </Text>
          <Pressable
            accessibilityRole="button"
            className="rounded-full bg-white px-5 py-2.5 active:opacity-80"
            onPress={() =>
              permission.canAskAgain ? void requestPermission() : void Linking.openSettings()
            }
          >
            <Text className="text-[15px] font-t3-bold text-black">
              {permission.canAskAgain ? gt("Allow Photos") : gt("Open Settings")}
            </Text>
          </Pressable>
        </View>
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
        {selected.length > 0 ? (
          <Pressable
            accessibilityRole="button"
            disabled={adding}
            onPress={() => void add()}
            className="h-[48px] min-w-[150px] flex-row items-center justify-center rounded-full bg-white px-6 active:opacity-80"
          >
            {adding ? (
              <ActivityIndicator color="#000000" />
            ) : (
              <Text className="text-[17px] font-t3-bold text-black">
                {selected.length === 1
                  ? gt("Add 1 photo")
                  : gt("Add {count} photos", { count: selected.length })}
              </Text>
            )}
          </Pressable>
        ) : (
          <Pressable
            accessibilityRole="button"
            onPress={props.onOpenLibrary}
            className="h-[48px] items-center justify-center overflow-hidden rounded-full bg-black/45 px-6 active:opacity-70"
          >
            {Platform.OS === "ios" ? (
              <BlurView intensity={40} tint="dark" style={StyleSheet.absoluteFill} />
            ) : null}
            <Text className="text-[17px] font-t3-bold text-white">{gt("All Photos")}</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

interface PhotoPage {
  readonly assets: ReadonlyArray<Asset>;
  readonly endCursor: string | undefined;
  readonly hasNextPage: boolean;
}

async function loadPhotoPage(previous: PhotoPage | null): Promise<PhotoPage> {
  const result = await getAssetsAsync({
    first: PAGE_SIZE,
    after: previous?.endCursor,
    mediaType: "photo",
    sortBy: [["creationTime", false]],
  }).catch(() => null);
  return {
    assets: [...(previous?.assets ?? []), ...(result?.assets ?? [])],
    endCursor: result?.endCursor,
    hasNextPage: result?.hasNextPage ?? false,
  };
}

async function resolvePhoto(asset: Asset): Promise<ComposerMediaAsset | null> {
  const info = await getAssetInfoAsync(asset, { shouldDownloadFromNetwork: true }).catch(
    () => null,
  );
  const uri = info?.localUri ?? (Platform.OS === "android" ? asset.uri : undefined);
  return uri
    ? { uri, type: "image", fileName: asset.filename, mimeType: photoMimeType(asset) }
    : null;
}

function photoMimeType(asset: Asset): string | undefined {
  const extension = asset.filename.split(".").pop()?.toLowerCase();
  switch (extension) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    default:
      // HEIC and friends are re-rendered to JPEG by the attachment pipeline.
      return undefined;
  }
}
