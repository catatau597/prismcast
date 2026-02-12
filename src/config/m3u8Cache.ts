/* Copyright(C) 2024-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * m3u8Cache.ts: Persistent M3U8 cache storage for PrismCast.
 */
import { LOG } from "../utils/index.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { promises: fsPromises } = fs;

const dataDir = path.join(os.homedir(), ".prismcast");
const cacheFilePath = path.join(dataDir, "m3u8-cache.json");

export interface M3u8CacheEntry {

  capturedAt: string;
  expiresAt?: string;
  headers?: Record<string, string>;
  m3u8Url: string;
  sourceUrl: string;
}

interface M3u8CacheFile {

  entries: Record<string, M3u8CacheEntry>;
  version: number;
}

let cachedFile: M3u8CacheFile | null = null;

export function buildM3u8CacheKey(channelKey: string, url: string): string {

  return channelKey + "|" + url;
}

export function isM3u8CacheExpired(entry: M3u8CacheEntry): boolean {

  if(!entry.expiresAt) {

    return false;
  }

  return Date.now() > new Date(entry.expiresAt).getTime();
}

export function computeM3u8ExpiresAt(m3u8Url: string, capturedAtMs: number, ttlSeconds?: number): string | undefined {

  const expMs = parseExpirationFromUrl(m3u8Url);

  if(expMs && expMs > capturedAtMs) {

    return new Date(expMs).toISOString();
  }

  if(ttlSeconds && (ttlSeconds > 0)) {

    return new Date(capturedAtMs + (ttlSeconds * 1000)).toISOString();
  }

  return undefined;
}

export async function getM3u8CacheEntry(key: string): Promise<M3u8CacheEntry | undefined> {

  const cache = await loadCacheFile();

  return cache.entries[key];
}

export async function setM3u8CacheEntry(key: string, entry: M3u8CacheEntry): Promise<void> {

  const cache = await loadCacheFile();

  cache.entries[key] = entry;

  await saveCacheFile(cache);
}

async function loadCacheFile(): Promise<M3u8CacheFile> {

  if(cachedFile) {

    return cachedFile;
  }

  try {

    const content = await fsPromises.readFile(cacheFilePath, "utf-8");
    const parsed = JSON.parse(content) as M3u8CacheFile;

    if(!parsed || (typeof parsed !== "object") || (parsed.version !== 1) || !parsed.entries || (typeof parsed.entries !== "object")) {

      throw new Error("Invalid cache format");
    }

    cachedFile = parsed;

    return parsed;
  } catch(error) {

    if((error as NodeJS.ErrnoException).code !== "ENOENT") {

      LOG.warn("Failed to read M3U8 cache %s: %s.", cacheFilePath, (error instanceof Error) ? error.message : String(error));
    }

    cachedFile = { entries: {}, version: 1 };

    return cachedFile;
  }
}

async function saveCacheFile(cache: M3u8CacheFile): Promise<void> {

  await fsPromises.mkdir(dataDir, { recursive: true });

  const content = JSON.stringify(cache, null, 2);
  const tempPath = cacheFilePath + ".tmp";

  await fsPromises.writeFile(tempPath, content + "\n", "utf-8");
  await fsPromises.rename(tempPath, cacheFilePath);
}

function parseExpirationFromUrl(m3u8Url: string): number | null {

  let url: URL;

  try {

    url = new URL(m3u8Url);
  } catch {

    return null;
  }

  const expParams = [ "exp", "expires", "expiration", "expires_at", "expiry" ];

  for(const name of expParams) {

    const value = url.searchParams.get(name);

    if(value) {

      const parsed = parseNumericTimestamp(value);

      if(parsed) {

        return parsed;
      }
    }
  }

  const jwtParams = [ "jwt", "token", "sjwt", "auth", "authorization" ];

  for(const name of jwtParams) {

    const value = url.searchParams.get(name);

    if(value) {

      const exp = parseJwtExpiration(value);

      if(exp) {

        return exp;
      }
    }
  }

  return null;
}

function parseNumericTimestamp(value: string): number | null {

  const numeric = Number(value);

  if(!Number.isFinite(numeric)) {

    return null;
  }

  if(numeric > 1000000000000) {

    return numeric;
  }

  if(numeric > 1000000000) {

    return numeric * 1000;
  }

  return null;
}

function parseJwtExpiration(token: string): number | null {

  const parts = token.split(".");

  if(parts.length < 2) {

    return null;
  }

  try {

    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "===".slice((base64.length + 3) % 4);
    const payload = JSON.parse(Buffer.from(padded, "base64").toString("utf-8")) as { exp?: number };
    const exp = payload?.exp;

    if(typeof exp === "number") {

      return parseNumericTimestamp(String(exp));
    }
  } catch {

    return null;
  }

  return null;
}
