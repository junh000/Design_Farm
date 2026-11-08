"""Opt-in Meshy jobs. No provider traffic is possible with the default settings."""
import asyncio
import base64
import hashlib
import ipaddress
import json
import logging
import math
import os
import re
import socket
import time
import uuid
from urllib.parse import urlsplit

import httpx
from fastapi import HTTPException

from models import MAX_MODEL_BYTES, validate_glb

MAX_IMAGE_BYTES = 5 * 1024 * 1024
API_URL = 'https://api.meshy.ai/openapi/v1/multi-image-to-3d'
ACTIVE = ('queued', 'submitting', 'running', 'needs_review')
UNKNOWN_SUBMISSION = '생성 요청의 접수 여부를 확인할 수 없어요. 중복 청구를 막기 위해 재시도를 중단했습니다. 운영자에게 확인을 요청해 주세요.'
DISABLED = '사진으로 3D 모형을 만드는 기능은 연동 준비 중이에요. GLB 파일을 직접 첨부하거나 사진만으로 등록할 수 있어요.'


def now_ms():
    return int(time.time() * 1000)


def settings():
    key = os.environ.get('DESIGN_FARM_MESHY_API_KEY', '').strip()
    enabled = os.environ.get('DESIGN_FARM_GENERATION_ENABLED') == '1' and bool(key)
    return enabled, key


def configuration():
    enabled, _ = settings()
    return {'enabled': enabled, 'provider': 'meshy', 'min_images': 4, 'max_images': 4,
            'max_image_bytes': MAX_IMAGE_BYTES, 'reason': None if enabled else DISABLED}


def initialize_schema(c):
    c.executescript('''
    CREATE TABLE IF NOT EXISTS model_generations(
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), source_ids TEXT NOT NULL,
      source_signature TEXT NOT NULL, status TEXT NOT NULL, progress INTEGER NOT NULL DEFAULT 0,
      provider_task TEXT, model_id TEXT REFERENCES model_uploads(id), error TEXT,
      retryable INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 1,
      created INTEGER NOT NULL, updated INTEGER NOT NULL, attempt_started INTEGER NOT NULL,
      lease_until INTEGER NOT NULL DEFAULT 0, consumed_credits REAL,
      UNIQUE(owner_id,source_signature));
    CREATE TABLE IF NOT EXISTS model_generation_requests(
      owner_id TEXT NOT NULL REFERENCES users(id), request_key TEXT NOT NULL, payload TEXT NOT NULL,
      job_id TEXT NOT NULL REFERENCES model_generations(id), PRIMARY KEY(owner_id,request_key));
    CREATE TABLE IF NOT EXISTS model_generation_attempts(
      job_id TEXT NOT NULL REFERENCES model_generations(id), number INTEGER NOT NULL,
      owner_id TEXT NOT NULL REFERENCES users(id), created INTEGER NOT NULL,
      PRIMARY KEY(job_id,number));
    CREATE INDEX IF NOT EXISTS model_generation_queue ON model_generations(status,lease_until,created);
    ''')


class ProviderFailure(Exception):
    def __init__(self, message, *, ambiguous=False, retryable=False, temporary=False):
        super().__init__(message)
        self.ambiguous, self.retryable, self.temporary = ambiguous, retryable, temporary


