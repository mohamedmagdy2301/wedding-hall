import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Turbopack's wasm loader resolves paths dynamically, so tracing pulls every .wasm under
  // node_modules (resvg, playwright, ...) into the Worker, and OpenNext then sees @vercel/og
  // as used. Imported wasm is emitted to .next/server/chunks; the app does not use OG images.
  outputFileTracingExcludes: {
    "*": ["node_modules/**/*.wasm", "node_modules/next/dist/compiled/@vercel/og/**"],
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
