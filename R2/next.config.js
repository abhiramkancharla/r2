/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: process.env.BUILD_TARGET === 'electron' ? 'export' : undefined,
  images: { unoptimized: true },
  trailingSlash: true,
  experimental: {
    esmExternals: 'loose'
  }
};
module.exports = nextConfig;
