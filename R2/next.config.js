/** @type {import('next').NextConfig} */
const isElectronBuild = process.env.BUILD_TARGET === 'electron';
const nextConfig = {
  reactStrictMode: true,
  output: isElectronBuild ? 'export' : undefined,
  images: { unoptimized: true },
  trailingSlash: true,
  experimental: {
    esmExternals: 'loose'
  }
};
module.exports = nextConfig;
