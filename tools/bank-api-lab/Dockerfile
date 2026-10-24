FROM python:3.12-slim@sha256:9e01bf1ae5db7649a236da7be1e94ffbbbdd7a93f867dd0d8d5720d9e1f89fab

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

COPY requirements.txt requirements.lock ./
RUN pip install --no-cache-dir -r requirements.txt -c requirements.lock

COPY api_atlas.py app.py ./
COPY templates ./templates
COPY static ./static

# Ejecutar como usuario no-root (seguridad)
RUN addgroup --system appgroup && adduser --system --ingroup appgroup appuser
USER appuser

EXPOSE 48880

# HEALTHCHECK via liveness endpoint
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:48880/api/health')" || exit 1

# Bind a 0.0.0.0 dentro del contenedor para permitir que Docker exponga los puertos.
# No guardar números de cuenta, alias ni query strings en el access log.
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "48880", "--no-access-log"]
