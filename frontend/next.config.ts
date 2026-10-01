import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Build to a static SPA in ./out so FastAPI can serve it locally.
  output: "export",
  images: { unoptimized: true },
};

export default nextConfig;
