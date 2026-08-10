import { assert, describe, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  type Project,
  type ProjectScript,
} from "@t3tools/contracts";

import { needsProjectFileBackfill, projectFileBackfillPatch } from "./T3ProjectFileBackfill.ts";

const script: ProjectScript = {
  id: "lint",
  name: "Lint",
  command: "pnpm lint",
  icon: "lint",
  runOnWorktreeCreate: false,
};

function project(scripts: ReadonlyArray<ProjectScript>): Project {
  return {
    id: ProjectId.make("project-1"),
    title: "Example",
    workspaceRoot: "/workspace/example",
    createdAt: 0,
    updatedAt: 0,
    deletedAt: null,
    scripts,
  } as unknown as Project;
}

describe("needsProjectFileBackfill", () => {
  it("seeds a project whose actions only exist in the projection", () => {
    assert.isTrue(needsProjectFileBackfill(project([script]), false));
  });

  it("never touches an existing t3.json", () => {
    // The file is the checked-in truth; reformatting or rewriting it would
    // discard hand formatting and comments the user owns.
    assert.isFalse(needsProjectFileBackfill(project([script]), true));
  });

  it("leaves a project with no actions without a file", () => {
    // An empty `scripts` array is a claim that the project declares no
    // actions. The backfill has no standing to make it.
    assert.isFalse(needsProjectFileBackfill(project([]), false));
  });
});

describe("projectFileBackfillPatch", () => {
  it("records the marker on the first boot", () => {
    assert.deepStrictEqual(projectFileBackfillPatch(DEFAULT_SERVER_SETTINGS), {
      projectFileBackfillApplied: true,
    });
  });

  it("does nothing once applied, so a deleted t3.json stays deleted", () => {
    assert.isNull(
      projectFileBackfillPatch({
        ...DEFAULT_SERVER_SETTINGS,
        projectFileBackfillApplied: true,
      }),
    );
  });
});
