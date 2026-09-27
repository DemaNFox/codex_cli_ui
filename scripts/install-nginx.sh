#!/usr/bin/env bash

set -euo pipefail
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
REPO_ROOT=$(cd -- "$SCRIPT_DIR/.." && pwd -P)
# shellcheck source=scripts/lib/ubuntu-common.sh
source "$SCRIPT_DIR/lib/ubuntu-common.sh"

domain=
tls_cert=
tls_key=
port=3210
http_port=80
https_port=443
reload=false

while (($#)); do
  case "$1" in
    --domain) domain=${2:?}; shift 2 ;;
    --tls-cert) tls_cert=${2:?}; shift 2 ;;
    --tls-key) tls_key=${2:?}; shift 2 ;;
    --port) port=${2:?}; shift 2 ;;
    --http-port) http_port=${2:?}; shift 2 ;;
    --https-port) https_port=${2:?}; shift 2 ;;
    --reload) reload=true; shift ;;
    --help|-h)
      printf 'Usage: sudo scripts/install-nginx.sh --domain HOST --tls-cert FILE --tls-key FILE [--port 3210] [--http-port 80] [--https-port 443] [--reload]\n'
      exit 0
      ;;
    *) die "unknown argument: $1" ;;
  esac
done

require_root
for command in nginx python3 install; do require_command "$command"; done
[[ -n ${domain:-} && ${#domain} -le 253 ]] || die 'invalid domain'
IFS='.' read -r -a domain_labels <<<"$domain"
for label in "${domain_labels[@]}"; do
  [[ ${#label} -le 63 && $label =~ ^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?$ ]] || die 'invalid domain label'
done
[[ $port =~ ^[0-9]{2,5}$ ]] && (( port >= 1024 && port <= 65535 )) || die 'invalid backend port'
[[ $http_port =~ ^[0-9]{2,5}$ ]] && (( http_port >= 1024 && http_port <= 65535 || http_port == 80 )) || die 'invalid HTTP edge port'
[[ $https_port =~ ^[0-9]{2,5}$ ]] && (( https_port >= 1024 && https_port <= 65535 || https_port == 443 )) || die 'invalid HTTPS edge port'
[[ $http_port != "$https_port" ]] || die 'HTTP and HTTPS edge ports must differ'
[[ ${tls_cert:-} = /* && $tls_cert =~ ^[A-Za-z0-9_./-]+$ ]] || die 'invalid TLS certificate path'
[[ ${tls_key:-} = /* && $tls_key =~ ^[A-Za-z0-9_./-]+$ ]] || die 'invalid TLS key path'
canonical_existing_file "$tls_cert" >/dev/null
canonical_existing_file "$tls_key" >/dev/null

target=/etc/nginx/sites-available/codex-web-ui.conf
temporary=$(mktemp /etc/nginx/sites-available/codex-web-ui.conf.XXXXXX)
DOMAIN=$domain TLS_CERT=$tls_cert TLS_KEY=$tls_key PORT=$port HTTP_PORT=$http_port HTTPS_PORT=$https_port \
  python3 - "$REPO_ROOT/infra/nginx/codex-web-ui.conf.template" "$temporary" <<'PY'
import os
import pathlib
import sys

source = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8")
for name in ("DOMAIN", "TLS_CERT", "TLS_KEY", "PORT", "HTTP_PORT", "HTTPS_PORT"):
    source = source.replace(f"@@{name}@@", os.environ[name])
if "@@" in source:
    raise SystemExit("unresolved nginx template placeholder")
pathlib.Path(sys.argv[2]).write_text(source, encoding="utf-8")
PY
chmod 0644 "$temporary"
mv -f -- "$temporary" "$target"
ln -sfn -- "$target" /etc/nginx/sites-enabled/codex-web-ui.conf
nginx -t
if $reload; then systemctl reload nginx; fi
printf 'Installed and validated %s%s\n' "$target" "$($reload && printf ' (nginx reloaded)' || true)"
