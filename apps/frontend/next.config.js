const path = require("node:path");

/** @type {import('next').NextConfig} */
const nextConfig = {
  typedRoutes: true,
  output: "standalone",
  outputFileTracingRoot: process.env.NEXT_OUTPUT_FILE_TRACING_ROOT
    ? path.resolve(process.env.NEXT_OUTPUT_FILE_TRACING_ROOT)
    : path.join(__dirname, "../.."),
};

module.exports = nextConfig;
