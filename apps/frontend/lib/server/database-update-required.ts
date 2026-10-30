import "server-only";

/**
 * The deployed code needs a database migration that this database or its
 * PostgREST schema cache does not have yet. The release preflight should
 * prevent this; the error keeps a write from falling back to unsafe behaviour.
 */
export class DatabaseUpdateRequiredError extends Error {
  readonly code = "DATABASE_UPDATE_REQUIRED";
  readonly status = 503;
  readonly userMessage =
    "Databasen mangler en nødvendig oppdatering, så dokumentet ble ikke lagret. Kontakt administrator.";

  constructor(missingFunction: string) {
    super(`DATABASE_UPDATE_REQUIRED: ${missingFunction} is not available`);
    this.name = "DatabaseUpdateRequiredError";
  }
}
