const API_BASE = "https://api.amctheatres.com";
// The API accepts much larger pages than its documented 100, which lets one
// request return a theatre's entire advance schedule. Pagination is still
// followed in case AMC ever starts enforcing a cap.
const PAGE_SIZE = 10000;
const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 1000;

class AmcApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "AmcApiError";
    this.status = status;
  }
}

function isRetryable(error) {
  return !(error instanceof AmcApiError) || error.status === 429 || error.status >= 500;
}

function createAmcClient({
  vendorKey,
  fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  if (!vendorKey) throw new Error("AMC_VENDOR_KEY is not set");
  if (typeof fetchImpl !== "function") throw new Error("fetch is not available");

  async function apiGet(pathOrUrl) {
    const url = new URL(pathOrUrl, API_BASE);
    if (url.origin !== API_BASE) throw new Error(`Refusing to send vendor key to ${url.origin}`);

    for (let attempt = 1; ; attempt++) {
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
          );
        }
        return await response.json();
      } catch (error) {
        if (attempt >= MAX_ATTEMPTS || !isRetryable(error)) throw error;
        const delay = RETRY_BASE_MS * 2 ** (attempt - 1);
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

  function getTheatreShowtimes(theatreId) {
    return getAllPages(`/v2/theatres/${theatreId}/showtimes`, "showtimes");
  }

  return { apiGet, getAllPages, getTheatreShowtimes };
}

module.exports = { AmcApiError, createAmcClient, PAGE_SIZE };
