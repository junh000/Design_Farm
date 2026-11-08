"""Opt-in, resumable Meshy experiment; preparing a run never uses the network."""
from __future__ import annotations

import argparse
import base64
import contextlib
from datetime import datetime, timezone
import hashlib
import io
import ipaddress
import json
import os
from pathlib import Path
import socket
import struct
import sys
import urllib.error
import urllib.parse
import urllib.request
import warnings

from PIL import Image, ImageOps

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))
from models import MAX_MODEL_BYTES, validate_glb

API = 'https://api.meshy.ai/openapi/v1/multi-image-to-3d'
ESTIMATED_CREDITS = 30
OPTIONS = {
    'ai_model': 'meshy-7.1', 'texture_model': 'meshy-7',
    'geometry_resolution': 'standard', 'should_texture': True,
    'should_remesh': True, 'topology': 'triangle', 'target_polycount': 30000,
    'image_enhancement': False, 'auto_size': False, 'target_formats': ['glb'],
}
FINAL_STATUSES = {'SUCCEEDED', 'FAILED', 'CANCELED'}
PHOTO_LIMIT = 5 * 1024 * 1024
PIXEL_LIMIT = 16_000_000


def now():
    return datetime.now(timezone.utc).isoformat()


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def save_report(directory, report):
    temporary = directory / 'report.json.tmp'
    temporary.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    temporary.replace(directory / 'report.json')


@contextlib.contextmanager
def locked(directory):
    path = directory / '.operation.lock'
    try:
        handle = path.open('x')
    except FileExistsError:
        raise ValueError('Another operation is active. Inspect the saved state before removing a stale lock.') from None
    try:
        handle.close()
        yield json.loads((directory / 'report.json').read_text(encoding='utf-8'))
    finally:
        path.unlink(missing_ok=True)


def normalized_photo(path):
    if path.stat().st_size > PHOTO_LIMIT:
        raise ValueError('Each source photo must be at most 5 MB.')
    raw = path.read_bytes()
    with warnings.catch_warnings():
        warnings.simplefilter('error', Image.DecompressionBombWarning)
        with Image.open(io.BytesIO(raw)) as opened:
            if opened.format not in {'JPEG', 'PNG', 'WEBP'}:
                raise ValueError('Only JPEG, PNG and WEBP photos are supported.')
            if min(opened.size) < 32 or opened.width * opened.height > PIXEL_LIMIT:
                raise ValueError('Photo size must be at least 32 pixels per side and at most 16 megapixels.')
            opened.load()
            oriented = ImageOps.exif_transpose(opened)
            mode = 'RGBA' if 'A' in oriented.getbands() or 'transparency' in oriented.info else 'RGB'
            converted = oriented.convert(mode)
            clean = Image.frombytes(mode, converted.size, converted.tobytes())
            output = io.BytesIO()
            clean.save(output, format='PNG' if mode == 'RGBA' else 'JPEG', **({} if mode == 'RGBA' else {'quality': 95}))
    sanitized = output.getvalue()
    if len(sanitized) > PHOTO_LIMIT:
        raise ValueError('The normalized image exceeds 5 MB; resize it before preparing the experiment.')
    return sanitized, ('image/png' if mode == 'RGBA' else 'image/jpeg'), {
        'original_sha256': digest(raw), 'submitted_sha256': digest(sanitized),
        'width_px': clean.width, 'height_px': clean.height,
    }


