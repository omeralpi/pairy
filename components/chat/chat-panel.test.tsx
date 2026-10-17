import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const list = vi.hoisted(() => ({ result: {} as Record<string, unknown> }));

vi.mock("@/lib/api", () => ({
  api: {
    chat: {
      list: { useQuery: () => list.result },
      send: { useMutation: () => ({ mutate: () => {}, isPending: false }) },
    },
  },
}));

const { ChatPanel } = await import("./chat-panel");

const render = () => renderToStaticMarkup(<ChatPanel tradeId="t" me="GME" closed={false} />);

describe("ChatPanel when the chat cannot be loaded", () => {
  it("does not say there are no messages when it could not read them", () => {
    list.result = { data: undefined, error: { message: "Failed to fetch" }, isLoading: false, refetch: () => {} };
    const html = render();
    expect(html).not.toContain("No messages yet");
    expect(html).toContain("Couldn&#x27;t load the chat");
  });

  it("says there are no messages when the list came back empty", () => {
    list.result = { data: [], error: null, isLoading: false, refetch: () => {} };
    expect(render()).toContain("No messages yet");
  });
});
