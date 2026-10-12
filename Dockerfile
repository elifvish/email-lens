# email-lens with WebKit, Chromium and Firefox included.
#   docker run --rm -p 4600:4600 ghcr.io/elifvish/email-lens
# The Playwright image's version must match the playwright version in package.json.
FROM mcr.microsoft.com/playwright:v1.63.0-noble

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY bin ./bin
COPY src ./src
COPY public ./public
COPY data ./data

# Listen on all interfaces inside the container; the app still only answers requests whose
# Host is localhost, so publish it with -p 4600:4600 and open http://localhost:4600.
ENV HOST=0.0.0.0 PORT=4600 NODE_ENV=production
EXPOSE 4600
USER pwuser
CMD ["node", "bin/email-lens.mjs", "serve"]
