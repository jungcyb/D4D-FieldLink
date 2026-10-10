import type { NextConfig } from "next";
const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  allowedDevOrigins: ['192.168.0.187']
  // Plain CSS: this dashboard needs no Tailwind loader/native optional binding.
};
export default nextConfig;
