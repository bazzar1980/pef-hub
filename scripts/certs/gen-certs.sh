#!/usr/bin/env bash
# Generates a name-constrained local CA + a localhost leaf certificate for the PEF Hub WSS listeners.
# The CA can ONLY issue certificates for localhost / 127.0.0.1 / ::1 (X.509 Name Constraints),
# so even if its key leaks it cannot be used to impersonate any other site.
#
# Usage (Git Bash / WSL / macOS / Linux):
#   bash scripts/certs/gen-certs.sh [output_dir] [org_name]
#   bash scripts/certs/gen-certs.sh certs/customer "ACME Contact Center"
set -euo pipefail

OUT="${1:-certs/test}"
ORG="${2:-PEF Hub TEST}"
CA_DAYS="${CA_DAYS:-1825}"     # 5 years
LEAF_DAYS="${LEAF_DAYS:-397}"  # keep <= 397 days

mkdir -p "$OUT"
cd "$OUT"

cat > ca.cnf <<CNF
[req]
distinguished_name = dn
prompt = no
[dn]
CN = ${ORG} Local CA
O  = ${ORG}
[v3_ca]
basicConstraints     = critical, CA:TRUE, pathlen:0
keyUsage             = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash
nameConstraints      = critical, permitted;DNS:localhost, permitted;IP:127.0.0.1/255.255.255.255, permitted;IP:0:0:0:0:0:0:0:1/FFFF:FFFF:FFFF:FFFF:FFFF:FFFF:FFFF:FFFF
CNF

cat > leaf.cnf <<CNF
[v3_leaf]
basicConstraints       = critical, CA:FALSE
keyUsage               = critical, digitalSignature
extendedKeyUsage       = serverAuth
subjectAltName         = DNS:localhost, IP:127.0.0.1, IP:0:0:0:0:0:0:0:1
subjectKeyIdentifier   = hash
authorityKeyIdentifier = keyid
CNF

openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out ca.key
openssl req -x509 -new -key ca.key -sha256 -days "$CA_DAYS" -config ca.cnf -extensions v3_ca -out ca.crt

openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out localhost.key
openssl req -new -key localhost.key -subj "/CN=localhost/O=${ORG}" -out localhost.csr
openssl x509 -req -in localhost.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
  -days "$LEAF_DAYS" -sha256 -extfile leaf.cnf -extensions v3_leaf -out localhost.crt

cat localhost.crt ca.crt > localhost-fullchain.crt
openssl verify -CAfile ca.crt localhost.crt

rm -f localhost.csr ca.srl ca.cnf leaf.cnf
echo
echo "Done -> $(pwd)"
echo "  ca.crt                  trust this (Trusted Root) on agent PCs"
echo "  localhost-fullchain.crt hub tls.certPath"
echo "  localhost.key           hub tls.keyPath"
echo "  ca.key                  keep private, only needed to re-issue the leaf"
