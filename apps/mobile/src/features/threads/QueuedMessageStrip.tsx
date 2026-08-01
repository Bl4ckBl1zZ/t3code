import { memo, useCallback, useEffect, useRef, useState, type ComponentProps } from "react";
import { ActivityIndicator, Pressable, View } from "react-native";
import Animated, { FadeIn, FadeOut, LinearTransition } from "react-native-reanimated";

import { AppText as Text, AppTextInput } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { useThemeColor } from "../../lib/useThemeColor";
import type { QueuedThreadMessage } from "../../state/thread-outbox";

export interface QueuedMessageStripProps {
  readonly messages: ReadonlyArray<QueuedThreadMessage>;
  readonly dispatchingMessageId: string | null;
  readonly onDelete: (message: QueuedThreadMessage) => void;
  readonly onMove: (message: QueuedThreadMessage, direction: "up" | "down") => void;
  readonly onSaveText: (message: QueuedThreadMessage, text: string) => void;
  readonly onEditingChange: (message: QueuedThreadMessage, editing: boolean) => void;
}

/** Collapse a queued message to a single presentable line. */
export function queuedMessagePreview(message: QueuedThreadMessage): string {
  const firstLine =
    message.text
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? "";
  if (firstLine.length > 0) {
    return firstLine;
  }
  if (message.attachments.length > 0) {
    return message.attachments.length === 1 ? "1 image" : `${message.attachments.length} images`;
  }
  return "Queued message";
}

const ROW_LAYOUT_TRANSITION = LinearTransition.duration(180);

function RowIconButton(props: {
  readonly icon: ComponentProps<typeof SymbolView>["name"];
  readonly accessibilityLabel: string;
  readonly disabled?: boolean;
  readonly danger?: boolean;
  readonly onPress: () => void;
}) {
  const iconColor = useThemeColor("--color-icon-subtle");
  const dangerColor = useThemeColor("--color-danger");
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel}
      disabled={props.disabled}
      hitSlop={6}
      className="size-7 items-center justify-center rounded-full active:bg-subtle"
      style={props.disabled ? { opacity: 0.3 } : undefined}
      onPress={props.onPress}
    >
      <SymbolView
        name={props.icon}
        size={13}
        tintColor={props.danger ? dangerColor : iconColor}
        type="monochrome"
      />
    </Pressable>
  );
}

