// @ts-check

/**
 * How to reach a connection and what to send in the headers.
 *
 * OpenAI-compatible providers differ in two ways that a base URL alone can't
 * express: which header carries the key (Azure OpenAI wants `api-key`, most
 * others want `Authorization: Bearer`), and whether the URL needs a query
 * string (Azure needs `?api-version=`). Both live on the connection.
 *
 * @typedef {import("./store.js").Provider} Provider
 */

/**
 * The chat completions endpoint for a connection.
 * @param {Pick<Provider, "baseUrl" | "queryParams">} provider
 */
export function completionsUrl(provider) {
  const base = `${provider.baseUrl}/chat/completions`;
  const query = String(provider.queryParams ?? "").replace(/^[?&]+/, "").trim();
  return query ? `${base}?${query}` : base;
}

/** The models endpoint for a connection (used by "Test connection"). @param {Pick<Provider, "baseUrl" | "queryParams">} provider */
export function modelsUrl(provider) {
  const base = `${provider.baseUrl}/models`;
  const query = String(provider.queryParams ?? "").replace(/^[?&]+/, "").trim();
  return query ? `${base}?${query}` : base;
}

/**
 * Headers for an upstream request, including the credential in whichever form
 * the connection asks for.
 *
 * @param {Partial<Provider>} provider
 * @param {string} apiKey
 * @returns {Record<string, string>}
 */
export function upstreamHeaders(provider, apiKey) {
  /** @type {Record<string, string>} */
  const headers = { "Content-Type": "application/json" };
  if (apiKey) {
    const scheme = provider.authScheme ?? "bearer";
    if (scheme === "x-api-key") headers["x-api-key"] = apiKey;
    else if (scheme === "header") headers[provider.authHeader || "api-key"] = apiKey;
    else if (scheme === "bearer") headers["Authorization"] = `Bearer ${apiKey}`;
    // "none": the key is stored but never sent (a local server that needs none).
  }
  return headers;
}
