import type { UsageProviderKind } from "@t3tools/contracts";
import { ChevronDownIcon } from "lucide-react";

import { InlineButton } from "../ui/button";
import { Menu, MenuCheckboxItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { PROVIDER_ORDER, PROVIDER_PRESENTATION } from "./usageProviders";

/** Provider visibility shared by the history and limits views. Stored as the hidden set. */
export function UsageProviderFilter({
  hiddenProviders,
  onChange,
}: {
  readonly hiddenProviders: ReadonlySet<UsageProviderKind>;
  readonly onChange: (hiddenProviders: readonly UsageProviderKind[]) => void;
}) {
  const visible = PROVIDER_ORDER.filter((provider) => !hiddenProviders.has(provider));
  const label =
    visible.length === PROVIDER_ORDER.length
      ? "All providers"
      : visible.length === 0
        ? "No providers"
        : visible.length === 1
          ? PROVIDER_PRESENTATION[visible[0]!].label
          : `${visible.length} providers`;

  return (
    <Menu>
      <MenuTrigger
        render={<InlineButton />}
        className="group/usage-provider min-w-0 max-w-full gap-1"
      >
        <span className="min-w-0 truncate">{label}</span>
        <ChevronDownIcon
          className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/usage-provider:opacity-100 group-focus-visible/usage-provider:opacity-100 group-data-popup-open/usage-provider:opacity-100"
          aria-hidden
        />
      </MenuTrigger>
      <MenuPopup align="start">
        <MenuCheckboxItem
          checked={hiddenProviders.size === 0}
          closeOnClick={false}
          onCheckedChange={(checked) => onChange(checked ? [] : PROVIDER_ORDER)}
        >
          All providers
        </MenuCheckboxItem>
        <MenuSeparator />
        {PROVIDER_ORDER.map((provider) => {
          const Mark = PROVIDER_PRESENTATION[provider].mark;
          return (
            <MenuCheckboxItem
              key={provider}
              checked={!hiddenProviders.has(provider)}
              closeOnClick={false}
              onCheckedChange={(checked) =>
                onChange(
                  PROVIDER_ORDER.filter((entry) =>
                    entry === provider ? !checked : hiddenProviders.has(entry),
                  ),
                )
              }
            >
              <span className="flex min-w-0 items-center gap-2">
                <Mark className="size-3.5 shrink-0" aria-hidden />
                <span className="truncate">{PROVIDER_PRESENTATION[provider].label}</span>
              </span>
            </MenuCheckboxItem>
          );
        })}
      </MenuPopup>
    </Menu>
  );
}
