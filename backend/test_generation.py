"""All generation tests use temporary data and fake providers; none contact Meshy."""
import asyncio
import io
import json
import os
import socket
import unittest
import uuid
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

import httpx
from fastapi.testclient import TestClient
from PIL import Image

import app
from model_generation import MeshyProvider, ProviderFailure, MAX_MODEL_BYTES
import test_app as test_helpers

model_bytes = test_helpers.model_bytes


class FakeProvider:
    def __init__(self):
        self.submissions = 0
        self.polls = 0
        self.polled_tasks = []
        self.downloads = 0
        self.submit_error = None
        self.results = []
        self.raw = model_bytes()

    async def submit(self, photos):
        self.submissions += 1
        if self.submit_error:
            raise self.submit_error
        assert len(photos) == 4
        return 'task-' + str(self.submissions)

    async def retrieve(self, task):
        self.polls += 1
        self.polled_tasks.append(task)
        result = self.results.pop(0) if self.results else {'status': 'IN_PROGRESS', 'progress': 25}
        if isinstance(result, Exception):
            raise result
        return result

    async def download(self, url):
        self.downloads += 1
        return self.raw


class GenerationTests(unittest.TestCase):
    signup = test_helpers.GalleryTests.signup
    artwork = test_helpers.GalleryTests.artwork
    upload = test_helpers.GalleryTests.upload

    def setUp(self):
        self.env = patch.dict(os.environ, {'DESIGN_FARM_GENERATION_ENABLED': '0', 'DESIGN_FARM_MESHY_API_KEY': ''})
        self.env.start()
        test_helpers.GalleryTests.setUp(self)
        self.previous_factory = app.generations.provider_factory
        self.fake = FakeProvider()
        app.generations.provider_factory = lambda key: self.fake
        self.owner, self.user = self.signup()
        self.other, _ = self.signup('other@example.test')

    def tearDown(self):
        test_helpers.GalleryTests.tearDown(self)
        app.generations.provider_factory = self.previous_factory
        self.env.stop()

    def enable(self):
        os.environ['DESIGN_FARM_GENERATION_ENABLED'] = '1'
        os.environ['DESIGN_FARM_MESHY_API_KEY'] = 'unit-test-only'

    def sources(self, client=None, identical=False):
        result = []
        for i in range(4):
            buffer = io.BytesIO()
            Image.new('RGB', (12, 12), (0 if identical else i * 50, 30, 90)).save(buffer, format='PNG')
            response = (client or self.owner).post('/api/uploads', files={'file': ('photo.png', buffer.getvalue(), 'image/png')})
            self.assertEqual(response.status_code, 200)
            result.append(response.json()['id'])
        return result

    def create(self, sources=None, key=None):
        payload = {'source_image_ids': sources or self.sources(), 'request_key': key or str(uuid.uuid4()), 'consent': True}
        response = self.owner.post('/api/model-generations', json=payload)
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def tick(self):
        asyncio.run(app.generations.tick())

    def complete(self, job):
        self.tick()
        self.fake.results.append({'status': 'SUCCEEDED', 'progress': 100, 'consumed_credits': 30,
                                  'model_urls': {'glb': 'https://assets.meshy.ai/test.glb'}})
        self.tick()
        return self.owner.get('/api/model-generations/' + job['id']).json()

    def test_default_off_and_key_alone_cannot_start_paid_work(self):
        payload = {'source_image_ids': self.sources(), 'request_key': str(uuid.uuid4()), 'consent': True}
        for flag, key in [('0', ''), ('0', 'present'), ('1', '')]:
            os.environ.update(DESIGN_FARM_GENERATION_ENABLED=flag, DESIGN_FARM_MESHY_API_KEY=key)
            config = self.client.get('/api/model-generation/config').json()
            self.assertFalse(config['enabled'])
            self.assertEqual((config['min_images'], config['max_images']), (4, 4))
            self.assertEqual(self.owner.post('/api/model-generations', json=payload).status_code, 503)
            self.tick()
        self.assertEqual(self.client.post('/api/model-generations', json=payload).status_code, 401)
        self.assertEqual(self.client.get('/api/model-generations').status_code, 401)
        self.assertEqual(self.owner.get('/api/model-generations').json()['jobs'], [])
        self.assertEqual(self.fake.submissions, 0)

    def test_four_distinct_owned_photos_and_consent_required(self):
        self.enable()
        photos = self.sources()
        payload = {'source_image_ids': photos, 'request_key': str(uuid.uuid4()), 'consent': True}
        for change in [{'consent': False}, {'consent': 'true'}, {'source_image_ids': photos[:3]},
                       {'source_image_ids': photos + photos[:1]}, {'source_image_ids': [photos[0]] * 4},
                       {'source_image_ids': ['../../anything'] * 4}, {'source_image_ids': self.sources(self.other)},
                       {'source_image_ids': self.sources(identical=True)}]:
            result = self.owner.post('/api/model-generations', json={**payload, **change})
            self.assertEqual(result.status_code, 422, result.text)
        self.assertEqual(self.fake.submissions, 0)

    def test_concurrent_creation_same_photos_deduplicated_before_submission(self):
        self.enable()
        photos = self.sources()
        body = {'source_image_ids': photos, 'request_key': str(uuid.uuid4()), 'consent': True}
        with ThreadPoolExecutor(max_workers=2) as pool:
            replies = list(pool.map(lambda _: self.owner.post('/api/model-generations', json=body), range(2)))
        self.assertTrue(all(r.status_code == 200 for r in replies))
        ident = replies[0].json()['id']
        self.assertEqual(replies[1].json()['id'], ident)
        self.assertEqual(self.create(photos)['id'], ident)
        self.assertEqual(self.owner.post('/api/model-generations', json={**body, 'source_image_ids': list(reversed(photos))}).status_code, 409)
        self.tick()
        self.assertEqual(self.fake.submissions, 1)
        with app.database() as c:
            self.assertEqual(c.execute('SELECT COUNT(*) FROM model_generation_attempts').fetchone()[0], 1)

    def test_progress_private_review_adoption_then_publication(self):
        self.enable()
        photos = self.sources()
        job = self.create(photos)
        self.assertIsNone(job['candidate_url'])
        self.assertEqual(self.other.get('/api/model-generations').json()['jobs'], [])
        for suffix in ['', '/model']:
            self.assertEqual(self.other.get('/api/model-generations/' + job['id'] + suffix).status_code, 404)
        self.assertEqual(self.other.post('/api/model-generations/' + job['id'] + '/adopt').status_code, 404)
        self.assertEqual(self.owner.post('/api/model-generations/' + job['id'] + '/adopt').status_code, 409)
        self.tick()
        self.tick()
        current = self.owner.get('/api/model-generations/' + job['id']).json()
        self.assertEqual((current['status'], current['progress']), ('running', 25))
        self.assertNotIn('provider_task', current)
        self.fake.results.append({'status': 'SUCCEEDED', 'consumed_credits': 30, 'model_urls': {'glb': 'https://assets.meshy.ai/test.glb'}})
        self.tick()
        current = self.owner.get('/api/model-generations/' + job['id']).json()
        self.assertEqual((current['status'], current['consumed_credits']), ('succeeded', 30))
        self.assertEqual(self.owner.get(current['candidate_url']).content, model_bytes())
        self.assertEqual(self.client.get(current['candidate_url']).status_code, 401)
        self.assertEqual(self.other.get(current['candidate_url']).status_code, 404)
        with ThreadPoolExecutor(max_workers=2) as pool:
            adoptions = list(pool.map(lambda _: self.owner.post('/api/model-generations/' + job['id'] + '/adopt'), range(2)))
        self.assertTrue(all(r.status_code == 200 for r in adoptions))
        model = adoptions[0].json()
        self.assertEqual(adoptions[1].json(), model)
        self.assertEqual(self.client.get(model['url']).status_code, 404)
        self.assertEqual(self.other.get(model['url']).status_code, 404)
        before = len(self.client.get('/api/gallery').json()['artworks'])
        self.artwork(self.owner, model_id=model['id'])
        self.assertEqual(self.client.get(model['url']).content, model_bytes())
        self.assertEqual(len(self.client.get('/api/gallery').json()['artworks']), before + 1)
        self.assertEqual(self.owner.get('/api/model-generations/' + job['id']).json()['status'], 'adopted')

    def test_queued_owner_is_submitted_while_other_runs_and_polling_is_fair(self):
        self.enable()
        first = self.create()
        self.tick()
        response = self.other.post('/api/model-generations', json={
            'source_image_ids': self.sources(self.other),
            'request_key': str(uuid.uuid4()), 'consent': True})
        self.assertEqual(response.status_code, 200)
        second = response.json()
        self.tick()
        self.assertEqual(self.fake.submissions, 2)
        self.assertEqual(self.fake.polls, 0)
        self.assertEqual(self.owner.get('/api/model-generations/' + first['id']).json()['status'], 'running')
        self.assertEqual(self.other.get('/api/model-generations/' + second['id']).json()['status'], 'running')
        # Controlled update order verifies repeated IN_PROGRESS replies cannot
        # starve a different remote job even when neither has completed.
        with app.database(True) as c:
            c.execute('UPDATE model_generations SET updated=100 WHERE id=?', (first['id'],))
            c.execute('UPDATE model_generations SET updated=200 WHERE id=?', (second['id'],))
        self.tick()
        self.tick()
        self.assertEqual(self.fake.polled_tasks, ['task-1', 'task-2'])
        self.assertEqual(self.fake.submissions, 2)

    def test_known_failure_retry_idempotency_and_daily_limit(self):
        self.enable()
        job = self.create()
        for attempt in range(1, 4):
            self.tick()
            self.fake.results.append({'status': 'FAILED', 'consumed_credits': 0})
            self.tick()
            current = self.owner.get('/api/model-generations/' + job['id']).json()
            self.assertTrue(current['can_retry'])
            payload = {'request_key': str(uuid.uuid4()), 'consent': True}
            route = '/api/model-generations/' + job['id'] + '/retry'
            response = self.owner.post(route, json=payload)
            if attempt < 3:
                self.assertEqual(response.status_code, 200)
                self.assertEqual(self.owner.post(route, json=payload).json(), response.json())
                self.assertEqual(response.json()['attempts'], attempt + 1)
            else:
                self.assertEqual(response.status_code, 429)
        self.assertEqual(self.fake.submissions, 3)

    def test_ambiguous_submission_never_automatically_retried(self):
        self.enable()
        self.fake.submit_error = ProviderFailure('not exposed provider details', ambiguous=True)
        job = self.create()
        self.tick()
        current = self.owner.get('/api/model-generations/' + job['id']).json()
        self.assertEqual(current['status'], 'needs_review')
        self.assertFalse(current['can_retry'])
        self.assertNotIn('provider details', current['error'])
        self.assertEqual(self.owner.post('/api/model-generations/' + job['id'] + '/retry', json={'request_key': str(uuid.uuid4()), 'consent': True}).status_code, 409)
        self.tick()
        self.assertEqual(self.fake.submissions, 1)

    def test_recovery_preserves_remote_job_and_blocks_unknown_submission(self):
        self.enable()
        job = self.create()
        with app.database(True) as c:
            c.execute("UPDATE model_generations SET status='submitting',lease_until=? WHERE id=?", (app.now_ms() + 100000, job['id']))
        app.generations.recover()
        self.assertEqual(self.owner.get('/api/model-generations/' + job['id']).json()['status'], 'needs_review')
        self.tick()
        self.assertEqual(self.fake.submissions, 0)
        with app.database(True) as c:
            c.execute("UPDATE model_generations SET status='submitting',provider_task='known-task',lease_until=? WHERE id=?", (app.now_ms() + 100000, job['id']))
        app.generations.recover()
        self.tick()
        self.assertEqual(self.fake.polls, 1)
        self.assertEqual(self.fake.submissions, 0)

    def test_stale_submission_lease_becomes_nonretryable_without_restart(self):
        self.enable()
        job = self.create()
        with app.database(True) as c:
            c.execute("UPDATE model_generations SET status='submitting',lease_until=? WHERE id=?", (app.now_ms() - 1, job['id']))
        self.tick()
        current = self.owner.get('/api/model-generations/' + job['id']).json()
        self.assertEqual(current['status'], 'needs_review')
        self.assertFalse(current['can_retry'])
        self.assertEqual(self.fake.submissions, 0)

    def test_temporary_poll_error_and_invalid_glb_never_publish(self):
        self.enable()
        job = self.create()
        self.tick()
        self.fake.results.append(ProviderFailure('잠시 후 다시 확인합니다.', temporary=True))
        self.tick()
        self.assertEqual(self.owner.get('/api/model-generations/' + job['id']).json()['status'], 'running')
        self.fake.raw = b'invalid output'
        self.fake.results.append({'status': 'SUCCEEDED', 'model_urls': {'glb': 'https://assets.meshy.ai/test.glb'}})
        self.tick()
        current = self.owner.get('/api/model-generations/' + job['id']).json()
        self.assertEqual(current['status'], 'failed')
        self.assertFalse(current['can_retry'])
        self.assertIsNone(current['candidate_url'])
        with app.database() as c:
            self.assertEqual(c.execute('SELECT COUNT(*) FROM model_uploads').fetchone()[0], 0)
        self.assertEqual(len(self.client.get('/api/gallery').json()['artworks']), 8)

    def test_disabled_worker_does_not_poll_old_jobs_or_start_new_ones(self):
        self.enable()
        job = self.create()
        self.tick()
        os.environ['DESIGN_FARM_GENERATION_ENABLED'] = '0'
        self.tick()
        self.assertEqual(self.fake.polls, 0)
        self.assertEqual(self.owner.get('/api/model-generations/' + job['id']).status_code, 200)

    def test_expired_queue_requires_fresh_consent_without_submission(self):
        self.enable()
        job = self.create()
        with app.database(True) as c:
            c.execute('UPDATE model_generations SET attempt_started=? WHERE id=?',
                      (app.now_ms() - 16 * 60000, job['id']))
        self.tick()
        current = self.owner.get('/api/model-generations/' + job['id']).json()
        self.assertEqual(current['status'], 'failed')
        self.assertTrue(current['can_retry'])
        self.assertEqual(self.fake.submissions, 0)

    def test_concurrent_retry_with_same_key_creates_only_one_attempt(self):
        self.enable()
        job = self.create()
        self.tick()
        self.fake.results.append({'status': 'FAILED'})
        self.tick()
        body = {'request_key': str(uuid.uuid4()), 'consent': True}
        route = '/api/model-generations/' + job['id'] + '/retry'
        with ThreadPoolExecutor(max_workers=2) as pool:
            responses = list(pool.map(lambda _: self.owner.post(route, json=body), range(2)))
        self.assertEqual([r.status_code for r in responses], [200, 200])
        self.assertTrue(all(r.json()['attempts'] == 2 for r in responses))
        self.assertEqual(self.other.post(route, json=body).status_code, 404)
        with app.database() as c:
            self.assertEqual(c.execute('SELECT COUNT(*) FROM model_generation_attempts').fetchone()[0], 2)


