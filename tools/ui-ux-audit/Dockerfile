FROM node:22-bookworm-slim
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright NODE_ENV=production HOME=/tmp/auditor-home XDG_CACHE_HOME=/tmp/auditor-cache
WORKDIR /opt/audit
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --omit=dev && npx playwright install --with-deps --only-shell chromium && rm -rf /var/lib/apt/lists/* /root/.npm && useradd --uid 10001 --create-home auditor && chmod -R a+rX /ms-playwright
USER 10001:10001
CMD ["sleep","infinity"]
