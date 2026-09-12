import {
  BrowserImportFailureReason,
  BROWSER_PROFILE_MAX_COUNT,
  BROWSER_PROFILE_NAME_MAX_LENGTH,
  DEFAULT_BROWSER_PROFILE_ID,
  findBrowserProfile,
  isBuiltInBrowserProfileId,
  resolveBrowserProfiles,
  type BrowserProfile,
  type EnvironmentId,
  type BrowserImportSource,
} from "@t3tools/contracts";
import { MoreVertical, Plus as PlusIcon } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { resolveEnvironmentOptionLabel } from "~/components/BranchToolbar.logic";
import { previewBridge } from "~/components/preview/previewBridge";
import { cn, randomUUID } from "~/lib/utils";
import { useEnvironments, usePrimaryEnvironment } from "~/state/environments";
import { Badge } from "../ui/badge";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { toastManager } from "../ui/toast";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { DraftInput } from "../ui/draft-input";
import {
  getClientSettings,
  persistClientSettingsUpdate,
  useClientSettings,
  useClientSettingsHydrated,
  useUpdatePrimarySettings,
} from "~/hooks/useSettings";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { BrowserImportWizard, type WizardTarget } from "./BrowserImportWizard";
import type { ImportOutcome } from "./browserImportWizard.logic";

type BrowserProfileDataBridge = Pick<
  NonNullable<typeof previewBridge>,
  "clearCookies" | "clearCache"
>;

export async function clearBrowserProfileData(
  bridge: BrowserProfileDataBridge | null,
  environmentIds: ReadonlyArray<EnvironmentId>,
  profileId: string,
): Promise<void> {
  if (bridge === null || environmentIds.length === 0) {
    throw new Error("Browser profile data is not available to clear.");
  }
  await Promise.all(
    environmentIds.flatMap((environmentId) => [
      bridge.clearCookies(environmentId, profileId),
      bridge.clearCache(environmentId, profileId),
    ]),
  );
}

export function browserProfileRemovalAvailable(
  bridgeAvailable: boolean,
  environmentsReady: boolean,
  environmentCount: number,
): boolean {
  return bridgeAvailable && environmentsReady && environmentCount > 0;
}

class ProfileLimitReachedError extends Error {
  constructor() {
    super("Browser profile limit reached.");
    this.name = "ProfileLimitReachedError";
  }
}

export const importFailureReason = (cause: unknown): BrowserImportFailureReason => {
  const message = String((cause as { message?: unknown } | undefined)?.message ?? "");
  return (
    BrowserImportFailureReason.literals.find((reason) => message.includes(`failed: ${reason}.`)) ??
    "readFailed"
  );
};

