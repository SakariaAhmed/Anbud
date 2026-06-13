# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e

FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY apps/frontend/package.json ./package.json
COPY apps/frontend/package-lock.json ./package-lock.json
RUN --mount=type=cache,target=/root/.npm \
    npm config set fetch-retries 5 \
    && npm config set fetch-retry-mintimeout 20000 \
    && npm config set fetch-retry-maxtimeout 180000 \
    && npm config set fetch-timeout 300000 \
    && npm ci --no-audit --no-fund --prefer-offline

FROM node:22-bookworm-slim AS builder
WORKDIR /app
ENV NEXT_OUTPUT_FILE_TRACING_ROOT=/app
COPY --from=deps /app/node_modules ./node_modules
COPY apps/frontend .
RUN npm run build
RUN if [ -f .next/standalone/apps/frontend/server.js ]; then \
      cp -a .next/standalone/apps/frontend/. .next/standalone/; \
    elif [ -f .next/standalone/app/server.js ]; then \
      cp -a .next/standalone/app/. .next/standalone/; \
    fi \
    && rm -rf .next/standalone/apps .next/standalone/app

FROM python:3.12-slim-bookworm AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
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
ENV PIP_DEFAULT_TIMEOUT=300
ENV PIP_RETRIES=10
ENV PIP_DISABLE_PIP_VERSION_CHECK=1
ENV PATH=/opt/docling/bin:$PATH
COPY --from=node:22-bookworm /usr/local/bin/node /usr/local/bin/node
RUN groupadd --system --gid 1001 node \
    && useradd --system --uid 1001 --gid node --home-dir /home/node --create-home node
RUN --mount=type=cache,target=/root/.cache/pip \
    python -m venv /opt/docling \
    && /opt/docling/bin/pip install docling==2.99.0 --extra-index-url https://download.pytorch.org/whl/cpu
RUN mkdir -p /opt/docling-models \
    && /opt/docling/bin/docling-tools models download -o /opt/docling-models -q \
    && chmod -R a+rX /opt/docling-models
RUN --mount=type=cache,target=/root/.cache/pip \
    /opt/docling/bin/pip install --force-reinstall --no-deps opencv-python-headless==4.13.0.92
ENV DOCLING_ARTIFACTS_PATH=/opt/docling-models
ENV DOCLING_OCR=auto
ENV HOME=/home/node
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/public ./public
COPY --from=builder --chown=node:node /app/scripts ./scripts
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health/live').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
