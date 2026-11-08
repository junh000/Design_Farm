#!/usr/bin/env bash
# Run as root: bash deploy-release.sh <reviewed 40-character source commit> [--activate-only]
# Fetch this script independently; the argument selects the application release.
set -Eeuo pipefail
umask 022
if [[ $# -lt 1 || $# -gt 2 || ! $1 =~ ^[0-9a-f]{40}$ || ${2:-} != "" && ${2:-} != --activate-only ]]; then
  echo 'Usage: deploy-release.sh <40-character commit> [--activate-only]' >&2
  exit 2
fi
test "$EUID" = 0
BASE=/opt/design-farm
COMMIT=$1
NAME=20261108-${COMMIT:0:7}
REL=$BASE/releases/$NAME
BACKUP=$BASE/backups/$NAME
OFF=/etc/systemd/system/design-farm-api.service.d/95-generation-off.conf
export PATH=$BASE/tools/node-v24.21.0-linux-x64/bin:$PATH
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
exec 9>"$BASE/.deploy.lock"
flock -n 9 || { echo 'Another deployment is running.' >&2; exit 1; }
test -L "$BASE/current"
OLD=$(readlink -f "$BASE/current")
case "$OLD" in "$BASE"/releases/*) ;; *) echo 'Unexpected current release path.' >&2; exit 1 ;; esac
test -d "$OLD"
test "$OLD" != "$REL"
test -f /var/lib/design-farm/gallery.sqlite3
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile

if [[ ${2:-} == --activate-only ]]; then
  test "$(cat "$REL/DEPLOYED_COMMIT")" = "$COMMIT"
  test -s "$REL/frontend/.next/BUILD_ID"
  test -x "$REL/backend/.venv/bin/python"
  test "$(cat "$BACKUP/previous-release.txt")" = "$OLD"
  test -f "$BACKUP/BUILD_AND_TESTS_PASSED"
else
  test ! -e "$REL"
  test ! -e "$BACKUP"
  mkdir -p "$REL" "$BACKUP"
  chmod 700 "$BACKUP"
  printf '%s\n' "$OLD" > "$BACKUP/previous-release.txt"
  cp -a /etc/caddy/Caddyfile "$BACKUP/Caddyfile.before"
  systemctl cat design-farm-api design-farm-web > "$BACKUP/services.before.txt"
  curl --fail --location --retry 2 --connect-timeout 15 --max-time 180 \
    "https://codeload.github.com/junh000/Design_Farm/tar.gz/$COMMIT" -o "$BACKUP/source.tar.gz"
  tar -xzf "$BACKUP/source.tar.gz" --no-same-owner --strip-components=1 -C "$REL"
  test -f "$REL/backend/model_generation.py"
  test -f "$REL/backend/test_generation.py"
  test -f "$REL/experiments/test_multiview.py"
  test -f "$REL/frontend/tests/ar-placement.test.mjs"
  python3 - "$OLD" "$REL" <<'PY'
from pathlib import Path
import sys
old, new = map(Path, sys.argv[1:])
before = (old/'backend/app.py').read_text()
p = new/'backend/app.py'
code = p.read_text()
# Preserve the currently verified hosted configuration; never guess a new origin.
settings = before[before.index('SECURE_COOKIES ='):before.index('MAX_PRICE =')]
assert 'ALLOWED_ORIGINS' in settings and 'SECURE_COOKIES' not in code
assert code.count("COOKIE = 'design_farm_session'\n") == 1
code = code.replace("COOKIE = 'design_farm_session'\n", "COOKIE = 'design_farm_session'\n"+settings)
assert code.count('secure=False') == 1
code = code.replace('secure=False', 'secure=SECURE_COOKIES')
origins = "('http://127.0.0.1:3000','http://localhost:3000','http://127.0.0.1:8000')"
assert code.count(origins) == 1
code = code.replace(origins, 'ALLOWED_ORIGINS')
logout = "response.delete_cookie(COOKIE,path='/',httponly=True,samesite='strict')"
assert code.count(logout) == 1
code = code.replace(logout, logout[:-1]+',secure=SECURE_COOKIES)')
compile(code, str(p), 'exec')
p.write_text(code)
for relative in ['frontend/app/layout.tsx', 'backend/test_hosting.py']:
    (new/relative).write_bytes((old/relative).read_bytes())
PY
  chown -R designfarm:designfarm "$REL"
  runuser -u designfarm -- python3 -m venv "$REL/backend/.venv"
  runuser -u designfarm -- "$REL/backend/.venv/bin/python" -m pip install \
    --disable-pip-version-check -r "$REL/backend/requirements.lock.txt"
  cd "$REL/backend"
  # Discovery includes all repository tests. The preserved hosting suite needs
  # secure-cookie defaults and therefore runs separately below.
  runuser -u designfarm -- env DESIGN_FARM_DATA="$REL/.verification-data" \
    DESIGN_FARM_SECURE_COOKIES=0 DESIGN_FARM_GENERATION_ENABLED=0 DESIGN_FARM_MESHY_API_KEY= \
    .venv/bin/python - <<'PY'
import sys, unittest
from pathlib import Path
suite = unittest.TestSuite()
for path in sorted(Path('.').glob('test*.py')):
    if path.name != 'test_hosting.py':
        suite.addTests(unittest.defaultTestLoader.discover('.', pattern=path.name))
assert suite.countTestCases() > 0
sys.exit(not unittest.TextTestRunner(verbosity=2).run(suite).wasSuccessful())
PY
  runuser -u designfarm -- env -u DESIGN_FARM_SECURE_COOKIES \
    DESIGN_FARM_DATA="$REL/.verification-hosting-data" \
    DESIGN_FARM_GENERATION_ENABLED=0 DESIGN_FARM_MESHY_API_KEY= \
    .venv/bin/python -m unittest test_hosting -v
  cd "$REL"
  runuser -u designfarm -- env DESIGN_FARM_GENERATION_ENABLED=0 DESIGN_FARM_MESHY_API_KEY= \
    backend/.venv/bin/python -m unittest experiments.test_multiview -v
  cd "$REL/frontend"
  runuser -u designfarm -- env PATH="$PATH" npx --yes pnpm@10.20.0 install --frozen-lockfile
  runuser -u designfarm -- env PATH="$PATH" npx --yes pnpm@10.20.0 exec next typegen
  runuser -u designfarm -- env PATH="$PATH" npx --yes pnpm@10.20.0 typecheck
  runuser -u designfarm -- env PATH="$PATH" node --test tests/*.test.mjs
  runuser -u designfarm -- env PATH="$PATH" NODE_OPTIONS=--max-old-space-size=2048 \
    DESIGN_FARM_PUBLIC_DEMO=1 npx --yes pnpm@10.20.0 build
  printf '%s\n' "$COMMIT" > "$REL/DEPLOYED_COMMIT"
  touch "$BACKUP/BUILD_AND_TESTS_PASSED"
fi

echo BUILD_AND_TESTS_PASSED
# Refuse activation if another operator changed the live release during the build.
test "$(readlink -f "$BASE/current")" = "$OLD"
ATTEMPT=$(mktemp -d "$BACKUP/activation-$(date -u +%Y%m%dT%H%M%SZ)-XXXXXX")
chmod 700 "$ATTEMPT"
if test -f "$OFF"; then
  cp -a "$OFF" "$ATTEMPT/generation-off.before"
fi
ACTIVATING=1
rollback() {
  code=$?
  trap - EXIT
  if [[ $code -ne 0 && ${ACTIVATING:-0} == 1 ]]; then
    set +e
    ln -sfn "$OLD" "$BASE/current.rollback"
    mv -Tf "$BASE/current.rollback" "$BASE/current"
    if test -f "$ATTEMPT/generation-off.before"; then
      cp -a "$ATTEMPT/generation-off.before" "$OFF"
    else
      rm -f -- "$OFF"
    fi
    systemctl daemon-reload
    systemctl restart design-farm-api design-farm-web
    # Schema additions are backward-compatible. Do not discard writes that arrived
    # during health checks by automatically restoring an older database snapshot.
    if systemctl is-active --quiet design-farm-api design-farm-web caddy; then
      echo ROLLED_BACK_TO_PREVIOUS_RELEASE
    else
      echo ROLLBACK_REQUIRES_ATTENTION >&2
    fi
  fi
  exit "$code"
}
trap rollback EXIT
systemctl stop design-farm-api design-farm-web
tar -czf "$ATTEMPT/data-before.tgz" -C /var/lib design-farm
python3 - "$ATTEMPT" <<'PY'
import json, sqlite3, sys
from pathlib import Path
target = Path(sys.argv[1])
with sqlite3.connect('file:/var/lib/design-farm/gallery.sqlite3?mode=ro', uri=True) as c:
    names = ['users','artworks','bids','sessions','uploads','model_uploads','registrations','saved','inquiries',
             'model_generations','model_generation_requests','model_generation_attempts']
    existing = {r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    counts = {t:c.execute('SELECT COUNT(*) FROM '+t).fetchone()[0] for t in names if t in existing}
    assert {'users','artworks','bids','sessions'} <= counts.keys()
    with sqlite3.connect(target/'gallery-before.sqlite3') as backup:
        c.backup(backup)
    (target/'counts-before.json').write_text(json.dumps(counts))
    print('DATA_BACKUP_READY', counts)
PY
mkdir -p "$(dirname "$OFF")"
# UnsetEnvironment also overrides EnvironmentFile values. Both opt-in flag and
# credential remain absent until an operator deliberately removes this safeguard.
printf '[Service]\nUnsetEnvironment=DESIGN_FARM_GENERATION_ENABLED DESIGN_FARM_MESHY_API_KEY\n' > "$OFF"
systemctl daemon-reload
ln -sfn "$REL" "$BASE/current.next"
mv -Tf "$BASE/current.next" "$BASE/current"
systemctl start design-farm-api design-farm-web
# Caddy is unchanged (25MB body limit, admin API disabled). No reload/restart needed.
python3 - "$ATTEMPT" <<'PY'
import json, sqlite3, sys, time, urllib.request
from pathlib import Path
def get(url):
    with urllib.request.urlopen(url, timeout=3) as response:
        assert response.status == 200
        return json.load(response)
for attempt in range(30):
    try:
        gallery = get('http://127.0.0.1:8100/api/gallery')
        config = get('http://127.0.0.1:8100/api/model-generation/config')
        assert config['enabled'] is False, 'Generation must remain disabled'
        with urllib.request.urlopen('http://127.0.0.1:3100', timeout=3) as response:
            assert response.status == 200
        break
    except Exception:
        if attempt == 29: raise
        time.sleep(1)
with sqlite3.connect('file:/var/lib/design-farm/gallery.sqlite3?mode=ro', uri=True) as c:
    before = json.loads((Path(sys.argv[1])/'counts-before.json').read_text())
    for table, count in before.items():
        assert c.execute('SELECT COUNT(*) FROM '+table).fetchone()[0] >= count, table
    required = {'model_uploads','registrations','model_generations','model_generation_requests','model_generation_attempts'}
    assert required <= {r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    assert c.execute('PRAGMA quick_check').fetchone()[0] == 'ok'
print('NEW_RELEASE_HEALTHY_DATA_PRESERVED', len(gallery['artworks']))
PY
systemctl is-active design-farm-api design-farm-web caddy
ACTIVATING=0
printf 'DEPLOYMENT_COMPLETE_%s\n' "$COMMIT"
