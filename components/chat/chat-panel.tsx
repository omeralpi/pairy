'use client';

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { btnPrimary } from "@/components/trade/format";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

const MAX = 1000;

/** Per-deal chat. The server deletes it when the trade reaches a terminal state. */
export function ChatPanel({ tradeId, me, closed }: { tradeId: string; me: string; closed: boolean }) {
  const [body, setBody] = useState("");
  const messages = api.chat.list.useQuery({ tradeId }, { refetchInterval: closed ? false : 3000 });
  const send = api.chat.send.useMutation({
    onSuccess: () => {
      setBody("");
      void messages.refetch();
    },
    onError: (e) => toast.error(e.message),
  });
  const end = useRef<HTMLDivElement>(null);
  const count = messages.data?.length ?? 0;
  // Braces matter: newer Chrome returns a Promise from scrollIntoView, and an
  // effect that returns one crashes React's cleanup.
  useEffect(() => {
    end.current?.scrollIntoView({ block: "nearest" });
  }, [count]);

  return (
    <section className="flex flex-col rounded-2xl border bg-card">
      <header className="border-b p-4">
        <h2 className="font-semibold">Chat</h2>
        <p className="text-xs text-muted-foreground">
          Only you and your counterparty see this. It is deleted from Pairy when the trade ends. Agree the meeting
          point here; don&apos;t share personal details.
        </p>
      </header>

      <div className="max-h-96 min-h-40 space-y-2 overflow-y-auto p-4">
        {closed ? (
          <p className="text-sm text-muted-foreground">This trade has ended, so its chat was deleted. Pairy keeps no chat history.</p>
        ) : count === 0 ? (
          <p className="text-sm text-muted-foreground">No messages yet.</p>
        ) : (
          messages.data?.map((m) => (
            <div
              key={m.id}
              className={cn(
                "max-w-[85%] whitespace-pre-wrap break-words rounded-2xl px-3 py-2 text-sm",
                m.author === me ? "ml-auto bg-pairy-flame text-white" : "bg-secondary",
              )}
            >
              {m.body}
              <span className={cn("mt-0.5 block text-[10px]", m.author === me ? "text-white/70" : "text-muted-foreground")}>
                {m.createdAt.toLocaleTimeString(undefined, { timeStyle: "short" })}
              </span>
            </div>
          ))
        )}
        <div ref={end} />
      </div>

      {!closed && (
        <form
          className="flex items-end gap-2 border-t p-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (body.trim()) send.mutate({ tradeId, body });
          }}
        >
          <div className="flex-1">
            <Textarea
              rows={2}
              maxLength={MAX}
              value={body}
              placeholder="Write a message"
              onChange={(e) => setBody(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  e.currentTarget.form?.requestSubmit();
                }
              }}
            />
            {body.length > MAX - 100 && (
              <p className="mt-1 text-right text-xs text-muted-foreground">
                {body.length}/{MAX}
              </p>
            )}
          </div>
          <button type="submit" className={btnPrimary} disabled={!body.trim() || send.isPending}>
            Send
          </button>
        </form>
      )}
    </section>
  );
}
