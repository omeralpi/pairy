/** @type {import('next').NextConfig} */
const nextConfig = {
    // Baseline headers only. A script/style CSP would break the MapLibre
    // worker, Next's inline scripts and the wallet kit, so CSP here only
    // forbids framing.
    async headers() {
        return [
            {
                source: '/:path*',
                headers: [
                    { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
                    { key: 'X-Frame-Options', value: 'DENY' },
                    { key: 'X-Content-Type-Options', value: 'nosniff' },
                    { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
                    { key: 'Permissions-Policy', value: 'geolocation=(), camera=(), microphone=()' },
                ],
            },
        ];
    },
    webpack: (config) => {
        // stellar-wallets-kit pulls optional WalletConnect / Ledger deps that
        // reference node-only modules; they are never used in the browser path.
        config.resolve.alias = {
            ...config.resolve.alias,
            'pino-pretty': false,
            // @privy-io/react-auth probes for a Farcaster mini-app host with a
            // dynamic import of this optional peer; webpack fails the build
            // when it is absent (S-01). Pairy is never a Farcaster mini-app.
            '@farcaster/mini-app-solana': false,
        };
        return config;
    },
};

export default nextConfig;
