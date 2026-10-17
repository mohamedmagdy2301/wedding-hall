import { CheckCircle2, Circle, CircleDashed } from "lucide-react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import type { SetupStep, SetupStepKey, SetupStepStatus } from "@/domain/setup-checklist";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

const ts = t.setup;

/** Where each step is done (UF-02). */
const STEP_HREF: Record<SetupStepKey, string> = {
  venue: "/settings/venue",
  spaces: "/settings/spaces",
  timing: "/settings/timing",
  seasons: "/settings/seasons",
  eventTypes: "/settings/event-types",
  paymentMethods: "/settings/payment-methods",
  services: "/settings/services",
  packages: "/settings/packages",
  policies: "/settings/policies",
  staff: "/staff",
};

// A separate number (no trailing period) avoids bidi reordering it to ".1" in RTL.
const stepNumber = new Intl.NumberFormat("ar-EG");

const ICONS: Record<SetupStepStatus, typeof Circle> = {
  done: CheckCircle2,
  missing: Circle,
  optional: CircleDashed,
};

const BADGE: Record<SetupStepStatus, "default" | "destructive" | "outline" | "secondary"> = {
  done: "secondary",
  missing: "destructive",
  optional: "outline",
};

/** S-14: every step with its status and a link; defaulted values are shown (D-71). */
export function SetupChecklist({
  steps,
  timing,
}: {
  steps: SetupStep[];
  timing: { bufferMinutes: number; tentativeHoldHours: number };
}) {
  return (
    <ol className="grid gap-2">
      {steps.map((step, index) => {
        const Icon = ICONS[step.status];
        const href = STEP_HREF[step.key];
        const detail =
          step.key === "timing"
            ? `${ts.details.timing} ${timing.bufferMinutes} ${ts.bufferValue} ${timing.tentativeHoldHours} ${ts.holdValue}`
            : ts.details[step.key];
        const title = ts.steps[step.key];
        return (
          <li
            key={step.key}
            data-testid={`setup-step-${step.key}`}
            data-status={step.status}
            className="flex items-start gap-3 rounded-lg border bg-card p-3"
          >
            <Icon
              aria-hidden
              className={cn(
                "mt-0.5 size-5 shrink-0",
                step.status === "done" ? "text-primary" : "text-muted-foreground",
                step.status === "missing" && "text-destructive",
              )}
            />
            <div className="grid flex-1 gap-0.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm text-muted-foreground tabular-nums">{stepNumber.format(index + 1)}</span>
                <Link href={href} className="font-medium underline-offset-4 hover:underline">
                  {title}
                </Link>
                <Badge variant={BADGE[step.status]}>{ts.statuses[step.status]}</Badge>
              </div>
              <p className="text-sm text-muted-foreground">{detail}</p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
