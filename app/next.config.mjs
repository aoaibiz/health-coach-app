/** @type {import('next').NextConfig} */
const nextConfig = {
  // Static export so it can be deployed to Cloudflare Pages (no Node server).
  output: "export",
  // Static export cannot use the Next.js image optimizer.
  images: { unoptimized: true },
  // Cleaner static hosting: emit /meal/index.html instead of /meal.html.
  trailingSlash: true,
  reactStrictMode: true,
};

export default nextConfig;
