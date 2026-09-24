# Navide Marketplace Registry image. Build context: marketplace/registry.
#   docker build -t navide-registry marketplace/registry
FROM python:3.12-slim

COPY --from=ghcr.io/astral-sh/uv:0.11 /uv /usr/local/bin/uv

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    UV_PROJECT_ENVIRONMENT=/app/.venv

WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --locked --no-dev --no-install-project
COPY registry ./registry
RUN uv sync --locked --no-dev

COPY deploy/entrypoint.sh /usr/local/bin/registry-entrypoint

RUN useradd --system --uid 10001 --user-group --home-dir /nonexistent --shell /usr/sbin/nologin registry \
 && mkdir -p /data /run/navide-keys \
 && chown registry:registry /data /run/navide-keys \
 && chmod 700 /data /run/navide-keys

ENV PATH=/app/.venv/bin:$PATH \
    REGISTRY_DATA_DIR=/data \
    PYTHONUNBUFFERED=1

USER registry
VOLUME ["/data"]
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8787/api/health', timeout=4)"]

ENTRYPOINT ["registry-entrypoint"]
