"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Globe, Lock, ExternalLink } from "lucide-react";
import { useSession } from "next-auth/react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { ProfilePrivacySettings } from "@/types";

const PRIVACY_QUERY_KEY = ["profile-privacy"] as const;

interface PrivacyResponse {
  settings: ProfilePrivacySettings;
}

export function ProfilePrivacyPanel() {
  const { data: session } = useSession();
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: PRIVACY_QUERY_KEY,
    queryFn: async (): Promise<PrivacyResponse> => {
      const res = await fetch("/api/profile");
      if (!res.ok) throw new Error("Failed to load privacy settings");
      return res.json() as Promise<PrivacyResponse>;
    },
    enabled: !!session,
  });

  const mutation = useMutation({
    mutationFn: async (settings: ProfilePrivacySettings) => {
      const res = await fetch("/api/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(settings),
      });
      if (!res.ok) throw new Error("Failed to update privacy settings");
      return res.json() as Promise<PrivacyResponse>;
    },
    onSuccess: (updated) => {
      queryClient.setQueryData<PrivacyResponse>(PRIVACY_QUERY_KEY, updated);
    },
  });

  const settings = data?.settings ?? { profilePublic: false, showStellarAddress: false };
  const username = session?.user?.githubUsername;

  // Signed-out visitors get nothing: the toggles PATCH an authenticated
  // endpoint, so rendering them without a session would only produce 401s.
  if (!session) {
    return null;
  }

  function toggle(field: keyof ProfilePrivacySettings) {
    const next = { ...settings };
    next[field] = !next[field];
    // Coerce: address can't be shown on a private profile
    if (!next.profilePublic) next.showStellarAddress = false;
    // Coerce: must be public before showing address
    if (field === "showStellarAddress" && next.showStellarAddress) {
      next.profilePublic = true;
    }
    mutation.mutate(next);
  }

  return (
    <Card data-testid="profile-privacy-panel">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {settings.profilePublic ? (
            <Globe className="h-4 w-4 text-emerald-500" aria-hidden />
          ) : (
            <Lock className="h-4 w-4 text-muted-foreground" aria-hidden />
          )}
          Profile visibility
        </CardTitle>
        <CardDescription>
          Control what others can see at your public profile link.
          Defaults to private.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium">Public profile</p>
            <p className="text-xs text-muted-foreground">
              Show username and readiness at{" "}
              {username ? (
                <code className="text-xs">/profile/{username}</code>
              ) : (
                "your profile URL"
              )}
            </p>
          </div>
          <Button
            variant={settings.profilePublic ? "outline" : "stellar"}
            size="sm"
            disabled={isLoading || mutation.isPending}
            onClick={() => toggle("profilePublic")}
            aria-pressed={settings.profilePublic}
            data-testid="toggle-profile-public"
          >
            {settings.profilePublic ? "Make private" : "Make public"}
          </Button>
        </div>

        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium">Show Stellar address</p>
            <p className="text-xs text-muted-foreground">
              Display your G-address on your public profile.
              Requires public profile to be enabled.
            </p>
          </div>
          <Button
            variant={settings.showStellarAddress ? "outline" : "ghost"}
            size="sm"
            disabled={isLoading || mutation.isPending || !settings.profilePublic}
            onClick={() => toggle("showStellarAddress")}
            aria-pressed={settings.showStellarAddress}
            data-testid="toggle-show-address"
            aria-describedby="address-visibility-note"
          >
            {settings.showStellarAddress ? "Hide address" : "Show address"}
          </Button>
        </div>
        {!settings.profilePublic && (
          <p
            id="address-visibility-note"
            className="text-xs text-muted-foreground"
            role="note"
          >
            Enable public profile first to control address visibility.
          </p>
        )}

        {settings.profilePublic && username && (
          <div className="rounded-md border bg-muted/40 px-3 py-2">
            <p className="text-xs text-muted-foreground">Your public profile</p>
            <Link
              href={`/profile/${username}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-sm font-medium hover:underline"
            >
              /profile/{username}
              <ExternalLink className="h-3 w-3" aria-hidden />
            </Link>
          </div>
        )}

        {mutation.isError && (
          <p className="text-xs text-destructive" role="alert" aria-live="polite">
            Failed to save. Please try again.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
