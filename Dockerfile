FROM eclipse-temurin:21-jre AS java

FROM node:22-bookworm-slim AS dependencies

# The repository's secret scanner uses git ls-files.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
RUN chown node:node /app
USER node
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci

FROM dependencies AS development
COPY --chown=node:node . .
# Scan the copied source without copying host Git metadata or credentials.
RUN git init --quiet

EXPOSE 5173
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0", "--port", "5173", "--strictPort"]

FROM dependencies AS emulator-tools
USER root
COPY --from=java /opt/java/openjdk /opt/java/openjdk
ENV JAVA_HOME=/opt/java/openjdk
ENV PATH="/opt/java/openjdk/bin:${PATH}"
RUN npm install --global firebase-tools@15.27.0
USER node
RUN firebase setup:emulators:firestore && firebase setup:emulators:ui

FROM emulator-tools AS emulators
COPY --chown=node:node . .
RUN git init --quiet
CMD ["firebase", "emulators:start", "--config", "firebase.docker.json", "--project", "demo-papertok", "--only", "auth,firestore", "--non-interactive"]
