"use client";

import { Check } from "lucide-react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { WalletInstallStepper } from "@/components/WalletInstallStepper";
import { cn } from "@/lib/utils";
import type { OnboardingChecklistState } from "@/types";

export interface ChecklistStep {
  id: string;
  title: string;
  description: string;
  detail: React.ReactNode;
}

export const ONBOARDING_STEPS: ChecklistStep[] = [
  {
    id: "choose_wallet",
    title: "Choose a wallet",
    description: "pick Freighter, LOBSTR, or xBull",
    detail: (
      <>
        Pick whichever tab suits you: Freighter (browser extension), LOBSTR
        (mobile + extension), or xBull (extension + PWA).
      </>
    ),
  },
  {
    id: "fund_wallet",
    title: "Install and fund it",
    description: "send at least 1 XLM to activate the address",
    detail: (
      <>
        Follow the steps in the panel below; send at least 1 XLM to activate
        the address.
      </>
    ),
  },
  {
    id: "add_trustline",
    title: "Add the USDC trustline",
    description: "opt-in so your wallet accepts USDC",
    detail: (
      <>
        Click the deep-link button at the bottom of the step list. It opens the
        wallet with USDC pre-selected so you only need to confirm.
      </>
    ),
  },
  {
    id: "register_address",
    title: "Paste your G-address below",
    description: "link your Stellar address on TrustBridge",
    detail: (
      <>
        The address starting with a capital <code>G</code>. Never share the
        secret key (starts with <code>S</code>).
      </>
    ),
  },
];

interface TrustlineGuidancePanelProps {
  checklistCompleted?: OnboardingChecklistState | null;
  onToggleStep?: (stepId: string, completed: boolean) => void;
  isUpdating?: boolean;
}

/**
 * Contributor-facing setup guide with interactive sticky checklist persistence.
 */
export function TrustlineGuidancePanel({
  checklistCompleted = {},
  onToggleStep,
  isUpdating = false,
}: TrustlineGuidancePanelProps) {
  const completedMap = checklistCompleted ?? {};
  const completedCount = ONBOARDING_STEPS.filter(
    (step) => Boolean(completedMap[step.id])
  ).length;
  const totalSteps = ONBOARDING_STEPS.length;
  const progressPercent = Math.round((completedCount / totalSteps) * 100);

  return (
    <Card
      className="border-stellar-cyan/20 bg-gradient-to-br from-stellar-purple/5 to-stellar-cyan/5"
      data-testid="trustline-guidance"
    >
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-lg">
            New to Stellar? Set your wallet up first
          </CardTitle>
          <span
            className={cn(
              "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold tabular-nums",
              completedCount === totalSteps
                ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                : "bg-stellar-purple/10 text-stellar-purple"
            )}
            data-testid="checklist-progress-badge"
          >
            {completedCount}/{totalSteps} complete
          </span>
        </div>
        <CardDescription>
          Payouts arrive as USDC on the Stellar network. Before a wallet can
          receive USDC it needs two things: a small XLM deposit to exist on the
          network, and a <em>trustline</em> — a one-time opt-in that tells
          Stellar the wallet accepts USDC. Pick a wallet below and follow the
          four steps. It usually takes about ten minutes.
        </CardDescription>

        {/* Progress bar */}
        <div
          className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-valuenow={progressPercent}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Onboarding checklist completion progress"
        >
          <div
            className="h-full bg-emerald-500 transition-all duration-300 ease-out"
            style={{ width: `${progressPercent}%` }}
          />
        </div>
      </CardHeader>

      <CardContent className="space-y-5 text-sm">
        {/* Interactive sticky checklist */}
        <fieldset
          className="space-y-2"
          data-testid="onboarding-checklist"
          aria-label="Contributor onboarding steps"
        >
          <legend className="sr-only">Contributor onboarding checklist</legend>
          {ONBOARDING_STEPS.map((step, index) => {
            const isCompleted = Boolean(completedMap[step.id]);

            return (
              <label
                key={step.id}
                htmlFor={`step-${step.id}`}
                className={cn(
                  "flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors",
                  isCompleted
                    ? "border-emerald-500/30 bg-emerald-500/5 dark:bg-emerald-950/20"
                    : "border-border bg-background hover:bg-accent/40"
                )}
                data-testid={`checklist-item-${step.id}`}
                data-checked={isCompleted ? "true" : "false"}
              >
                <div className="relative flex items-center pt-0.5">
                  <input
                    type="checkbox"
                    id={`step-${step.id}`}
                    name={step.id}
                    checked={isCompleted}
                    disabled={!onToggleStep || isUpdating}
                    onChange={(e) => onToggleStep?.(step.id, e.target.checked)}
                    className="sr-only"
                    aria-label={`Step ${index + 1}: ${step.title}`}
                  />
                  <div
                    className={cn(
                      "flex h-5 w-5 shrink-0 items-center justify-center rounded border transition-colors",
                      isCompleted
                        ? "border-emerald-600 bg-emerald-600 text-white dark:border-emerald-500 dark:bg-emerald-500"
                        : "border-muted-foreground/40 bg-background"
                    )}
                    aria-hidden="true"
                  >
                    {isCompleted ? (
                      <Check className="h-3.5 w-3.5 stroke-[3]" />
                    ) : (
                      <span className="text-xs font-semibold text-muted-foreground">
                        {index + 1}
                      </span>
                    )}
                  </div>
                </div>

                <div className="flex-1 text-xs sm:text-sm">
                  <span
                    className={cn(
                      "font-medium",
                      isCompleted
                        ? "text-emerald-700 dark:text-emerald-300 line-through opacity-80"
                        : "text-foreground"
                    )}
                  >
                    {step.title}
                  </span>{" "}
                  <span className="text-muted-foreground">— {step.detail}</span>
                </div>
              </label>
            );
          })}
        </fieldset>

        {/* Wallet picker + per-wallet guides */}
        <WalletInstallStepper />

        <p className="text-xs text-muted-foreground">
          You can save your address as soon as you have it — you do not need to
          wait for the badge to turn green. Your checklist progress is saved to
          your account across visits.
        </p>
      </CardContent>
    </Card>
  );
}
