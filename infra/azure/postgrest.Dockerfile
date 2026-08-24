# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e

# The official PostgREST image is intentionally minimal and contains no CA
# bundle. Microsoft documents both roots as the minimum Azure PostgreSQL trust
# set; their public fingerprints are verified during the image build.
FROM postgrest/postgrest@sha256:c9dc201e555f5d8e37e7f39cdd4df0229774996e213bfd7de8d10ac609030f2c
COPY infra/azure/certs/azure-postgres-roots.pem /etc/ssl/certs/azure-postgres-roots.pem
ENV SSL_CERT_FILE=/etc/ssl/certs/azure-postgres-roots.pem
