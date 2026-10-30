// Preloaded by CI's build (NODE_OPTIONS=--require) so a build that fetches
// from Google Fonts fails every time instead of whenever Google's response
// trips next/font. The app's fonts are served from app/fonts.
const https = require("node:https");

const googleFonts = /(^|\.)fonts\.(googleapis|gstatic)\.com$/u;

function hostOf(target) {
  if (typeof target === "string" || target instanceof URL) {
    try {
      return new URL(String(target)).hostname;
    } catch {
      return "";
    }
  }
  if (target && typeof target === "object") {
    if (typeof target.url === "string") return hostOf(target.url);
    return String(target.hostname ?? target.host ?? "").replace(/:\d+$/u, "");
  }
  return "";
}

function refuse(target) {
  return new Error(`The build must not fetch from Google Fonts (${hostOf(target)}). Serve fonts from app/fonts.`);
}

for (const method of ["request", "get"]) {
  const original = https[method];
  https[method] = function guardedRequest(target, ...rest) {
    if (googleFonts.test(hostOf(target))) throw refuse(target);
    return original.call(this, target, ...rest);
  };
}

const originalFetch = globalThis.fetch;
globalThis.fetch = function guardedFetch(target, init) {
  if (googleFonts.test(hostOf(target))) return Promise.reject(refuse(target));
  return originalFetch(target, init);
};
