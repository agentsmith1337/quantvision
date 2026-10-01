import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Build to a static SPA in ./out so FastAPI can serve it locally.
  output: "export",
  // Emit /trade/index.html rather than /trade.html so FastAPI's StaticFiles resolves it.
  trailingSlash: true,
  images: { unoptimized: true },
};

export default nextConfig;
