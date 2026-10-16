# NOTE: pinned to the python:3.12-slim tag explicitly. Digest-pinning
# (python:3.12-slim@sha256:<digest>) is the follow-up hardening step — bump
# digests deliberately (renovate/dependabot + a rebuild) so a repushed tag
# can never silently change image contents in prod.
FROM python:3.12-slim

WORKDIR /app

ENV PYTHONPATH=/app/shared:/app/shared/proto_generated
# Multi-worker serving (D1 / task 1.4): safe because rate limiting and session
# state live in Redis. Overridable per deployment via the GATEWAY_WORKERS env.
ENV GATEWAY_WORKERS=2

# Layer order (4.9): dependency install FIRST so shared/ or service code
# changes never bust the slow pip layer.
COPY services/api-gateway/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

# 4.9: rootless container — the service needs no privileges (unprivileged
# ports, no writes outside /tmp), so it runs as an unprivileged user.
RUN useradd --system --user-group --create-home app

# COPY --chown after the pip layer keeps the image root-file-free and the
# dependency layer cacheable.
COPY --chown=app:app shared/ /app/shared/
COPY --chown=app:app services/api-gateway/ /app/

USER app

CMD ["python", "main.py"]
