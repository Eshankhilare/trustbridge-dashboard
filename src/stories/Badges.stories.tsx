import type { Meta, StoryObj } from "@storybook/react";
import { TrustlineStatusBadge } from "@/components/TrustlineStatusBadge";
import { VerifiedBadge } from "@/components/VerifiedBadge";

const meta: Meta<typeof TrustlineStatusBadge> = {
  title: "Components/Badges",
  component: TrustlineStatusBadge,
  tags: ["autodocs"],
  parameters: {
    layout: "centered",
  },
};

export default meta;
type Story = StoryObj<typeof TrustlineStatusBadge>;

export const Ready: Story = {
  args: {
    status: "ready",
    showDescription: false,
  },
};

export const LowReserve: Story = {
  args: {
    status: "low_reserve",
    showDescription: false,
  },
};

export const NotReady: Story = {
  args: {
    status: "not_ready",
    showDescription: false,
  },
};

export const ReadyWithDescription: Story = {
  args: {
    status: "ready",
    showDescription: true,
  },
};

export const LowReserveWithDescription: Story = {
  args: {
    status: "low_reserve",
    showDescription: true,
  },
};

export const NotReadyWithDescription: Story = {
  args: {
    status: "not_ready",
    showDescription: true,
  },
};

export const VerifiedStatus: StoryObj<typeof VerifiedBadge> = {
  render: () => (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-4">
        <span className="text-sm font-medium w-24">Full badge:</span>
        <VerifiedBadge verified={true} />
        <VerifiedBadge verified={false} />
      </div>
      <div className="flex items-center gap-4">
        <span className="text-sm font-medium w-24">Compact:</span>
        <VerifiedBadge verified={true} compact={true} />
        <VerifiedBadge verified={false} compact={true} />
      </div>
    </div>
  ),
};
