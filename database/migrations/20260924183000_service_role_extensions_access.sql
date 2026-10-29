-- Standalone PostgreSQL does not grant access to a newly created extensions
-- schema automatically. Ingestion casts JSON embeddings to extensions.vector
-- under service_role; retrieval also uses that type. USAGE does not permit
-- creating objects or expose the schema to anonymous/authenticated API roles.
grant usage on schema extensions to service_role;
