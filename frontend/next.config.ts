import type { NextConfig } from "next";

const BUILD_STAMP = new Date().toISOString().replace(/[-:]/g, "").slice(0, 13); // e.g. 20260920T0215
const nextConfig: NextConfig = {
  env: { NEXT_PUBLIC_BUILD: BUILD_STAMP },
  output: "standalone",
};

export default nextConfig;
