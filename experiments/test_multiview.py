"""Offline contract/safety checks, not a real generation-quality experiment."""
import base64
import io
import json
from pathlib import Path
import struct
import tempfile
import unittest
from unittest.mock import Mock, patch

from PIL import Image

from experiments import multiview as experiment


def tiny_glb():
    binary = struct.pack('<9f', 0, 0, 0, 1, 0, 0, 0, 1, 0)
    document = {'asset': {'version': '2.0'}, 'buffers': [{'byteLength': len(binary)}],
        'bufferViews': [{'buffer': 0, 'byteLength': len(binary)}],
        'accessors': [{'bufferView': 0, 'componentType': 5126, 'count': 3, 'type': 'VEC3'}],
        'meshes': [{'primitives': [{'attributes': {'POSITION': 0}}]}],
        'nodes': [{'mesh': 0}], 'scenes': [{'nodes': [0]}], 'scene': 0}
    encoded = json.dumps(document).encode()
    encoded += b' ' * (-len(encoded) % 4)
    return (struct.pack('<4sII', b'glTF', 2, 28 + len(encoded) + len(binary))
            + struct.pack('<II', len(encoded), 0x4E4F534A) + encoded
            + struct.pack('<II', len(binary), 0x004E4942) + binary)


class ExperimentTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        names = ['front', 'right', 'back', 'left', 'upper-right']
        for index, name in enumerate(names):
            image = Image.new('RGB', (40, 60), (index * 30, 50, 180))
            exif = Image.Exif()
            exif[270] = 'private camera note'
            image.save(self.root / f'{name}.jpg', exif=exif)
        self.manifest = {
            'version': 1, 'object_id': 'fixture-not-real-artwork',
            # These are explicit fixture declarations, never a quality experiment.
            'source_kind': 'real_photographs', 'same_object_confirmed': True,
            'rights_confirmed': True,
            'inputs': [{'view': n, 'path': n + '.jpg'} for n in names[:4]],
            'holdouts': [{'view': names[4], 'path': names[4] + '.jpg'}],
        }
        self.manifest_path = self.root / 'manifest.json'
        self.directory = self.root / 'run'
        self.client = Mock()
        self.client.create.return_value = {'result': 'task-fixture'}
        self.client.get.return_value = {'status': 'SUCCEEDED', 'progress': 100,
            'consumed_credits': 30, 'started_at': 1000, 'finished_at': 65000,
            'model_urls': {'glb': 'https://assets.meshy.ai/fixture.glb?token=not-a-real-token'}}
        self.client.download.return_value = tiny_glb()

    def prepare(self):
        self.manifest_path.write_text(json.dumps(self.manifest), encoding='utf-8')
        return experiment.prepare(self.manifest_path, self.directory)

    def submit(self):
        return experiment.submit(self.directory, self.client, approve_credits=30, confirm_transfer=True)

    def report(self):
        return json.loads((self.directory / 'report.json').read_text(encoding='utf-8'))

    def test_prepare_does_not_call_network_or_claim_measured_quality(self):
        with patch('urllib.request.OpenerDirector.open', side_effect=AssertionError('network')):
            result = self.prepare()
        self.assertEqual(result['generation_input_count'], 4)
        self.assertEqual(result['holdout_count'], 1)
        self.assertIsNone(result['generation_seconds'])
        self.assertIsNone(result['cost']['consumed_credits'])
        self.assertFalse(result['real_photo_quality_verified'])
        self.assertFalse(result['publishable'])
        for photo in result['photos']:
            with Image.open(self.directory / photo['file']) as image:
                self.assertFalse(image.getexif())

    def test_eight_generation_inputs_are_rejected_not_silently_truncated(self):
        self.manifest['inputs'] *= 2
        with self.assertRaises(ValueError):
            self.prepare()
        self.assertFalse(self.directory.exists())

    def test_duplicate_photo_is_not_another_view(self):
        self.manifest['inputs'][1]['path'] = 'front.jpg'
        with self.assertRaisesRegex(ValueError, 'Duplicate'):
            self.prepare()

    def test_paid_submit_requires_both_acknowledgements(self):
        self.prepare()
        with self.assertRaises(ValueError):
            experiment.submit(self.directory, self.client, approve_credits=30, confirm_transfer=False)
        with self.assertRaises(ValueError):
            experiment.submit(self.directory, self.client, approve_credits=0, confirm_transfer=True)
        self.client.create.assert_not_called()
        self.assertEqual(self.report()['state'], 'prepared')

    def test_no_generation_of_unconfirmed_or_non_photographic_inputs(self):
        self.manifest['source_kind'] = 'synthetic_test_fixture'
        self.prepare()
        with self.assertRaises(ValueError):
            self.submit()
        self.client.create.assert_not_called()

    def test_submit_sends_four_normalized_images_not_holdouts_or_metadata(self):
        self.prepare()
        self.submit()
        payload = self.client.create.call_args.args[0]
        self.assertEqual(len(payload['image_urls']), 4)
        self.assertEqual(payload['ai_model'], 'meshy-7.1')
        image = Image.open(io.BytesIO(base64.b64decode(payload['image_urls'][0].split(',')[1])))
        self.assertFalse(image.getexif())
        self.assertNotIn('private camera note', json.dumps(payload))
        with self.assertRaises(ValueError):
            self.submit()
        self.assertEqual(self.client.create.call_count, 1)

    def test_ambiguous_submission_cannot_be_charged_again_by_retry(self):
        self.prepare()
        self.client.create.side_effect = experiment.ProviderError('simulated timeout')
        with self.assertRaises(experiment.ProviderError):
            self.submit()
        self.assertEqual(self.report()['state'], 'submission_unknown')
        with self.assertRaises(ValueError):
            self.submit()
        self.assertEqual(self.client.create.call_count, 1)

    def test_changed_input_is_rejected_before_network(self):
        self.prepare()
        (self.directory / 'photo-01.jpg').write_bytes(b'changed')
        with self.assertRaisesRegex(ValueError, 'changed'):
            self.submit()
        self.client.create.assert_not_called()

    def test_success_records_actual_cost_and_time_but_needs_human_review(self):
        self.prepare()
        self.submit()
        result = experiment.poll(self.directory, self.client)
        self.assertEqual(result['state'], 'awaiting_review')
        self.assertEqual(result['generation_seconds'], 64)
        self.assertEqual(result['cost']['consumed_credits'], 30)
        self.assertIsNone(result['cost']['amount'])
        self.assertFalse(result['publishable'])
        self.assertNotIn('token=not-a-real-token', json.dumps(result))
        self.assertNotIn('image_urls', result)
        experiment.poll(self.directory, self.client)
        self.assertEqual(self.client.get.call_count, 1)

    def test_invalid_glb_is_not_saved_or_approved(self):
        self.prepare()
        self.submit()
        self.client.download.return_value = b'invalid glb'
        with self.assertRaises(ValueError):
            experiment.poll(self.directory, self.client)
        self.assertEqual(self.report()['state'], 'result_rejected')
        self.assertFalse((self.directory / 'result.glb').exists())
        self.assertFalse(self.report()['publishable'])

    def test_missing_cost_is_unknown_not_zero(self):
        self.prepare()
        self.submit()
        self.client.get.return_value = {'status': 'IN_PROGRESS', 'progress': 42}
        result = experiment.poll(self.directory, self.client)
        self.assertIsNone(result['cost']['consumed_credits'])
        self.assertIsNone(result['generation_seconds'])

    def test_human_review_requires_glb_and_all_holdout_comparisons(self):
        self.prepare()
        self.submit()
        experiment.poll(self.directory, self.client)
        review = {'reviewer': 'fixture-reviewer', 'shape': 'fixture', 'material': 'fixture',
            'missing_parts': 'fixture', 'evidence': 'fixture-only', 'decision': 'reject',
            'opened_glb': True, 'compared_all_inputs': True, 'compared_holdouts': False}
        path = self.root / 'review.json'
        path.write_text(json.dumps(review), encoding='utf-8')
        with self.assertRaisesRegex(ValueError, 'holdout'):
            experiment.record_review(self.directory, path)
        review['compared_holdouts'] = True
        path.write_text(json.dumps(review), encoding='utf-8')
        result = experiment.record_review(self.directory, path)
        self.assertEqual(result['state'], 'reviewed')
        self.assertFalse(result['publishable'])

    def test_asset_download_rejects_unapproved_hosts_before_network(self):
        client = experiment.Client('fixture-api-key')
        client.opener = Mock()
        for url in ['http://assets.meshy.ai/a.glb', 'https://127.0.0.1/a.glb',
                    'https://assets.meshy.ai.attacker.example/a.glb',
                    'https://user:pass@assets.meshy.ai/a.glb', 'https://assets.meshy.ai:444/a.glb']:
            with self.subTest(url=url), self.assertRaises(experiment.ProviderError):
                client.download(url)
        client.opener.open.assert_not_called()

    def test_asset_download_rejects_private_resolution(self):
        client = experiment.Client('fixture-api-key')
        client.opener = Mock()
        with patch('socket.getaddrinfo', return_value=[(2, 1, 6, '', ('127.0.0.1', 443))]):
            with self.assertRaises(experiment.ProviderError):
                client.download('https://assets.meshy.ai/a.glb')
        client.opener.open.assert_not_called()


if __name__ == '__main__':
    unittest.main()