class ProviderTests(unittest.IsolatedAsyncioTestCase):
    def provider(self, handler):
        provider = MeshyProvider('unit-test-secret')
        provider.client = lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler), follow_redirects=False)
        return provider

    async def test_api_payload_and_timeout_have_no_automatic_retries(self):
        received = []
        def handle(request):
            received.append(request)
            if request.method == 'POST':
                body = json.loads(request.content)
                self.assertEqual(len(body['image_urls']), 4)
                self.assertEqual(body['target_formats'], ['glb'])
                self.assertEqual(body['auto_size'], False)
                return httpx.Response(202, json={'result': 'test-task'})
            return httpx.Response(200, json={'status': 'PENDING'})
        provider = self.provider(handle)
        self.assertEqual(await provider.submit([b'photo'] * 4), 'test-task')
        self.assertEqual((await provider.retrieve('test-task'))['status'], 'PENDING')
        self.assertTrue(all(r.url.host == 'api.meshy.ai' for r in received))
        def timeout(request):
            raise httpx.ReadTimeout('a message containing a secret must not escape')
        provider = self.provider(timeout)
        with self.assertRaises(ProviderFailure) as caught:
            await provider.submit([b'photo'] * 4)
        self.assertTrue(caught.exception.ambiguous)
        self.assertNotIn('secret', str(caught.exception))
        for response in [httpx.Response(503, json={'detail': 'private provider message'}),
                         httpx.Response(202, json={'unexpected': 'missing task id'})]:
            provider = self.provider(lambda request: response)
            with self.assertRaises(ProviderFailure) as caught:
                await provider.submit([b'photo'] * 4)
            self.assertTrue(caught.exception.ambiguous)
            self.assertNotIn('private', str(caught.exception))

    async def test_asset_host_dns_redirect_size_and_auth_header(self):
        seen = []
        def handler(request):
            seen.append(request)
            self.assertNotIn('authorization', request.headers)
            return httpx.Response(200, content=model_bytes())
        provider = self.provider(handler)
        public_dns = [(socket.AF_INET, socket.SOCK_STREAM, 6, '', ('8.8.8.8', 443))]
        with patch('model_generation.socket.getaddrinfo', return_value=public_dns):
            self.assertEqual(await provider.download('https://assets.meshy.ai/result.glb?signature=opaque'), model_bytes())
            for url in ['http://assets.meshy.ai/a.glb', 'https://evil.example/a.glb',
                        'https://assets.meshy.ai:444/a.glb', 'https://user:password@assets.meshy.ai/a.glb',
                        'https://assets.meshy.ai.evil.example/a.glb']:
                with self.assertRaises(ProviderFailure):
                    await provider.download(url)
        self.assertEqual(len(seen), 1)
        private_dns = [(socket.AF_INET, socket.SOCK_STREAM, 6, '', ('127.0.0.1', 443))]
        with patch('model_generation.socket.getaddrinfo', return_value=private_dns):
            with self.assertRaises(ProviderFailure):
                await provider.download('https://assets.meshy.ai/result.glb')
        for response in [httpx.Response(302, headers={'Location': 'https://evil.example/a.glb'}),
                         httpx.Response(200, headers={'Content-Length': str(MAX_MODEL_BYTES + 1)}, content=b'x'),
                         httpx.Response(200, content=b'not glb')]:
            provider = self.provider(lambda request: response)
            with patch('model_generation.socket.getaddrinfo', return_value=public_dns):
                with self.assertRaises(ProviderFailure):
                    await provider.download('https://assets.meshy.ai/result.glb')


if __name__ == '__main__':
    unittest.main()
