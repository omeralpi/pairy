import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Pairy",
    short_name: "Pairy",
    description: "Trade in person. A Stellar testnet demo: Pairy holds no key and never touches the funds.",
    start_url: "/map",
    display: "standalone",
    background_color: "#F5F1EA",
    theme_color: "#F5F1EA",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
  };
}
