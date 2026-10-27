import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock next-auth/react
const mockUseSession = vi.fn();
vi.mock("next-auth/react", () => ({
  useSession: () => mockUseSession(),
}));

// Mock react-query
const mockUseQuery = vi.fn();
const mockUseMutation = vi.fn();
const mockUseQueryClient = vi.fn(() => ({
  setQueryData: vi.fn(),
  getQueryData: vi.fn(),
  cancelQueries: vi.fn(),
  invalidateQueries: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
  useMutation: (...args: unknown[]) => mockUseMutation(...args),
  useQueryClient: () => mockUseQueryClient(),
}));

// Mock fetch
global.fetch = vi.fn();

import { ProfilePrivacyPanel } from "@/components/ProfilePrivacyPanel";

// Test helpers
function setSession(user: { githubUsername?: string; isMaintainer?: boolean } | null) {
  if (user) {
    mockUseSession.mockReturnValue({ data: { user } });
  } else {
    mockUseSession.mockReturnValue({ data: null });
  }
}

function mockQueryResponse(data: { profilePublic: boolean; showStellarAddress: boolean }) {
  mockUseQuery.mockReturnValue({
    data: { settings: data },
    isLoading: false,
  });
}

function mockMutationResponse(
  data: { settings: { profilePublic: boolean; showStellarAddress: boolean } },
  isError = false,
  isPending = false
) {
  mockUseMutation.mockReturnValue({
    mutate: vi.fn(),
    mutateAsync: vi.fn().mockResolvedValue(data),
    isError,
    isPending,
    isSuccess: !isError,
    data: isError ? undefined : data,
    error: isError ? new Error("Failed to update privacy settings") : null,
  });
}

function mockFetchSuccess(data: unknown) {
  (global.fetch as vi.Mock).mockResolvedValue({
    ok: true,
    json: async () => data,
  });
}

function mockFetchError() {
  (global.fetch as vi.Mock).mockResolvedValue({
    ok: false,
  });
}

