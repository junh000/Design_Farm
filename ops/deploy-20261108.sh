#!/usr/bin/env bash
set -Eeuo pipefail
umask 022
BASE=/opt/design-farm
OLD=$(readlink -f "$BASE/current")
REL=$BASE/releases/20261108-4571c7f
BACKUP=$BASE/backups/20261108-4571c7f
export PATH=$BASE/tools/node-v24.21.0-linux-x64/bin:$PATH
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
test "$OLD" = /opt/design-farm/releases/20261013
test ! -e "$REL"
mkdir -p "$REL" "$BACKUP"
chmod 700 "$BACKUP"
printf '%s\n' "$OLD" > "$BACKUP/previous-release.txt"
cp -a /etc/caddy/Caddyfile "$BACKUP/Caddyfile.before"
systemctl cat design-farm-api design-farm-web > "$BACKUP/services.before.txt"
curl --fail --location --retry 2 https://codeload.github.com/junh000/Design_Farm/tar.gz/4571c7ff0d72b7e6db6ccac2791b9c4cf60a54b5 -o "$BACKUP/source.tar.gz"
tar -xzf "$BACKUP/source.tar.gz" --strip-components=1 -C "$REL"
python3 - "$OLD" "$REL" "$BACKUP" <<'PY'
from pathlib import Path
import sys
old, new, backup = map(Path, sys.argv[1:])
before = (old/'backend/app.py').read_text()
p = new/'backend/app.py'
code = p.read_text()
settings = before[before.index('SECURE_COOKIES ='):before.index('MAX_PRICE =')]
assert 'ALLOWED_ORIGINS' in settings
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
for relative in ['frontend/app/layout.tsx','backend/test_hosting.py']:
    (new/relative).write_bytes((old/relative).read_bytes())
config = (backup/'Caddyfile.before').read_text()
start = config.index('design-farm.211-233-200-3.sslip.io {')
end = config.index('\n}', start)+2
block = config[start:end]
assert block.count('max_size 10MB') == 1
config = config[:start]+block.replace('max_size 10MB','max_size 25MB')+config[end:]
(backup/'Caddyfile.candidate').write_text(config)
PY
caddy validate --config "$BACKUP/Caddyfile.candidate" --adapter caddyfile
chown -R designfarm:designfarm "$REL"
runuser -u designfarm -- python3 -m venv "$REL/backend/.venv"
runuser -u designfarm -- "$REL/backend/.venv/bin/python" -m pip install --disable-pip-version-check -r "$REL/backend/requirements.lock.txt"
cd "$REL/backend"
runuser -u designfarm -- env DESIGN_FARM_SECURE_COOKIES=0 .venv/bin/python -m unittest test_app -v
runuser -u designfarm -- .venv/bin/python -m unittest test_hosting -v
cd "$REL/frontend"
runuser -u designfarm -- env PATH="$PATH" npx --yes pnpm@10.20.0 install --frozen-lockfile
runuser -u designfarm -- env PATH="$PATH" npx --yes pnpm@10.20.0 typecheck
runuser -u designfarm -- env PATH="$PATH" node --test tests/spatial-dimensions.test.mjs
runuser -u designfarm -- env PATH="$PATH" NODE_OPTIONS=--max-old-space-size=2048 DESIGN_FARM_PUBLIC_DEMO=1 npx --yes pnpm@10.20.0 build
printf '%s\n' 4571c7ff0d72b7e6db6ccac2791b9c4cf60a54b5 > "$REL/DEPLOYED_COMMIT"
echo BUILD_AND_TESTS_PASSED
ACTIVATING=1
rollback() {
  code=$?
  if [ "$code" -ne 0 ] && [ "${ACTIVATING:-0}" = 1 ]; then
    ln -sfn "$OLD" "$BASE/current.rollback"
    mv -Tf "$BASE/current.rollback" "$BASE/current"
    cp "$BACKUP/Caddyfile.before" /etc/caddy/Caddyfile
    systemctl restart design-farm-api design-farm-web
    systemctl reload caddy
    echo ROLLED_BACK_TO_PREVIOUS_RELEASE
  fi
  exit "$code"
}
trap rollback EXIT
systemctl stop design-farm-api design-farm-web
tar -czf "$BACKUP/data-before.tgz" -C /var/lib design-farm
python3 - "$BACKUP" <<'PY'
import json, sqlite3, sys
from pathlib import Path
c=sqlite3.connect('file:/var/lib/design-farm/gallery.sqlite3?mode=ro',uri=True)
counts={t:c.execute('SELECT COUNT(*) FROM '+t).fetchone()[0] for t in ['users','artworks','bids','sessions']}
(Path(sys.argv[1])/'counts-before.json').write_text(json.dumps(counts))
print('DATA_BACKUP_READY', counts)
PY
ln -s "$REL" "$BASE/current.next"
mv -Tf "$BASE/current.next" "$BASE/current"
cp "$BACKUP/Caddyfile.candidate" /etc/caddy/Caddyfile
systemctl start design-farm-api design-farm-web
systemctl reload caddy
python3 - "$BACKUP" <<'PY'
import json, sqlite3, sys, time, urllib.request
from pathlib import Path
for attempt in range(30):
    try:
        with urllib.request.urlopen('http://127.0.0.1:8100/api/gallery',timeout=3) as r:
            gallery=json.load(r)
        with urllib.request.urlopen('http://127.0.0.1:3100',timeout=3) as r:
            assert r.status==200
        break
    except Exception:
        if attempt==29: raise
        time.sleep(1)
c=sqlite3.connect('file:/var/lib/design-farm/gallery.sqlite3?mode=ro',uri=True)
before=json.loads((Path(sys.argv[1])/'counts-before.json').read_text())
for table,count in before.items():
    assert c.execute('SELECT COUNT(*) FROM '+table).fetchone()[0]>=count,table
assert c.execute("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('model_uploads','registrations')").fetchone()[0]==2
print('NEW_RELEASE_HEALTHY_DATA_PRESERVED',len(gallery['artworks']))
PY
systemctl is-active design-farm-api design-farm-web caddy
ACTIVATING=0
echo DEPLOYMENT_COMPLETE_4571c7f
