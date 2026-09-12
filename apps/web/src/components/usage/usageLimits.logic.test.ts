import {
  ProviderInstanceId,
  UsageLimitSourceId,
  ProviderDriverKind,
  type ServerProviderUsageLimits,
  type ServerProviderUsageWindow,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  collectLimitAccounts,
  collectLimitPools,
  elapsedShare,
  formatResetsIn,
  paceOf,
  type LimitAccount,
  type LimitProvider,
} from "./usageLimits.logic";

const now = Date.parse("2026-09-10T12:00:00Z");
const window = (overrides: Partial<ServerProviderUsageWindow> = {}): ServerProviderUsageWindow => ({
  id: "primary",
  kind: "session",
  label: "5 hours",
  usedPercent: 50,
  windowDurationMins: 300,
  resetsAt: "2026-09-10T14:30:00Z",
  ...overrides,
});
const limits = (overrides: Partial<ServerProviderUsageLimits> = {}): ServerProviderUsageLimits => ({
  checkedAt: "2026-09-10T12:00:00Z",
  windows: [window()],
  ...overrides,
});
const provider = (overrides: Partial<LimitProvider> = {}): LimitProvider => ({
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  displayName: "Codex",
  enabled: true,
  installed: true,
  availability: "available",
  auth: {},
  usageLimits: limits(),
  ...overrides,
});
const account = (
  id: string,
  report: ServerProviderUsageLimits | undefined = limits(),
): LimitAccount => ({
  id,
  driver: ProviderDriverKind.make("codex"),
  label: id,
  environments: ["Mac"],
  limits: report,
});

describe("quota accounts", () => {
  it("routes redemption to the account instance that supplied the displayed credits", () => {
    const accounts = collectLimitAccounts([
      {
        id: "older",
        label: "Older",
        providers: [
          provider({
            instanceId: ProviderInstanceId.make("personal"),
            auth: { email: "same@example.com" },
            usageLimits: limits({
              checkedAt: "2026-09-10T10:00:00Z",
              resetCredits: { availableCount: 1 },
            }),
          }),
        ],
      },
      {
        id: "newer",
        label: "Newer",
        providers: [
          provider({
            instanceId: ProviderInstanceId.make("work"),
            auth: { email: "same@example.com" },
            usageLimits: limits({ resetCredits: { availableCount: 2 } }),
          }),
        ],
      },
    ]);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]?.resetTarget).toEqual({ environmentId: "newer", instanceId: "work" });
    expect(accounts[0]?.limits?.resetCredits?.availableCount).toBe(2);
  });
  it("counts a signed-in account once across environments and keeps its newest report", () => {
    const accounts = collectLimitAccounts([
      { id: "mac", label: "Mac", providers: [provider({ auth: { email: " User@Example.com " } })] },
      {
        id: "linux",
        label: "Linux",
        providers: [
          provider({
            auth: { email: "user@example.com" },
            usageLimits: limits({
              checkedAt: "2026-09-10T11:00:00Z",
              windows: [window({ usedPercent: 10 })],
            }),
          }),
        ],
      },
    ]);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]?.environments).toEqual(["Mac", "Linux"]);
    expect(accounts[0]?.limits?.windows[0]?.usedPercent).toBe(50);
  });
  it("does not deduplicate unknown identities or accounts on different drivers", () => {
    expect(
      collectLimitAccounts([
        {
          id: "a",
          label: "A",
          providers: [provider(), provider({ driver: ProviderDriverKind.make("claudeAgent") })],
        },
        { id: "b", label: "B", providers: [provider()] },
      ]),
    ).toHaveLength(3);
  });
  it("replaces a successful report with a newer explicit failure instead of implying fresh quota", () => {
    const accounts = collectLimitAccounts([
      { id: "a", label: "A", providers: [provider({ auth: { email: "a@b.c" } })] },
      {
        id: "b",
        label: "B",
        providers: [
          provider({
            auth: { email: "a@b.c" },
            usageLimits: limits({
              checkedAt: "2026-09-10T12:01:00Z",
              windows: [],
              unavailable: { reason: "probeFailed" },
            }),
          }),
        ],
      },
    ]);
    expect(accounts[0]?.limits?.unavailable?.reason).toBe("probeFailed");
    expect(collectLimitPools(accounts, now)).toEqual([]);
  });
});
describe("quota pooling", () => {
  it("separates monthly and session windows with the same id and leaves missing cells empty", () => {
    const pools = collectLimitPools(
      [
        account("paid"),
        account("free", limits({ windows: [window({ kind: "monthly", usedPercent: 90 })] })),
      ],
      now,
    );
    expect(pools[0]?.windows.map((item) => [item.kind, item.remainingPercent])).toEqual([
      ["session", 50],
      ["monthly", 10],
    ]);
    expect(pools[0]?.windows[0]?.columns.map((item) => item.window === null)).toEqual([
      false,
      true,
    ]);
  });
  it("orders accounts by reset, preserves columns, and calculates pace only from timed reports", () => {
    const pools = collectLimitPools(
      [
        account(
          "untimed",
          limits({
            windows: [{ id: "primary", label: "5 hours", kind: "session", usedPercent: 100 }],
          }),
        ),
        account("later"),
        account(
          "earlier",
          limits({ windows: [window({ resetsAt: "2026-09-10T13:00:00Z", usedPercent: 80 })] }),
        ),
      ],
      now,
    );
    expect(pools[0]?.accounts.map((item) => item.id)).toEqual(["earlier", "later", "untimed"]);
    expect(pools[0]?.windows[0]?.remainingPercent).toBe(23);
    expect(pools[0]?.windows[0]?.pace).toBe("on");
    expect(pools[0]?.windows[0]?.resets.map((item) => item.member.account.id)).toEqual([
      "earlier",
      "later",
    ]);
  });
  it("excludes unavailable reports even if they carry old windows", () => {
    expect(
      collectLimitPools(
        [account("ok"), account("failed", limits({ unavailable: { reason: "probeFailed" } }))],
        now,
      )[0]?.accounts,
    ).toHaveLength(1);
  });
  it("handles missing and expired clocks without granting a fresh quota", () => {
    expect(elapsedShare(window({ windowDurationMins: 0 }), now)).toBeNull();
    expect(paceOf(window({ usedPercent: 80 }), now)).toBe("ahead");
    expect(formatResetsIn(window({ resetsAt: "2026-09-10T11:00:00Z" }), now)).toBe("resets now");
  });
});

it("deduplicates a hub account with a local account and redeems the displayed hub credit", () => {
  const result = collectLimitAccounts([
    {
      id: "mac",
      label: "Mac",
      providers: [provider({ auth: { email: "same@example.com" } })],
      usageLimitSources: [
        {
          id: UsageLimitSourceId.make("hub"),
          kind: "cliproxy",
          label: "Team",
          checkedAt: "2026-09-10T13:00:00Z",
          accounts: [
            {
              id: "auth-file",
              driver: ProviderDriverKind.make("codex"),
              email: "Same@Example.com",
              usageLimits: limits({
                checkedAt: "2026-09-10T13:00:00Z",
                resetCredits: { availableCount: 1, nextCreditId: "credit" },
              }),
            },
          ],
        },
      ],
    },
  ]);
  expect(result).toHaveLength(1);
  expect(result[0]?.resetTarget).toEqual({
    environmentId: "mac",
    sourceId: "hub",
    accountId: "auth-file",
    creditId: "credit",
  });
  expect(result[0]?.environments).toEqual(["Mac", "Mac · Team"]);
});