const QueuedMessageRow = memo(function QueuedMessageRow(props: {
  readonly message: QueuedThreadMessage;
  readonly index: number;
  readonly count: number;
  readonly isDispatching: boolean;
  readonly onDelete: QueuedMessageStripProps["onDelete"];
  readonly onMove: QueuedMessageStripProps["onMove"];
  readonly onSaveText: QueuedMessageStripProps["onSaveText"];
  readonly onEditingChange: QueuedMessageStripProps["onEditingChange"];
}) {
  const { message, isDispatching, onEditingChange, onDelete, onSaveText } = props;
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(message.text);
  const iconSubtle = useThemeColor("--color-icon-subtle");
  const editingRef = useRef(false);

  // A row that starts dispatching under an open editor loses the edit
  // session: the payload it was editing is already on its way out.
  useEffect(() => {
    if (isDispatching && isEditing) {
      setIsEditing(false);
      editingRef.current = false;
      onEditingChange(message, false);
    }
  }, [isDispatching, isEditing, message, onEditingChange]);

  useEffect(() => {
    return () => {
      if (editingRef.current) {
        onEditingChange(message, false);
      }
    };
    // Release the editing hold only on unmount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const beginEdit = useCallback(() => {
    setEditValue(message.text);
    setIsEditing(true);
    editingRef.current = true;
    onEditingChange(message, true);
  }, [message, onEditingChange]);

  const cancelEdit = useCallback(() => {
    setIsEditing(false);
    editingRef.current = false;
    onEditingChange(message, false);
  }, [message, onEditingChange]);

  const saveEdit = useCallback(() => {
    const trimmed = editValue.trim();
    // Emptying a text-only message means deleting it; with attachments the
    // images still make it a sendable payload.
    if (trimmed.length === 0 && message.attachments.length === 0) {
      onDelete(message);
    } else {
      onSaveText(message, editValue);
    }
    setIsEditing(false);
    editingRef.current = false;
    onEditingChange(message, false);
  }, [editValue, message, onDelete, onEditingChange, onSaveText]);

  return (
    <Animated.View
      layout={ROW_LAYOUT_TRANSITION}
      entering={FadeIn.duration(160)}
      exiting={FadeOut.duration(120)}
      className="flex-row items-center gap-2 rounded-2xl border border-border/60 bg-subtle/60 px-3 py-1.5"
    >
      <View className="size-5 items-center justify-center">
        {isDispatching ? (
          <ActivityIndicator size="small" accessibilityLabel="Sending queued message" />
        ) : (
          <SymbolView name="clock" size={12} tintColor={iconSubtle} type="monochrome" />
        )}
      </View>

      {isEditing ? (
        <>
          <AppTextInput
            value={editValue}
            multiline
            autoFocus
            accessibilityLabel="Edit queued message"
            className="min-h-9 flex-1 rounded-lg bg-background px-2 py-1.5 text-sm text-foreground"
            onChangeText={setEditValue}
          />
          <RowIconButton
            icon="checkmark"
            accessibilityLabel="Save queued message"
            onPress={saveEdit}
          />
          <RowIconButton icon="xmark" accessibilityLabel="Cancel editing" onPress={cancelEdit} />
        </>
      ) : (
        <>
          <View className="min-w-0 flex-1">
            <Text numberOfLines={1} className="text-sm text-foreground/85">
              {queuedMessagePreview(message)}
            </Text>
          </View>
          <View className="flex-row items-center">
            <RowIconButton
              icon="chevron.up"
              accessibilityLabel="Move queued message up"
              disabled={isDispatching || props.index === 0}
              onPress={() => props.onMove(message, "up")}
            />
            <RowIconButton
              icon="chevron.down"
              accessibilityLabel="Move queued message down"
              disabled={isDispatching || props.index === props.count - 1}
              onPress={() => props.onMove(message, "down")}
            />
            <RowIconButton
              icon="pencil"
              accessibilityLabel="Edit queued message"
              disabled={isDispatching}
              onPress={beginEdit}
            />
            <RowIconButton
              icon="trash"
              accessibilityLabel="Delete queued message"
              disabled={isDispatching}
              danger
              onPress={() => onDelete(message)}
            />
          </View>
        </>
      )}
    </Animated.View>
  );
});

/**
 * Pre-measure estimate of the strip's height so the feed's initial bottom inset
 * accounts for it before onComposerLayout reports the real overlay height —
 * otherwise content sits under the strip and jumps once measurement lands.
 * Header line (~16) + per-row height (~36) + gaps (6) + bottom padding (8).
 */
export function estimatedQueuedMessageStripHeight(messageCount: number): number {
  if (messageCount === 0) return 0;
  return 16 + messageCount * 42 + 8;
}

/**
 * Queued messages waiting for the running turn (or reconnect) to finish,
 * rendered above the composer. Rows send top-to-bottom and stay editable,
 * deletable, and reorderable until the moment they dispatch.
 */
export const QueuedMessageStrip = memo(function QueuedMessageStrip(props: QueuedMessageStripProps) {
  if (props.messages.length === 0) {
    return null;
  }

  return (
    <Animated.View
      layout={ROW_LAYOUT_TRANSITION}
      entering={FadeIn.duration(180)}
      exiting={FadeOut.duration(120)}
      className="gap-1.5 pb-2"
    >
      <Text className="px-1 text-xs text-foreground-muted">
        {props.messages.length} queued — sends when the agent finishes
      </Text>
      {props.messages.map((message, index) => (
        <QueuedMessageRow
          key={message.messageId}
          message={message}
          index={index}
          count={props.messages.length}
          isDispatching={props.dispatchingMessageId === message.messageId}
          onDelete={props.onDelete}
          onMove={props.onMove}
          onSaveText={props.onSaveText}
          onEditingChange={props.onEditingChange}
        />
      ))}
    </Animated.View>
  );
});
