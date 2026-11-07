# Nap's app signer: signs unsigned iOS builds with the distribution certificate and App Store profile.
# rcodesign is a Rust implementation of Apple code signing that runs on Linux.
FROM python:3.13-alpine
ARG RCODESIGN_VERSION=0.29.0
ARG TARGETARCH
RUN set -eu; \
    case "${TARGETARCH:-amd64}" in arm64) arch=aarch64 ;; *) arch=x86_64 ;; esac; \
    wget -qO- "https://github.com/indygreg/apple-platform-rs/releases/download/apple-codesign/${RCODESIGN_VERSION}/apple-codesign-${RCODESIGN_VERSION}-${arch}-unknown-linux-musl.tar.gz" \
      | tar xz -C /tmp; \
    mv /tmp/apple-codesign-*/rcodesign /usr/local/bin/rcodesign; \
    rm -rf /tmp/apple-codesign-*; \
    rcodesign --version
COPY server.py /app/server.py
EXPOSE 8080
CMD ["python3", "-u", "/app/server.py"]
