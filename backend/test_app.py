"""Integration tests use isolated temporary storage, never the local gallery data."""
import io
import json
import struct
import tempfile
import unittest
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from fastapi.testclient import TestClient
from PIL import Image
import app


def model_bytes(external=False):
    vertices = struct.pack('<12f', 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1)
    document = {
        'asset': {'version': '2.0'},
        'buffers': [{'byteLength': len(vertices)}],
        'bufferViews': [{'buffer': 0, 'byteLength': len(vertices)}],
        'accessors': [{'bufferView': 0, 'componentType': 5126, 'count': 4, 'type': 'VEC3',
                       'min': [0, 0, 0], 'max': [1, 1, 1]}],
        'meshes': [{'primitives': [{'attributes': {'POSITION': 0}, 'mode': 5}]}],
        'nodes': [{'mesh': 0}], 'scenes': [{'nodes': [0]}], 'scene': 0,
    }
    if external:
        document['buffers'][0]['uri'] = 'https://example.com/private.bin'
    data = json.dumps(document).encode()
    data += b' ' * (-len(data) % 4)
    return (struct.pack('<4sII', b'glTF', 2, 28 + len(data) + len(vertices))
            + struct.pack('<II', len(data), 0x4E4F534A) + data
            + struct.pack('<II', len(vertices), 0x004E4942) + vertices)


