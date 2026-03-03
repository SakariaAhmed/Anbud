FROM python:3.12-slim

WORKDIR /app
COPY apps/backend/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
COPY apps/backend/app ./app
COPY apps/worker/worker.py ./worker.py

CMD ["python", "worker.py"]
