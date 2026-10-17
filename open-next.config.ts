import { defineCloudflareConfig } from "@opennextjs/cloudflare";
import staticAssetsIncrementalCache from "@opennextjs/cloudflare/overrides/incremental-cache/static-assets-incremental-cache";

// The app is fully dynamic (authenticated, per-request data). Prerendered output is
// served from Workers static assets; no R2-backed cache is needed.
export default defineCloudflareConfig({
  incrementalCache: staticAssetsIncrementalCache,
});
