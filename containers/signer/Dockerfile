# Nap's app signer: signs unsigned iOS builds with the distribution certificate and App Store profile,
# and Android App Bundles with the Play upload key.
# rcodesign is a Rust implementation of Apple code signing that runs on Linux; Android bundles are
# signed in Python (android.py), with cryptography for the PKCS #7 signature.
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
RUN pip install --no-cache-dir cryptography==50.0.2
COPY server.py android.py /app/
EXPOSE 8080
CMD ["python3", "-u", "/app/server.py"]
