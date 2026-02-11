/* Copyright(C) 2024-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * m3u8Capture.ts: M3U8 link capture from network traffic for PrismCast.
 */
import type { CDPSession, Page } from "puppeteer-core";
import type { ResolvedSiteProfile } from "../types/index.js";
import { LOG, delay, formatError } from "../utils/index.js";
import { navigateToPage } from "./video.js";

export interface M3u8CaptureOptions {

  page: Page;
  url: string;
  profile: ResolvedSiteProfile;
  timeout?: number;
}

export interface M3u8CaptureResult {

  success: boolean;
  m3u8Url?: string;
  requestHeaders?: Record<string, string>;
  reason?: string;
}

const M3U8_URL_PATTERNS = [
  /\.m3u8(\?.*)?$/i,
  /\/manifest\.m3u8/i,
  /\/playlist\.m3u8/i,
  /\/master\.m3u8/i,
  /hls.*\.m3u8/i,
  /\/chunklist.*\.m3u8/i,
  /m3u8/i
];

function isM3u8Url(url: string): boolean {

  return M3U8_URL_PATTERNS.some((pattern) => pattern.test(url));
}

export async function validateM3u8Url(url: string): Promise<boolean> {

  try {

    const response = await fetch(url, {
      method: "HEAD",
      signal: AbortSignal.timeout(5000)
    });

    return response.ok;
  } catch(error) {

    LOG.warn("M3U8 validation failed for %s: %s", url, formatError(error));

    return false;
  }
}

export async function captureM3u8FromNetwork(options: M3u8CaptureOptions): Promise<M3u8CaptureResult> {

  const { page, profile, url, timeout = 15000 } = options;
  let cdpSession: CDPSession | null = null;
  let capturedM3u8: string | null = null;
  let capturedHeaders: Record<string, string> | null = null;
  const requestListener = (request: { url: () => string; headers: () => Record<string, string> }): void => {

    handleUrl(request.url(), request.headers());
  };
  const responseListener = (response: { url: () => string; headers: () => Record<string, string> }): void => {

    const responseUrl = response.url();
    const contentType = response.headers()["content-type"] ?? "";

    if(contentType.includes("mpegurl") || contentType.includes("m3u8")) {

      handleUrl(responseUrl);
      return;
    }

    handleUrl(responseUrl);
  };
  const handleUrl = (responseUrl?: string, headers?: Record<string, string>): void => {

    if(responseUrl && isM3u8Url(responseUrl) && !capturedM3u8) {

      LOG.info("M3U8 link detected: %s", responseUrl);
      capturedM3u8 = responseUrl;
      if(headers) {

        capturedHeaders = { ...headers };
      }
    }
  };

  try {

    cdpSession = await page.createCDPSession();
    await cdpSession.send("Network.enable");

    LOG.info("Network monitoring enabled for M3U8 capture.");

    cdpSession.on("Network.responseReceived", (params: { response?: { url?: string } }) => {

      handleUrl(params.response?.url);
    });

    cdpSession.on("Network.requestWillBeSent", (params: { request?: { url?: string; headers?: Record<string, string> } }) => {

      handleUrl(params.request?.url, params.request?.headers);
    });

    page.on("request", requestListener);
    page.on("response", responseListener);

    await navigateToPage(page, url, profile);

    LOG.info("Page loaded, monitoring network traffic for M3U8.");

    const startTime = Date.now();

    while(!capturedM3u8 && (Date.now() - startTime) < timeout) {

      await delay(500);
    }

    if(!capturedM3u8) {

      LOG.warn("M3U8 capture timeout (%dms) for %s", timeout, url);

      return {
        success: false,
        reason: "No M3U8 link detected in network traffic within timeout period."
      };
    }

    const isValid = await validateM3u8Url(capturedM3u8);

    if(!isValid) {

      return {
        success: false,
        reason: "Captured M3U8 URL is not accessible."
      };
    }

    LOG.info("M3U8 captured and validated: %s", capturedM3u8);

    return {
      success: true,
      m3u8Url: capturedM3u8,
      requestHeaders: capturedHeaders ?? undefined
    };
  } catch(error) {

    LOG.error("M3U8 capture error: %s", formatError(error));

    return {
      success: false,
      reason: "M3U8 capture error: " + formatError(error)
    };
  } finally {

    page.off("request", requestListener);
    page.off("response", responseListener);

    if(cdpSession) {

      try {

        await cdpSession.detach();
      } catch {
        // Ignore detach errors.
      }
    }
  }
}
