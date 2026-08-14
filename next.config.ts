import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Vercel handles output automatically; standalone is for self-hosted only.
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "**" },
    ],
  },
};

export default nextConfig;
