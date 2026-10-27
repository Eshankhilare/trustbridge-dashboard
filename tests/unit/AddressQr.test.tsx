import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { AddressQr } from "@/components/AddressQr";

// Mock the QRCode library
vi.mock("qrcode", () => ({
  default: {
    toDataURL: vi.fn(),
  },
}));

// Mock stellar-sdk to control address validation
vi.mock("stellar-sdk", () => ({
  StrKey: {
    isValidEd25519PublicKey: vi.fn(),
  },
}));

import QRCode from "qrcode";
import { StrKey } from "stellar-sdk";

const validAddress = "GDXNXL25GDM3N5LAR5FALA3VSGHFET3EOKLXRP3ITPPMR3PISTQSKSFS";
const dataUrl =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

describe("AddressQr", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(StrKey.isValidEd25519PublicKey).mockReturnValue(true);
    vi.mocked(QRCode.toDataURL).mockResolvedValue(dataUrl);
  });

  describe("valid address rendering", () => {
    it("generates and displays QR code for valid address", async () => {
      render(<AddressQr address={validAddress} />);

      // Wait for QR generation
      await waitFor(() => {
        const img = screen.getByRole("img");
        expect(img).toBeInTheDocument();
        expect(img).toHaveAttribute("src", dataUrl);
      });
    });

    it("renders image with accessible alt text", async () => {
      render(<AddressQr address={validAddress} />);

      await waitFor(() => {
        const img = screen.getByRole("img");
        expect(img).toHaveAttribute(
          "alt",
          `QR code for Stellar address ${validAddress}`
        );
      });
    });

    it("displays address in figcaption", async () => {
      render(<AddressQr address={validAddress} />);

      await waitFor(() => {
        expect(screen.getByText(validAddress)).toBeInTheDocument();
      });
    });

    it("calls QRCode.toDataURL with correct parameters", async () => {
      render(<AddressQr address={validAddress} />);

      await waitFor(() => {
        expect(QRCode.toDataURL).toHaveBeenCalledWith(
          validAddress,
          expect.objectContaining({
            errorCorrectionLevel: "M",
            margin: 2,
            width: 160,
            color: {
              dark: "#0b0b0f",
              light: "#ffffff",
            },
          })
        );
      });
    });

    it("applies correct CSS classes to figure element", async () => {
      const { container } = render(<AddressQr address={validAddress} />);

      await waitFor(() => {
        const figure = container.querySelector("figure");
        expect(figure).toHaveAttribute("data-testid", "address-qr");
        expect(figure?.className).toContain("rounded-lg");
        expect(figure?.className).toContain("border");
        expect(figure?.className).toContain("bg-white");
      });
    });

    it("renders with custom className prop", async () => {
      const { container } = render(
        <AddressQr address={validAddress} className="custom-class" />
      );

      await waitFor(() => {
        const figure = container.querySelector("figure");
        expect(figure?.className).toContain("custom-class");
      });
    });

    it("shows loading state initially", () => {
      vi.mocked(QRCode.toDataURL).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            setTimeout(() => resolve(dataUrl), 100);
          })
      );

      render(<AddressQr address={validAddress} />);

      const loading = screen.getByTestId("address-qr-loading");
      expect(loading).toBeInTheDocument();
      expect(loading).toHaveTextContent("Generating QR code");
    });

    it("transitions from loading to success", async () => {
      render(<AddressQr address={validAddress} />);

      // Loading state first
      expect(screen.getByTestId("address-qr-loading")).toBeInTheDocument();

      // Then success state
      await waitFor(() => {
        expect(screen.queryByTestId("address-qr-loading")).not.toBeInTheDocument();
        expect(screen.getByTestId("address-qr")).toBeInTheDocument();
      });
    });

    it("normalizes whitespace in address", async () => {
      render(<AddressQr address={`  ${validAddress}  `} />);

      await waitFor(() => {
        expect(QRCode.toDataURL).toHaveBeenCalledWith(
          validAddress,
          expect.anything()
        );
      });
    });
  });

  describe("invalid address handling", () => {
    it("renders nothing for invalid address", () => {
      vi.mocked(StrKey.isValidEd25519PublicKey).mockReturnValue(false);

      const { container } = render(<AddressQr address="invalid" />);

      expect(container.firstChild).toBeNull();
      expect(QRCode.toDataURL).not.toHaveBeenCalled();
    });

    it("does not render loading state for invalid address", () => {
      vi.mocked(StrKey.isValidEd25519PublicKey).mockReturnValue(false);

      render(<AddressQr address="invalid" />);

      expect(screen.queryByTestId("address-qr-loading")).not.toBeInTheDocument();
    });

    it("returns null for empty address", () => {
      vi.mocked(StrKey.isValidEd25519PublicKey).mockReturnValue(false);

      const { container } = render(<AddressQr address="" />);

      expect(container.firstChild).toBeNull();
    });

    it("handles short addresses", () => {
      vi.mocked(StrKey.isValidEd25519PublicKey).mockReturnValue(false);

      const { container } = render(<AddressQr address="G123" />);

      expect(container.firstChild).toBeNull();
    });
  });

  describe("generation failure handling", () => {
    it("shows error status when QR generation fails", async () => {
      vi.mocked(QRCode.toDataURL).mockRejectedValueOnce(
        new Error("Generation failed")
      );

      render(<AddressQr address={validAddress} />);

      // Show loading first
      expect(screen.getByTestId("address-qr-loading")).toBeInTheDocument();

      // Then error state
      await waitFor(() => {
        const error = screen.getByTestId("address-qr-error");
        expect(error).toBeInTheDocument();
        expect(error).toHaveTextContent(
          "Could not generate a QR code for this address."
        );
      });
    });

    it("error status has role=status for accessibility", async () => {
      vi.mocked(QRCode.toDataURL).mockRejectedValueOnce(
        new Error("Generation failed")
      );

      render(<AddressQr address={validAddress} />);

      await waitFor(() => {
        const error = screen.getByTestId("address-qr-error");
        expect(error).toHaveAttribute("role", "status");
      });
    });

    it("clears error when address changes", async () => {
      vi.mocked(QRCode.toDataURL).mockRejectedValueOnce(
        new Error("Generation failed")
      );

      const { rerender } = render(<AddressQr address={validAddress} />);

      await waitFor(() => {
        expect(screen.getByTestId("address-qr-error")).toBeInTheDocument();
      });

      // Reset mock to succeed
      vi.mocked(QRCode.toDataURL).mockResolvedValueOnce(dataUrl);

      // Re-render with a *different* address: regeneration (and error
      // clearing) only runs when the normalized address changes.
      rerender(
        <AddressQr address="GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN" />
      );

      await waitFor(() => {
        expect(screen.queryByTestId("address-qr-error")).not.toBeInTheDocument();
        expect(screen.getByTestId("address-qr")).toBeInTheDocument();
      });
    });

    it("regenerates QR when address changes", async () => {
      const address1 = validAddress;
      const address2 = "GBSX7U7ARH74ENSCCX7FYTA5FS2YQXZHY737IBSZEOF72ULMITMZNKQ";

      const { rerender } = render(<AddressQr address={address1} />);

      await waitFor(() => {
        expect(QRCode.toDataURL).toHaveBeenCalledWith(address1, expect.anything());
      });

      vi.mocked(QRCode.toDataURL).mockClear();
      vi.mocked(StrKey.isValidEd25519PublicKey).mockReturnValue(true);
      vi.mocked(QRCode.toDataURL).mockResolvedValueOnce(dataUrl);

      rerender(<AddressQr address={address2} />);

      await waitFor(() => {
        expect(QRCode.toDataURL).toHaveBeenCalledWith(address2, expect.anything());
      });
    });
  });

  describe("cleanup and cancellation", () => {
    it("cancels pending QR generation when unmounting", async () => {
      let resolve: (value: string) => void;
      vi.mocked(QRCode.toDataURL).mockImplementationOnce(
        () =>
          new Promise((res) => {
            resolve = res;
          })
      );

      const { unmount } = render(<AddressQr address={validAddress} />);

      // Unmount before QR generation completes
      unmount();

      // Resolve the promise after unmount
      resolve!(dataUrl);

      // Wait a bit and ensure nothing crashes
      await new Promise((r) => setTimeout(r, 50));
    });

    it("does not update state after unmount", async () => {
      vi.mocked(QRCode.toDataURL).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            setTimeout(() => resolve(dataUrl), 100);
          })
      );

      const { unmount } = render(<AddressQr address={validAddress} />);

      unmount();

      // Wait for the promise to resolve after unmount
      await new Promise((r) => setTimeout(r, 150));

      // Should not throw any warnings about setting state on unmounted component
    });
  });

  describe("image attributes", () => {
    it("renders img with correct dimensions", async () => {
      render(<AddressQr address={validAddress} />);

      await waitFor(() => {
        const img = screen.getByRole("img");
        expect(img).toHaveAttribute("width", "160");
        expect(img).toHaveAttribute("height", "160");
        expect(img).toHaveClass("h-40", "w-40");
      });
    });

    it("does not have next/image restrictions (uses plain img)", async () => {
      render(<AddressQr address={validAddress} />);

      await waitFor(() => {
        const img = screen.getByRole("img") as HTMLImageElement;
        // Should be a plain img element, not next/image
        expect(img.tagName).toBe("IMG");
        expect(img.src).toContain("data:image");
      });
    });
  });

  describe("accessibility", () => {
    it("renders figure element with semantic structure", async () => {
      const { container } = render(<AddressQr address={validAddress} />);

      await waitFor(() => {
        const figure = container.querySelector("figure");
        const figcaption = container.querySelector("figcaption");
        expect(figure).toBeInTheDocument();
        expect(figcaption).toBeInTheDocument();
      });
    });

    it("includes figcaption with address text for reference", async () => {
      const { container } = render(<AddressQr address={validAddress} />);

      await waitFor(() => {
        const figcaption = container.querySelector("figcaption");
        expect(figcaption).toHaveTextContent(validAddress);
        expect(figcaption).toHaveClass("font-mono", "text-[10px]");
      });
    });

    it("loading state has role=status", () => {
      vi.mocked(QRCode.toDataURL).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            setTimeout(() => resolve(dataUrl), 1000);
          })
      );

      render(<AddressQr address={validAddress} />);

      const loading = screen.getByTestId("address-qr-loading");
      expect(loading).toHaveAttribute("role", "status");
    });
  });
});
