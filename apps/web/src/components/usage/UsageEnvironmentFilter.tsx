import { USAGE_CONTRACT_VERSION, type EnvironmentId } from "@t3tools/contracts";
import { isCompatibleUsageContractVersion } from "@t3tools/shared/usageMerge";
import {
  CircleAlertIcon,
  ChevronDownIcon,
  CircleDashedIcon,
  SlidersHorizontalIcon,
} from "lucide-react";
import { useState } from "react";
import { cn } from "../../lib/utils";
import type { EnvironmentUsageStatus } from "../../state/usage";
import {
  Menu,
  MenuCheckboxItem,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { UsagePriceOverrides } from "./UsagePriceOverrides";

function UsageCoverageNotice({
  environments,
  duplicateSources,
  staleEnvironments,
}: {
  readonly environments: readonly EnvironmentUsageStatus[];
  readonly duplicateSources: readonly string[];
  readonly staleEnvironments: readonly string[];
}) {
  const failed = environments.filter((environment) => environment.error !== null);
  const stale = environments.filter((environment) =>
    staleEnvironments.includes(environment.environmentId),
  );
  if (failed.length === 0 && stale.length === 0 && duplicateSources.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-col gap-1 border-t border-border px-2 py-2 text-xs text-muted-foreground">
      {failed.map((environment) => (
        <span key={environment.label}>{environment.label} could not report usage.</span>
      ))}
      {stale.map((environment) => (
        <span key={environment.label}>
          {environment.label} runs an older server version and is excluded from totals.
        </span>
      ))}
      {duplicateSources.length > 0 ? (
        <span>
          Counted once across environments sharing a transcript directory:{" "}
          {duplicateSources.join(", ")}
        </span>
      ) : null}
    </div>
  );
}

/** Environment selection and scan progress share a permanent header control. */
export function UsageEnvironmentFilter({
  environments,
  selectedEnvironments,
  selectedEnvironmentIds,
  onSelectionChange,
  showUsageStatus,
  isPartial,
  duplicateSources,
  staleEnvironments,
}: {
  readonly environments: readonly EnvironmentUsageStatus[];
  readonly selectedEnvironments: readonly EnvironmentUsageStatus[];
  readonly selectedEnvironmentIds: ReadonlySet<EnvironmentId> | null;
  readonly onSelectionChange: (ids: ReadonlySet<EnvironmentId> | null) => void;
  readonly showUsageStatus: boolean;
  readonly isPartial: boolean;
  readonly duplicateSources: readonly string[];
  readonly staleEnvironments: readonly string[];
}) {
  const [modelPricesOpen, setModelPricesOpen] = useState(false);
  const allSelected = selectedEnvironmentIds === null;
  const label = allSelected
    ? "All environments"
    : selectedEnvironments.length === 1
      ? selectedEnvironments[0]!.label
      : `${selectedEnvironments.length} environments`;
  const pendingCount = selectedEnvironments.filter(
    (environment) =>
      environment.error === null && (environment.isPending || environment.summary === null),
  ).length;
  const hasIssue =
    selectedEnvironments.some((environment) => environment.error !== null) ||
    staleEnvironments.length > 0;

  return (
    <>
      <Menu>
        <MenuTrigger className="group/usage-environment inline-flex min-w-0 max-w-full cursor-pointer items-center gap-1 rounded-sm text-left focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring">
          <span className="min-w-0 truncate">{label}</span>
          <span className="flex size-3.5 shrink-0 items-center justify-center text-muted-foreground">
            {showUsageStatus && pendingCount > 0 ? (
              <>
                <CircleDashedIcon className="size-3.5" aria-hidden />
                <span className="sr-only">
                  {pendingCount} {pendingCount === 1 ? "environment" : "environments"} still
                  scanning
                  {isPartial ? "; totals are partial" : ""}
                </span>
              </>
            ) : showUsageStatus && hasIssue ? (
              <CircleAlertIcon
                className="size-3.5 text-amber-600 dark:text-amber-400"
                aria-label="Some environments could not report usage"
              />
            ) : (
              <ChevronDownIcon
                className="size-3.5 opacity-0 transition-opacity group-hover/usage-environment:opacity-100 group-focus-visible/usage-environment:opacity-100 group-data-popup-open/usage-environment:opacity-100"
                aria-hidden
              />
            )}
          </span>
        </MenuTrigger>
        <MenuPopup align="start" className="w-80 max-w-[calc(100vw-2rem)]">
          <MenuCheckboxItem
            checked={allSelected}
            closeOnClick={false}
            onCheckedChange={(checked) => onSelectionChange(checked ? null : new Set())}
          >
            All environments
          </MenuCheckboxItem>
          <MenuSeparator />
          {environments.map((environment) => {
            const checked =
              selectedEnvironmentIds === null ||
              selectedEnvironmentIds.has(environment.environmentId);
            const status =
              environment.error !== null
                ? "Unavailable"
                : environment.summary !== null &&
                    !isCompatibleUsageContractVersion(
                      environment.summary.contractVersion,
                      USAGE_CONTRACT_VERSION,
                    )
                  ? "Update required"
                  : environment.summary === null
                    ? "Scanning…"
                    : environment.isPending
                      ? "Refreshing…"
                      : "Ready";
            return (
              <MenuCheckboxItem
                key={environment.environmentId}
                checked={checked}
                closeOnClick={false}
                className="grid-cols-[1rem_minmax(0,1fr)]"
                onCheckedChange={(nextChecked) => {
                  const next = new Set(selectedEnvironments.map((entry) => entry.environmentId));
                  if (nextChecked) next.add(environment.environmentId);
                  else next.delete(environment.environmentId);
                  onSelectionChange(next.size === environments.length ? null : next);
                }}
              >
                <span className="flex min-w-0 items-center gap-3">
                  <span className="min-w-0 flex-1 truncate">{environment.label}</span>
                  {showUsageStatus ? (
                    <span
                      className={cn(
                        "shrink-0 text-xs text-muted-foreground",
                        environment.error !== null && "text-destructive",
                      )}
                    >
                      {status}
                    </span>
                  ) : null}
                </span>
              </MenuCheckboxItem>
            );
          })}
          {environments.length === 0 ? (
            <p className="px-2 py-2 text-xs text-muted-foreground">No environments connected.</p>
          ) : null}
          {showUsageStatus && isPartial ? (
            <p className="px-2 py-2 text-xs text-muted-foreground">
              Totals are partial while selected environments scan.
            </p>
          ) : null}
          {showUsageStatus ? (
            <UsageCoverageNotice
              environments={selectedEnvironments}
              duplicateSources={duplicateSources}
              staleEnvironments={staleEnvironments}
            />
          ) : null}
          <MenuSeparator />
          <MenuItem onClick={() => setModelPricesOpen(true)}>
            <SlidersHorizontalIcon aria-hidden />
            Model prices
          </MenuItem>
        </MenuPopup>
      </Menu>
      {modelPricesOpen ? (
        <UsagePriceOverrides
          usage={environments}
          initialSelectedEnvironmentIds={selectedEnvironmentIds}
          onOpenChange={setModelPricesOpen}
        />
      ) : null}
    </>
  );
}
