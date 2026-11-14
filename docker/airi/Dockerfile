# airi-cli ships only macOS/Linux binaries. On Windows we run it in this small
# Linux container; the session lives in the "airi-home" volume so `auth login`
# survives restarts. The npm postinstall verifies the binary's pinned SHA256.
FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates tar && rm -rf /var/lib/apt/lists/* \
 && npm install -g @airwallex/airi-cli@0.1.0-beta.1 \
 && airi-cli version
ENV AIRI_TELEMETRY_DISABLED=1
WORKDIR /root
CMD ["sleep", "infinity"]
