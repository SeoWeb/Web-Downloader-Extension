FROM python:3.12-slim

WORKDIR /app

ENV PYTHONPATH=/app/shared:/app/shared/proto_generated

COPY shared/ /app/shared/

COPY services/library-service/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

COPY services/library-service/ /app/

CMD ["python", "main.py"]
