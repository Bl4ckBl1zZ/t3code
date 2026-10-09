import { describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const rule = createOxlintRuleHarness("t3code/require-centered-scroll-gutter", {
  filename: "fixture.tsx",
});

describe("t3code/require-centered-scroll-gutter", () => {
  rule.valid(
    "allows a centered scroller that reserves the gutter",
    `
      export const View = () => (
        <div className="scrollbar-gutter-both flex items-center justify-center overflow-y-auto" />
      );
    `,
  );

  rule.valid(
    "allows a scroller that hides its scrollbar",
    `
      export const View = () => (
        <div className="[scrollbar-width:none] flex justify-center overflow-auto" />
      );
    `,
  );

  rule.valid(
    "allows a scroller that does not center",
    `
      export const View = () => <div className="flex flex-col overflow-y-auto" />;
    `,
  );

  rule.invalid(
    "reports a row scroller that centers with justify-center",
    `
      export const View = () => <div className="flex justify-center overflow-y-auto" />;
    `,
  );

  rule.invalid(
    "reports a column scroller that centers with items-center",
    `
      export const View = () => <div className="flex flex-col items-center overflow-auto" />;
    `,
  );

  rule.invalid(
    "reports the nearest scroller around mx-auto content",
    `
      export const View = () => (
        <div className="h-full overflow-y-auto">
          <div className="mx-auto max-w-xl" />
        </div>
      );
    `,
  );

  rule.invalid(
    "does not accept a gutter that only applies at one breakpoint",
    `
      export const View = () => (
        <div className="lg:scrollbar-gutter-both flex justify-center overflow-y-auto" />
      );
    `,
  );

  rule.valid(
    "ignores mx-auto content passed through a prop",
    `
      export const View = () => (
        <div className="overflow-y-auto">
          <Panel header={<div className="mx-auto" />} />
        </div>
      );
    `,
  );
});
