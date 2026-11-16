# AGNES Gender Hotspot Map: Flask app served by gunicorn.
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PORT=8000

WORKDIR /app

COPY deploy/requirements.txt ./requirements-deploy.txt
RUN pip install -r requirements-deploy.txt

COPY app.py ./
COPY templates ./templates
COPY static ./static
COPY tools ./tools
COPY data ./data

# Uploads (PDFs, Excel files, AI images) live in /app/instance; mount a volume there.
RUN useradd --create-home --uid 10001 appuser \
    && mkdir -p /app/instance \
    && chown -R appuser:appuser /app
USER appuser

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD python -c "import os,urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:%s/healthz' % os.environ.get('PORT','8000'), timeout=4).status == 200 else 1)"

CMD ["sh", "-c", "exec gunicorn --preload --workers=${WEB_CONCURRENCY:-2} --threads=4 --timeout=180 --bind=0.0.0.0:${PORT} --forwarded-allow-ips='*' app:app"]
