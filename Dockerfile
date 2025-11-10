# Use Node.js LTS version
FROM node:20-alpine

# Set working directory
WORKDIR /app

# Install dependencies first (for better caching)
COPY package*.json ./
RUN npm ci --only=production

# Copy application code
COPY . .

# Create cache directories
RUN mkdir -p .cache/translations \
    .cache/translations_bypass \
    .cache/translations_partial \
    .cache/sync_cache \
    data \
    logs

# Set permissions
RUN chown -R node:node /app

# Use non-root user
USER node

# Expose port (default 7000)
EXPOSE 7000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://localhost:7000/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# Start the application
CMD ["npm", "start"]
