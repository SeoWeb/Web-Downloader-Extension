# NOTE: pinned to the python:3.12-slim tag explicitly. Digest-pinning
# (python:3.12-slim@sha256:<digest>) is the follow-up hardening step — bump
# digests deliberately (renovate/dependabot + a rebuild) so a repushed tag
# can never silently change image contents in prod.
FROM python:3.12-slim

WORKDIR /app

ENV PYTHONPATH=/app/shared:/app/shared/proto_generated

# Layer order (4.9): dependency install FIRST so shared/ or service code
# changes never bust the slow pip layer.
COPY services/auth-service/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

# 4.9: rootless container — the service needs no privileges (unprivileged
# ports, no writes outside /tmp), so it runs as an unprivileged user.
RUN useradd --system --user-group --create-home app

# COPY --chown after the pip layer keeps the image root-file-free and the
# dependency layer cacheable.
COPY --chown=app:app shared/ /app/shared/
COPY --chown=app:app services/auth-service/ /app/

USER app

CMD ["python", "main.py"]
