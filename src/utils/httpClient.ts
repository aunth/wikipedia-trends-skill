import axios, { AxiosError, AxiosInstance } from "axios";
import { config } from "../config";

/**
 * Shared axios instance for all Wikimedia/Wikidata calls.
 *
 * Why a shared client with baked-in retry/backoff instead of ad-hoc axios.get()
 * calls in each service: both APIs are public, shared infrastructure with strict
 * etiquette rules (custom User-Agent, respect 429s). Centralizing this means every
 * service gets the same resilience behavior for free, and it's the one place to
 * tune if Wikimedia's limits ever change.
 */
export const httpClient: AxiosInstance = axios.create({
  timeout: config.httpTimeoutMs,
  headers: {
    "User-Agent": config.userAgent,
    Accept: "application/json",
  },
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryable(error: unknown): boolean {
  if (!axios.isAxiosError(error)) return false;
  const status = error.response?.status;
  // 429 (rate limited) and 5xx (transient server errors) are worth retrying.
  // 404 is NOT retryable -- it means "no data for this article/date range", a
  // legitimate outcome the caller must handle, not a transport failure.
  return status === 429 || status === undefined || (status >= 500 && status < 600);
}

/**
 * GET with exponential backoff. Wikimedia's REST API returns 429 under burst
 * traffic; retrying blindly and immediately would just make that worse, so we
 * back off exponentially and cap the attempts.
 */
export async function getWithRetry<T>(url: string, params?: Record<string, unknown>): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= config.httpMaxRetries; attempt++) {
    try {
      const response = await httpClient.get<T>(url, { params });
      return response.data;
    } catch (error) {
      lastError = error;

      // 404s surface immediately -- callers treat "no data" as a normal case.
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        throw error;
      }

      if (attempt < config.httpMaxRetries && isRetryable(error)) {
        const delay = config.httpRetryBaseDelayMs * 2 ** attempt;
        await sleep(delay);
        continue;
      }
      throw error;
    }
  }

  throw lastError;
}

export function isNotFoundError(error: unknown): boolean {
  return axios.isAxiosError(error) && error.response?.status === 404;
}

export function describeAxiosError(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const err = error as AxiosError;
    return `HTTP ${err.response?.status ?? "?"} calling ${err.config?.url ?? "unknown URL"}: ${err.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}
