# 🐳 Docker Deployment Guide

## Quick Start with Docker Compose

### Option 1: With Redis (Recommended for Production)

```bash
# Clone the repository
git clone https://github.com/xtremexq/StremioSubMaker.git
cd StremioSubMaker

# Create .env file with your configuration
cp .env.example .env

# Edit .env and change any necessary settings
nano .env

# Start with Redis
docker-compose up -d

# When troubleshooting, you might want to use:
# docker-compose up --build -d
# instead.

# View logs
docker-compose logs -f stremio-submaker
```

### Option 2: Filesystem Storage (Local Development)

```bash
# Use the local development compose file
docker-compose -f docker-compose.local.yaml up -d
```

## Configuration

The application uses the `STORAGE_TYPE` environment variable to determine storage backend:

- **`STORAGE_TYPE=filesystem`** (default): Uses local disk storage, perfect for npm start/local development
- **`STORAGE_TYPE=redis`**: Uses Redis for distributed caching, required for HA deployments

### Redis Configuration Options

Add these to your `.env` file when using Redis:

```env
# Storage Configuration
STORAGE_TYPE=redis

# Redis Connection
REDIS_HOST=redis
REDIS_PORT=6379
REDIS_PASSWORD=your_secure_password
REDIS_DB=0
REDIS_KEY_PREFIX=stremio

# API Keys
OPENSUBTITLES_API_KEY=your_opensubtitles_key
```

## Docker Build

### Build the Image

```bash
docker build -t stremio-submaker .
```

### Run with Redis

```bash
docker run -d \
  --name stremio-submaker \
  -p 7001:7001 \
  -e STORAGE_TYPE=redis \
  -e REDIS_HOST=your-redis-host \
  -e REDIS_PORT=6379 \
  stremio-submaker
```

### Run with Filesystem Storage

Requires volume mount for data persistence:

```bash
docker run -d \
  --name stremio-submaker \
  -p 7001:7001 \
  -v $(pwd)/.cache:/app/.cache \
  -v $(pwd)/data:/app/data \
  -e STORAGE_TYPE=filesystem \
  stremio-submaker
```

## Troubleshooting

### Container won't start

1. Check logs: `docker-compose logs -f stremio-submaker`
2. Verify `.env` file exists and contains required keys
3. Ensure ports are not already in use

### Redis connection issues

1. Verify Redis is running: `docker-compose ps`
2. Check Redis logs: `docker-compose logs -f redis`
3. Verify `REDIS_HOST` matches your compose service name

### Volume permissions

If you encounter permission errors:
```bash
# Set proper ownership
sudo chown -R 1000:1000 .cache data
```

---

[← Back to README](README.md)
