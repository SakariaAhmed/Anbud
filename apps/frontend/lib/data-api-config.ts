export type DataApiConfiguration = {
  baseUrl: string;
  serviceKey: string;
};

function trimmed(name: string) {
  return process.env[name]?.trim() || "";
}

function normalizedBaseUrl(value: string) {
  try {
    const url = new URL(value);
    const allowedProtocol =
      url.protocol === "https:" ||
      (process.env.NODE_ENV !== "production" && url.protocol === "http:");
    if (
      !allowedProtocol ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      return "";
    }
    return `${url.origin}${url.pathname}`.replace(/\/+$/u, "");
  } catch {
    return "";
  }
}

function explicitProductionHostAllowed(baseUrl: string) {
  if (process.env.NODE_ENV !== "production") return true;
  const suffix = trimmed("DATA_API_ALLOWED_HOST_SUFFIX").toLowerCase();
  if (!/^\.internal\.[a-z0-9.-]+$/u.test(suffix)) return false;
  const hostname = new URL(baseUrl).hostname.toLowerCase();
  return hostname.endsWith(suffix) && hostname.length > suffix.length;
}

export function dataApiConfiguration(): DataApiConfiguration | null {
  const explicitUrlValue = trimmed("DATA_API_URL");
  const explicitUrl = normalizedBaseUrl(explicitUrlValue);
  const explicitKey = trimmed("DATA_API_SERVICE_ROLE_KEY");
  return explicitUrl && explicitKey && explicitProductionHostAllowed(explicitUrl)
    ? { baseUrl: explicitUrl, serviceKey: explicitKey }
    : null;
}

export function dataApiHeaders(serviceKey: string) {
  return {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    "Content-Type": "application/json",
  };
}
