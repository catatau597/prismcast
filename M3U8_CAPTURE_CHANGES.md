# M3U8 Capture Changes

This document summarizes the M3U8-related changes that were implemented in PrismCast. It replaces the earlier planning and mockup documents that are now removed.

## Overview

PrismCast now supports capturing M3U8 URLs from network traffic and serving them via a passthrough proxy. This avoids screen capture for supported sites, reduces startup time, and lowers CPU usage.

## Key Behavior

- When a channel has Use M3U8 Link enabled, PrismCast captures the M3U8 URL using a temporary browser page and CDP network monitoring.
- The stream runs in M3U8 proxy mode (no FFmpeg re-encode). Requests to /hls/:name/stream.m3u8 and segment URLs are proxied to the upstream playlist and media URLs.
- The proxy rewrites playlist URIs so all nested requests route through /hls/:name/proxy.
- Client counts and stream status updates include proxy streams.

## Cache

- M3U8 cache is persisted at ~/.prismcast/m3u8-cache.json.
- Cache entries are keyed by channelKey|sourceUrl.
- TTL is derived from exp-style query parameters or JWT exp when available.
- Optional per-channel TTL override is supported via m3u8TtlSeconds.
- Expired cache entries are not used; new captures refresh the cache.

## UI/Config

- Channel advanced options include Use M3U8 Link.
- Channel advanced options include M3U8 Cache TTL (seconds).
- Channel config validation allows optional m3u8TtlSeconds (> 0).

## Files Touched (summary)

- src/browser/m3u8Capture.ts
  - Capture M3U8 URL from network traffic using CDP.
- src/streaming/setup.ts
  - M3U8 capture path, cache integration, and stream mode metadata.
- src/streaming/hls.ts
  - M3U8 proxy passthrough, playlist rewrite, proxy refresh on errors.
- src/config/m3u8Cache.ts
  - Persistent cache storage, TTL computation and validation.
- src/config/userChannels.ts
  - Validation for m3u8TtlSeconds.
- src/types/index.ts
  - Channel type includes optional m3u8TtlSeconds.
- src/routes/config.ts
  - Advanced options form includes M3U8 TTL field and save handling.

## Operational Notes

- Proxy mode does not fall back to screen capture on failure.
- If a cached M3U8 expires or upstream errors occur, PrismCast attempts a recapture.
- No HEAD precheck is performed when capturing M3U8.

## Removed Documents

The following planning and mockup files were removed during cleanup:

- DOCUMENTACAO_M3U8_INDEX.md
- FLUXO_DETALHADO_M3U8.md
- GUIA_VISUAL_UI_M3U8.md
- PLANO_IMPLEMENTACAO_M3U8.md
- SUMARIO_EXECUTIVO_M3U8.md
