import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  shouldShowBrowserAnnotationButton,
  shouldShowOpenInPicker,
  shouldShowProjectScriptsControl,
  shouldShowPreviewButton,
} from "./ChatHeader";

describe("shouldShowOpenInPicker", () => {
  const primaryEnvironmentId = EnvironmentId.make("environment-primary");

  it("shows the picker for projects in the primary environment", () => {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: "codething-mvp",
        activeThreadEnvironmentId: primaryEnvironmentId,
        primaryEnvironmentId,
        currentSessionCanManageAccess: true,
      }),
    ).toBe(true);
  });

  it("hides the picker when hosted static mode has no primary environment", () => {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: "codething-mvp",
        activeThreadEnvironmentId: EnvironmentId.make("environment-remote"),
        primaryEnvironmentId: null,
        currentSessionCanManageAccess: true,
      }),
    ).toBe(false);
  });

  it("hides the picker for remote environments", () => {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: "codething-mvp",
        activeThreadEnvironmentId: EnvironmentId.make("environment-remote"),
        primaryEnvironmentId,
        currentSessionCanManageAccess: true,
      }),
    ).toBe(false);
  });

  it("hides the picker for sessions without access management scope", () => {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: "codething-mvp",
        activeThreadEnvironmentId: primaryEnvironmentId,
        primaryEnvironmentId,
        currentSessionCanManageAccess: false,
      }),
    ).toBe(false);
  });

  it("hides the picker when there is no active project", () => {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: undefined,
        activeThreadEnvironmentId: primaryEnvironmentId,
        primaryEnvironmentId,
        currentSessionCanManageAccess: true,
      }),
    ).toBe(false);
  });
});

describe("shouldShowBrowserAnnotationButton", () => {
  const primaryEnvironmentId = EnvironmentId.make("environment-primary");

  it("shows in primary-project browser-agent sidebars", () => {
    expect(
      shouldShowBrowserAnnotationButton({
        activeProjectName: "codething-mvp",
        activeThreadEnvironmentId: primaryEnvironmentId,
        primaryEnvironmentId,
        browserAgentSidebarMode: true,
      }),
    ).toBe(true);
  });

  it("hides outside browser-agent sidebars", () => {
    expect(
      shouldShowBrowserAnnotationButton({
        activeProjectName: "codething-mvp",
        activeThreadEnvironmentId: primaryEnvironmentId,
        primaryEnvironmentId,
        browserAgentSidebarMode: false,
      }),
    ).toBe(false);
  });

  it("hides without an active project", () => {
    expect(
      shouldShowBrowserAnnotationButton({
        activeProjectName: undefined,
        activeThreadEnvironmentId: primaryEnvironmentId,
        primaryEnvironmentId,
        browserAgentSidebarMode: true,
      }),
    ).toBe(false);
  });

  it("hides for remote environments", () => {
    expect(
      shouldShowBrowserAnnotationButton({
        activeProjectName: "codething-mvp",
        activeThreadEnvironmentId: EnvironmentId.make("environment-remote"),
        primaryEnvironmentId,
        browserAgentSidebarMode: true,
      }),
    ).toBe(false);
  });
});

describe("shouldShowProjectScriptsControl", () => {
  it("shows project actions when project scripts are loaded", () => {
    expect(shouldShowProjectScriptsControl({ activeProjectScripts: [] })).toBe(true);
  });

  it("hides project actions when there is no active project", () => {
    expect(shouldShowProjectScriptsControl({ activeProjectScripts: undefined })).toBe(false);
  });
});

describe("shouldShowPreviewButton", () => {
  const primaryEnvironmentId = EnvironmentId.make("environment-primary");

  it("shows in primary-project app chats", () => {
    expect(
      shouldShowPreviewButton({
        activeProjectName: "codething-mvp",
        activeThreadEnvironmentId: primaryEnvironmentId,
        primaryEnvironmentId,
        browserAgentSidebarMode: false,
        previewVisible: true,
      }),
    ).toBe(true);
  });

  it("shows when preview discovery is starting", () => {
    expect(
      shouldShowPreviewButton({
        activeProjectName: "codething-mvp",
        activeThreadEnvironmentId: primaryEnvironmentId,
        primaryEnvironmentId,
        browserAgentSidebarMode: false,
        previewVisible: true,
      }),
    ).toBe(true);
  });

  it("hides when no preview target state is available", () => {
    expect(
      shouldShowPreviewButton({
        activeProjectName: "codething-mvp",
        activeThreadEnvironmentId: primaryEnvironmentId,
        primaryEnvironmentId,
        browserAgentSidebarMode: false,
        previewVisible: false,
      }),
    ).toBe(false);
  });

  it("hides in browser-agent sidebars", () => {
    expect(
      shouldShowPreviewButton({
        activeProjectName: "codething-mvp",
        activeThreadEnvironmentId: primaryEnvironmentId,
        primaryEnvironmentId,
        browserAgentSidebarMode: true,
        previewVisible: true,
      }),
    ).toBe(false);
  });

  it("hides without an active project", () => {
    expect(
      shouldShowPreviewButton({
        activeProjectName: undefined,
        activeThreadEnvironmentId: primaryEnvironmentId,
        primaryEnvironmentId,
        browserAgentSidebarMode: false,
        previewVisible: true,
      }),
    ).toBe(false);
  });

  it("hides for remote environments", () => {
    expect(
      shouldShowPreviewButton({
        activeProjectName: "codething-mvp",
        activeThreadEnvironmentId: EnvironmentId.make("environment-remote"),
        primaryEnvironmentId,
        browserAgentSidebarMode: false,
        previewVisible: true,
      }),
    ).toBe(false);
  });
});
