import { AlertTriangle } from "lucide-react";

interface FreezeWindowBannerProps {
  /** ISO-8601 string for window start, or undefined when not set. */
  start?: string;
  /** ISO-8601 string for window end, or undefined when not set. */
  end?: string;
  /** Human-readable reason from the freeze-window check. */
  reason?: string;
  /**
   * Whether the freeze window is currently active. Defaults to `true` so
   * existing call sites that only render the banner while active keep working.
   * When `false`, the banner renders nothing — useful for Storybook state
   * coverage and for parents that always mount the banner.
   */
  active?: boolean;
}

/**
 * Displays a prominent amber alert banner while a Wave freeze window is active.
 * Rendered only when the freeze is active; the parent decides whether to render
 * this component at all by reading `isFreezeWindowActive()` server-side or via
 * an API endpoint. Passing `active={false}` renders nothing.
 *
 * Light/dark colours both meet WCAG 2.1 AA contrast requirements.
 */
export function FreezeWindowBanner({
  start,
  end,
  reason,
  active = true,
}: FreezeWindowBannerProps) {
  if (!active) return null;

  const fmt = (iso?: string) => {
    if (!iso) return null;
    const parsed = new Date(iso);
    // `new Date()` never throws on garbage input — it yields Invalid Date.
    // Fall back to the raw string so operators still see what was configured.
    if (Number.isNaN(parsed.getTime())) return iso;
    try {
      return parsed.toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      });
    } catch {
      return iso;
    }
  };

  const startLabel = fmt(start);
  const endLabel = fmt(end);

  return (
    <div
      role="alert"
      aria-live="polite"
      data-testid="freeze-window-banner"
      className="mb-6 flex items-start gap-3 rounded-lg border border-amber-400 bg-amber-50 px-4 py-3 text-amber-900 shadow-sm dark:border-amber-600 dark:bg-amber-950/60 dark:text-amber-200"
    >
      <AlertTriangle
        className="mt-0.5 h-5 w-5 flex-shrink-0 text-amber-600 dark:text-amber-400"
        aria-hidden="true"
      />
      <div className="flex-1 text-sm">
        <h4 className="font-semibold text-amber-950 dark:text-amber-100">
          Wave Freeze Window Active
        </h4>
        <p className="mt-1 text-amber-800 dark:text-amber-200">
          {reason ??
            "The roster is currently frozen for Wave payout. Rechecks and address changes are temporarily disabled."}
        </p>
        {(startLabel ?? endLabel) && (
          <p className="mt-1 text-amber-700 dark:text-amber-300">
            {startLabel && (
              <span>
                <span className="font-medium">Starts:</span> {startLabel}
              </span>
            )}
            {startLabel && endLabel && <span className="mx-2">·</span>}
            {endLabel && (
              <span>
                <span className="font-medium">Ends:</span> {endLabel}
              </span>
            )}
          </p>
        )}
      </div>
    </div>
  );
}
