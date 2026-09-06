const path = require("node:path");

/** @type {import('next').NextConfig} */
const nextConfig = {
  typedRoutes: true,
  serverExternalPackages: ["pdfjs-dist", "@napi-rs/canvas"],
  outputFileTracingIncludes: {
    "/*": ["./node_modules/@napi-rs/canvas*/**/*", "./node_modules/pdfjs-dist/legacy/build/**/*", "./node_modules/pdf-parse/lib/**/*"],
  },
  output: "standalone",
  experimental: {
    authInterrupts: true,
  },
  outputFileTracingRoot: process.env.NEXT_OUTPUT_FILE_TRACING_ROOT
    ? path.resolve(process.env.NEXT_OUTPUT_FILE_TRACING_ROOT)
    : path.join(__dirname, "../.."),
};

module.exports = nextConfig;
