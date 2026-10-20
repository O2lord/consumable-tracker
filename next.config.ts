import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  experimental: {
    agentFeedback: true,
    // Dev-only: only validate instant navigation for segments that export `instant` themselves.
    // Every page here sits behind a per-user session cookie, so there is no shared static shell to validate.
    instantInsights: {
      validationLevel: "manual-warning",
    },
    // Server Actions (e.g. lookupLabelAction) reject requests whose forwarded host doesn't match the
    // origin. Allow the ngrok tunnel so actions work when the app is opened through it.
    serverActions: {
      allowedOrigins: ["alene-offscreen-unprevalently.ngrok-free.dev"],
    },
  },
  cacheComponents: true,
  partialPrefetching: true,
  // Dev only: let phones and other computers on the local network (and the ngrok tunnel) load the dev
  // server's scripts. Without this their pages show but nothing is interactive. Add each address (or
  // hostname) you test from.
  allowedDevOrigins: [
    "192.168.18.3",
    "10.158.41.195",
    "alene-offscreen-unprevalently.ngrok-free.dev",
  ],
  // The app has no landing page: / goes to the dashboard, whose proxy/layout sends signed-out visitors to /login.
  async redirects() {
    return [{ source: "/", destination: "/dashboard", permanent: false }];
  },
  // The service worker must always be fetched fresh, or a fix to it would never reach the devices.
  async headers() {
    return [
      {
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
    ];
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;