export function BrowserProfilesSetting({ disabled }: { readonly disabled: boolean }) {
  const userProfiles = useClientSettings((settings) => settings.browserProfiles);
  const defaultProfileId = useClientSettings((settings) => settings.browserDefaultProfileId);
  const settingsHydrated = useClientSettingsHydrated();
  const updateSettings = useUpdatePrimarySettings();
  const { environments, isReady: environmentsReady } = useEnvironments();
  const primaryEnvironment = usePrimaryEnvironment();
  const [sources, setSources] = useState<ReadonlyArray<BrowserImportSource> | null>(null);
  const [importSession, setImportSession] = useState<{
    readonly source: BrowserImportSource;
    readonly environmentId: EnvironmentId;
    readonly environmentName: string;
  } | null>(null);
  const [profilePendingRemoval, setProfilePendingRemoval] = useState<BrowserProfile | null>(null);
  const [profileRemovalError, setProfileRemovalError] = useState<string | null>(null);
  const [profileRemovalInFlight, setProfileRemovalInFlight] = useState(false);
  const removalAvailable = browserProfileRemovalAvailable(
    previewBridge !== null,
    environmentsReady,
    environments.length,
  );
  const importInFlightRef = useRef(false);
  const [importInFlight, setImportInFlight] = useState(false);
  const profileWritesDisabled = disabled || !settingsHydrated;

  const profiles = resolveBrowserProfiles(userProfiles);
  // Incognito is deliberately not a row — it holds nothing to manage — so the
  // default has to resolve against the list that renders. A stored
  // `browserDefaultProfileId` of "incognito" would otherwise leave the section
  // with no Default badge at all.
  const listedProfiles = profiles.filter((profile) => profile.kind !== "incognito");
  const resolvedDefaultId =
    findBrowserProfile(listedProfiles, defaultProfileId)?.id ?? DEFAULT_BROWSER_PROFILE_ID;

  const createProfile = (baseName: string) => {
    if (!settingsHydrated || importInFlightRef.current) return undefined;
    const currentProfiles = getClientSettings().browserProfiles;
    // Checked against the live settings, not the rendered list: two clicks
    // before a re-render would otherwise both pass the disabled control.
    if (currentProfiles.length >= BROWSER_PROFILE_MAX_COUNT) return undefined;
    const resolvedProfiles = resolveBrowserProfiles(currentProfiles);
    const taken = new Set(resolvedProfiles.map((profile) => profile.name));
    let name = baseName;
    for (let index = 2; taken.has(name); index += 1) name = `${baseName} ${index}`;
    const profile = { id: `profile-${randomUUID()}`, name, kind: "persistent" as const };
    updateSettings({ browserProfiles: [...currentProfiles, profile] });
    return profile;
  };

  const renameProfile = (id: string, next: string) => {
    if (!settingsHydrated || importInFlightRef.current) return;
    const name = next.trim().slice(0, BROWSER_PROFILE_NAME_MAX_LENGTH);
    if (name === "") return;
    const currentProfiles = getClientSettings().browserProfiles;
    updateSettings({
      browserProfiles: currentProfiles.map((profile) =>
        profile.id === id ? { ...profile, name } : profile,
      ),
    });
  };

  const clearProfileData = (id: string, name: string) => {
    if (!settingsHydrated || importInFlightRef.current) return;
    if (!previewBridge || !environmentsReady || environments.length === 0) {
      toastManager.add({
        type: "error",
        title: `Could not clear ${name}'s data`,
        description: "You're not connected to a server yet.",
      });
      return;
    }
    void clearBrowserProfileData(
      previewBridge,
      environments.map((environment) => environment.environmentId),
      id,
    )
      .then(() => {
        toastManager.add({ type: "success", title: `Cleared ${name}'s cookies and cache` });
      })
      .catch(() => {
        toastManager.add({ type: "error", title: `Could not clear ${name}'s data` });
      });
  };

  const removeProfile = async (id: string) => {
    if (!settingsHydrated || importInFlightRef.current) return;
    if (!removalAvailable) {
      setProfileRemovalError("Connect to an environment before removing this profile.");
      return;
    }
    setProfileRemovalError(null);
    setProfileRemovalInFlight(true);
    // Drop the partition's data too, otherwise a removed profile's cookies
    // stay on disk with nothing in the UI pointing at them.
    try {
      await clearBrowserProfileData(
        previewBridge,
        environmentsReady ? environments.map((environment) => environment.environmentId) : [],
        id,
      );
    } catch {
      setProfileRemovalError("Profile data could not be deleted. Try again.");
      setProfileRemovalInFlight(false);
      return;
    }
    const currentSettings = getClientSettings();
    updateSettings({
      browserProfiles: currentSettings.browserProfiles.filter((profile) => profile.id !== id),
      // Reassign the default rather than leaving it pointing at nothing.
      ...(currentSettings.browserDefaultProfileId === id
        ? { browserDefaultProfileId: DEFAULT_BROWSER_PROFILE_ID }
        : {}),
    });
    setProfileRemovalInFlight(false);
    setProfilePendingRemoval(null);
  };

  // A browser that is not on this machine is left out rather than listed as a
  // dead row: there is nothing to act on, and the menu is a list of things you
  // can import from. An unsupported one is left out for the same reason — the
  // blocked wizard step can't be fixed from here. Every other unavailable
  // reason stays, since each names a step the user can take.
  const importableSources = (sources ?? []).filter(
    (source) =>
      source.unavailable !== "notInstalled" && source.unavailable !== "unsupportedPlatform",
  );

  // Refreshed without blanking the last result: the menu shows the cached list
  // straight away so it doesn't reflow on open, and the source list is stable
  // (names only) since choosing what to import happens in the wizard, not here.
  const loadSources = useCallback(() => {
    if (!previewBridge) return;
    void previewBridge
      .listBrowserImportSources()
      .then(setSources)
      .catch(() => setSources((previous) => previous ?? []));
  }, []);

  // Runs one import for the wizard. A new profile is registered only once the
  // import succeeds — the cookies land in its partition first — so a blocked
  // attempt never leaves an empty profile behind.
  const runWizardImport = async (
    source: BrowserImportSource,
    environmentId: EnvironmentId,
    input: { readonly sourceProfileDirectory: string; readonly target: WizardTarget },
  ): Promise<ImportOutcome> => {
    if (!previewBridge) return { kind: "blocked", reason: "sessionUnavailable" };
    if (!settingsHydrated) return { kind: "blocked", reason: "sessionUnavailable" };
    if (
      input.target.kind === "existing" &&
      !resolveBrowserProfiles(getClientSettings().browserProfiles).some(
        (profile) => profile.id === input.target.profileId,
      )
    ) {
      return { kind: "blocked", reason: "readFailed" };
    }
    if (importInFlightRef.current) return { kind: "blocked", reason: "readFailed" };
    importInFlightRef.current = true;
    setImportInFlight(true);
    try {
      const result = await previewBridge.importBrowserCookies({
        environmentId,
        sourceId: source.id,
        sourceProfileDirectory: input.sourceProfileDirectory,
        targetProfileId: input.target.profileId,
      });
      if (
        input.target.kind === "existing" &&
        !resolveBrowserProfiles(getClientSettings().browserProfiles).some(
          (profile) => profile.id === input.target.profileId,
        )
      ) {
        return { kind: "blocked", reason: "readFailed" };
      }
      let targetName: string;
      if (input.target.kind === "new") {
        // Registered only when something actually came over: an import that
        // found no cookies should not leave a new, empty profile behind.
        if (result.imported > 0) {
          try {
            const persisted = await persistClientSettingsUpdate((current) => {
              const existing = current.browserProfiles.find(
                (profile) => profile.id === input.target.profileId,
              );
              if (existing) return current;
              // The wizard refuses a new target at the cap, but the cap can be
              // reached while the import runs; the updater sees the newest
              // settings, so this is the check that holds.
              if (current.browserProfiles.length >= BROWSER_PROFILE_MAX_COUNT) {
                throw new ProfileLimitReachedError();
              }
              const taken = new Set(
                resolveBrowserProfiles(current.browserProfiles).map((profile) => profile.name),
              );
              let name = source.name;
              for (let index = 2; taken.has(name); index += 1) name = `${source.name} ${index}`;
              return {
                ...current,
                browserProfiles: [
                  ...current.browserProfiles,
                  { id: input.target.profileId, name, kind: "persistent" as const },
                ],
              };
            });
            targetName =
              persisted.browserProfiles.find((profile) => profile.id === input.target.profileId)
                ?.name ?? source.name;
          } catch (cause) {
            // This target id belongs only to the attempted new profile. Clear
            // its partition so a failed registration cannot strand imported
            // cookies behind a profile that disappears on restart.
            await clearBrowserProfileData(
              previewBridge,
              [environmentId],
              input.target.profileId,
            ).catch(() => undefined);
            // Not a read failure: the cookies came over and were cleared again
            // because the profile could not be kept. Name that, in the same
            // token form `importFailureReason` recovers from a bridge error.
            const reason =
              cause instanceof ProfileLimitReachedError ? "profileLimitReached" : "profileNotSaved";
            throw new Error(`Importing cookies from ${source.id} failed: ${reason}.`, { cause });
          }
        } else {
          targetName = source.name;
        }
      } else {
        targetName = input.target.name;
      }
      return {
        kind: "imported",
        imported: result.imported,
        skipped: result.skipped,
        skippedDomains: result.skippedDomains,
        targetName,
      };
    } catch (cause) {
      return { kind: "blocked", reason: importFailureReason(cause) };
    } finally {
      importInFlightRef.current = false;
      setImportInFlight(false);
    }
  };

  // Re-checks a source's availability after the user quits the browser, and
  // keeps the cached list in step so the menu reflects it too.
  const refreshImportSource = async (
    sourceId: BrowserImportSource["id"],
  ): Promise<BrowserImportSource | undefined> => {
    if (!previewBridge) return undefined;
    try {
      const latest = await previewBridge.listBrowserImportSources();
      setSources(latest);
      return latest.find((source) => source.id === sourceId);
    } catch {
      return undefined;
    }
  };

  const atProfileLimit = userProfiles.length >= BROWSER_PROFILE_MAX_COUNT;

  return (
    <SettingsRow
      {...searchableSetting("browser-profiles")}
      description="Profiles separate cookies and logins. Incognito data is cleared when the app closes."
      control={
        <Menu onOpenChange={(open) => open && loadSources()}>
          <MenuTrigger
            render={
              <Button
                size="sm"
                variant="outline"
                disabled={profileWritesDisabled || importInFlight}
              />
            }
          >
            <PlusIcon />
            Add profile
          </MenuTrigger>
          <MenuPopup align="end" className="min-w-56">
            <MenuItem
              disabled={!settingsHydrated || atProfileLimit}
              onClick={() => createProfile("New profile")}
            >
              Blank profile
            </MenuItem>
            {atProfileLimit ? (
              <MenuItem disabled>You&rsquo;ve reached the profile limit</MenuItem>
            ) : null}
            <MenuSeparator />
            <MenuGroup>
              <MenuGroupLabel>Import from</MenuGroupLabel>
              {sources === null ? (
                <MenuItem disabled>Looking for browsers…</MenuItem>
              ) : importableSources.length === 0 ? (
                <MenuItem disabled>No supported browsers found</MenuItem>
              ) : (
                // Every source is a plain row — running, needs-permission and
                // ready all look the same here. The wizard picks up whatever
                // state the source is in and walks the user forward from there.
                <>
                  {importableSources.map((source) => (
                    <MenuItem
                      key={source.id}
                      disabled={!settingsHydrated || primaryEnvironment == null}
                      onClick={() => {
                        if (!settingsHydrated || primaryEnvironment == null) return;
                        setImportSession({
                          source,
                          environmentId: primaryEnvironment.environmentId,
                          environmentName: resolveEnvironmentOptionLabel({
                            isPrimary: true,
                            environmentId: primaryEnvironment.environmentId,
                            runtimeLabel: primaryEnvironment.label,
                          }),
                        });
                      }}
                    >
                      {source.name}
                    </MenuItem>
                  ))}
                  {primaryEnvironment == null ? (
                    <MenuItem disabled>Connect to an environment to import cookies</MenuItem>
                  ) : null}
                </>
              )}
            </MenuGroup>
          </MenuPopup>
        </Menu>
      }
    >
      {/*
        The bordered container groups rows unambiguously at any width, and
        carries the bottom spacing `SettingsRow` leaves to its children
        (`pt-3 pb-1`).
      */}
      <div className="mt-2 mb-2 overflow-hidden rounded-lg border border-border/60">
        {listedProfiles.map((profile, index) => {
          const builtIn = isBuiltInBrowserProfileId(profile.id);
          const isDefault = profile.id === resolvedDefaultId;
          return (
            <div
              key={profile.id}
              className={cn(
                "flex items-center gap-3 px-3 py-2",
                index > 0 && "border-t border-border/60",
              )}
            >
              <span className="flex min-w-0 flex-1 items-center gap-2">
                {builtIn ? (
                  // Dimmed here rather than on the table: a wrapper-level dim
                  // stacks with the rename field's and the row menu button's
                  // own, landing them near 0.41 while every other disabled
                  // control in the block sits at 0.64.
                  <span
                    className={cn(
                      "truncate text-sm text-foreground",
                      profileWritesDisabled && "opacity-64",
                    )}
                  >
                    {profile.name}
                  </span>
                ) : (
                  <DraftInput
                    nativeInput
                    size="sm"
                    className="w-full max-w-56"
                    aria-label={`Rename ${profile.name}`}
                    disabled={profileWritesDisabled || importInFlight}
                    maxLength={BROWSER_PROFILE_NAME_MAX_LENGTH}
                    value={profile.name}
                    onCommit={(next) => renameProfile(profile.id, next)}
                  />
                )}
                {/*
                  Dimmed with the rest of the row: a `Badge` has no disabled
                  treatment of its own, so a solid `bg-primary` pill would
                  otherwise sit at full strength beside a name, rename field
                  and menu button that are all at 0.64.
                */}
                {isDefault ? (
                  <Badge className={cn(profileWritesDisabled && "opacity-64")}>Default</Badge>
                ) : null}
              </span>
              <Menu>
                <MenuTrigger
                  render={
                    <Button
                      size="icon-xs"
                      variant="ghost-muted"
                      disabled={profileWritesDisabled || importInFlight}
                      aria-label={`${profile.name} options`}
                    />
                  }
                >
                  <MoreVertical />
                </MenuTrigger>
                <MenuPopup align="end" className="min-w-44">
                  <MenuItem
                    disabled={!settingsHydrated || isDefault}
                    onClick={() => {
                      if (settingsHydrated) {
                        updateSettings({ browserDefaultProfileId: profile.id });
                      }
                    }}
                  >
                    Set as default
                  </MenuItem>
                  <MenuItem
                    disabled={!settingsHydrated || !removalAvailable}
                    onClick={() => clearProfileData(profile.id, profile.name)}
                  >
                    Clear cookies and cache
                  </MenuItem>
                  {builtIn ? null : (
                    <MenuItem
                      variant="destructive"
                      disabled={!settingsHydrated || !removalAvailable}
                      onClick={() => {
                        if (settingsHydrated) setProfilePendingRemoval(profile);
                      }}
                    >
                      Remove profile and data
                    </MenuItem>
                  )}
                  {!removalAvailable ? (
                    <>
                      <MenuSeparator />
                      <MenuItem disabled>
                        {environmentsReady
                          ? "Connect to an environment to clear profile data"
                          : "Checking environments…"}
                      </MenuItem>
                    </>
                  ) : null}
                </MenuPopup>
              </Menu>
            </div>
          );
        })}
      </div>
      <AlertDialog
        open={profilePendingRemoval !== null}
        onOpenChange={(open) => {
          if (!open && !profileRemovalInFlight) {
            setProfilePendingRemoval(null);
            setProfileRemovalError(null);
          }
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove “{profilePendingRemoval?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              Its cookies and logins are deleted. Tabs already open in this profile stay open until
              you close them.
            </AlertDialogDescription>
            {profileRemovalError ? (
              <p aria-live="polite" className="text-sm text-destructive">
                {profileRemovalError}
              </p>
            ) : null}
            {!removalAvailable ? (
              <p className="text-sm text-muted-foreground">
                Connect to an environment to remove this profile and its data.
              </p>
            ) : null}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose
              disabled={profileRemovalInFlight}
              render={<Button variant="outline" disabled={profileRemovalInFlight} />}
            >
              Cancel
            </AlertDialogClose>
            <Button
              variant="destructive"
              disabled={profileRemovalInFlight || !settingsHydrated || !removalAvailable}
              onClick={() => {
                if (profilePendingRemoval && settingsHydrated && removalAvailable) {
                  void removeProfile(profilePendingRemoval.id);
                }
              }}
            >
              {profileRemovalInFlight ? "Removing…" : "Remove profile"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
      {importSession ? (
        <BrowserImportWizard
          source={importSession.source}
          destinationEnvironmentName={importSession.environmentName}
          targetProfiles={listedProfiles.map((profile) => ({ id: profile.id, name: profile.name }))}
          canCreateProfile={settingsHydrated && !atProfileLimit}
          onImport={(input) =>
            runWizardImport(importSession.source, importSession.environmentId, input)
          }
          onRefreshSource={() => refreshImportSource(importSession.source.id)}
          onOpenFullDiskAccessSettings={() => {
            // Rejects outside the desktop shell (and on shells that predate the
            // method), so the one toast covers every way the link can fail.
            void previewBridge?.openFullDiskAccessSettings().catch(() => {
              toastManager.add({
                type: "error",
                title: "Could not open System Settings",
                description: "Open Privacy & Security → Full Disk Access manually.",
              });
            });
          }}
          onClose={() => setImportSession(null)}
        />
      ) : null}
    </SettingsRow>
  );
}
