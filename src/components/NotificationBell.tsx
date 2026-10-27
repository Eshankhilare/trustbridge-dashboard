"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, Check, CheckCheck, Inbox, Loader2 } from "lucide-react";
import { useSession } from "next-auth/react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface NotificationItem {
  id: string;
  type: string;
  title: string;
  body: string;
  read: boolean;
  createdAt: string;
}

interface NotificationsApiResponse {
  notifications: NotificationItem[];
  unreadCount: number;
}

const NOTIFICATIONS_QUERY_KEY = ["notifications"] as const;

export function NotificationBell() {
  const { data: session } = useSession();
  const queryClient = useQueryClient();

  const [isOpen, setIsOpen] = React.useState(false);

  const bellButtonRef = React.useRef<HTMLButtonElement | null>(null);
  const popoverRef = React.useRef<HTMLDivElement | null>(null);

  const titleId = React.useId();
  const popoverId = React.useId();

  // Fetch notifications with lightweight 30s background polling
  const { data, isLoading } = useQuery({
    queryKey: NOTIFICATIONS_QUERY_KEY,
    queryFn: async (): Promise<NotificationsApiResponse> => {
      const res = await fetch("/api/notifications");
      if (!res.ok) throw new Error("Failed to load notifications");
      return res.json() as Promise<NotificationsApiResponse>;
    },
    enabled: !!session,
    refetchInterval: 30_000,
  });

  const notifications = data?.notifications ?? [];
  const unreadCount = data?.unreadCount ?? 0;

  // Mark notification(s) as read
  const markReadMutation = useMutation({
    mutationFn: async (payload: { notificationIds?: string[]; all?: boolean }) => {
      const res = await fetch("/api/notifications", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error("Failed to mark notifications as read");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: NOTIFICATIONS_QUERY_KEY });
    },
  });

  const togglePopover = React.useCallback(() => {
    setIsOpen((open) => !open);
  }, []);

  const closePopover = React.useCallback(() => {
    setIsOpen(false);
    bellButtonRef.current?.focus();
  }, []);

  // Keyboard accessibility (ESC key to close, Tab focus management)
  React.useEffect(() => {
    if (!isOpen) return;

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.stopPropagation();
        closePopover();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, closePopover]);

  // Click outside to close
  React.useEffect(() => {
    if (!isOpen) return;

    function handlePointerDown(event: PointerEvent) {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(event.target as Node) &&
        bellButtonRef.current &&
        !bellButtonRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
      }
    }

    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [isOpen]);

  if (!session) return null;

  const bellLabel = unreadCount > 0
    ? `Notifications, ${unreadCount} unread`
    : "Notifications, no unread";

  return (
    <div className="relative inline-block text-left">
      <Button
        ref={bellButtonRef}
        variant="ghost"
        size="icon"
        aria-expanded={isOpen}
        aria-haspopup="dialog"
        aria-controls={popoverId}
        aria-label={bellLabel}
        onClick={togglePopover}
        data-testid="notification-bell-button"
        className="relative"
      >
        <Bell className="h-4 w-4" aria-hidden="true" />
        {unreadCount > 0 && (
          <span
            data-testid="notification-badge"
            className="absolute -right-0.5 -top-0.5 flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-stellar-purple px-1 text-[10px] font-bold text-white shadow-sm"
          >
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        )}
      </Button>

      {isOpen && (
        <div
          ref={popoverRef}
          id={popoverId}
          role="dialog"
          aria-modal="false"
          aria-labelledby={titleId}
          data-testid="notification-popover"
          className={cn(
            "absolute right-0 top-full z-50 mt-2 w-80 sm:w-96 rounded-lg border border-border bg-background shadow-xl",
            "animate-in fade-in-0 zoom-in-95"
          )}
        >
          {/* Header */}
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <div className="flex items-center gap-2">
              <h2 id={titleId} className="text-sm font-semibold">
                Notifications
              </h2>
              {unreadCount > 0 && (
                <span className="rounded-full bg-stellar-purple/15 px-2 py-0.5 text-xs font-medium text-stellar-purple">
                  {unreadCount} new
                </span>
              )}
            </div>

            {unreadCount > 0 && (
              <Button
                variant="ghost"
                size="sm"
                className="h-8 text-xs text-muted-foreground hover:text-foreground"
                aria-label="Mark all notifications as read"
                onClick={() => markReadMutation.mutate({ all: true })}
                disabled={markReadMutation.isPending}
                data-testid="mark-all-read-button"
              >
                <CheckCheck className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
                Mark all read
              </Button>
            )}
          </div>

          {/* Screen reader live region */}
          <div className="sr-only" aria-live="polite" aria-atomic="true">
            {unreadCount > 0
              ? `You have ${unreadCount} unread notification${unreadCount === 1 ? "" : "s"}`
              : "No unread notifications"}
          </div>

          {/* Body List */}
          <div className="max-h-80 overflow-y-auto p-1">
            {isLoading ? (
              <div className="flex items-center justify-center p-6 text-muted-foreground">
                <Loader2 className="h-5 w-5 animate-spin mr-2" aria-hidden="true" />
                <span className="text-xs">Loading notifications...</span>
              </div>
            ) : notifications.length === 0 ? (
              <div className="flex flex-col items-center justify-center p-8 text-center text-muted-foreground">
                <Inbox className="h-8 w-8 mb-2 opacity-50" aria-hidden="true" />
                <p className="text-sm font-medium">No notifications</p>
                <p className="text-xs">You are all caught up!</p>
              </div>
            ) : (
              <ul role="list" className="space-y-1">
                {notifications.map((item) => (
                  <li
                    key={item.id}
                    role="listitem"
                    className={cn(
                      "group relative flex items-start justify-between gap-2 rounded-md p-3 text-left text-xs transition-colors",
                      item.read
                        ? "bg-transparent text-muted-foreground hover:bg-muted/50"
                        : "bg-stellar-purple/5 text-foreground hover:bg-stellar-purple/10 font-medium"
                    )}
                  >
                    <div className="flex-1 space-y-1">
                      <div className="flex items-center justify-between gap-2">
                        <p className="font-semibold text-foreground">{item.title}</p>
                        <time
                          dateTime={item.createdAt}
                          className="shrink-0 text-[10px] text-muted-foreground"
                        >
                          {new Date(item.createdAt).toLocaleTimeString([], {
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </time>
                      </div>
                      <p className="text-muted-foreground leading-relaxed break-words">{item.body}</p>
                    </div>

                    {!item.read && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 shrink-0 opacity-70 group-hover:opacity-100"
                        aria-label={`Mark "${item.title}" as read`}
                        onClick={() =>
                          markReadMutation.mutate({ notificationIds: [item.id] })
                        }
                        disabled={markReadMutation.isPending}
                      >
                        <Check className="h-3.5 w-3.5 text-emerald-500" aria-hidden="true" />
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
