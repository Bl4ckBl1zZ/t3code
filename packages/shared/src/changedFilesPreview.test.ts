import { describe, expect, it } from "vite-plus/test";

import {
  changedFileName,
  selectChangedFilePreview,
  summarizeChangedFileScopes,
} from "./changedFilesPreview";

describe("changedFilesPreview", () => {
  it("summarizes the most prominent top-level scopes", () => {
    const files = [
      { path: "apps/web/src/App.tsx" },
      { path: "README.md" },
      { path: "apps/server/src/index.ts" },
      { path: "packages/shared/src/git.ts" },
      { path: "apps\\mobile\\App.tsx" },
    ];

    expect(summarizeChangedFileScopes(files)).toEqual([
      { label: "apps", fileCount: 3 },
      { label: "root", fileCount: 1 },
      { label: "packages", fileCount: 1 },
    ]);
  });

  it("previews files across different scopes before filling from one scope", () => {
    const files = [
      { path: "apps/web/src/App.tsx" },
      { path: "apps/web/src/App.test.tsx" },
      { path: "packages/shared/src/git.ts" },
      { path: "README.md" },
    ];

    expect(selectChangedFilePreview(files).map((file) => file.path)).toEqual([
      "apps/web/src/App.tsx",
      "packages/shared/src/git.ts",
      "README.md",
    ]);
    expect(changedFileName("apps\\web\\src\\App.tsx")).toBe("App.tsx");
  });
});
