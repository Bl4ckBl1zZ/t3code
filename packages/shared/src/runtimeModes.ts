import type { RuntimeMode } from "@t3tools/contracts";

export interface RuntimeModeChoice {
  readonly mode: RuntimeMode;
  readonly label: string;
  readonly description: string;
}

/**
 * The access options a T3 Work (Hermes) thread offers.
 *
 * Hermes runs its own gate on the commands it considers dangerous, and its
 * session protocol carries no approval or sandbox setting to relax it, so the
 * four generic modes collapse to two things T3 can actually do with an
 * `approval.request`: answer it, or show it. Supervised, Auto-accept edits and
 * Auto would all behave identically here, so the picker offers this pair
 * instead of three labels that promise distinctions Hermes does not make.
 */
export const HERMES_RUNTIME_MODE_CHOICES: ReadonlyArray<RuntimeModeChoice> = [
  {
    mode: "approval-required",
    label: "Approve risky commands",
    description: "Hermes asks before running anything it flags as dangerous.",
  },
  {
    mode: "full-access",
    label: "Full access",
    description: "Let Hermes run commands without asking.",
  },
];

/**
 * The choice a Hermes thread's stored mode displays as. A thread can carry
 * `auto` or `auto-accept-edits` in from wherever it was created; both ask on
 * Hermes, so both read as the approval choice rather than a label the picker
 * does not offer.
 */
export function hermesRuntimeModeChoice(mode: RuntimeMode): RuntimeModeChoice {
  const choice = HERMES_RUNTIME_MODE_CHOICES.find((candidate) => candidate.mode === mode);
  return choice ?? HERMES_RUNTIME_MODE_CHOICES[0]!;
}
