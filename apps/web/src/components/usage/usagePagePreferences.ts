import * as Schema from "effect/Schema";

const STORAGE_KEY = "t3code:usage-page-preferences:v1";
const UsagePagePreferencesSchema = Schema.Struct({
  metric: Schema.Literals(["cost", "tokens", "limits"]),
  windowDays: Schema.Literals([1, 7, 30, 90]),
});
export type UsagePagePreferences = typeof UsagePagePreferencesSchema.Type;

const decodePreferences = Schema.decodeSync(Schema.fromJsonString(UsagePagePreferencesSchema));
const encodePreferences = Schema.encodeSync(Schema.fromJsonString(UsagePagePreferencesSchema));

// Limits is what most people open the page for (how much subscription quota is
// left, and when it resets), so it is the first-visit default; the last picked
// tab sticks after that.
const DEFAULT_PREFERENCES: UsagePagePreferences = { metric: "limits", windowDays: 30 };

export function readUsagePagePreferences(): UsagePagePreferences {
  try {
    const stored = typeof window === "undefined" ? null : window.localStorage.getItem(STORAGE_KEY);
    return stored === null ? DEFAULT_PREFERENCES : decodePreferences(stored);
  } catch (error) {
    console.error("Could not read Usage page preferences.", error);
    return DEFAULT_PREFERENCES;
  }
}

export function saveUsagePagePreferences(preferences: UsagePagePreferences): void {
  try {
    if (typeof window !== "undefined")
      window.localStorage.setItem(STORAGE_KEY, encodePreferences(preferences));
  } catch (error) {
    console.error("Could not save Usage page preferences.", error);
  }
}
