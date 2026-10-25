import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Turbopack's wasm loader resolves paths dynamically, so tracing pulls every .wasm under
  // node_modules (resvg, playwright, ...) into the Worker, and OpenNext then sees @vercel/og
  // as used. Imported wasm is emitted to .next/server/chunks; the app does not use OG images.
  outputFileTracingExcludes: {
    "*": ["node_modules/**/*.wasm", "node_modules/next/dist/compiled/@vercel/og/**"],
  },
  experimental: {
    // Documents go up to 5 MB (SEC-23); the service checks the exact limit from the bytes.
    serverActions: { bodySizeLimit: "6mb" },
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
