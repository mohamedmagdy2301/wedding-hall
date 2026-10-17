/**
 * The guided setup checklist (UF-02, S-14) as a pure function of a few counts, so the
 * screen, the home card and the tests agree on what is missing (D-71).
 */

export const SETUP_STEPS = [
  "venue",
  "spaces",
  "timing",
  "seasons",
  "eventTypes",
  "paymentMethods",
  "services",
  "packages",
  "policies",
  "staff",
] as const;

export type SetupStepKey = (typeof SETUP_STEPS)[number];

/** done; missing (required); optional (not done, not required); unavailable (a later phase). */
export type SetupStepStatus = "done" | "missing" | "optional" | "unavailable";

export type SetupFacts = {
  venue: { name: string; phone: string | null; address: string | null };
  activeSpaces: number;
  activeSeasons: number;
  activeEventTypes: number;
  activePaymentMethods: number;
  cancellationTiers: number;
  /** Active non-owner staff members. */
  activeStaff: number;
  /** Services and packages come in phase 3 (P2-10): null until then. */
  activeServices: number | null;
  pricedPackages: number | null;
};

export type SetupStep = { key: SetupStepKey; status: SetupStepStatus; required: boolean };

const OPTIONAL: ReadonlySet<SetupStepKey> = new Set(["seasons", "staff"]);

const filled = (text: string | null) => (text ?? "").trim().length > 0;

function isDone(key: SetupStepKey, f: SetupFacts): boolean | null {
  switch (key) {
    case "venue":
      return filled(f.venue.name) && filled(f.venue.phone) && filled(f.venue.address);
    case "spaces":
      return f.activeSpaces > 0;
    case "timing":
      // Buffer and tentative hold always have a value (defaults from setup-venue, P1-01).
      return true;
    case "seasons":
      return f.activeSeasons > 0;
    case "eventTypes":
      return f.activeEventTypes > 0;
    case "paymentMethods":
      return f.activePaymentMethods > 0;
    case "services":
      return f.activeServices === null ? null : f.activeServices > 0;
    case "packages":
      return f.pricedPackages === null ? null : f.pricedPackages > 0;
    case "policies":
      // Only the cancellation tiers are mandatory (D-60, D-67); the rest have defaults.
      return f.cancellationTiers > 0;
    case "staff":
      return f.activeStaff > 0;
  }
}

export function setupChecklist(facts: SetupFacts): { steps: SetupStep[]; complete: boolean } {
  const steps = SETUP_STEPS.map((key): SetupStep => {
    const required = !OPTIONAL.has(key);
    const done = isDone(key, facts);
    const status: SetupStepStatus = done === null ? "unavailable" : done ? "done" : required ? "missing" : "optional";
    return { key, status, required };
  });
  return { steps, complete: steps.every((s) => s.status === "done" || s.status === "optional") };
}

/** UF-02 step 3: what still blocks confirming any booking (used by BR-21 from phase 6). */
export type BookingReadinessGap = "activeSpace" | "pricedPackage" | "cancellationTiers";

export function bookingReadinessGaps(facts: Pick<SetupFacts, "activeSpaces" | "pricedPackages" | "cancellationTiers">) {
  const gaps: BookingReadinessGap[] = [];
  if (facts.activeSpaces === 0) gaps.push("activeSpace");
  if (!facts.pricedPackages) gaps.push("pricedPackage");
  if (facts.cancellationTiers === 0) gaps.push("cancellationTiers");
  return gaps;
}
