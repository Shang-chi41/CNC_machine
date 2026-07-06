FROM python:3.11-slim
WORKDIR /app
COPY cloud_backend/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
COPY . /app
EXPOSE 8000
CMD ["sh", "-c", "uvicorn cloud_backend.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
