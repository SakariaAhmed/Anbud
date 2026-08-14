#!/usr/bin/env node

import { isIP } from "node:net";
import { pathToFileURL } from "node:url";

export function validatePostgresProvisioning(input) {
  if (!Array.isArray(input.allowedIpv4Addresses) || input.allowedIpv4Addresses.length === 0) {
    throw new Error("At least one exact PostgreSQL firewall IPv4 address is required.");
  }
  for (const address of input.allowedIpv4Addresses) {
    if (
      typeof address !== "string" ||
      isIP(address) !== 4 ||
      address === "0.0.0.0"
    ) {
      throw new Error(
        `Unsafe PostgreSQL firewall address ${JSON.stringify(address)}; use exact IPv4 addresses and never Allow Azure services.`,
      );
    }
  }
  if (typeof input.databaseCollation !== "string" || !input.databaseCollation.trim()) {
    throw new Error("The source database collation reported by preflight is required.");
  }
  return {
    allowedIpv4Addresses: [...new Set(input.allowedIpv4Addresses)].sort(),
    databaseCollation: input.databaseCollation.trim(),
  };
}

export function validatePostgrestProvisioning(input) {
  if (
    typeof input.image !== "string" ||
    !/@sha256:[0-9a-f]{64}$/u.test(input.image)
  ) {
    throw new Error("PostgREST image must end in an immutable sha256 digest.");
  }
  return { image: input.image };
}

function parseJsonEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}.`);
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${name} must be valid JSON.`);
  }
}

function main() {
  const mode = process.argv[2];
  if (mode === "postgres") {
    const result = validatePostgresProvisioning({
      allowedIpv4Addresses: parseJsonEnvironment("POSTGRES_ALLOWED_IPV4_ADDRESSES"),
      databaseCollation: process.env.POSTGRES_DATABASE_COLLATION,
    });
    console.log(
      JSON.stringify({
        status: "safe-to-preview-postgres",
        address_count: result.allowedIpv4Addresses.length,
        database_collation: result.databaseCollation,
      }),
    );
    return;
  }
  if (mode === "postgrest") {
    validatePostgrestProvisioning({ image: process.env.POSTGREST_IMAGE });
    console.log(JSON.stringify({ status: "safe-to-preview-postgrest" }));
    return;
  }
  throw new Error("Usage: azure_migration_guardrails.mjs postgres|postgrest");
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  try {
    main();
  } catch (error) {
    console.error(
      JSON.stringify({
        status: "stop",
        reason: error instanceof Error ? error.message : "Unknown guardrail error.",
      }),
    );
    process.exit(2);
  }
}
