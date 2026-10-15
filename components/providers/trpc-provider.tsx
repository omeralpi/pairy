'use client';

import { api } from '@/lib/api';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { httpBatchLink } from '@trpc/client';
import { useState } from 'react';
import superjson from 'superjson';

// Auth rides on the httpOnly session cookie, so no headers are needed here.
export function TRPCProvider({ children }: { children: React.ReactNode }) {
    const [queryClient] = useState(() => new QueryClient({
        defaultOptions: {
            queries: { retry: (failureCount) => failureCount < 2, staleTime: 10_000 },
        },
    }));

    const [trpcClient] = useState(() =>
        api.createClient({
            links: [httpBatchLink({ url: '/api/trpc', transformer: superjson })],
        })
    );

    return (
        <api.Provider client={trpcClient} queryClient={queryClient}>
            <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
        </api.Provider>
    );
}
