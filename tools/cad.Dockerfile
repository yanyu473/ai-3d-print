FROM ghcr.io/astral-sh/uv:0.12.7 AS uv
FROM python:3.12-slim-bookworm

COPY --from=uv /uv /usr/local/bin/uv
ENV UV_PYTHON_DOWNLOADS=never \
    UV_LINK_MODE=copy \
    OPENBLAS_NUM_THREADS=1 \
    UV_DEFAULT_INDEX=https://pypi.tuna.tsinghua.edu.cn/simple
WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --locked --no-build --no-cache
COPY cad-worker/ /app/cad-worker/

ENTRYPOINT ["/app/.venv/bin/python", "-B", "/app/cad-worker/build_plate.py"]
