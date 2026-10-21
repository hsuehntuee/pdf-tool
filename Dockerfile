FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app ./app
ENV PDFTOOL_NO_ENV_WRITE=1 PYTHONUNBUFFERED=1
EXPOSE 8765
# Set PDFTOOL_PASSWORD and PDFTOOL_SECRET as environment variables when you run/deploy.
CMD ["python", "-m", "app", "--host", "0.0.0.0", "--port", "8765", "--no-browser"]
