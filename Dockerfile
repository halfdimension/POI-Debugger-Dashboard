FROM node:22-alpine AS frontend-build
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM python:3.12-slim AS runtime
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1
WORKDIR /app
COPY backend/requirements.txt backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt
COPY backend/ backend/
COPY config/debugger.example.yaml config/debugger.example.yaml
COPY data/ data/
COPY scripts/ scripts/
COPY --from=frontend-build /app/frontend/dist frontend/dist
EXPOSE 8010
CMD ["./scripts/run_backend.sh"]
