// @arsumbris/au-mcp-core — the bundled baseline plugin package for the au-mcp kernel.
//
// Ships the default agent surface + the always-present governance floors (read-guard,
// tool-precondition, the native-tool redirect — each always loaded as `critical`; the redirect
// enforces only when a session sets a native-tool allowlist), all as TRUE PLUGINS over
// @arsumbris/au-mcp-sdk (decision 2608261517: the kernel holds only the mechanism; tools +
// policy are plugins). Migrated in over plan 2608261532.
//
// There is DELIBERATELY nothing to export here. The kernel does not import this package as a
// JS module — it discovers au-mcp-core as a mounted workspace member and loads each plugin by
// its type-def's `plugin-runtime-meta.entry` (a per-tool `.ts` file exporting `createPlugin`).
// A convenience barrel re-exporting a subset would only imply a completeness it never has, so
// this stays empty; the def `entry:` pointers are the single source of truth for the load path.

export {}