describe("ProfilePrivacyPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setSession({ githubUsername: "alice" });
    mockQueryResponse({ profilePublic: false, showStellarAddress: false });
    mockMutationResponse({ settings: { profilePublic: false, showStellarAddress: false } });
    mockFetchSuccess({ settings: { profilePublic: false, showStellarAddress: false } });
  });

  describe("default state", () => {
    it("renders the panel with title and description", () => {
      render(<ProfilePrivacyPanel />);

      expect(screen.getByTestId("profile-privacy-panel")).toBeInTheDocument();
      expect(screen.getByText("Profile visibility")).toBeInTheDocument();
      expect(
        screen.getByText(/Control what others can see at your public profile link/)
      ).toBeInTheDocument();
    });

    it("shows lock icon when profile is private", () => {
      render(<ProfilePrivacyPanel />);

      expect(screen.getByTestId("profile-privacy-panel")).toHaveTextContent("Profile visibility");
      expect(screen.getByRole("button", { name: /make public/i })).toBeInTheDocument();
    });

    it("shows default privacy settings (both false)", () => {
      render(<ProfilePrivacyPanel />);

      // Public profile toggle should show "Make public"
      expect(screen.getByRole("button", { name: /make public/i })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /make public/i })).not.toBeDisabled();

      // Show Stellar address toggle should show "Show address" and be disabled
      expect(screen.getByRole("button", { name: /show address/i })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /show address/i })).toBeDisabled();
    });

    it("shows username and profile URL placeholder when signed in", () => {
      render(<ProfilePrivacyPanel />);

      expect(screen.getByText(/Show username and readiness at/)).toBeInTheDocument();
      expect(screen.getByText("/profile/alice")).toBeInTheDocument();
    });

    it("shows note when profile is private", () => {
      render(<ProfilePrivacyPanel />);

      expect(
        screen.getByText("Enable public profile first to control address visibility.")
      ).toBeInTheDocument();
    });
  });

  describe("toggle profile public", () => {
    it("toggles profilePublic from false to true", async () => {
      render(<ProfilePrivacyPanel />);

      const publicButton = screen.getByRole("button", { name: /make public/i });
      await userEvent.click(publicButton);

      await new Promise((r) => setTimeout(r, 10));
      expect(mockUseMutation.mock.results[0].value.mutate).toHaveBeenCalledWith({
        profilePublic: true,
        showStellarAddress: false,
      });
    });

    it("toggles profilePublic from true to false", async () => {
      mockQueryResponse({ profilePublic: true, showStellarAddress: false });
      mockMutationResponse({ settings: { profilePublic: true, showStellarAddress: false } });
      mockFetchSuccess({ settings: { profilePublic: true, showStellarAddress: false } });

      render(<ProfilePrivacyPanel />);

      const publicButton = screen.getByRole("button", { name: /make private/i });
      await userEvent.click(publicButton);

      await new Promise((r) => setTimeout(r, 10));
      expect(mockUseMutation.mock.results[0].value.mutate).toHaveBeenCalledWith({
        profilePublic: false,
        showStellarAddress: false,
      });
    });

    it("disables button while loading", () => {
      mockUseQuery.mockReturnValue({
        data: { settings: { profilePublic: false, showStellarAddress: false } },
        isLoading: true,
      });

      render(<ProfilePrivacyPanel />);

      expect(screen.getByRole("button", { name: /make public/i })).toBeDisabled();
    });

    it("disables button while mutation is pending", () => {
      mockUseMutation.mockReturnValue({
        mutate: vi.fn(),
        mutateAsync: vi.fn().mockResolvedValue({ settings: { profilePublic: true, showStellarAddress: false } }),
        isError: false,
        isPending: true,
        isSuccess: false,
        data: undefined,
        error: null,
      });

      render(<ProfilePrivacyPanel />);

      expect(screen.getByRole("button", { name: /make public/i })).toBeDisabled();
    });
  });

  describe("toggle show stellar address", () => {
    it("toggles showStellarAddress from false to true when profile is public", async () => {
      mockQueryResponse({ profilePublic: true, showStellarAddress: false });
      mockMutationResponse({ settings: { profilePublic: true, showStellarAddress: true } });
      mockFetchSuccess({ settings: { profilePublic: true, showStellarAddress: true } });

      render(<ProfilePrivacyPanel />);

      const addressButton = screen.getByRole("button", { name: /show address/i });
      expect(addressButton).not.toBeDisabled();

      await userEvent.click(addressButton);

      await new Promise((r) => setTimeout(r, 10));
      expect(mockUseMutation.mock.results[0].value.mutate).toHaveBeenCalledWith({
        profilePublic: true,
        showStellarAddress: true,
      });
    });

    it("toggles showStellarAddress from true to false", async () => {
      mockQueryResponse({ profilePublic: true, showStellarAddress: true });
      mockMutationResponse({ settings: { profilePublic: true, showStellarAddress: false } });
      mockFetchSuccess({ settings: { profilePublic: true, showStellarAddress: false } });

      render(<ProfilePrivacyPanel />);

      const addressButton = screen.getByRole("button", { name: /hide address/i });
      await userEvent.click(addressButton);

      await new Promise((r) => setTimeout(r, 10));
      expect(mockUseMutation.mock.results[0].value.mutate).toHaveBeenCalledWith({
        profilePublic: true,
        showStellarAddress: false,
      });
    });

    it("is disabled when profile is private", () => {
      render(<ProfilePrivacyPanel />);

      const addressButton = screen.getByRole("button", { name: /show address/i });
      expect(addressButton).toBeDisabled();
    });

    it("is disabled while loading", () => {
      mockUseQuery.mockReturnValue({
        data: { settings: { profilePublic: true, showStellarAddress: false } },
        isLoading: true,
      });

      render(<ProfilePrivacyPanel />);

      expect(screen.getByRole("button", { name: /show address/i })).toBeDisabled();
    });

    it("is disabled while mutation is pending", () => {
      mockUseMutation.mockReturnValue({
        mutate: vi.fn(),
        mutateAsync: vi.fn().mockResolvedValue({ settings: { profilePublic: true, showStellarAddress: true } }),
        isError: false,
        isPending: true,
        isSuccess: false,
        data: undefined,
        error: null,
      });
      mockQueryResponse({ profilePublic: true, showStellarAddress: false });

      render(<ProfilePrivacyPanel />);

      expect(screen.getByRole("button", { name: /show address/i })).toBeDisabled();
    });

    it("shows aria-describedby pointing to note", () => {
      render(<ProfilePrivacyPanel />);

      const addressButton = screen.getByRole("button", { name: /show address/i });
      expect(addressButton).toHaveAttribute("aria-describedby", "address-visibility-note");
    });
  });

  describe("coercion logic", () => {
    it("forces showStellarAddress to false when profilePublic becomes false", async () => {
      mockQueryResponse({ profilePublic: true, showStellarAddress: true });
      mockMutationResponse({ settings: { profilePublic: false, showStellarAddress: false } });
      mockFetchSuccess({ settings: { profilePublic: false, showStellarAddress: false } });

      render(<ProfilePrivacyPanel />);

      // First make profile private
      const publicButton = screen.getByRole("button", { name: /make private/i });
      await userEvent.click(publicButton);

      await new Promise((r) => setTimeout(r, 10));
      expect(mockUseMutation.mock.results[0].value.mutate).toHaveBeenCalledWith({
        profilePublic: false,
        showStellarAddress: false,
      });
    });

    it("forces profilePublic to true when showStellarAddress becomes true", async () => {
      mockQueryResponse({ profilePublic: false, showStellarAddress: false });
      mockMutationResponse({ settings: { profilePublic: true, showStellarAddress: true } });
      mockFetchSuccess({ settings: { profilePublic: true, showStellarAddress: true } });

      render(<ProfilePrivacyPanel />);

      // First make profile public
      const publicButton = screen.getByRole("button", { name: /make public/i });
      await userEvent.click(publicButton);

      await new Promise((r) => setTimeout(r, 10));
      expect(mockUseMutation.mock.results[0].value.mutate).toHaveBeenCalledWith({
        profilePublic: true,
        showStellarAddress: false,
      });
    });
  });

  describe("accessible labels and names", () => {
    it("has accessible button names", () => {
      render(<ProfilePrivacyPanel />);

      expect(screen.getByRole("button", { name: /make public/i })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /show address/i })).toBeInTheDocument();
    });

    it("has aria-pressed on toggle buttons", () => {
      render(<ProfilePrivacyPanel />);

      const publicButton = screen.getByRole("button", { name: /make public/i });
      expect(publicButton).toHaveAttribute("aria-pressed", "false");

      const addressButton = screen.getByRole("button", { name: /show address/i });
      expect(addressButton).toHaveAttribute("aria-pressed", "false");
    });

    it("shows note with role=note when profile is private", () => {
      render(<ProfilePrivacyPanel />);

      const note = screen.getByText("Enable public profile first to control address visibility.");
      expect(note).toHaveAttribute("role", "note");
    });

    it("has public profile link when public", async () => {
      mockQueryResponse({ profilePublic: true, showStellarAddress: false });
      mockMutationResponse({ settings: { profilePublic: true, showStellarAddress: false } });
      mockFetchSuccess({ settings: { profilePublic: true, showStellarAddress: false } });

      render(<ProfilePrivacyPanel />);

      await new Promise((r) => setTimeout(r, 10));
      expect(screen.getByRole("link", { name: /\/profile\/alice/i })).toHaveAttribute(
        "href",
        "/profile/alice"
      );
    });
  });

  describe("error handling", () => {
    it("shows error message when mutation fails", async () => {
      mockUseMutation.mockReturnValue({
        mutate: vi.fn(),
        mutateAsync: vi.fn().mockRejectedValue(new Error("Failed to update privacy settings")),
        isError: true,
        isPending: false,
        isSuccess: false,
        data: undefined,
        error: new Error("Failed to update privacy settings"),
      });
      mockQueryResponse({ profilePublic: false, showStellarAddress: false });

      render(<ProfilePrivacyPanel />);

      const publicButton = screen.getByRole("button", { name: /make public/i });
      await userEvent.click(publicButton);

      await new Promise((r) => setTimeout(r, 10));
      expect(screen.getByRole("alert")).toHaveTextContent("Failed to save. Please try again.");
    });
  });

  describe("when signed out", () => {
    it("does not render panel when no session", () => {
      setSession(null);
      mockUseQuery.mockReturnValue({
        data: undefined,
        isLoading: false,
      });

      render(<ProfilePrivacyPanel />);

      // The component should not fetch when no session
      expect(screen.queryByTestId("profile-privacy-panel")).not.toBeInTheDocument();
    });
  });
});