def prepare(manifest_path, directory):
    manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
    if not isinstance(manifest, dict):
        raise ValueError('The manifest must be a JSON object.')
    inputs, holdouts = manifest.get('inputs', []), manifest.get('holdouts', [])
    if (manifest.get('version') != 1 or not isinstance(inputs, list) or not isinstance(holdouts, list)
            or len(inputs) != 4 or len(holdouts) > 16
            or any(not isinstance(entry, dict) for entry in inputs + holdouts)):
        raise ValueError('Use a version 1 manifest with exactly four generation inputs and at most 16 holdouts.')
    if not isinstance(manifest.get('object_id'), str) or not manifest['object_id'].strip():
        raise ValueError('object_id is required.')
    if inputs[0].get('view') != 'front':
        raise ValueError('The first generation input must be labelled front.')
    prepared, photos, hashes = [], [], set()
    for index, entry in enumerate(inputs + holdouts):
        if not isinstance(entry.get('view'), str) or not entry['view'].strip():
            raise ValueError('Every photo needs a view label.')
        if not isinstance(entry.get('path'), str) or not entry['path'].strip():
            raise ValueError('Every photo needs a local file path.')
        path = (manifest_path.parent / entry['path']).resolve()
        raw, mime, info = normalized_photo(path)
        if info['submitted_sha256'] in hashes:
            raise ValueError('Duplicate photos are not different viewpoints.')
        hashes.add(info['submitted_sha256'])
        extension = '.png' if mime == 'image/png' else '.jpg'
        name = f'photo-{index + 1:02d}{extension}'
        photos.append({'file': name, 'view': entry['view'], 'mime': mime,
                       'role': 'generation' if index < 4 else 'holdout', **info})
        prepared.append((name, raw))
    fingerprint = digest(json.dumps({'object': manifest['object_id'], 'photos': photos,
                                     'options': OPTIONS}, sort_keys=True).encode())
    report = {
        'schema_version': 1, 'object_id': manifest['object_id'], 'prepared_at': now(),
        'state': 'prepared', 'provider': 'meshy', 'options': OPTIONS.copy(),
        'fingerprint': fingerprint, 'generation_input_count': 4, 'holdout_count': len(holdouts),
        'photos': photos, 'source_kind': manifest.get('source_kind', 'unspecified'),
        'same_object_confirmed': manifest.get('same_object_confirmed') is True,
        'rights_confirmed': manifest.get('rights_confirmed') is True,
        'capture_notes': manifest.get('capture_notes', ''),
        'dimensions_cm': manifest.get('dimensions_cm'),
        'cost': {'estimated_credits': ESTIMATED_CREDITS, 'estimate_checked_on': '2026-11-08',
                 'consumed_credits': None, 'currency': None, 'amount': None,
                 'note': 'Estimate only, not a provider-enforced spending cap.'},
        'provider_task_id': None, 'provider_status': None, 'generation_seconds': None,
        'quality_review': None, 'publishable': False,
        'real_photo_quality_verified': False,
    }
    directory.mkdir(parents=True, exist_ok=False)
    for name, raw in prepared:
        (directory / name).write_bytes(raw)
    save_report(directory, report)
    return report


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class ProviderError(Exception):
    pass


class Client:
    def __init__(self, key):
        if not key:
            raise ValueError('Set DESIGN_FARM_MESHY_API_KEY before a network operation.')
        self.key = key
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

    def request(self, path='', payload=None):
        request = urllib.request.Request(API + path,
            data=None if payload is None else json.dumps(payload).encode(),
            headers={'Authorization': 'Bearer ' + self.key, 'Content-Type': 'application/json'})
        try:
            with self.opener.open(request, timeout=60) as response:
                raw = response.read(2 * 1024 * 1024 + 1)
                if len(raw) > 2 * 1024 * 1024:
                    raise ProviderError('Provider response exceeded the supported size.')
                result = json.loads(raw)
                if not isinstance(result, dict):
                    raise ProviderError('Provider response was not an object.')
                return result
        except urllib.error.HTTPError as error:
            raise ProviderError(f'Provider HTTP {error.code}; inspect the provider dashboard before retrying submission.') from None
        except (urllib.error.URLError, TimeoutError, OSError, ValueError):
            raise ProviderError('Provider request could not be confirmed; do not automatically resubmit.') from None

    def create(self, payload):
        return self.request(payload=payload)

    def get(self, task_id):
        return self.request('/' + urllib.parse.quote(task_id, safe=''))

    def download(self, url):
        if not isinstance(url, str):
            raise ProviderError('Provider did not return a supported GLB URL.')
        parsed = urllib.parse.urlsplit(url)
        if (parsed.scheme != 'https' or parsed.hostname != 'assets.meshy.ai'
                or parsed.port not in {None, 443} or parsed.username or parsed.password or parsed.fragment):
            raise ProviderError('Result URL is outside the approved Meshy asset host.')
        addresses = socket.getaddrinfo(parsed.hostname, 443, type=socket.SOCK_STREAM)
        if not addresses or any(not ipaddress.ip_address(item[4][0]).is_global for item in addresses):
            raise ProviderError('The asset host did not resolve to public addresses.')
        try:
            # A separate request carries no API key, and redirects remain disabled.
            with self.opener.open(urllib.request.Request(url), timeout=60) as response:
                raw = response.read(MAX_MODEL_BYTES + 1)
        except (urllib.error.URLError, TimeoutError, OSError):
            raise ProviderError('Result download failed; polling the existing task can be retried.') from None
        if len(raw) > MAX_MODEL_BYTES:
            raise ProviderError('Generated GLB exceeds the application limit of 20 MB.')
        return raw


