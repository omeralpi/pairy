import { describe, expect, it, vi } from "vitest";

// The boundary around the lazily loaded Privy layer: a chunk that fails to
// load, or Privy throwing while it mounts, must not take the (app) pages down.
const { PrivyBoundary } = await import("./privy-layer-dynamic");

describe("PrivyBoundary", () => {
  it("renders nothing once Privy threw, and tells WalletProvider that Privy failed", () => {
    expect(PrivyBoundary.getDerivedStateFromError(new Error("Loading chunk 9771 failed"))).toEqual({ failed: true });

    const onFail = vi.fn();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const boundary = new PrivyBoundary({ onFail, children: "privy" });
    expect(boundary.render()).toBe("privy");
    boundary.componentDidCatch(new Error("Loading chunk 9771 failed"), { componentStack: "" });
    expect(onFail).toHaveBeenCalledOnce();
    boundary.state = { failed: true };
    expect(boundary.render()).toBeNull();
    logged.mockRestore();
  });
});
