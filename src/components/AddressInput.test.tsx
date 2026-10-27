import React from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AddressInput } from "@/components/AddressInput";

const VALID =
  "GDXNXL25GDM3N5LAR5FALA3VSGHFET3EOKLXRP3ITPPMR3PISTQSKSFS";

vi.mock("qrcode", () => ({
  default: {
    toDataURL: vi.fn().mockResolvedValue("data:image/png;base64,qr"),
  },
}));

const readyBody = {
  funded: true,
  trustline: true,
  trustline_authorized: true,
  verified: false,
  xlm_balance: "5",
  spendable_xlm_balance: "4",
  usdc_balance: "0",
  errors: [],
  readiness: "ready",
};

/** Build a minimal `Response`-shaped mock for `global.fetch`. */
function mockResponse({
  status = 200,
  ok = status >= 200 && status < 300,
  body,
  retryAfter,
}: {
  status?: number;
  ok?: boolean;
  body: unknown;
  retryAfter?: string;
}) {
  return {
    status,
    ok,
    json: async () => body,
    headers: {
      get: (name: string) =>
        name.toLowerCase() === "retry-after" ? (retryAfter ?? null) : null,
    },
  };
}

describe("AddressInput QR and copy", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    });
    global.fetch = vi
      .fn()
      .mockResolvedValue(
        mockResponse({ status: 200, body: readyBody })
      ) as unknown as typeof fetch;
  });

  it("does not show QR or enable copy for invalid addresses", () => {
    render(<AddressInput value="GNOTVALID" onChange={() => {}} />);

    expect(screen.queryByTestId("address-qr")).not.toBeInTheDocument();
    expect(screen.getByTestId("copy-address")).toBeDisabled();
    expect(screen.getByTestId("address-invalid-hint")).toBeInTheDocument();
  });

  it("shows QR and copies a valid G-address with confirmation", async () => {
    render(<AddressInput value={VALID} onChange={() => {}} />);

    await waitFor(() => {
      expect(screen.getByTestId("address-qr")).toBeInTheDocument();
    });

    const img = screen.getByRole("img", {
      name: new RegExp(`QR code for Stellar address ${VALID}`),
    });
    expect(img).toHaveAttribute("src", "data:image/png;base64,qr");

    fireEvent.click(screen.getByTestId("copy-address"));

    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(VALID);
      expect(screen.getByTestId("copy-address")).toHaveTextContent("Copied");
      expect(screen.getByTestId("copy-address-status")).toHaveTextContent(
        /Address copied to clipboard/i
      );
    });
  });

  it("shows the ready readiness result once the check resolves", async () => {
    render(<AddressInput value={VALID} onChange={() => {}} />);

    await waitFor(() => {
      expect(screen.getByTestId("address-check-result")).toBeInTheDocument();
    });
    expect(screen.getByTestId("readiness-badge-ready")).toBeInTheDocument();
  });
});

describe("AddressInput check progress states", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  it("shows a rate-limited message with retry-after seconds on a 429", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      mockResponse({
        status: 429,
        ok: false,
        body: { errors: ["Rate limit exceeded. Please try again later."] },
        // Small value: the component awaits checkAddressViaApi, which honors
        // Retry-After between attempts; a large value would stall the test.
        retryAfter: "1",
      })
    ) as unknown as typeof fetch;

    render(<AddressInput value={VALID} onChange={() => {}} />);

    await waitFor(
      () => {
        expect(screen.getByTestId("address-check-status")).toHaveTextContent(
          /try again in 1s/i
        );
      },
      { timeout: 10000 }
    );
    // The generic result block (readiness badge etc.) must not render for
    // a rate-limited outcome — it isn't a HorizonCheckResult.
    expect(
      screen.queryByTestId("address-check-result")
    ).not.toBeInTheDocument();
  });

  it("shows a circuit-open message for a 200 response with a transient Horizon error", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      mockResponse({
        status: 200,
        body: {
          funded: false,
          trustline: false,
          trustline_authorized: false,
          verified: false,
          xlm_balance: "0",
          spendable_xlm_balance: "0",
          usdc_balance: "0",
          errors: [
            "Horizon is temporarily unavailable. Please try again later.",
          ],
          readiness: "not_ready",
        },
      })
    ) as unknown as typeof fetch;

    render(<AddressInput value={VALID} onChange={() => {}} />);

    await waitFor(() => {
      expect(screen.getByTestId("address-check-status")).toHaveTextContent(
        /temporarily unavailable/i
      );
    });
    expect(
      screen.queryByTestId("address-check-result")
    ).not.toBeInTheDocument();
  });

  it("shows a timeout message when the fetch is aborted", async () => {
    const abortError = Object.assign(new Error("The operation was aborted."), {
      name: "AbortError",
    });
    global.fetch = vi.fn().mockRejectedValue(abortError) as unknown as typeof fetch;

    render(<AddressInput value={VALID} onChange={() => {}} />);

    await waitFor(() => {
      expect(screen.getByTestId("address-check-status")).toHaveTextContent(
        /timed out/i
      );
    });
  });

  it("shows a generic error message on a plain network failure", async () => {
    global.fetch = vi
      .fn()
      .mockRejectedValue(new TypeError("Failed to fetch")) as unknown as typeof fetch;

    render(<AddressInput value={VALID} onChange={() => {}} />);

    await waitFor(() => {
      expect(screen.getByTestId("address-check-status")).toHaveTextContent(
        /unable to reach validation service/i
      );
    });
  });

  it("marks the input aria-busy while a check is in flight", async () => {
    let resolveFetch: (value: unknown) => void = () => {};
    global.fetch = vi.fn().mockReturnValue(
      new Promise((resolve) => {
        resolveFetch = resolve;
      })
    ) as unknown as typeof fetch;

    render(<AddressInput value={VALID} onChange={() => {}} />);

    await waitFor(() => {
      expect(screen.getByTestId("stellar-address-input")).toHaveAttribute(
        "aria-busy",
        "true"
      );
    });

    resolveFetch(mockResponse({ status: 200, body: readyBody }));

    await waitFor(() => {
      expect(screen.getByTestId("stellar-address-input")).toHaveAttribute(
        "aria-busy",
        "false"
      );
    });
  });
});