def submit(directory, client, *, approve_credits, confirm_transfer):
    with locked(directory) as report:
        if report['state'] != 'prepared':
            raise ValueError('This run has already been submitted or has an uncertain submission; use poll, not submit.')
        if not confirm_transfer or approve_credits != report['cost']['estimated_credits']:
            raise ValueError('Explicit photo-transfer consent and acknowledgement of the 30-credit estimate are required.')
        if report['source_kind'] != 'real_photographs' or not report['same_object_confirmed'] or not report['rights_confirmed']:
            raise ValueError('Confirm real same-object photographs and permission in the manifest before preparing a paid run.')
        image_urls = []
        for photo in report['photos']:
            if photo['role'] != 'generation':
                continue
            raw = (directory / photo['file']).read_bytes()
            if digest(raw) != photo['submitted_sha256']:
                raise ValueError('Prepared photo changed. Prepare a new experiment before submission.')
            image_urls.append('data:' + photo['mime'] + ';base64,' + base64.b64encode(raw).decode())
        report.update(state='submitting', submitted_at=now())
        save_report(directory, report)
        try:
            result = client.create({**report['options'], 'image_urls': image_urls})
            task_id = result.get('result')
            if not isinstance(task_id, str) or not 1 <= len(task_id) <= 200 or any(ord(c) < 32 for c in task_id):
                raise ProviderError('Provider did not return a usable task ID.')
        except Exception:
            report.update(state='submission_unknown', error='Check the Meshy dashboard. A charged task may already exist; no automatic retry.')
            save_report(directory, report)
            raise
        report.update(state='pending', provider_task_id=task_id, provider_status='PENDING')
        save_report(directory, report)
        return report


def poll(directory, client):
    with locked(directory) as report:
        if report['state'] in {'awaiting_review', 'reviewed', 'failed', 'canceled'}:
            return report
        if not report.get('provider_task_id'):
            raise ValueError('No saved provider task ID. Resolve uncertain submission in the provider dashboard.')
        result = client.get(report['provider_task_id'])
        status = result.get('status')
        if not isinstance(status, str) or status not in FINAL_STATUSES | {'PENDING', 'IN_PROGRESS'}:
            raise ProviderError('Unknown provider status; the result was not adopted.')
        report.update(provider_status=status, last_checked_at=now())
        progress = result.get('progress')
        report['progress'] = progress if type(progress) in {int, float} and 0 <= progress <= 100 else None
        credits = result.get('consumed_credits')
        report['cost']['consumed_credits'] = credits if type(credits) is int and credits >= 0 else None
        start, finish = result.get('started_at'), result.get('finished_at')
        if type(start) in {int, float} and type(finish) in {int, float} and 0 < start <= finish:
            report['generation_seconds'] = (finish - start) / 1000
        report['state'] = {'PENDING': 'pending', 'IN_PROGRESS': 'generating', 'FAILED': 'failed',
                           'CANCELED': 'canceled', 'SUCCEEDED': 'downloading'}[status]
        save_report(directory, report)
        if status == 'SUCCEEDED':
            try:
                urls = result.get('model_urls')
                raw = client.download(urls.get('glb', '') if isinstance(urls, dict) else '')
                if len(raw) > MAX_MODEL_BYTES:
                    raise ValueError('Generated GLB exceeds 20 MB.')
                validate_glb(raw)
                size, _ = struct.unpack_from('<II', raw, 12)
                document = json.loads(raw[20:20 + size])
                (directory / 'result.glb').write_bytes(raw)
                report.update(state='awaiting_review', model={'file': 'result.glb', 'bytes': len(raw),
                    'sha256': digest(raw), 'meshes': len(document['meshes']),
                    'materials': len(document.get('materials', [])), 'images': len(document.get('images', []))})
            except (ProviderError, ValueError, OSError):
                report.update(state='result_rejected', error='GLB download or application validation failed. No model is approved.')
                save_report(directory, report)
                raise
        save_report(directory, report)
        return report


