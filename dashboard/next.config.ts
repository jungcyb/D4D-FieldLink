import type { NextConfig } from "next";
const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  // Plain CSS: this dashboard needs no Tailwind loader/native optional binding.
};
export default nextConfig;
