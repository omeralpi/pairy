'use client';

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
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
    <section className="flex flex-col self-start rounded-xl border border-line">
      <header className="space-y-1.5 border-b border-line p-5">
        <h2 className="text-base font-semibold">Chat</h2>
        <p className="text-sm leading-relaxed text-slate">
          Only you and your peer see this. It&apos;s deleted when the trade ends. Agree the meeting point here; skip
          personal details.
        </p>
      </header>

      <div className="max-h-[28rem] min-h-48 space-y-3 overflow-y-auto p-5">
        {closed ? (
          <p className="text-sm text-slate">This trade has ended, so its chat was deleted.</p>
        ) : count === 0 ? (
          <p className="text-sm text-slate">No messages yet. Start with where to meet.</p>
        ) : (
          messages.data?.map((m) => (
            <div
              key={m.id}
              className={cn(
                "w-fit max-w-[85%] whitespace-pre-wrap break-words rounded-2xl px-4 py-2.5 text-sm leading-relaxed",
                m.author === me ? "ml-auto rounded-br-md bg-ink text-paper" : "rounded-bl-md bg-sand text-ink",
              )}
            >
              {m.body}
              <span className={cn("mt-1 block font-mono text-[10px]", m.author === me ? "text-paper/60" : "text-slate")}>
                {m.createdAt.toLocaleTimeString(undefined, { timeStyle: "short" })}
              </span>
            </div>
          ))
        )}
        <div ref={end} />
      </div>

      {!closed && (
        <form
          className="flex items-end gap-2 border-t border-line p-3"
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
              className="resize-none rounded-xl border-line bg-paper shadow-none"
              onChange={(e) => setBody(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  e.currentTarget.form?.requestSubmit();
                }
              }}
            />
            {body.length > MAX - 100 && (
              <p className="mt-1 text-right font-mono text-xs text-slate">
                {body.length}/{MAX}
              </p>
            )}
          </div>
          <Button type="submit" size="sm" disabled={!body.trim() || send.isPending}>
            Send
          </Button>
        </form>
      )}
    </section>
  );
}
