# A stand-in for Hermes. VERSION=good answers /health and "migrates" the data
# (writes its tag to /opt/data/schema); VERSION=bad migrates too but never
# answers health, so an update to it must be rolled back. Run with the
# argument "gate" it plays hermes-gate: /gate/health on 9120.
FROM node:22-alpine
ARG VERSION=good
ARG TAG=v0
ENV VERSION=${VERSION} TAG=${TAG}
COPY server.js /server.js
CMD ["node", "/server.js"]