def record_review(directory, review_path):
    review = json.loads(review_path.read_text(encoding='utf-8'))
    with locked(directory) as report:
        if report['state'] not in {'awaiting_review', 'reviewed'} or not report.get('model'):
            raise ValueError('A validated generated GLB is required before recording a quality review.')
        if digest((directory / 'result.glb').read_bytes()) != report['model']['sha256']:
            raise ValueError('The generated model changed after validation.')
        for field in ['reviewer', 'shape', 'material', 'missing_parts', 'evidence']:
            if not isinstance(review.get(field), str) or not review[field].strip():
                raise ValueError(f'Review field {field} is required.')
        if review.get('decision') not in {'accept', 'reject'}:
            raise ValueError('Decision must be accept or reject.')
        if review.get('opened_glb') is not True or review.get('compared_all_inputs') is not True:
            raise ValueError('Open the GLB and compare every generation input before recording a review.')
        if report['holdout_count'] and review.get('compared_holdouts') is not True:
            raise ValueError('Compare the extra-angle holdout photos too.')
        report.update(state='reviewed', quality_review={**review, 'recorded_at': now()},
                      publishable=review['decision'] == 'accept', real_photo_quality_verified=True)
        save_report(directory, report)
        return report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    prep = commands.add_parser('prepare', help='Validate and normalize local photos; no network or charges.')
    prep.add_argument('manifest', type=Path)
    prep.add_argument('directory', type=Path)
    create = commands.add_parser('submit', help='One paid request; requires explicit consent and an API key.')
    create.add_argument('directory', type=Path)
    create.add_argument('--confirm-photo-transfer', action='store_true')
    create.add_argument('--approve-estimated-credits', type=int, required=True)
    check = commands.add_parser('poll', help='Fetch an existing task once; never creates another task.')
    check.add_argument('directory', type=Path)
    review = commands.add_parser('review', help='Record a human comparison; does not publish to the website.')
    review.add_argument('directory', type=Path)
    review.add_argument('review_file', type=Path)
    args = parser.parse_args(argv)
    try:
        if args.command == 'prepare':
            result = prepare(args.manifest.resolve(), args.directory.resolve())
        elif args.command == 'review':
            result = record_review(args.directory.resolve(), args.review_file.resolve())
        else:
            client = Client(os.environ.get('DESIGN_FARM_MESHY_API_KEY', ''))
            result = (submit(args.directory.resolve(), client, approve_credits=args.approve_estimated_credits,
                             confirm_transfer=args.confirm_photo_transfer) if args.command == 'submit'
                      else poll(args.directory.resolve(), client))
        print(json.dumps({'state': result['state'], 'report': str(args.directory / 'report.json'),
                          'publishable': result['publishable']}, ensure_ascii=False))
        return 0
    except (ValueError, ProviderError, OSError, Image.DecompressionBombError, Image.DecompressionBombWarning) as error:
        print(str(error), file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
