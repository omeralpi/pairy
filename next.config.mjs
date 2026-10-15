/** @type {import('next').NextConfig} */
const nextConfig = {
    webpack: (config) => {
        // stellar-wallets-kit pulls optional WalletConnect / Ledger deps that
        // reference node-only modules; they are never used in the browser path.
        config.resolve.alias = {
            ...config.resolve.alias,
            'pino-pretty': false,
        };
        return config;
    },
};

export default nextConfig;
