'use client';

import { api } from '@/lib/api';
import { trpcLinks } from '@/lib/trpc-links';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';

// Auth rides on the httpOnly session cookie, so no headers are needed here.
export function TRPCProvider({ children }: { children: React.ReactNode }) {
    const [queryClient] = useState(() => new QueryClient({
        defaultOptions: {
            queries: { retry: (failureCount) => failureCount < 2, staleTime: 10_000 },
        },
    }));

    const [trpcClient] = useState(() =>
        api.createClient({
            links: trpcLinks(),
        })
    );

    return (
        <api.Provider client={trpcClient} queryClient={queryClient}>
            <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
        </api.Provider>
    );
}
