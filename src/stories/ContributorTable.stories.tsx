import type { Meta, StoryObj } from "@storybook/react";
import { ContributorTable } from "@/components/ContributorTable";
import type { ContributorRow } from "@/types";

const mockContributors: ContributorRow[] = [
  {
    id: "reg-1",
    githubUsername: "alice",
    stellarAddress: "GBX7ABCDEF1234567890ABCDEF1234567890ABCDEF1234567890ABCD",
    funded: true,
    trustlineReady: true,
    trustlineAuthorized: true,
    xlmBalance: "15.5000000",
    spendableXlmBalance: "13.5000000",
    readiness: "ready",
    verified: true,
    lastCheckedAt: new Date(Date.now() - 1000 * 60 * 15).toISOString(),
    banned: false,
    usdcBalance: "0",
    horizonLatencyMs: null,
  },
  {
    id: "reg-2",
    githubUsername: "bob-dev",
    stellarAddress: "GAY2BCDEF1234567890ABCDEF1234567890ABCDEF1234567890ABCD",
    funded: true,
    trustlineReady: true,
    trustlineAuthorized: true,
    xlmBalance: "1.2000000",
    spendableXlmBalance: "0.2000000",
    readiness: "low_reserve",
    verified: false,
    lastCheckedAt: new Date(Date.now() - 1000 * 60 * 60 * 2).toISOString(),
    banned: false,
    usdcBalance: "0",
    horizonLatencyMs: null,
  },
  {
    id: "reg-3",
    githubUsername: "charlie-builder",
    stellarAddress: "GCZ3CDEF1234567890ABCDEF1234567890ABCDEF1234567890ABCD",
    funded: false,
    trustlineReady: false,
    trustlineAuthorized: false,
    xlmBalance: "0.0000000",
    spendableXlmBalance: "0.0000000",
    readiness: "not_ready",
    verified: false,
    lastCheckedAt: new Date(Date.now() - 1000 * 60 * 60 * 24).toISOString(),
    banned: false,
    usdcBalance: "0",
    horizonLatencyMs: null,
  },
  {
    id: "reg-4",
    githubUsername: "dave-maintainer",
    stellarAddress: "GDW4DEF1234567890ABCDEF1234567890ABCDEF1234567890ABCD",
    funded: true,
    trustlineReady: true,
    trustlineAuthorized: true,
    xlmBalance: "500.0000000",
    spendableXlmBalance: "498.0000000",
    readiness: "ready",
    verified: true,
    lastCheckedAt: new Date(Date.now() - 1000 * 60 * 5).toISOString(),
    banned: false,
    usdcBalance: "0",
    horizonLatencyMs: null,
  },
];

const meta: Meta<typeof ContributorTable> = {
  title: "Components/ContributorTable",
  component: ContributorTable,
  tags: ["autodocs"],
  parameters: {
    layout: "padded",
  },
};

export default meta;
type Story = StoryObj<typeof ContributorTable>;

/** Ready / populated state with multiple contributor statuses */
export const ReadyState: Story = {
  args: {
    contributors: mockContributors,
    viewerRole: "maintainer",
    registerUrl: "/register",
    hasMore: false,
    isLoading: false,
  },
};

/** Empty state when no contributors are registered */
export const EmptyStateMaintainer: Story = {
  args: {
    contributors: [],
    viewerRole: "maintainer",
    registerUrl: "/register",
    hasMore: false,
    isLoading: false,
  },
};

/** Empty state for a single contributor view */
export const EmptyStateContributor: Story = {
  args: {
    contributors: [],
    viewerRole: "contributor",
    registerUrl: "/register",
    hasMore: false,
    isLoading: false,
  },
};

/** Loading state */
export const LoadingState: Story = {
  args: {
    contributors: [],
    viewerRole: "maintainer",
    isLoading: true,
  },
};

/** Mobile viewport state */
export const MobileView: Story = {
  args: {
    contributors: mockContributors,
    viewerRole: "maintainer",
    registerUrl: "/register",
  },
  parameters: {
    viewport: {
      defaultViewport: "mobile1",
    },
  },
};