class GalleryTests(unittest.TestCase):
    def test_publication_retry_creates_one_artwork_and_preserves_request_content(self):
        artist, _ = self.signup()
        image = self.upload(artist)
        image_url = '/api/images/' + image
        self.assertEqual(self.client.get(image_url).status_code, 404)
        payload = {'title': '최종 미리보기', 'category': '회화', 'material': '캔버스', 'story': '수정 후 공개',
                   'image_id': image, 'width': 30, 'height': 40, 'depth': 0, 'space': '거실',
                   'placement': '벽', 'mounting': 'wall', 'start': 10000, 'duration': 3,
                   'request_key': str(uuid.uuid4())}
        before = len(self.client.get('/api/gallery').json()['artworks'])
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _: artist.post('/api/artworks', json=payload), range(2)))
        self.assertTrue(all(result.status_code == 200 for result in results))
        self.assertEqual(results[0].json()['id'], results[1].json()['id'])
        self.assertEqual(len(self.client.get('/api/gallery').json()['artworks']), before + 1)
        self.assertEqual(self.client.get(image_url).status_code, 200)
        self.assertEqual(artist.post('/api/artworks', json={**payload, 'title': '다른 내용'}).status_code, 409)

    def test_model_upload_is_private_until_published_and_owner_only(self):
        artist, _ = self.signup()
        other, _ = self.signup('other@example.test')
        before = len(other.get('/api/gallery').json()['artworks'])
        raw = model_bytes()
        result = artist.post('/api/model-uploads', files={'file': ('work.glb', raw, 'model/gltf-binary')})
        self.assertEqual(result.status_code, 200, result.text)
        model = result.json()
        self.assertEqual(artist.get(model['url']).content, raw)
        self.assertEqual(other.get(model['url']).status_code, 404)
        self.assertEqual(len(other.get('/api/gallery').json()['artworks']), before)
        payload = {'title': '조형', 'category': '조소', 'material': '석고', 'story': '시험 작품',
                   'image_id': self.upload(other), 'model_id': model['id'], 'width': 20, 'height': 30,
                   'depth': 10, 'space': '거실', 'placement': '탁자', 'mounting': 'surface',
                   'start': 10000, 'duration': 3}
        self.assertEqual(other.post('/api/artworks', json=payload).status_code, 422)
        payload['image_id'] = self.upload(artist)
        self.assertEqual(artist.post('/api/artworks', json={**payload, 'depth': 0}).status_code, 422)
        result = artist.post('/api/artworks', json=payload)
        self.assertEqual(result.status_code, 200, result.text)
        self.assertEqual(other.get(model['url']).content, raw)
        self.assertEqual(self.client.get(model['url']).status_code, 200)
        art = next(a for a in other.get('/api/gallery').json()['artworks'] if a['id'] == result.json()['id'])
        self.assertEqual(art['model_url'], model['url'])
        self.assertEqual(art['dimensions'], {'width': 20, 'height': 30, 'depth': 10, 'unit': 'cm'})
        app.initialize()
        self.assertEqual(other.get(model['url']).content, raw)

    def test_invalid_model_uploads_are_rejected(self):
        artist, _ = self.signup()
        self.assertEqual(self.client.post('/api/model-uploads', files={'file': ('x.glb', model_bytes())}).status_code, 401)
        for name, raw in [('x.txt', model_bytes()), ('x.glb', b'invalid'),
                          ('x.glb', model_bytes()[:-4]), ('x.glb', model_bytes(True)),
                          ('x.glb', b'x' * (app.MAX_MODEL_BYTES + 1))]:
            with self.subTest(name=name, length=len(raw)):
                result = artist.post('/api/model-uploads', files={'file': (name, raw)})
                self.assertEqual(result.status_code, 422, result.text)
        with app.database() as connection:
            self.assertEqual(connection.execute('SELECT COUNT(*) FROM model_uploads').fetchone()[0], 0)
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        app.DATA=Path(self.temp.name)
        app.DB=app.DATA/'test.sqlite3'
        app.AUTH_ATTEMPTS.clear()
        self.client=TestClient(app.app,headers={'X-Gallery-Request':'1'})
        self.client.__enter__()

    def tearDown(self):
        self.client.__exit__(None,None,None)
        self.temp.cleanup()

    def signup(self,email='artist@example.test',name='같은 이름'):
        c=TestClient(app.app,headers={'X-Gallery-Request':'1'})
        r=c.post('/api/auth/signup',json={'name':name,'email':email,'password':'TestPassword123!'})
        self.assertEqual(r.status_code,200,r.text)
        return c,r.json()['user']

    def upload(self,c):
        buffer=io.BytesIO();Image.new('RGB',(20,25),'white').save(buffer,format='PNG')
        r=c.post('/api/uploads',files={'file':('test.png',buffer.getvalue(),'image/png')})
        self.assertEqual(r.status_code,200,r.text)
        return r.json()['id']

    def artwork(self,c,**changes):
        body={'title':'테스트 작품','category':'조소','material':'석고','story':'공간을 위한 형태',
              'image_id':self.upload(c),'width':20,'height':30,'depth':10,'space':'거실',
              'placement':'콘솔 위에 놓으세요','mounting':'surface','start':10000,'duration':3}
        body.update(changes)
        r=c.post('/api/artworks',json=body)
        self.assertEqual(r.status_code,200,r.text)
        return r.json()['id']

    def place(self,c,ident,amount=10000,key=None):
        return c.post(f'/api/artworks/{ident}/bids',json={'amount':amount,'request_key':key or str(uuid.uuid4())})

    def getart(self,c,ident):
        return next(a for a in c.get('/api/gallery').json()['artworks'] if a['id']==ident)

    def test_signup_session_persistence_logout_and_password_hash(self):
        c,u=self.signup()
        cookie=c.cookies.get(app.COOKIE)
        self.assertIsNotNone(cookie)
        fresh=TestClient(app.app,headers={'X-Gallery-Request':'1'},cookies={app.COOKIE:cookie})
        self.assertEqual(fresh.get('/api/me').json()['user']['id'],u['id'])
        with app.database() as db:
            stored=db.execute('SELECT password FROM users WHERE id=?',(u['id'],)).fetchone()[0]
            self.assertNotIn('TestPassword123!',stored)
        c.post('/api/auth/logout')
        self.assertEqual(fresh.get('/api/me').status_code,401)
        self.assertEqual(c.post('/api/auth/login',json={'email':u['email'],'password':'TestPassword123!'}).status_code,200)

    def test_additional_collection_migrates_without_resetting_activity(self):
        c,u=self.signup()
        ident=self.artwork(c)
        buyer,_=self.signup('buyer@example.test')
        self.assertEqual(self.place(buyer,ident).status_code,200)
        self.assertEqual(buyer.put('/api/artworks/ceramic/save').status_code,200)
        c.patch('/api/me',json={'name':'유지할 이름','study':'섬유·패션','bio':'유지할 소개'})
        with app.database(True) as db:
            # Simulate the first collection's existing database before upgrade.
            db.execute("DELETE FROM artworks WHERE id IN ('verdant','bronze','porcelain','weave')")
        app.initialize()
        dates={a['id']:a['ends'] for a in c.get('/api/gallery').json()['artworks']}
        app.initialize()
        gallery=c.get('/api/gallery').json()
        self.assertEqual(len(gallery['artworks']),9)
        self.assertEqual(dates,{a['id']:a['ends'] for a in gallery['artworks']})
        self.assertEqual(gallery['user']['study'],'섬유·패션')
        self.assertEqual(self.getart(buyer,ident)['bid_count'],1)
        self.assertTrue(self.getart(buyer,'ceramic')['saved'])
        self.assertTrue(all(a['is_sample'] for a in gallery['artworks'] if a['id']!=ident))

    def test_anonymous_and_cross_origin_mutations_rejected(self):
        self.assertEqual(self.client.get('/api/me').status_code,401)
        self.assertEqual(self.client.put('/api/artworks/ochre/save').status_code,401)
        self.assertEqual(TestClient(app.app).post('/api/auth/logout').status_code,403)
        self.assertEqual(self.client.post('/api/auth/logout',headers={'Origin':'https://unrelated.example'}).status_code,403)

    def test_invalid_login_and_duplicate_email(self):
        c,u=self.signup()
        self.assertEqual(c.post('/api/auth/login',json={'email':u['email'],'password':'WrongPassword123!'}).status_code,401)
        self.assertEqual(c.post('/api/auth/signup',json={'email':u['email'],'name':'다른 이름','password':'TestPassword123!'}).status_code,409)
        self.assertEqual(c.post('/api/auth/signup',json={'email':'invalid','name':'a','password':'TestPassword123!'}).status_code,422)

    def test_identity_owner_and_same_name_artists(self):
        a,ua=self.signup('a@example.test');b,ub=self.signup('b@example.test')
        ia=self.artwork(a);ib=self.artwork(b)
        self.assertNotEqual(ua['id'],ub['id'])
        self.assertEqual(self.place(a,ia).status_code,403)
        self.assertEqual(self.place(b,ia).status_code,200)
        artists=a.get('/api/gallery').json()['artists']
        same=[x for x in artists if x['name']=='같은 이름']
        self.assertEqual(len(same),2)
        self.assertTrue(all(x['rank'] is None for x in same))
        self.assertEqual(self.getart(a,ib)['mine'],False)

    def test_upload_validation_private_drafts_and_owner(self):
        a,_=self.signup('a@example.test');b,_=self.signup('b@example.test')
        self.assertEqual(a.post('/api/uploads',files={'file':('bad.png',b'not an image','image/png')}).status_code,422)
        self.assertEqual(a.post('/api/uploads',files={'file':('big.png',b'x'*(5*1024*1024+1),'image/png')}).status_code,422)
        image=self.upload(a)
        self.assertEqual(a.get('/api/images/'+image).status_code,200)
        self.assertEqual(b.get('/api/images/'+image).status_code,404)
        self.assertEqual(self.client.get('/api/images/'+image).status_code,404)

    def test_invalid_bid_amounts_and_single_bid_sale(self):
        a,_=self.signup('a@example.test');b,_=self.signup('b@example.test');ident=self.artwork(a)
        for value in [9000,10500,-1000,'10000',100000001,True]:
            self.assertIn(self.place(b,ident,value).status_code,(409,422))
        self.assertEqual(self.place(b,ident).status_code,200)
        self.assertEqual(self.place(b,ident).status_code,409)
        b.post('/api/artworks/'+ident+'/finish-demo')
        art=self.getart(b,ident)
        self.assertEqual((art['status'],art['current_price'],art['trade_status']),('sold',10000,'awaiting_payment'))
        self.assertEqual(self.place(b,ident,11000).status_code,409)
        self.assertEqual(next(x for x in b.get('/api/gallery').json()['artists'] if x['id']==art['artist']['id'])['sales'],0)

    def test_upper_limit_first_bid_and_no_further_bid(self):
        a,_=self.signup('a@example.test');b,_=self.signup('b@example.test');ident=self.artwork(a,start=100000000)
        self.assertEqual(self.getart(b,ident)['minimum_bid'],100000000)
        self.assertEqual(self.place(b,ident,100000000).status_code,200)
        self.assertIsNone(self.getart(b,ident)['minimum_bid'])
        self.assertEqual(self.place(b,ident,100000000).status_code,409)

    def test_unsold_expiry_and_idempotent_finish(self):
        a,_=self.signup('a@example.test');b,_=self.signup('b@example.test');ident=self.artwork(a)
        self.assertEqual(b.post('/api/artworks/'+ident+'/finish-demo').status_code,403)
        with app.database(True) as c:c.execute('UPDATE artworks SET ends=? WHERE id=?',(app.now_ms()-1,ident))
        self.assertEqual(self.place(b,ident).status_code,409)
        self.assertEqual(self.getart(a,ident)['status'],'unsold')
        a.post('/api/artworks/'+ident+'/finish-demo');a.post('/api/artworks/'+ident+'/finish-demo')
        self.assertEqual(self.getart(a,ident)['status'],'unsold')

    def test_idempotent_bid_and_concurrent_equal_bids(self):
        a,_=self.signup('a@example.test');b,_=self.signup('b@example.test');d,_=self.signup('d@example.test');ident=self.artwork(a)
        key=str(uuid.uuid4())
        self.assertEqual(self.place(b,ident,10000,key).status_code,200)
        self.assertEqual(self.place(b,ident,10000,key).status_code,200)
        self.assertEqual(self.place(b,ident,11000,key).status_code,409)
        with ThreadPoolExecutor(max_workers=2) as pool:
            codes=list(pool.map(lambda c:self.place(c,ident,11000).status_code,[b,d]))
        self.assertEqual(sorted(codes),[200,409])
        art=self.getart(b,ident)
        self.assertEqual(art['bid_count'],2)
        self.assertNotIn('user_id',art['bids'][0])

    def test_saves_are_account_scoped_and_idempotent(self):
        a,_=self.signup('a@example.test');b,_=self.signup('b@example.test')
        a.put('/api/artworks/ochre/save');a.put('/api/artworks/ochre/save')
        self.assertEqual(len(a.get('/api/me').json()['artworks']),1)
        self.assertEqual(len(b.get('/api/me').json()['artworks']),0)
        a.delete('/api/artworks/ochre/save')
        self.assertEqual(len(a.get('/api/me').json()['artworks']),0)

    def test_inquiry_privacy_self_block_duplicate_and_terminal_state(self):
        a,ua=self.signup('a@example.test');b,_=self.signup('b@example.test');d,_=self.signup('d@example.test');self.artwork(a)
        body={'artist_id':ua['id'],'kind':'외주 의뢰','name':'테스트','email':'sender@example.test','message':'협업 요청','request_key':str(uuid.uuid4())}
        self.assertEqual(a.post('/api/inquiries',json=body).status_code,403)
        first=b.post('/api/inquiries',json=body);ident=first.json()['id']
        self.assertEqual(b.post('/api/inquiries',json=body).json()['id'],ident)
        self.assertEqual(len(a.get('/api/me').json()['inquiries']),1)
        self.assertEqual(len(d.get('/api/me').json()['inquiries']),0)
        self.assertEqual(d.patch('/api/inquiries/'+ident,json={'status':'accepted'}).status_code,404)
        self.assertEqual(b.patch('/api/inquiries/'+ident,json={'status':'accepted'}).status_code,403)
        self.assertEqual(a.patch('/api/inquiries/'+ident,json={'status':'accepted'}).status_code,200)
        self.assertEqual(b.patch('/api/inquiries/'+ident,json={'status':'cancelled'}).status_code,409)

    def test_profile_identity_stays_stable_and_unknown_privileges_rejected(self):
        a,ua=self.signup()
        payload={'name':'새 이름','study':'회화','bio':'나의 소개'}
        self.assertEqual(a.patch('/api/me',json={**payload,'id':'collector'}).status_code,422)
        self.assertEqual(a.patch('/api/me',json=payload).status_code,200)
        profile=a.get('/api/me').json()['user']
        self.assertEqual((profile['id'],profile['name']),(ua['id'],'새 이름'))


if __name__=='__main__':
    unittest.main(verbosity=2)
