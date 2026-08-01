import type { ApprovalRequestId } from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { cn } from "../../lib/cn";
import { useThemeColor } from "../../lib/useThemeColor";
import type { PendingUserInput, PendingUserInputDraftAnswer } from "../../lib/threadActivity";

// Mirrors the desktop panel: selecting a single-select option pauses briefly
// so the selection is visible, then advances to the next question.
const AUTO_ADVANCE_DELAY_MS = 200;

export interface PendingUserInputCardProps {
  readonly pendingUserInput: PendingUserInput;
  readonly drafts: Record<string, PendingUserInputDraftAnswer>;
  readonly answers: Record<string, string> | null;
  readonly respondingUserInputId: ApprovalRequestId | null;
  readonly onSelectOption: (
    requestId: ApprovalRequestId,
    questionId: string,
    label: string,
  ) => void;
  readonly onChangeCustomAnswer: (
    requestId: ApprovalRequestId,
    questionId: string,
    customAnswer: string,
  ) => void;
  readonly onSubmit: () => Promise<unknown>;
}

export function PendingUserInputCard(props: PendingUserInputCardProps) {
  const questions = props.pendingUserInput.questions;
  const [rawQuestionIndex, setRawQuestionIndex] = useState(0);
  const autoAdvanceTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const iconSubtleColor = useThemeColor("--color-icon-subtle");

  useEffect(() => {
    return () => {
      if (autoAdvanceTimeoutRef.current) {
        clearTimeout(autoAdvanceTimeoutRef.current);
      }
    };
  }, []);

  const questionIndex = Math.min(rawQuestionIndex, Math.max(0, questions.length - 1));
  const question = questions[questionIndex];
  if (!question) {
    return null;
  }

  const draft = props.drafts[question.id];
  const isLastQuestion = questionIndex === questions.length - 1;
  const responding = props.respondingUserInputId === props.pendingUserInput.requestId;
  const currentAnswered = Boolean(draft?.customAnswer?.trim().length || draft?.selectedOptionLabel);
  const primaryEnabled = isLastQuestion ? props.answers !== null && !responding : currentAnswered;

  const goToQuestion = (index: number) => {
    if (autoAdvanceTimeoutRef.current) {
      clearTimeout(autoAdvanceTimeoutRef.current);
      autoAdvanceTimeoutRef.current = null;
    }
    setRawQuestionIndex(Math.max(0, Math.min(index, questions.length - 1)));
  };

  const handleSelectOption = (label: string) => {
    props.onSelectOption(props.pendingUserInput.requestId, question.id, label);
    // Auto-advance keeps single-select flows one tap per question; the last
    // question never auto-submits — that stays an explicit tap.
    if (!question.multiSelect && !isLastQuestion) {
      if (autoAdvanceTimeoutRef.current) {
        clearTimeout(autoAdvanceTimeoutRef.current);
      }
      autoAdvanceTimeoutRef.current = setTimeout(() => {
        autoAdvanceTimeoutRef.current = null;
        setRawQuestionIndex((current) => Math.min(current + 1, questions.length - 1));
      }, AUTO_ADVANCE_DELAY_MS);
    }
  };

  return (
    <View className="gap-2.5 rounded-[20px] border border-neutral-200 bg-neutral-100/80 p-4 dark:border-white/6 dark:bg-neutral-900/80">
      <Text className="font-t3-bold text-2xs uppercase tracking-[1.1px] text-sky-700 dark:text-sky-300">
        User input needed
      </Text>
      <Text className="font-t3-bold text-lg text-neutral-950 dark:text-neutral-50">
        Fill in the pending answers
      </Text>
      <View key={question.id} className="gap-2 pt-1">
        <View className="flex-row items-center justify-between">
          <Text className="font-t3-bold text-xs uppercase tracking-[1px] text-neutral-500 dark:text-neutral-500">
            {question.header}
          </Text>
          {questions.length > 1 ? (
            <Text className="font-t3-medium text-xs tabular-nums text-neutral-500 dark:text-neutral-500">
              {questionIndex + 1}/{questions.length}
            </Text>
          ) : null}
        </View>
        <Text className="font-sans text-base leading-snug text-neutral-950 dark:text-neutral-50">
          {question.question}
        </Text>
        <View className="flex-row flex-wrap gap-2.5">
          {question.options.map((option) => {
            const selected =
              draft?.selectedOptionLabel === option.label && !draft.customAnswer?.trim().length;
            return (
              <Pressable
                key={option.label}
                className={cn(
                  "rounded-full border px-3 py-2.5 ",
                  selected
                    ? "border-blue-300/50 bg-blue-50 dark:border-blue-400/28 dark:bg-blue-400/14"
                    : "border-neutral-200 bg-white dark:border-white/6 dark:bg-neutral-950/70",
                )}
                onPress={() => handleSelectOption(option.label)}
              >
                <Text
                  className={cn(
                    "font-t3-bold text-sm",
                    selected
                      ? "text-sky-700 dark:text-sky-300"
                      : "text-neutral-600 dark:text-neutral-300",
                  )}
                >
                  {option.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
        <TextInput
          value={draft?.customAnswer ?? ""}
          onChangeText={(value) =>
            props.onChangeCustomAnswer(props.pendingUserInput.requestId, question.id, value)
          }
          placeholder="Or type a custom answer"
          className="min-h-[54px] rounded-2xl border border-neutral-200 bg-white px-3.5 py-3 font-sans text-base text-neutral-950 dark:border-white/8 dark:bg-neutral-950/70 dark:text-neutral-50"
        />
      </View>
      <View className="flex-row gap-2.5">
        {questionIndex > 0 ? (
          <Pressable
            accessibilityLabel="Previous question"
            className="items-center justify-center rounded-2xl bg-neutral-200 px-4 py-3.5 dark:bg-neutral-800"
            onPress={() => goToQuestion(questionIndex - 1)}
          >
            <SymbolView name="chevron.left" size={16} tintColor={iconSubtleColor} />
          </Pressable>
        ) : null}
        <Pressable
          className={cn(
            "flex-1 items-center justify-center rounded-2xl px-4 py-3.5",
            primaryEnabled ? "bg-blue-500" : "bg-neutral-200 dark:bg-neutral-700/60",
          )}
          disabled={!primaryEnabled}
          onPress={() => {
            if (isLastQuestion) {
              void props.onSubmit();
              return;
            }
            goToQuestion(questionIndex + 1);
          }}
        >
          <Text className="font-t3-extrabold text-sm text-white">
            {responding
              ? "Submitting…"
              : isLastQuestion
                ? questions.length > 1
                  ? "Submit answers"
                  : "Submit answer"
                : "Next question"}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}
