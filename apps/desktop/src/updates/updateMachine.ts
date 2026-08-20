import type {
  DesktopRuntimeInfo,
  DesktopUpdateChannel,
  DesktopUpdateReleaseNote,
  DesktopUpdateState,
} from "@t3tools/contracts";

export function nextStatusAfterDownloadFailure(
  currentState: DesktopUpdateState,
): DesktopUpdateState["status"] {
  return currentState.availableVersion ? "available" : "error";
}

export function getCanRetryAfterDownloadFailure(currentState: DesktopUpdateState): boolean {
  return currentState.availableVersion !== null;
}

export function createInitialDesktopUpdateState(
  currentVersion: string,
  runtimeInfo: DesktopRuntimeInfo,
  channel: DesktopUpdateChannel,
): DesktopUpdateState {
  return {
    enabled: false,
    autoUpdateEnabled: false,
    autoInstallPending: false,
    status: "disabled",
    channel,
    currentVersion,
    hostArch: runtimeInfo.hostArch,
    appArch: runtimeInfo.appArch,
    runningUnderArm64Translation: runtimeInfo.runningUnderArm64Translation,
    availableVersion: null,
    downloadedVersion: null,
    releaseNotes: [],
    downloadPercent: null,
    checkedAt: null,
    message: null,
    errorContext: null,
    canRetry: false,
  };
}

export function reduceDesktopUpdateStateOnCheckStart(
  state: DesktopUpdateState,
  checkedAt: string,
): DesktopUpdateState {
  const hasDownloadedUpdate = state.downloadedVersion !== null;
  return {
    ...state,
    status: "checking",
    // A check that runs on top of a downloaded update no longer discards it,
    // so the armed idle install survives the round trip too.
    autoInstallPending: hasDownloadedUpdate ? state.autoInstallPending : false,
    checkedAt,
    releaseNotes: hasDownloadedUpdate ? state.releaseNotes : [],
    message: null,
    downloadPercent: hasDownloadedUpdate ? 100 : null,
    errorContext: null,
    canRetry: false,
  };
}

export function reduceDesktopUpdateStateOnCheckFailure(
  state: DesktopUpdateState,
  message: string,
  checkedAt: string,
): DesktopUpdateState {
  if (state.downloadedVersion !== null) {
    return {
      ...state,
      status: "downloaded",
      message: null,
      checkedAt,
      downloadPercent: 100,
      errorContext: null,
      canRetry: true,
    };
  }

  return {
    ...state,
    status: "error",
    message,
    checkedAt,
    downloadPercent: null,
    errorContext: "check",
    canRetry: true,
  };
}

export function reduceDesktopUpdateStateOnUpdateAvailable(
  state: DesktopUpdateState,
  version: string,
  checkedAt: string,
  releaseNotes: ReadonlyArray<DesktopUpdateReleaseNote> = [],
): DesktopUpdateState {
  const isDownloadedVersion = state.downloadedVersion === version;
  const nextReleaseNotes =
    isDownloadedVersion && releaseNotes.length === 0 ? state.releaseNotes : releaseNotes;
  return {
    ...state,
    status: isDownloadedVersion ? "downloaded" : "available",
    // A re-announced download keeps whatever the idle watcher had armed; a
    // genuinely new version starts over.
    autoInstallPending: isDownloadedVersion ? state.autoInstallPending : false,
    availableVersion: version,
    downloadedVersion: isDownloadedVersion ? version : null,
    releaseNotes: nextReleaseNotes,
    downloadPercent: isDownloadedVersion ? 100 : null,
    checkedAt,
    message: null,
    errorContext: null,
    canRetry: isDownloadedVersion,
  };
}

export function reduceDesktopUpdateStateOnNoUpdate(
  state: DesktopUpdateState,
  checkedAt: string,
): DesktopUpdateState {
  if (state.downloadedVersion !== null) {
    return {
      ...state,
      status: "downloaded",
      availableVersion: state.downloadedVersion,
      downloadPercent: 100,
      checkedAt,
      message: null,
      errorContext: null,
      canRetry: true,
    };
  }

  return {
    ...state,
    status: "up-to-date",
    autoInstallPending: false,
    availableVersion: null,
    downloadedVersion: null,
    releaseNotes: [],
    downloadPercent: null,
    checkedAt,
    message: null,
    errorContext: null,
    canRetry: false,
  };
}

export function reduceDesktopUpdateStateOnDownloadStart(
  state: DesktopUpdateState,
): DesktopUpdateState {
  return {
    ...state,
    status: "downloading",
    autoInstallPending: false,
    downloadPercent: 0,
    message: null,
    errorContext: null,
    canRetry: false,
  };
}

export function reduceDesktopUpdateStateOnDownloadFailure(
  state: DesktopUpdateState,
  message: string,
): DesktopUpdateState {
  return {
    ...state,
    status: nextStatusAfterDownloadFailure(state),
    message,
    downloadPercent: null,
    errorContext: "download",
    canRetry: getCanRetryAfterDownloadFailure(state),
  };
}

export function reduceDesktopUpdateStateOnDownloadProgress(
  state: DesktopUpdateState,
  percent: number,
): DesktopUpdateState {
  return {
    ...state,
    status: "downloading",
    downloadPercent: percent,
    message: null,
    errorContext: null,
    canRetry: false,
  };
}

export function reduceDesktopUpdateStateOnDownloadComplete(
  state: DesktopUpdateState,
  version: string,
): DesktopUpdateState {
  return {
    ...state,
    status: "downloaded",
    availableVersion: version,
    downloadedVersion: version,
    downloadPercent: 100,
    message: null,
    errorContext: null,
    canRetry: true,
  };
}

export function reduceDesktopUpdateStateOnInstallFailure(
  state: DesktopUpdateState,
  message: string,
): DesktopUpdateState {
  return {
    ...state,
    status: "downloaded",
    // A failed install stops the automatic idle-wait; retrying is left to the
    // user so a persistent installer failure can't loop forever.
    autoInstallPending: false,
    message,
    errorContext: "install",
    canRetry: true,
  };
}

export function reduceDesktopUpdateStateOnAutoUpdatePreferenceChange(
  state: DesktopUpdateState,
  autoUpdateEnabled: boolean,
): DesktopUpdateState {
  return {
    ...state,
    autoUpdateEnabled,
    autoInstallPending: autoUpdateEnabled ? state.autoInstallPending : false,
  };
}

/**
 * True while a downloaded update is still the thing the idle watcher is waiting
 * on. A periodic check now runs on top of a downloaded update instead of
 * discarding it, so "checking" is a transient the watcher rides through.
 */
export function desktopUpdateHoldsDownloadedUpdate(state: DesktopUpdateState): boolean {
  return (
    state.downloadedVersion !== null &&
    (state.status === "downloaded" || state.status === "checking")
  );
}

export function reduceDesktopUpdateStateOnAutoInstallWait(
  state: DesktopUpdateState,
  autoInstallPending: boolean,
): DesktopUpdateState {
  return desktopUpdateHoldsDownloadedUpdate(state) ? { ...state, autoInstallPending } : state;
}
