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
  it("offers banked resets for Claude logins but not for other providers", () => {
    const accounts = collectLimitAccounts([
      {
        id: "local",
        label: "Local",
        providers: [
          provider({
            instanceId: ProviderInstanceId.make("claude"),
            driver: ProviderDriverKind.make("claudeAgent"),
            displayName: "Claude",
            auth: { email: "claude@example.com" },
            usageLimits: limits({ resetCredits: { availableCount: 1 } }),
          }),
          provider({
            instanceId: ProviderInstanceId.make("grok"),
            driver: ProviderDriverKind.make("grok"),
            displayName: "Grok",
            auth: { email: "grok@example.com" },
            usageLimits: limits({ resetCredits: { availableCount: 1 } }),
          }),
        ],
      },
    ]);
    const byInstance = new Map(accounts.map((account) => [account.label, account.resetTarget]));
    expect(byInstance.get("Claude")).toEqual({ environmentId: "local", instanceId: "claude" });
    expect(byInstance.get("Grok")).toBeUndefined();
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

describe("workspaces", () => {
  const hub = (accounts: ReadonlyArray<{ id: string; email?: string; workspaceId?: string }>) => [
    {
      id: UsageLimitSourceId.make("hub"),
      kind: "cliproxy" as const,
      label: "Team",
      checkedAt: "2026-09-10T12:00:00Z",
      accounts: accounts.map((account) => ({
        ...account,
        driver: ProviderDriverKind.make("codex"),
        usageLimits: limits(),
      })),
    },
  ];
  const login = (instanceId: string, workspaceId: string) =>
    provider({
      instanceId: ProviderInstanceId.make(instanceId),
      displayName: instanceId,
      auth: { email: "same@example.com", workspaceId },
    });

  it("keeps one email in two workspaces apart while merging each workspace's duplicates", () => {
    const accounts = collectLimitAccounts([
      {
        id: "laptop",
        label: "Laptop",
        providers: [login("business", "ws-business"), login("personal", "ws-plus")],
        // A hub that names the workspace joins it; one that does not cannot
        // say which of the two it read, so it keeps its own row.
        usageLimitSources: hub([
          { id: "plus.json", email: "same@example.com", workspaceId: "ws-plus" },
          { id: "x.json", email: "same@example.com" },
        ]),
      },
      { id: "desktop", label: "Desktop", providers: [login("personal", "ws-plus")] },
    ]);
    expect(accounts.map((account) => account.label)).toEqual([
      "business",
      "personal",
      "same@example.com",
    ]);
    expect(accounts[1]?.environments).toEqual(["Laptop", "Laptop · Team", "Desktop"]);
  });

  it("joins a report without a workspace to the only workspace signed in with its email", () => {
    const source = hub([{ id: "x.json", email: "same@example.com" }]);
    expect(
      collectLimitAccounts([
        {
          id: "laptop",
          label: "Laptop",
          providers: [login("work", "org-a")],
          usageLimitSources: source,
        },
      ]),
    ).toHaveLength(1);
    // A second workspace whose limits could not be read still makes the hub ambiguous.
    expect(
      collectLimitAccounts([
        {
          id: "laptop",
          label: "Laptop",
          providers: [
            login("work", "org-a"),
            provider({
              ...login("team", "org-b"),
              usageLimits: limits({ windows: [], unavailable: { reason: "probeFailed" } }),
            }),
          ],
          usageLimitSources: source,
        },
      ]),
    ).toHaveLength(3);
  });
});

describe("codex slots", () => {
  it("pools Codex windows by kind, whichever slot reported them", () => {
    const codexAccount = (id: string, slots: readonly string[]) =>
      account(
        id,
        limits({
          windows: slots.map((slot) =>
            window({ id: slot, kind: "weekly", label: "Weekly", windowDurationMins: 10080 }),
          ),
        }),
      );
    // A weekly-only plan reports weekly as `primary`. The pool keeps one id
    // whichever account sorts first.
    for (const order of [
      [codexAccount("business", ["primary"]), codexAccount("plus", ["secondary"])],
      [codexAccount("plus", ["secondary"]), codexAccount("business", ["primary"])],
    ]) {
      const windows = collectLimitPools(order, now)[0]?.windows ?? [];
      expect(windows.map((item) => item.id)).toEqual(["weekly"]);
      expect(windows[0]?.members).toHaveLength(2);
    }
    // A second window of the same kind on one account stays apart, with its own id.
    expect(
      collectLimitPools(
        [codexAccount("a", ["secondary"]), codexAccount("b", ["primary", "secondary"])],
        now,
      )[0]?.windows.map((item) => item.id),
    ).toEqual(["weekly", "weekly:secondary"]);
  });
});

describe("Antigravity limit presentation", () => {
  it("keeps the shared Claude/GPT bucket separate from Gemini and pairs their windows", () => {
    const antigravity = provider({
      instanceId: ProviderInstanceId.make("antigravity"),
      driver: ProviderDriverKind.make("antigravity"),
      displayName: "Antigravity",
      usageLimits: limits({
        windows: [
          window({ id: "3p-5h", label: "Claude & GPT (shared) · 5-hour", usedPercent: 90 }),
          window({ id: "gemini-5h", label: "Gemini · 5-hour", usedPercent: 20 }),
          window({
            id: "3p-weekly",
            kind: "weekly",
            label: "Claude & GPT (shared) · Weekly",
            usedPercent: 100,
          }),
          window({
            id: "gemini-weekly",
            kind: "weekly",
            label: "Gemini · Weekly",
            usedPercent: 10,
          }),
        ],
      }),
    });
    const pools = collectLimitPools(
      collectLimitAccounts([{ id: "a", label: "Local", providers: [provider(), antigravity] }]),
      now,
    );
    expect(pools.map((pool) => pool.driver)).toEqual(["codex", "antigravity"]);
    const windows = pools[1]?.windows ?? [];
    expect(windows.map((item) => item.id)).toEqual([
      "gemini-5h",
      "gemini-weekly",
      "3p-5h",
      "3p-weekly",
    ]);
    expect(windows.map((item) => item.remainingPercent)).toEqual([80, 90, 10, 0]);
  });
});
