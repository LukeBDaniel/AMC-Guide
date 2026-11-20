const API_BASE = "https://api.amctheatres.com";
// The API accepts much larger pages than its documented 100, which lets one
// request return a theatre's entire advance schedule. Pagination is still
// followed in case AMC ever starts enforcing a cap.
const PAGE_SIZE = 10000;
const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 1000;
// Longest Retry-After the client will honour before giving up on a request.
const MAX_RETRY_AFTER_MS = 60 * 1000;

class AmcApiError extends Error {
  constructor(message, status, retryAfterMs = null) {
    super(message);
    this.name = "AmcApiError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

// Retry-After in milliseconds, from either its seconds or its HTTP-date form.
function retryAfterMs(response) {
  const value = response.headers?.get?.("retry-after");
  if (!value) return null;
  const ms = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(ms) ? Math.max(0, ms) : null;
}

function isRetryable(error) {
  return !(error instanceof AmcApiError) || error.status === 429 || error.status >= 500;
}

// `minIntervalMs` spaces out the start of every request, across concurrent callers.
// Once a request is still rate limited (HTTP 429) after its retries, every later
// request fails straight away rather than keep pressing the API.
function createAmcClient({
  vendorKey,
  fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  minIntervalMs = 0,
} = {}) {
  if (!vendorKey) throw new Error("AMC_VENDOR_KEY is not set");
  if (typeof fetchImpl !== "function") throw new Error("fetch is not available");

  let nextRequestAt = 0;
  let rateLimited = false;

  async function waitForTurn() {
    if (!minIntervalMs) return;
    const now = Date.now();
    const wait = Math.max(0, nextRequestAt - now);
    nextRequestAt = Math.max(now, nextRequestAt) + minIntervalMs;
    if (wait) await sleep(wait);
  }

  async function apiGet(pathOrUrl) {
    const url = new URL(pathOrUrl, API_BASE);
    if (url.origin !== API_BASE) throw new Error(`Refusing to send vendor key to ${url.origin}`);

    for (let attempt = 1; ; attempt++) {
      if (rateLimited) throw new AmcApiError(`GET ${url.pathname} skipped: the API is rate limiting requests`, 429);
      await waitForTurn();
      try {
        const response = await fetchImpl(url.toString(), {
          headers: { "X-AMC-Vendor-Key": vendorKey, Accept: "application/json" },
        });
        if (!response.ok) {
          let detail = "";
          try {
            detail = (await response.json())?.errors?.[0]?.message || "";
          } catch (_) {
            // Error bodies are not always JSON.
          }
          throw new AmcApiError(
            `GET ${url.pathname} failed with HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
            response.status,
            retryAfterMs(response),
          );
        }
        return await response.json();
      } catch (error) {
        const retryAfter = error.retryAfterMs;
        if (attempt >= MAX_ATTEMPTS || !isRetryable(error) || retryAfter > MAX_RETRY_AFTER_MS) {
          if (error.status === 429) rateLimited = true;
          throw error;
        }
        const delay = retryAfter ?? RETRY_BASE_MS * 2 ** (attempt - 1);
        console.warn(`${error.message}; retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_ATTEMPTS})`);
        await sleep(delay);
      }
    }
  }

  async function getAllPages(path, embeddedKey) {
    const separator = path.includes("?") ? "&" : "?";
    let next = `${path}${separator}page-size=${PAGE_SIZE}`;
    const items = [];
    let first = null;

    while (next) {
      const page = await apiGet(next);
      first = first || page;
      items.push(...(page._embedded?.[embeddedKey] || []));
      next = page._links?.next?.href || null;
    }

    if (first && Number.isInteger(first.count) && items.length !== first.count) {
      throw new Error(`${path}: expected ${first.count} ${embeddedKey}, received ${items.length}`);
    }
    return items;
  }

  function getTheatres() {
    return getAllPages("/v2/theatres", "theatres");
  }

  function getTheatreShowtimes(theatreId) {
    return getAllPages(`/v2/theatres/${theatreId}/showtimes`, "showtimes");
  }

  return { apiGet, getAllPages, getTheatres, getTheatreShowtimes };
}

module.exports = { AmcApiError, createAmcClient, PAGE_SIZE };
