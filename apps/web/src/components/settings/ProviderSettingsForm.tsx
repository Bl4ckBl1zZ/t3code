import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
("use client");

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { PlusIcon, XIcon } from "lucide-react";

import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { DraftInput } from "../ui/draft-input";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import type { ProviderClientDefinition } from "./providerDriverMeta";

export {
  deriveProviderSettingsFields,
  isLocalAcpConfig,
  readProviderConfigString,
  readProviderConfigBoolean,
  nextProviderConfigWithFieldValue,
} from "./providerSettingsFields";
import {
  deriveProviderSettingsFields,
  isLocalAcpConfig,
  readProviderConfigString,
  readProviderConfigBoolean,
  nextProviderConfigWithFieldValue,
  type ProviderSettingsFieldModel,
} from "./providerSettingsFields";
export type { ProviderSettingsFieldModel } from "./providerSettingsFields";

interface ProviderSettingsFormProps {
  readonly definition: ProviderClientDefinition;
  readonly value: unknown;
  readonly idPrefix: string;
  readonly variant: "card" | "dialog";
  readonly onChange: (nextConfig: Record<string, unknown> | undefined) => void;
}

/** Stores the default choice as an omitted key so unchanged configs stay small. */
function ProviderSettingsSelect({
  field,
  value,
  inputId,
  size,
  className,
  onChange,
}: {
  readonly field: ProviderSettingsFieldModel;
  readonly value: unknown;
  readonly inputId: string;
  readonly size: "sm" | "xs";
  readonly className?: string | undefined;
  readonly onChange: ProviderSettingsFormProps["onChange"];
}) {
  const options = field.options ?? [];
  const fallback = options[0]?.value ?? "";
  const current = readProviderConfigString(value, field.key) || fallback;
  const label = options.find((option) => option.value === current)?.label ?? current;
  return (
    <Select
      value={current}
      onValueChange={(next) => {
        if (typeof next !== "string") return;
        onChange(nextProviderConfigWithFieldValue(value, field, next === fallback ? "" : next));
      }}
    >
      <SelectTrigger id={inputId} size={size} className={className} aria-label={field.label}>
        <SelectValue>{label}</SelectValue>
      </SelectTrigger>
      <SelectPopup align="start" alignItemWithTrigger={false}>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

function FieldFrame(props: {
  readonly variant: ProviderSettingsFormProps["variant"];
  readonly children: ReactNode;
}) {
  if (props.variant === "card") {
    return <div>{props.children}</div>;
  }
  return <div className="grid gap-1.5">{props.children}</div>;
}

interface ProviderSettingsFieldRowProps {
  readonly field: ProviderSettingsFieldModel;
  readonly value: unknown;
  readonly idPrefix: string;
  readonly variant: ProviderSettingsFormProps["variant"];
  readonly onChange: ProviderSettingsFormProps["onChange"];
}

function ProviderSettingsFieldRow({
  field,
  value,
  idPrefix,
  variant,
  onChange,
}: ProviderSettingsFieldRowProps) {
  const inputId = `${idPrefix}-${field.key}`;
  const descriptionClassName =
    variant === "card"
      ? "mt-1 block text-xs text-muted-foreground"
      : "text-2xs text-muted-foreground";
  const label = <span className="text-xs font-medium text-foreground">{field.label}</span>;
  const description = field.description ? (
    <span className={descriptionClassName}>{field.description}</span>
  ) : null;

  if (field.control === "switch") {
    return (
      <FieldFrame variant={variant}>
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            {label}
            {description}
          </div>
          <Switch
            checked={readProviderConfigBoolean(value, field.key, field.defaultBooleanValue)}
            onCheckedChange={(checked) =>
              onChange(nextProviderConfigWithFieldValue(value, field, Boolean(checked)))
            }
            aria-label={field.label}
          />
        </div>
      </FieldFrame>
    );
  }

  if (field.control === "select") {
    return (
      <FieldFrame variant={variant}>
        <label htmlFor={inputId} className={cn(variant === "card" && "block")}>
          {label}
          <ProviderSettingsSelect
            field={field}
            value={value}
            inputId={inputId}
            size="sm"
            className={cn("w-full", variant === "card" && "mt-1.5")}
            onChange={onChange}
          />
          {description}
        </label>
      </FieldFrame>
    );
  }

  if (field.control === "textarea") {
    return (
      <FieldFrame variant={variant}>
        <label htmlFor={inputId} className={cn(variant === "card" && "block")}>
          {label}
          <Textarea
            id={inputId}
            className={cn(variant === "card" && "mt-1.5")}
            value={readProviderConfigString(value, field.key)}
            onChange={(event) =>
              onChange(nextProviderConfigWithFieldValue(value, field, event.target.value))
            }
            placeholder={field.placeholder}
            spellCheck={false}
          />
          {description}
        </label>
      </FieldFrame>
    );
  }

  const type = field.control === "password" ? "password" : undefined;
  return (
    <FieldFrame variant={variant}>
      <label htmlFor={inputId} className={cn(variant === "card" && "block")}>
        {label}
        {variant === "card" ? (
          <DraftInput
            id={inputId}
            className="mt-1.5"
            type={type}
            autoComplete={field.control === "password" ? "off" : undefined}
            value={readProviderConfigString(value, field.key)}
            onCommit={(next) => onChange(nextProviderConfigWithFieldValue(value, field, next))}
            placeholder={field.placeholder}
            spellCheck={false}
          />
        ) : (
          <Input
            id={inputId}
            type={type}
            autoComplete={field.control === "password" ? "off" : undefined}
            value={readProviderConfigString(value, field.key)}
            onChange={(event) =>
              onChange(nextProviderConfigWithFieldValue(value, field, event.target.value))
            }
            placeholder={field.placeholder}
            spellCheck={false}
          />
        )}
        {description}
      </label>
    </FieldFrame>
  );
}

let commandArgumentDraftId = 0;
const makeCommandArgumentDraftRow = (value: string) => ({
  id: `provider-argument-${commandArgumentDraftId++}`,
  value,
});

function commandArgumentsEqual(left: ReadonlyArray<string>, right: ReadonlyArray<string>) {
  return left.length === right.length && left.every((argument, index) => argument === right[index]);
}

/** Literal launch arguments for a local ACP command, one per row and never shell-expanded. */
function ProviderCommandArguments({
  value,
  idPrefix,
  variant,
  onChange,
}: Omit<ProviderSettingsFormProps, "definition">) {
  const args = useMemo(() => {
    const configured =
      value !== null && typeof value === "object"
        ? (value as Record<string, unknown>).commandArgs
        : undefined;
    return Array.isArray(configured)
      ? configured.filter((argument): argument is string => typeof argument === "string")
      : [];
  }, [value]);
  const [rows, setRows] = useState(() => args.map(makeCommandArgumentDraftRow));
  const rowsRef = useRef(rows);
  const previousArgsRef = useRef(args);
  const lastPublishedArgsRef = useRef<ReadonlyArray<string> | undefined>(undefined);

  // Rebuild rows only when the arguments change from outside this editor.
  useEffect(() => {
    const previousArgs = previousArgsRef.current;
    const lastPublishedArgs = lastPublishedArgsRef.current;
    previousArgsRef.current = args;
    lastPublishedArgsRef.current = undefined;
    if (
      commandArgumentsEqual(previousArgs, args) ||
      (lastPublishedArgs !== undefined && commandArgumentsEqual(lastPublishedArgs, args))
    ) {
      return;
    }
    const nextRows = args.map(makeCommandArgumentDraftRow);
    rowsRef.current = nextRows;
    setRows(nextRows);
  }, [args]);

  const updateArguments = (nextRows: typeof rows) => {
    rowsRef.current = nextRows;
    setRows(nextRows);
    const next = nextRows.map((row) => row.value);
    lastPublishedArgsRef.current = next;
    const config =
      value !== null && typeof value === "object" ? { ...(value as Record<string, unknown>) } : {};
    onChange({ ...config, commandArgs: next });
  };

  return (
    <FieldFrame variant={variant}>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <span className="text-xs font-medium text-foreground">Arguments</span>
          <span
            className={
              variant === "card"
                ? "mt-1 block text-xs text-muted-foreground"
                : "block text-2xs text-muted-foreground"
            }
          >
            One literal argument per row, in launch order.
          </span>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-7 gap-1.5 px-2 text-xs"
          onClick={() => updateArguments([...rowsRef.current, makeCommandArgumentDraftRow("")])}
        >
          <PlusIcon className="size-3" />
          Add
        </Button>
      </div>
      {rows.length > 0 ? (
        <div className="mt-2 grid min-w-0 gap-1.5">
          {rows.map((argument, index) => (
            <div key={argument.id} className="flex min-w-0 items-center gap-1.5">
              <DraftInput
                id={`${idPrefix}-commandArgs-${index}`}
                value={argument.value}
                onCommit={(next) =>
                  updateArguments(
                    rowsRef.current.map((current) =>
                      current.id === argument.id ? { ...current, value: next } : current,
                    ),
                  )
                }
                aria-label={`Argument ${index + 1}`}
                spellCheck={false}
              />
              <Button
                type="button"
                size="icon-micro"
                variant="ghost-destructive"
                onClick={() =>
                  updateArguments(rowsRef.current.filter((current) => current.id !== argument.id))
                }
                aria-label={`Remove argument ${index + 1}`}
              >
                <XIcon />
              </Button>
            </div>
          ))}
        </div>
      ) : null}
    </FieldFrame>
  );
}

export function ProviderSettingsForm({
  definition,
  value,
  idPrefix,
  variant,
  onChange,
}: ProviderSettingsFormProps) {
  const fields = useMemo(
    () => deriveProviderSettingsFields(definition, value),
    [definition, value],
  );
  const isLocalAcp = isLocalAcpConfig(definition, value);

  if (fields.length === 0) {
    return null;
  }

  return (
    <>
      {fields.map((field) => (
        <ProviderSettingsFieldRow
          key={field.key}
          field={field}
          value={value}
          idPrefix={idPrefix}
          variant={variant}
          onChange={onChange}
        />
      ))}
      {isLocalAcp ? (
        <ProviderCommandArguments
          value={value}
          idPrefix={idPrefix}
          variant={variant}
          onChange={onChange}
        />
      ) : null}
    </>
  );
}
