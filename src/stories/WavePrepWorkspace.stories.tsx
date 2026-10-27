import type { Meta, StoryObj } from "@storybook/react";
import { WavePrepWorkspace } from "@/components/WavePrepWorkspace";
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
];

const meta: Meta<typeof WavePrepWorkspace> = {
  title: "Components/WavePrepWorkspace",
  component: WavePrepWorkspace,
  tags: ["autodocs"],
  parameters: {
    layout: "padded",
  },
};

export default meta;
type Story = StoryObj<typeof WavePrepWorkspace>;

/** Ready state populated with wave contributor distribution */
export const ReadyState: Story = {
  args: {
    contributors: mockContributors,
    waveNumber: 5,
    isExporting: false,
  },
};

/** Empty state when no contributors are available */
export const EmptyState: Story = {
  args: {
    contributors: [],
    waveNumber: 5,
    isExporting: false,
  },
};

/** Exporting in-progress state */
export const ExportingState: Story = {
  args: {
    contributors: mockContributors,
    waveNumber: 5,
    isExporting: true,
  },
};

/** Mobile viewport state */
export const MobileView: Story = {
  args: {
    contributors: mockContributors,
    waveNumber: 5,
    isExporting: false,
  },
  parameters: {
    viewport: {
      defaultViewport: "mobile1",
    },
  },
};
