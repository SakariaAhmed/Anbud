# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e

FROM node:22-bookworm-slim@sha256:813a7480f28fdadac1f7f5c824bcdad435b5bc1322a5968bbbdef8d058f9dff4 AS deps
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY apps/frontend/package.json ./package.json
COPY apps/frontend/package-lock.json ./package-lock.json
RUN --mount=type=cache,target=/root/.npm \
    npm config set fetch-retries 5 \
    && npm config set fetch-retry-mintimeout 20000 \
    && npm config set fetch-retry-maxtimeout 180000 \
    && npm config set fetch-timeout 300000 \
    && npm ci --no-audit --no-fund --prefer-offline

FROM node:22-bookworm-slim@sha256:813a7480f28fdadac1f7f5c824bcdad435b5bc1322a5968bbbdef8d058f9dff4 AS builder
WORKDIR /app
ENV NEXT_OUTPUT_FILE_TRACING_ROOT=/app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY apps/frontend .
RUN npm run build
RUN if [ -f .next/standalone/apps/frontend/server.js ]; then \
      cp -a .next/standalone/apps/frontend/. .next/standalone/; \
    elif [ -f .next/standalone/app/server.js ]; then \
      cp -a .next/standalone/app/. .next/standalone/; \
    fi \
    && rm -rf .next/standalone/apps .next/standalone/app

FROM node:22-bookworm-slim@sha256:813a7480f28fdadac1f7f5c824bcdad435b5bc1322a5968bbbdef8d058f9dff4 AS runner-os
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
ENV HOME=/home/node
# The runtime only needs node itself. Drop package managers and Perl from the
# final web image to reduce attack surface and avoid unfixed runtime CVEs.
RUN rm -rf \
      /opt/yarn-v* \
      /usr/local/bin/corepack \
      /usr/local/bin/npm \
      /usr/local/bin/npx \
      /usr/local/bin/yarn \
      /usr/local/bin/yarnpkg \
      /usr/local/lib/node_modules/corepack \
      /usr/local/lib/node_modules/npm \
    && if dpkg-query -W perl-base >/dev/null 2>&1; then \
      dpkg --purge --force-depends --force-remove-essential perl-base; \
    fi \
    && rm -rf /usr/share/perl5 /var/lib/apt/lists/*

FROM python:3.14-slim-bookworm@sha256:4ff4b92a68355dbdb52584ab3391dff8d371a61d4e063468bfd0130e3189c6d9 AS docling-os
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
ENV PIP_DEFAULT_TIMEOUT=300
ENV PIP_RETRIES=10
ENV PIP_DISABLE_PIP_VERSION_CHECK=1
# Keep Node and Python runtime bases on Debian bookworm so the copied Node
# binary resolves against compatible libc/libstdc++ libraries.
COPY --from=deps /usr/local/bin/node /usr/local/bin/node
RUN groupadd --system --gid 1001 node \
    && useradd --system --uid 1001 --gid node --home-dir /home/node --create-home node
ENV HOME=/root

FROM docling-os AS docling-runtime
ENV DOCLING_INGESTION=on
ENV DOCLING_FORMATS=pdf,docx
ENV DOCLING_ENHANCEMENT_MODE=async
ENV DOCLING_ASYNC_AUTO_RUN=off
ENV DOCLING_CLI_COMMAND=/opt/docling/bin/docling
ENV DOCLING_IMAGE_EXPORT_MODE=placeholder
ENV DOCLING_TABLE_MODE=accurate
ENV DOCLING_LARGE_PDF_TABLE_MODE=fast
ENV DOCLING_NUM_THREADS=2
ENV DOCLING_TIMEOUT_MS=600000
ENV DOCLING_PDF_CHUNKING=auto
ENV DOCLING_PDF_CHUNK_PAGES=40
ENV DOCLING_PDF_CHUNK_THRESHOLD_PAGES=120
ENV PATH=/opt/docling/bin:$PATH
RUN --mount=type=cache,target=/root/.cache/pip \
    python -m venv /opt/docling \
    && /opt/docling/bin/pip install --no-cache-dir \
      "docling-slim[standard,models-local,feat-ocr-rapidocr]==2.99.0" \
      --extra-index-url https://download.pytorch.org/whl/cpu \
    && /opt/docling/bin/pip install --force-reinstall --no-cache-dir --no-deps opencv-python-headless==4.13.0.92 \
    && find /opt/docling -type d \( -name __pycache__ -o -name test -o -name tests \) -prune -exec rm -rf '{}' + \
    && find /opt/docling -type f \( -name '*.pyc' -o -name '*.pyo' -o -name '*.a' \) -delete \
    && rm -rf /opt/docling/lib/python3.12/site-packages/torch/include \
      /opt/docling/lib/python3.12/site-packages/torch/share
RUN mkdir -p /opt/docling-models \
    && /opt/docling/bin/docling-tools models download -o /opt/docling-models -q \
    && find /opt/docling-models -type d -name .cache -prune -exec rm -rf '{}' + \
    && chmod -R a+rX /opt/docling-models
# The production Docling image does not use Debian package management at
# runtime. Remove Perl after build-time tooling has finished to keep the final
# image free of the current unfixed Perl CVEs in Debian slim bases.
RUN if dpkg-query -W perl-base >/dev/null 2>&1; then \
      dpkg --purge --force-depends --force-remove-essential perl-base; \
    fi \
    && rm -rf /usr/share/perl5 /var/lib/apt/lists/*
ENV DOCLING_ARTIFACTS_PATH=/opt/docling-models
ENV DOCLING_OCR=auto

FROM docling-runtime AS runner-docling
ENV HOME=/home/node
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/public ./public
# Azure Container Apps jobs override the command to run this worker entrypoint.
COPY --from=builder --chown=node:node /app/scripts/run_project_job_worker.mjs ./scripts/run_project_job_worker.mjs
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health/live').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]

FROM runner-os AS runner-lite
ENV DOCLING_INGESTION=off
ENV DOCLING_FORMATS=pdf,docx
ENV DOCLING_ENHANCEMENT_MODE=async
ENV DOCLING_ASYNC_AUTO_RUN=off
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/public ./public
# Azure Container Apps jobs override the command to run this worker entrypoint.
COPY --from=builder --chown=node:node /app/scripts/run_project_job_worker.mjs ./scripts/run_project_job_worker.mjs
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health/live').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]

# Keep the default target small enough for local and CI smoke tests. Production
# Azure deploys explicitly build runner-docling to keep offline Docling parsing.
FROM runner-lite AS runner
