#!/usr/bin/env bash
# Generate mTLS certificates for all gRPC services.
# Creates a self-signed CA and per-service server + client certs.
set -euo pipefail

CERT_DIR="$(dirname "$0")/certs"
mkdir -p "$CERT_DIR"

CA_KEY="$CERT_DIR/ca-key.pem"
CA_CERT="$CERT_DIR/ca.pem"
DAYS=3650

echo "==> Generating CA key and certificate..."
openssl genrsa -out "$CA_KEY" 4096 2>/dev/null
openssl req -new -x509 -days $DAYS -key "$CA_KEY" \
  -out "$CA_CERT" -subj "/CN=PagePocket CA" 2>/dev/null

generate_cert() {
  local name="$1"
  local san="$2"
  local usage="$3"   # server or client
  local key_out="$CERT_DIR/${name}-key.pem"
  local csr_out="$CERT_DIR/${name}.csr"
  local cert_out="$CERT_DIR/${name}.pem"

  echo "==> Generating cert for $name ($usage)..."

  openssl genrsa -out "$key_out" 2048 2>/dev/null
  openssl req -new -key "$key_out" -out "$csr_out" \
    -subj "/CN=${name}" 2>/dev/null

  local ext_file
  ext_file=$(mktemp)
  if [ "$usage" = "server" ]; then
    cat > "$ext_file" <<EOF
authorityKeyIdentifier=keyid,issuer
basicConstraints=CA:FALSE
keyUsage=digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=$san
EOF
  else
    cat > "$ext_file" <<EOF
authorityKeyIdentifier=keyid,issuer
basicConstraints=CA:FALSE
keyUsage=digitalSignature
extendedKeyUsage=clientAuth
EOF
  fi

  openssl x509 -req -days $DAYS -in "$csr_out" \
    -CA "$CA_CERT" -CAkey "$CA_KEY" -CAcreateserial \
    -out "$cert_out" -extfile "$ext_file" 2>/dev/null

  rm -f "$csr_out" "$ext_file"
}

# Server certs (for gRPC servers)
generate_cert "archive-service"  "DNS:archive-service,DNS:localhost,IP:127.0.0.1" "server"
generate_cert "auth-service"     "DNS:auth-service,DNS:localhost,IP:127.0.0.1"    "server"
generate_cert "library-service"  "DNS:library-service,DNS:localhost,IP:127.0.0.1" "server"
generate_cert "search-service"   "DNS:search-service,DNS:localhost,IP:127.0.0.1"  "server"
generate_cert "share-service"    "DNS:share-service,DNS:localhost,IP:127.0.0.1"   "server"

# Client certs (for gRPC clients / api-gateway / extension-server)
generate_cert "api-gateway"      "" "client"
generate_cert "extension-server" "" "client"

# Remove CA serial file
rm -f "$CERT_DIR/ca.srl"

echo "==> Done. Certificates written to $CERT_DIR/"
ls -1 "$CERT_DIR/"