class MeshyProvider:
    """Fixed API destination; asset requests never carry the API authorization header."""
    def __init__(self, key):
        self.key = key

    def client(self):
        return httpx.AsyncClient(timeout=httpx.Timeout(30, connect=10),
                                 follow_redirects=False, trust_env=False)

    async def _json(self, method, url, payload=None):
        submitting = method == 'POST'
        try:
            async with asyncio.timeout(40), self.client() as client:
                async with client.stream(method, url, json=payload,
                                         headers={'Authorization': 'Bearer ' + self.key}) as response:
                    if response.status_code not in (200, 201, 202):
                        # A 5xx/timeout can occur after a chargeable task was created.
                        ambiguous = submitting and (response.status_code >= 500 or response.status_code == 408)
                        temporary = not submitting and (response.status_code >= 500 or response.status_code == 429)
                        raise ProviderFailure('생성 서비스 요청을 처리하지 못했어요. 연결 설정과 이용 한도를 확인해 주세요.',
                                              ambiguous=ambiguous, temporary=temporary,
                                              retryable=submitting and response.status_code == 429)
                    body = bytearray()
                    async for chunk in response.aiter_bytes():
                        body.extend(chunk)
                        if len(body) > 2 * 1024 * 1024:
                            raise ValueError('oversized response')
                    result = json.loads(body)
                    if not isinstance(result, dict):
                        raise ValueError('invalid response')
                    return result
        except ProviderFailure:
            raise
        except (httpx.HTTPError, TimeoutError, ValueError, UnicodeError):
            raise ProviderFailure('생성 서비스 응답을 확인하지 못했어요.', ambiguous=submitting,
                                  temporary=not submitting) from None

    async def submit(self, photos):
        payload = {'image_urls': ['data:image/jpeg;base64,' + base64.b64encode(p).decode() for p in photos],
                   'ai_model': 'meshy-7.1', 'texture_model': 'meshy-7',
                   'geometry_resolution': 'standard', 'should_texture': True, 'should_remesh': True,
                   'topology': 'triangle', 'target_polycount': 30000, 'image_enhancement': False,
                   'auto_size': False, 'target_formats': ['glb']}
        result = await self._json('POST', API_URL, payload)
        task_id = result.get('result')
        if not isinstance(task_id, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', task_id):
            raise ProviderFailure(UNKNOWN_SUBMISSION, ambiguous=True)
        return task_id

    async def retrieve(self, task_id):
        if not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', task_id):
            raise ProviderFailure('생성 작업 번호를 확인할 수 없어요.')
        return await self._json('GET', API_URL + '/' + task_id)

    async def download(self, url):
        try:
            parsed = urlsplit(url)
            if (parsed.scheme != 'https' or parsed.hostname != 'assets.meshy.ai'
                    or parsed.port not in (None, 443) or parsed.username or parsed.password
                    or parsed.fragment or not parsed.path or len(url) > 8192):
                raise ValueError('unapproved asset URL')
            addresses = await asyncio.wait_for(asyncio.to_thread(socket.getaddrinfo,
                                                parsed.hostname, 443, type=socket.SOCK_STREAM), 5)
            if not addresses or any(not ipaddress.ip_address(a[4][0]).is_global for a in addresses):
                raise ValueError('nonpublic address')
        except (ValueError, TypeError, OSError, TimeoutError):
            raise ProviderFailure('생성 파일의 안전한 다운로드 주소를 확인할 수 없어요.') from None
        try:
            async with asyncio.timeout(45), self.client() as client:
                async with client.stream('GET', url) as response:
                    if response.status_code != 200:
                        raise ProviderFailure('생성 파일을 내려받지 못했어요.',
                                              temporary=response.status_code >= 500)
                    length = response.headers.get('Content-Length')
                    if length and (not length.isdigit() or int(length) > MAX_MODEL_BYTES):
                        raise ProviderFailure('생성된 GLB 파일이 20MB 제한을 초과했어요.')
                    raw = bytearray()
                    async for chunk in response.aiter_bytes():
                        raw.extend(chunk)
                        if len(raw) > MAX_MODEL_BYTES:
                            raise ProviderFailure('생성된 GLB 파일이 20MB 제한을 초과했어요.')
                    validate_glb(raw)
                    return bytes(raw)
        except ProviderFailure:
            raise
        except (httpx.HTTPError, TimeoutError):
            raise ProviderFailure('생성 파일을 내려받는 중 연결이 끊겼어요.', temporary=True) from None
        except ValueError:
            raise ProviderFailure('생성 결과가 지원하는 GLB 형식이 아니에요. 직접 GLB를 첨부하거나 사진으로 등록해 주세요.') from None


class GenerationService:
    def __init__(self, database, data):
        self.database, self.data = database, data
        self.provider_factory = MeshyProvider
        self.lock = asyncio.Lock()

    def path(self, ident):
        return self.data() / 'generation-results' / (ident + '.glb')

    def recover(self):
        (self.data() / 'generation-results').mkdir(exist_ok=True)
        with self.database(True) as c:
            # Never resubmit an interrupted chargeable POST. Known task IDs may be polled safely.
            c.execute("UPDATE model_generations SET status='needs_review',error=?,retryable=0,lease_until=0,updated=? WHERE status='submitting' AND provider_task IS NULL",
                      (UNKNOWN_SUBMISSION, now_ms()))
            c.execute("UPDATE model_generations SET status='running',lease_until=0 WHERE status='submitting' AND provider_task IS NOT NULL")
            c.execute("UPDATE model_generations SET lease_until=0 WHERE status='running'")

    def owned(self, c, ident, owner):
        row = c.execute('SELECT * FROM model_generations WHERE id=? AND owner_id=?', (ident, owner)).fetchone()
        if row is None:
            raise HTTPException(404, '생성 작업을 찾을 수 없어요.')
        return row

    def public(self, row):
        ident, model_id = row['id'], row['model_id']
        return {'id': ident, 'status': row['status'], 'progress': row['progress'],
                'source_images': [{'id': source, 'url': '/api/images/' + source} for source in json.loads(row['source_ids'])],
                'candidate_url': '/api/model-generations/' + ident + '/model' if row['status'] in ('succeeded', 'adopted') else None,
                'model': {'id': model_id, 'url': '/api/models/' + model_id} if model_id else None,
                'error': row['error'], 'can_retry': row['status'] == 'failed' and bool(row['retryable']) and settings()[0],
                'attempts': row['attempts'], 'created': row['created'], 'updated': row['updated'],
                'consumed_credits': row['consumed_credits']}

    def get(self, ident, owner):
        with self.database() as c:
            return self.public(self.owned(c, ident, owner))

    def list(self, owner):
        with self.database() as c:
            return {'jobs': [self.public(r) for r in c.execute('SELECT * FROM model_generations WHERE owner_id=? ORDER BY created DESC LIMIT 20', (owner,))]}

    def _existing_request(self, c, owner, key, payload):
        previous = c.execute('SELECT * FROM model_generation_requests WHERE owner_id=? AND request_key=?', (owner, key)).fetchone()
        if previous:
            if previous['payload'] != payload:
                raise HTTPException(409, '같은 요청 번호의 사진이나 작업을 바꿀 수 없어요.')
            return self.public(self.owned(c, previous['job_id'], owner))

    def _limits(self, c, owner):
        today = now_ms() - 86400000
        if c.execute('SELECT COUNT(*) FROM model_generation_attempts WHERE owner_id=? AND created>?', (owner, today)).fetchone()[0] >= 3:
            raise HTTPException(429, '하루에 최대 3회 생성할 수 있어요. 나중에 다시 시도해 주세요.')
        if c.execute('SELECT COUNT(*) FROM model_generation_attempts WHERE created>?', (today,)).fetchone()[0] >= 10:
            raise HTTPException(429, '오늘의 생성 가능 횟수를 모두 사용했어요.')
        if c.execute("SELECT COUNT(*) FROM model_generations WHERE owner_id=? AND status IN ('queued','submitting','running','needs_review')", (owner,)).fetchone()[0]:
            raise HTTPException(409, '진행 중이거나 확인이 필요한 생성 작업을 먼저 완료해 주세요.')
        if c.execute("SELECT COUNT(*) FROM model_generations WHERE status IN ('queued','submitting','running','needs_review')").fetchone()[0] >= 4:
            raise HTTPException(429, '현재 생성 대기열이 가득 찼어요. 잠시 후 다시 시도해 주세요.')

    def create(self, owner, source_ids, key):
        payload = json.dumps({'operation': 'create', 'sources': source_ids}, sort_keys=True)
        with self.database(True) as c:
            existing = self._existing_request(c, owner, key, payload)
            if existing:
                return existing
            if not settings()[0]:
                raise HTTPException(503, DISABLED)
            digests = []
            for source in source_ids:
                if not c.execute('SELECT 1 FROM uploads WHERE id=? AND owner_id=?', (source, owner)).fetchone():
                    raise HTTPException(422, '본인이 올린 사진 4장을 선택해 주세요.')
                path = self.data() / 'uploads' / (source + '.jpg')
                if not path.is_file() or not 0 < path.stat().st_size <= MAX_IMAGE_BYTES:
                    raise HTTPException(422, '원본 사진을 다시 올려 주세요. 각 사진은 최대 5MB입니다.')
                digests.append(hashlib.sha256(path.read_bytes()).hexdigest())
            if len(set(digests)) != 4:
                raise HTTPException(422, '같은 사진을 반복해서 올릴 수 없어요. 서로 다른 방향의 사진 4장이 필요합니다.')
            signature = hashlib.sha256(','.join(digests).encode()).hexdigest()
            previous = c.execute('SELECT * FROM model_generations WHERE owner_id=? AND source_signature=?', (owner, signature)).fetchone()
            if previous:
                c.execute('INSERT INTO model_generation_requests VALUES(?,?,?,?)', (owner, key, payload, previous['id']))
                return self.public(previous)
            self._limits(c, owner)
            if (c.execute('SELECT COUNT(*) FROM model_generations WHERE owner_id=?', (owner,)).fetchone()[0] >= 10
                    or c.execute('SELECT COUNT(*) FROM model_generations').fetchone()[0] >= 100):
                raise HTTPException(429, '보관 가능한 생성 작업 수에 도달했어요. 운영자에게 문의해 주세요.')
            ident, stamp = str(uuid.uuid4()), now_ms()
            c.execute('''INSERT INTO model_generations(id,owner_id,source_ids,source_signature,status,created,updated,attempt_started)
                         VALUES(?,?,?,?,?,?,?,?)''', (ident, owner, json.dumps(source_ids), signature, 'queued', stamp, stamp, stamp))
            c.execute('INSERT INTO model_generation_requests VALUES(?,?,?,?)', (owner, key, payload, ident))
            c.execute('INSERT INTO model_generation_attempts VALUES(?,?,?,?)', (ident, 1, owner, stamp))
            return self.public(self.owned(c, ident, owner))

    def retry(self, ident, owner, key):
        payload = json.dumps({'operation': 'retry', 'job': ident}, sort_keys=True)
        with self.database(True) as c:
            row = self.owned(c, ident, owner)
            existing = self._existing_request(c, owner, key, payload)
            if existing:
                return existing
            if not settings()[0]:
                raise HTTPException(503, DISABLED)
            if row['status'] != 'failed' or not row['retryable']:
                raise HTTPException(409, '이 작업은 다시 생성할 수 없어요. 현재 상태와 안내를 확인해 주세요.')
            self._limits(c, owner)
            stamp, attempt = now_ms(), row['attempts'] + 1
            c.execute("UPDATE model_generations SET status='queued',progress=0,provider_task=NULL,error=NULL,retryable=0,attempts=?,updated=?,attempt_started=?,lease_until=0,consumed_credits=NULL WHERE id=?", (attempt, stamp, stamp, ident))
            c.execute('INSERT INTO model_generation_requests VALUES(?,?,?,?)', (owner, key, payload, ident))
            c.execute('INSERT INTO model_generation_attempts VALUES(?,?,?,?)', (ident, attempt, owner, stamp))
            return self.public(self.owned(c, ident, owner))

    def candidate(self, ident, owner):
        with self.database() as c:
            row = self.owned(c, ident, owner)
            if row['status'] not in ('succeeded', 'adopted') or not self.path(ident).is_file():
                raise HTTPException(404, '검토할 모형이 아직 없어요.')
        return self.path(ident)

    def adopt(self, ident, owner):
        with self.database(True) as c:
            row = self.owned(c, ident, owner)
            if row['status'] == 'adopted':
                return {'id': row['model_id'], 'url': '/api/models/' + row['model_id']}
            if row['status'] != 'succeeded' or not self.path(ident).is_file():
                raise HTTPException(409, '생성이 완료된 모형을 먼저 검토해 주세요.')
            try:
                if self.path(ident).stat().st_size > MAX_MODEL_BYTES:
                    raise ValueError('oversized candidate')
                raw = self.path(ident).read_bytes()
                validate_glb(raw)
            except (OSError, ValueError):
                raise HTTPException(422, '모형 파일을 확인할 수 없어요. 운영자에게 문의해 주세요.') from None
            model_id = str(uuid.uuid4())
            target = self.data() / 'uploads' / (model_id + '.glb')
            try:
                target.write_bytes(raw)
                c.execute('INSERT INTO model_uploads VALUES(?,?)', (model_id, owner))
                c.execute("UPDATE model_generations SET status='adopted',model_id=?,updated=? WHERE id=?", (model_id, now_ms(), ident))
            except Exception:
                target.unlink(missing_ok=True)
                raise
            return {'id': model_id, 'url': '/api/models/' + model_id}

    def _change(self, ident, **fields):
        fields.update(updated=now_ms(), lease_until=0)
        with self.database(True) as c:
            c.execute('UPDATE model_generations SET ' + ','.join(k + '=?' for k in fields) + ' WHERE id=?', (*fields.values(), ident))

    async def tick(self):
        enabled, key = settings()
        if not enabled or self.lock.locked():
            return
        async with self.lock:
            with self.database(True) as c:
                c.execute("UPDATE model_generations SET status='needs_review',error=?,retryable=0,updated=? WHERE status='submitting' AND lease_until<?",
                          (UNKNOWN_SUBMISSION, now_ms(), now_ms()))
                # Submit waiting jobs promptly, then poll the least recently checked
                # remote task. An unfinished old task must not monopolize the queue.
                row = c.execute("""SELECT * FROM model_generations
                                   WHERE status IN ('queued','running') AND lease_until<?
                                   ORDER BY CASE status WHEN 'queued' THEN 0 ELSE 1 END,
                                            updated,created,id LIMIT 1""", (now_ms(),)).fetchone()
                if row is None:
                    return
                row = dict(row)
                status = 'submitting' if row['status'] == 'queued' else 'running'
                c.execute('UPDATE model_generations SET status=?,lease_until=?,updated=? WHERE id=?', (status, now_ms() + 120000, now_ms(), row['id']))
            ident, provider = row['id'], self.provider_factory(key)
            try:
                if row['status'] == 'queued':
                    if now_ms() - row['attempt_started'] > 15 * 60000:
                        self._change(ident, status='failed', retryable=1, error='대기 시간이 길어 생성하지 않았어요. 다시 동의한 후 재시도해 주세요.')
                        return
                    photos = []
                    for source in json.loads(row['source_ids']):
                        path = self.data() / 'uploads' / (source + '.jpg')
                        if not path.is_file() or not 0 < path.stat().st_size <= MAX_IMAGE_BYTES:
                            raise ProviderFailure('생성에 필요한 원본 사진을 찾을 수 없어요.')
                        photos.append(path.read_bytes())
                    task_id = await provider.submit(photos)
                    self._change(ident, status='running', provider_task=task_id, error=None)
                    return
                if now_ms() - row['attempt_started'] > 2 * 60 * 60000:
                    self._change(ident, status='needs_review', retryable=0, error='생성 상태 확인 시간이 초과됐어요. 새 요청 전에 운영자에게 기존 작업 확인을 요청해 주세요.')
                    return
                result = await provider.retrieve(row['provider_task'])
                status = result.get('status')
                credits = result.get('consumed_credits')
                credits = credits if isinstance(credits, (int, float)) and not isinstance(credits, bool) and math.isfinite(credits) and 0 <= credits <= 1000000 else None
                if status in ('PENDING', 'IN_PROGRESS'):
                    progress = result.get('progress', 0)
                    progress = max(0, min(99, int(progress))) if isinstance(progress, (int, float)) and math.isfinite(progress) else 0
                    self._change(ident, progress=progress, error=None, consumed_credits=credits)
                elif status == 'SUCCEEDED':
                    model_urls = result.get('model_urls')
                    if not isinstance(model_urls, dict) or not isinstance(model_urls.get('glb'), str):
                        raise ProviderFailure('생성 결과에 GLB 파일이 없어요.')
                    raw = await provider.download(model_urls['glb'])
                    if len(raw) > MAX_MODEL_BYTES:
                        raise ProviderFailure('생성된 GLB 파일이 20MB 제한을 초과했어요.')
                    validate_glb(raw)
                    path = self.path(ident)
                    path.parent.mkdir(exist_ok=True)
                    temporary = path.with_suffix('.part')
                    temporary.write_bytes(raw)
                    temporary.replace(path)
                    self._change(ident, status='succeeded', progress=100, error=None, consumed_credits=credits)
                elif status in ('FAILED', 'CANCELED'):
                    self._change(ident, status='failed', retryable=1, error='모형을 생성하지 못했어요. 사진을 확인하고 다시 시도하거나 사진만으로 등록해 주세요.', consumed_credits=credits)
                else:
                    self._change(ident, status='needs_review', retryable=0, error='생성 서비스의 작업 상태를 확인할 수 없어요. 운영자에게 확인을 요청해 주세요.')
            except ProviderFailure as error:
                if error.temporary and row['status'] == 'running':
                    self._change(ident, error=str(error))
                else:
                    self._change(ident, status='needs_review' if error.ambiguous else 'failed',
                                 retryable=int(error.retryable and not error.ambiguous),
                                 error=UNKNOWN_SUBMISSION if error.ambiguous else str(error))
            except (OSError, ValueError):
                self._change(ident, status='failed', retryable=0, error='생성 파일을 안전하게 저장하지 못했어요. 운영자에게 문의해 주세요.')
            except Exception:
                # Do not leak provider payloads or resubmit work after an uncertain failure.
                self._change(ident, status='needs_review', retryable=0, error='생성 작업 확인이 필요해요. 운영자에게 문의해 주세요.')

    async def run(self):
        while True:
            await asyncio.sleep(5)
            try:
                await self.tick()
            except Exception:
                # A transient DB failure must not silently stop the worker forever.
                logging.getLogger(__name__).warning('Model generation worker could not update job state; retrying later.')
