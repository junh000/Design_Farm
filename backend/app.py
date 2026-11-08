"""Local Design Farm API. Loopback only; payment and student verification are not enabled."""
import asyncio
import hashlib
import hmac
import io
import os
import re
import secrets
import sqlite3
import threading
import time
import uuid
from contextlib import asynccontextmanager, contextmanager
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, HTTPException, Request, Response, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from PIL import Image, UnidentifiedImageError
from pydantic import BaseModel, ConfigDict, Field, field_validator
from models import MAX_MODEL_BYTES, validate_glb
from model_generation import GenerationService, configuration as generation_configuration, initialize_schema as initialize_generation_schema

ROOT = Path(__file__).resolve().parent
DATA = Path(os.environ.get('DESIGN_FARM_DATA', ROOT / 'data'))
DB = DATA / 'gallery.sqlite3'
COOKIE = 'design_farm_session'
MAX_PRICE = 100_000_000
SESSION_DAYS = 7
AUTH_LOCK = threading.Lock()
AUTH_ATTEMPTS: dict[str, list[float]] = {}


def now_ms():
    return int(time.time() * 1000)


@contextmanager
def database(write=False):
    conn = sqlite3.connect(DB, timeout=15)
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA foreign_keys=ON')
    try:
        if write:
            conn.execute('BEGIN IMMEDIATE')
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def password_hash(password: str, salt=None):
    salt = salt or secrets.token_hex(16)
    digest = hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt), n=16384, r=8, p=1).hex()
    return salt + ':' + digest


def password_matches(password, stored):
    return hmac.compare_digest(password_hash(password, stored.split(':')[0]), stored)


def public_user(row):
    return {k: row[k] for k in ('id', 'name', 'email', 'bio', 'study')}


def current_user(request, conn, required=True):
    raw = request.cookies.get(COOKIE, '')
    row = conn.execute('SELECT u.* FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.token_hash=? AND s.expires>?',
                       (hashlib.sha256(raw.encode()).hexdigest(), now_ms())).fetchone()
    if required and not row:
        raise HTTPException(401, '로그인 후 이용해 주세요.')
    return row


def make_session(conn, response, user_id, request):
    previous = request.cookies.get(COOKIE)
    if previous:
        conn.execute('DELETE FROM sessions WHERE token_hash=?', (hashlib.sha256(previous.encode()).hexdigest(),))
    token = secrets.token_urlsafe(40)
    conn.execute('DELETE FROM sessions WHERE expires<=?', (now_ms(),))
    conn.execute('INSERT INTO sessions VALUES (?,?,?)',
                 (hashlib.sha256(token.encode()).hexdigest(), user_id, now_ms() + SESSION_DAYS*86400000))
    response.set_cookie(COOKIE, token, httponly=True, samesite='strict', secure=False,
                        max_age=SESSION_DAYS*86400, path='/')


def throttle(request):
    key = request.client.host if request.client else 'local'
    with AUTH_LOCK:
        attempts = [t for t in AUTH_ATTEMPTS.get(key, []) if t > time.time()-60]
        if len(attempts) >= 20:
            raise HTTPException(429, '시도가 많습니다. 1분 뒤 다시 시도해 주세요.')
        AUTH_ATTEMPTS[key] = attempts + [time.time()]


def initialize():
    DATA.mkdir(parents=True, exist_ok=True)
    (DATA / 'uploads').mkdir(exist_ok=True)
    with database() as c:
        c.execute('PRAGMA journal_mode=WAL')
        c.executescript('''
        CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL,
          name TEXT NOT NULL, password TEXT NOT NULL, bio TEXT NOT NULL DEFAULT '', study TEXT NOT NULL DEFAULT '학생 작가 · 미인증');
        CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,user_id TEXT REFERENCES users(id),expires INTEGER);
        CREATE TABLE IF NOT EXISTS uploads(id TEXT PRIMARY KEY,owner_id TEXT REFERENCES users(id));
        CREATE TABLE IF NOT EXISTS model_uploads(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL REFERENCES users(id));
        CREATE TABLE IF NOT EXISTS registrations(user_id TEXT REFERENCES users(id), request_key TEXT,
          payload TEXT NOT NULL, artwork_id TEXT REFERENCES artworks(id), PRIMARY KEY(user_id,request_key));
        CREATE TABLE IF NOT EXISTS artworks(id TEXT PRIMARY KEY,artist_id TEXT NOT NULL REFERENCES users(id),
          title TEXT NOT NULL,category TEXT NOT NULL,material TEXT NOT NULL,story TEXT NOT NULL,
          image TEXT NOT NULL,width REAL NOT NULL,height REAL NOT NULL,depth REAL NOT NULL,
          space TEXT NOT NULL,placement TEXT NOT NULL,mounting TEXT NOT NULL,
          start INTEGER NOT NULL CHECK(start>=1000 AND start<=100000000 AND start%1000=0),
          ends INTEGER NOT NULL,created INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'active',
          trade_status TEXT NOT NULL DEFAULT 'none',model_url TEXT,usdz_url TEXT);
        CREATE TABLE IF NOT EXISTS bids(id INTEGER PRIMARY KEY AUTOINCREMENT,artwork_id TEXT REFERENCES artworks(id),
          user_id TEXT REFERENCES users(id),amount INTEGER NOT NULL,created INTEGER NOT NULL,
          request_key TEXT NOT NULL,UNIQUE(user_id,request_key));
        CREATE TABLE IF NOT EXISTS saved(user_id TEXT REFERENCES users(id),artwork_id TEXT REFERENCES artworks(id),PRIMARY KEY(user_id,artwork_id));
        CREATE TABLE IF NOT EXISTS inquiries(id TEXT PRIMARY KEY,sender_id TEXT REFERENCES users(id),artist_id TEXT REFERENCES users(id),
          kind TEXT NOT NULL,name TEXT NOT NULL,email TEXT NOT NULL,message TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',created INTEGER NOT NULL,request_key TEXT NOT NULL,UNIQUE(sender_id,request_key));
        CREATE INDEX IF NOT EXISTS bids_work ON bids(artwork_id,id);
        ''')
        initialize_generation_schema(c)
        if c.execute('SELECT COUNT(*) FROM users').fetchone()[0]:
            seed_additional_artworks(c)
            return
        users = [
            ('collector','collector@designfarm.local','게스트 컬렉터','Gallery2026!','일상에 오래 머물 작품을 찾습니다.','컬렉터'),
            ('artist-yoon','yoon@designfarm.local','윤서하',secrets.token_urlsafe(24),'흐릿한 풍경에서 오래 남는 색을 채집합니다.','회화 전공'),
            ('artist-kim','kim@designfarm.local','김도윤',secrets.token_urlsafe(24),'비어 있는 공간과 형태 사이의 관계를 탐구합니다.','조소 전공'),
            ('artist-lee','lee@designfarm.local','이소은',secrets.token_urlsafe(24),'흙의 우연한 표정을 일상의 그릇으로 옮깁니다.','도예 전공'),
            ('artist-jung','jung@designfarm.local','정해린',secrets.token_urlsafe(24),'물과 안료가 남긴 느린 움직임을 기록합니다.','회화 전공'),
        ]
        c.executemany('INSERT INTO users VALUES (?,?,?,?,?,?)',[(a,b,d,password_hash(p),bio,s) for a,b,d,p,bio,s in users])
        t=now_ms()
        works=[
          ('ochre','artist-yoon','온기가 머무는 자리','회화','캔버스에 유채','하루의 끝에 남는 온도를 그렸습니다. 익숙한 풍경을 덜어내고 나니, 색과 빛이 머물 자리가 생겼어요.',40,50,3,'거실','소파 옆 작은 벽에, 중심이 눈높이에 오도록 걸어 주세요. 오후의 자연광과 잘 어울립니다.','wall',42000,3),
          ('sculpture','artist-kim','사이의 형태','조소','석고, 석재 받침','서로를 지탱하는 두 형태와 그 사이의 빈 공간. 바라보는 방향에 따라 조금씩 다른 관계가 보입니다.',26,38,22,'거실','안정적인 콘솔이나 받침 위에 놓고, 주위에 20cm 정도의 여백을 남겨 주세요.','surface',65000,5),
          ('ceramic','artist-lee','이끼의 시간','공예','재유를 입힌 고온 소성 도자','숲의 바닥에서 만난 오래된 초록을 유약으로 옮겼습니다. 손으로 빚은 작은 비대칭을 그대로 남겼어요.',21,24,18,'서재','책장이나 낮은 선반 위에 단독으로 두면 유약의 흐름과 흙의 질감을 가까이 볼 수 있어요.','surface',28000,2),
          ('blue','artist-jung','고요의 파장','회화','면지에 잉크, 오크 프레임','물 위에서 천천히 번지는 파란색. 선명하게 기억되지 않는 순간이 오히려 오래 남는다는 생각에서 시작했습니다.',35,45,2,'침실','침대 옆 벽이나 밝은 독서 공간에 추천합니다. 직사광선을 피해 걸어 주세요.','wall',36000,4),
        ]
        for ident,artist,title,cat,mat,story,w,h,d,space,placement,mount,start,days in works:
            c.execute('''INSERT INTO artworks(id,artist_id,title,category,material,story,image,width,height,depth,space,placement,mounting,start,ends,created)
                       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)''',
                      (ident,artist,title,cat,mat,story,f'/artworks/{ident}.png',w,h,d,space,placement,mount,start,t+days*86400000,t))
        seed_additional_artworks(c)


def seed_additional_artworks(c):
    """Add the second collection once, preserving accounts, bids and auction dates."""
    works = [
      ('verdant','artist-yoon','초록의 문장','회화','캔버스에 유채, 오크 프레임','겹겹이 쌓인 초록 사이로 밝은 지평을 남겼습니다. 가까이에서는 붓의 결을, 멀리에서는 숲의 호흡을 만나보세요.',40,50,3,'거실','밝은 벽에 걸고 식물과 조금 떨어뜨려 놓으면 초록의 층이 더 선명해집니다.','wall',48000,6),
      ('bronze','artist-kim','흐르는 결','조소','브론즈 주조, 석재 받침','이어지는 선이 한 번 비틀리며 작은 풍경을 만듭니다. 손으로 두드린 표면에 시간이 남기는 색을 상상했어요.',20,34,15,'서재','단단한 콘솔에 놓아 주세요. 옆에서 비추는 조명 아래 금속의 결이 살아납니다.','surface',78000,7),
      ('porcelain','artist-lee','백색의 숨','공예','백자토, 반무광 유약','완벽한 원보다 손의 흔적이 남은 둥근 모양을 좋아합니다. 고요한 흰색 안에도 수많은 표정이 있으니까요.',25,28,25,'침실','안정적인 선반 위에 여유를 두고 놓아 주세요. 부드러운 간접광을 추천합니다.','surface',39000,5),
      ('weave','artist-jung','겹의 풍경','공예','리넨, 울, 오크 프레임','실을 한 올씩 엮으며 기억 속 언덕의 선을 그렸습니다. 가까이 다가갈수록 또 다른 작은 풍경이 펼쳐집니다.',30,40,4,'거실','거실 벽이나 독서 공간에 걸어 주세요. 옆에서 들어오는 빛이 섬유의 높낮이를 드러냅니다.','wall',52000,8),
    ]
    t = now_ms()
    for ident,artist,title,cat,mat,story,w,h,d,space,placement,mount,start,days in works:
        if not c.execute('SELECT 1 FROM users WHERE id=?',(artist,)).fetchone():
            continue
        c.execute('''INSERT OR IGNORE INTO artworks(id,artist_id,title,category,material,story,image,width,height,depth,space,placement,mounting,start,ends,created)
                     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)''',
                  (ident,artist,title,cat,mat,story,f'/artworks/{ident}.png',w,h,d,space,placement,mount,start,t+days*86400000,t))


def close_expired(c):
    c.execute("UPDATE artworks SET status=CASE WHEN EXISTS(SELECT 1 FROM bids WHERE bids.artwork_id=artworks.id) THEN 'sold' ELSE 'unsold' END, trade_status=CASE WHEN EXISTS(SELECT 1 FROM bids WHERE bids.artwork_id=artworks.id) THEN 'awaiting_payment' ELSE 'none' END WHERE status='active' AND ends<=?", (now_ms(),))


def serialize_art(c, row, user_id=None):
    a=dict(row)
    a['is_sample']=a['id'] in ('ochre','sculpture','ceramic','blue','verdant','bronze','porcelain','weave')
    artist=c.execute('SELECT id,name,study,bio FROM users WHERE id=?',(a.pop('artist_id'),)).fetchone()
    bids=c.execute('SELECT * FROM bids WHERE artwork_id=? ORDER BY id',(a['id'],)).fetchall()
    a['artist']=dict(artist)
    a['dimensions']={'width':a.pop('width'),'height':a.pop('height'),'depth':a.pop('depth'),'unit':'cm' if a['category']!='디지털' else 'px'}
    a['current_price']=bids[-1]['amount'] if bids else a['start']
    a['minimum_bid']=None if bids and a['current_price']>=MAX_PRICE else (a['current_price']+1000 if bids else a['start'])
    a['bid_count']=len(bids)
    # Public history never reveals account IDs or contact details.
    a['bids']=[{'amount':b['amount'],'created':b['created'],'mine':b['user_id']==user_id} for b in bids]
    a['saved']=bool(user_id and c.execute('SELECT 1 FROM saved WHERE user_id=? AND artwork_id=?',(user_id,a['id'])).fetchone())
    a['mine']=artist['id']==user_id
    a['participated']=any(b['user_id']==user_id for b in bids)
    a['winning']=bool(bids and bids[-1]['user_id']==user_id)
    return a


@asynccontextmanager
async def lifespan(app):
    initialize()
    generations.recover()
    async def expire():
        while True:
            await asyncio.sleep(3)
            await asyncio.to_thread(expire_once)
    task=asyncio.create_task(expire())
    generation_task=asyncio.create_task(generations.run())
    yield
    task.cancel()
    generation_task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass
    try:
        await generation_task
    except asyncio.CancelledError:
        pass


def expire_once():
    with database(True) as c:
        close_expired(c)


app=FastAPI(title='Design Farm — Local Gallery',lifespan=lifespan)
generations=GenerationService(database, lambda: DATA)


@app.middleware('http')
async def security_headers(request:Request,call_next):
    if request.method not in ('GET','HEAD','OPTIONS'):
        origin=request.headers.get('origin')
        if origin and origin not in ('http://127.0.0.1:3000','http://localhost:3000','http://127.0.0.1:8000'):
            return JSONResponse({'detail':'허용되지 않은 요청입니다.'},status_code=403)
        if request.headers.get('x-gallery-request')!='1':
            return JSONResponse({'detail':'요청 확인 정보가 없습니다.'},status_code=403)
    response=await call_next(request)
    response.headers['Cache-Control']='no-store'
    response.headers['X-Content-Type-Options']='nosniff'
    return response


class Input(BaseModel):
    model_config=ConfigDict(str_strip_whitespace=True,extra='forbid')


class GenerationRequest(Input):
    request_key: str = Field(min_length=36, max_length=36)
    consent: bool = Field(strict=True)

    @field_validator('request_key')
    @classmethod
    def valid_request_key(cls, value):
        return str(uuid.UUID(value))

    @field_validator('consent')
    @classmethod
    def require_consent(cls, value):
        if not value:
            raise ValueError('외부 생성 서비스로 사진을 보내고 이용료가 발생할 수 있음에 동의해 주세요.')
        return value


class GenerationCreate(GenerationRequest):
    source_image_ids: list[str] = Field(min_length=4, max_length=4)

    @field_validator('source_image_ids')
    @classmethod
    def valid_source_ids(cls, values):
        values = [str(uuid.UUID(value)) for value in values]
        if len(set(values)) != 4:
            raise ValueError('서로 다른 방향의 사진 4장을 선택해 주세요.')
        return values


def generation_owner(request):
    with database() as c:
        return current_user(request, c)['id']


@app.get('/api/model-generation/config')
def generation_config():
    return generation_configuration()


@app.post('/api/model-generations')
def create_generation(body: GenerationCreate, request: Request):
    return generations.create(generation_owner(request), body.source_image_ids, body.request_key)


@app.get('/api/model-generations')
def list_generations(request: Request):
    return generations.list(generation_owner(request))


@app.get('/api/model-generations/{ident}')
def get_generation(ident: str, request: Request):
    return generations.get(ident, generation_owner(request))


@app.post('/api/model-generations/{ident}/retry')
def retry_generation(ident: str, body: GenerationRequest, request: Request):
    return generations.retry(ident, generation_owner(request), body.request_key)


@app.post('/api/model-generations/{ident}/adopt')
def adopt_generation(ident: str, request: Request):
    return generations.adopt(ident, generation_owner(request))


@app.get('/api/model-generations/{ident}/model')
def generation_model(ident: str, request: Request):
    return FileResponse(generations.candidate(ident, generation_owner(request)), media_type='model/gltf-binary')


class Login(Input):
    email:str=Field(min_length=3,max_length=120)
    password:str=Field(min_length=10,max_length=128)

    @field_validator('email')
    @classmethod
    def email_valid(cls,v):
        if not re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+',v):
            raise ValueError('올바른 이메일을 입력해 주세요.')
        return v.lower()


class Signup(Login):
    name:str=Field(min_length=1,max_length=30)


@app.post('/api/auth/signup')
def signup(body:Signup,request:Request,response:Response):
    throttle(request)
    with database(True) as c:
        if c.execute('SELECT 1 FROM users WHERE email=?',(body.email,)).fetchone():
            raise HTTPException(409,'이미 가입된 이메일입니다.')
        ident=str(uuid.uuid4())
        c.execute('INSERT INTO users(id,email,name,password) VALUES(?,?,?,?)',(ident,body.email,body.name,password_hash(body.password)))
        make_session(c,response,ident,request)
        return {'user':public_user(c.execute('SELECT * FROM users WHERE id=?',(ident,)).fetchone())}


@app.post('/api/auth/login')
def login(body:Login,request:Request,response:Response):
    throttle(request)
    with database(True) as c:
        user=c.execute('SELECT * FROM users WHERE email=?',(body.email,)).fetchone()
        dummy='00'*16+':'+'00'*64
        valid=password_matches(body.password,user['password'] if user else dummy)
        if not user or not valid:
            raise HTTPException(401,'이메일 또는 비밀번호를 확인해 주세요.')
        make_session(c,response,user['id'],request)
        return {'user':public_user(user)}


@app.post('/api/auth/logout')
def logout(request:Request,response:Response):
    with database(True) as c:
        token=request.cookies.get(COOKIE,'')
        c.execute('DELETE FROM sessions WHERE token_hash=?',(hashlib.sha256(token.encode()).hexdigest(),))
    response.delete_cookie(COOKIE,path='/',httponly=True,samesite='strict')
    return {'ok':True}


@app.get('/api/gallery')
def gallery(request:Request):
    with database(True) as c:
        close_expired(c)
        user=current_user(request,c,False)
        works=[serialize_art(c,r,user['id'] if user else None) for r in c.execute('SELECT * FROM artworks ORDER BY created DESC,id')]
        artists=[dict(r) for r in c.execute("SELECT u.id,u.name,u.study,u.bio,COUNT(a.id) AS works,SUM(CASE WHEN a.trade_status='completed' THEN 1 ELSE 0 END) AS sales FROM users u JOIN artworks a ON a.artist_id=u.id GROUP BY u.id ORDER BY sales DESC,u.id")]
        last_sales=None
        rank=None
        for i,a in enumerate(artists):
            if a['sales']!=last_sales:
                rank=i+1
            a['rank']=rank if a['sales']>0 else None
            last_sales=a['sales']
        return {'artworks':works,'artists':artists,'user':public_user(user) if user else None,'server_time':now_ms()}


@app.get('/api/me')
def me(request:Request):
    with database(True) as c:
        close_expired(c)
        u=current_user(request,c)
        works=[serialize_art(c,r,u['id']) for r in c.execute('SELECT * FROM artworks ORDER BY created DESC')]
        inquiries=[dict(r) for r in c.execute('SELECT i.*,s.name sender_name,a.name artist_name FROM inquiries i JOIN users s ON i.sender_id=s.id JOIN users a ON i.artist_id=a.id WHERE sender_id=? OR artist_id=? ORDER BY i.created DESC',(u['id'],u['id']))]
        return {'user':public_user(u),'artworks':[a for a in works if a['mine'] or a['saved'] or a['participated']],'inquiries':inquiries}


class Profile(Input):
    name:str=Field(min_length=1,max_length=30)
    study:str=Field(min_length=1,max_length=100)
    bio:str=Field(max_length=500)


@app.patch('/api/me')
def edit_profile(body:Profile,request:Request):
    with database(True) as c:
        u=current_user(request,c)
        c.execute('UPDATE users SET name=?,study=?,bio=? WHERE id=?',(body.name,body.study,body.bio,u['id']))
    return {'ok':True}


@app.put('/api/artworks/{ident}/save')
def save(ident:str,request:Request):
    with database(True) as c:
        u=current_user(request,c)
        if not c.execute('SELECT 1 FROM artworks WHERE id=?',(ident,)).fetchone():
            raise HTTPException(404,'작품을 찾을 수 없습니다.')
        c.execute('INSERT OR IGNORE INTO saved VALUES(?,?)',(u['id'],ident))
    return {'ok':True}


@app.delete('/api/artworks/{ident}/save')
def unsave(ident:str,request:Request):
    with database(True) as c:
        u=current_user(request,c)
        c.execute('DELETE FROM saved WHERE user_id=? AND artwork_id=?',(u['id'],ident))
    return {'ok':True}


class Bid(Input):
    amount:int=Field(strict=True,ge=1000,le=MAX_PRICE,multiple_of=1000)
    request_key:str=Field(min_length=16,max_length=100)


@app.post('/api/artworks/{ident}/bids')
def bid(ident:str,body:Bid,request:Request):
    with database(True) as c:
        u=current_user(request,c)
        previous=c.execute('SELECT * FROM bids WHERE user_id=? AND request_key=?',(u['id'],body.request_key)).fetchone()
        if previous:
            if previous['artwork_id']!=ident or previous['amount']!=body.amount:
                raise HTTPException(409,'같은 요청에 다른 금액을 사용할 수 없습니다.')
            return {'ok':True,'amount':previous['amount']}
        art=c.execute('SELECT * FROM artworks WHERE id=?',(ident,)).fetchone()
        if not art:
            raise HTTPException(404,'작품을 찾을 수 없습니다.')
        if art['artist_id']==u['id']:
            raise HTTPException(403,'본인 작품에는 입찰할 수 없습니다.')
        if art['status']!='active' or art['ends']<=now_ms():
            raise HTTPException(409,'이미 마감된 경매입니다.')
        top=c.execute('SELECT amount FROM bids WHERE artwork_id=? ORDER BY id DESC LIMIT 1',(ident,)).fetchone()
        minimum=top['amount']+1000 if top else art['start']
        if minimum>MAX_PRICE:
            raise HTTPException(409,'최대 입찰 금액에 도달했습니다.')
        if body.amount<minimum:
            raise HTTPException(409,f'최소 입찰가는 {minimum:,}원입니다. 최신 금액을 확인해 주세요.')
        c.execute('INSERT INTO bids(artwork_id,user_id,amount,created,request_key) VALUES(?,?,?,?,?)',(ident,u['id'],body.amount,now_ms(),body.request_key))
    return {'ok':True,'amount':body.amount}


@app.post('/api/artworks/{ident}/finish-demo')
def finish_demo(ident:str,request:Request):
    with database(True) as c:
        u=current_user(request,c)
        art=c.execute('SELECT * FROM artworks WHERE id=?',(ident,)).fetchone()
        if not art:
            raise HTTPException(404,'작품을 찾을 수 없습니다.')
        involved=art['artist_id']==u['id'] or c.execute('SELECT 1 FROM bids WHERE artwork_id=? AND user_id=?',(ident,u['id'])).fetchone()
        if not involved:
            raise HTTPException(403,'참여하거나 등록한 경매만 체험할 수 있습니다.')
        c.execute("UPDATE artworks SET ends=? WHERE id=? AND status='active'",(now_ms(),ident))
        close_expired(c)
    return {'ok':True}


class Artwork(Input):
    title:str=Field(min_length=1,max_length=60)
    category:Literal['회화','조소','공예','디지털']
    material:str=Field(min_length=1,max_length=100)
    story:str=Field(min_length=1,max_length=500)
    image_id:str
    model_id:str | None = None
    request_key:str | None = Field(default=None,min_length=16,max_length=100)
    width:float=Field(gt=0,le=10000,allow_inf_nan=False)
    height:float=Field(gt=0,le=10000,allow_inf_nan=False)
    depth:float=Field(ge=0,le=10000,allow_inf_nan=False)
    space:Literal['거실','침실','서재','카페·매장','디지털 공간','기타']
    placement:str=Field(min_length=1,max_length=180)
    mounting:Literal['wall','surface','floor']
    start:int=Field(strict=True,ge=1000,le=MAX_PRICE,multiple_of=1000)
    duration:Literal[1,3,7]


@app.post('/api/artworks')
def create_art(body:Artwork,request:Request):
    with database(True) as c:
        u=current_user(request,c)
        payload = body.model_dump_json()
        if body.request_key:
            previous = c.execute('SELECT * FROM registrations WHERE user_id=? AND request_key=?',
                                 (u['id'], body.request_key)).fetchone()
            if previous:
                if previous['payload'] != payload:
                    raise HTTPException(409, '동일한 등록 요청의 내용이 변경되었습니다.')
                return {'id': previous['artwork_id']}
        if not c.execute('SELECT 1 FROM uploads WHERE id=? AND owner_id=?',(body.image_id,u['id'])).fetchone():
            raise HTTPException(422,'본인의 작품 사진을 업로드해 주세요.')
        model_url = None
        if body.model_id:
            if body.category == '디지털' or body.depth <= 0:
                raise HTTPException(422,'3D 모형은 실물 작품의 가로·세로·깊이(cm)가 모두 필요합니다.')
            if not c.execute('SELECT 1 FROM model_uploads WHERE id=? AND owner_id=?',(body.model_id,u['id'])).fetchone():
                raise HTTPException(422,'본인이 업로드한 3D 파일을 선택해 주세요.')
            model_url = '/api/models/' + body.model_id
        ident=str(uuid.uuid4())
        c.execute('''INSERT INTO artworks(id,artist_id,title,category,material,story,image,width,height,depth,space,placement,mounting,start,ends,created)
                     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)''',
                  (ident,u['id'],body.title,body.category,body.material,body.story,'/api/images/'+body.image_id,body.width,body.height,body.depth,body.space,body.placement,body.mounting,body.start,now_ms()+body.duration*86400000,now_ms()))
        c.execute('UPDATE artworks SET model_url=? WHERE id=?', (model_url, ident))
        if body.request_key:
            c.execute('INSERT INTO registrations VALUES(?,?,?,?)', (u['id'], body.request_key, payload, ident))
    return {'id':ident}


@app.post('/api/uploads')
async def upload(request:Request,file:UploadFile):
    with database() as c:
        u=current_user(request,c)
    raw=await file.read(5*1024*1024+1)
    await file.close()
    if len(raw)>5*1024*1024:
        raise HTTPException(422,'이미지는 최대 5MB입니다.')
    try:
        with Image.open(io.BytesIO(raw)) as img:
            if img.format not in ('JPEG','PNG','WEBP') or max(img.size)>10000 or img.width*img.height>40_000_000:
                raise ValueError()
            img.load()
            img.thumbnail((1800,1800))
            ident=str(uuid.uuid4())
            img.convert('RGB').save(DATA/'uploads'/f'{ident}.jpg',quality=90)
    except (UnidentifiedImageError,OSError,ValueError,Image.DecompressionBombError):
        raise HTTPException(422,'유효한 JPG·PNG·WEBP 이미지가 필요합니다. 최대 변 길이는 10,000px입니다.')
    with database(True) as c:
        c.execute('INSERT INTO uploads VALUES(?,?)',(ident,u['id']))
    return {'id':ident,'url':'/api/images/'+ident}


@app.get('/api/images/{ident}')
def uploaded_image(ident:str,request:Request):
    try:
        uuid.UUID(ident)
    except ValueError:
        raise HTTPException(404)
    with database() as c:
        public=c.execute('SELECT 1 FROM artworks WHERE image=?',('/api/images/'+ident,)).fetchone()
        u=current_user(request,c,False)
        owned=u and c.execute('SELECT 1 FROM uploads WHERE id=? AND owner_id=?',(ident,u['id'])).fetchone()
        if not public and not owned:
            raise HTTPException(404)
    return FileResponse(DATA/'uploads'/f'{ident}.jpg',media_type='image/jpeg')


@app.post('/api/model-uploads')
async def upload_model(request: Request, file: UploadFile):
    with database() as c:
        user = current_user(request, c)
    filename = file.filename or ''
    raw = await file.read(MAX_MODEL_BYTES + 1)
    await file.close()
    if len(raw) > MAX_MODEL_BYTES or not filename.lower().endswith('.glb'):
        raise HTTPException(422, 'GLB 파일만 첨부할 수 있습니다. 최대 크기는 20MB입니다.')
    try:
        validate_glb(raw)
    except ValueError as error:
        raise HTTPException(422, str(error))
    ident = str(uuid.uuid4())
    path = DATA / 'uploads' / f'{ident}.glb'
    try:
        path.write_bytes(raw)
        with database(True) as c:
            c.execute('INSERT INTO model_uploads VALUES(?,?)', (ident, user['id']))
    except Exception:
        path.unlink(missing_ok=True)
        raise
    return {'id': ident, 'url': '/api/models/' + ident}


@app.get('/api/models/{ident}')
def uploaded_model(ident: str, request: Request):
    try:
        uuid.UUID(ident)
    except ValueError:
        raise HTTPException(404)
    with database() as c:
        user = current_user(request, c, False)
        public = c.execute('SELECT 1 FROM artworks WHERE model_url=?', ('/api/models/' + ident,)).fetchone()
        owned = user and c.execute('SELECT 1 FROM model_uploads WHERE id=? AND owner_id=?', (ident, user['id'])).fetchone()
        if not public and not owned:
            raise HTTPException(404)
    return FileResponse(DATA / 'uploads' / f'{ident}.glb', media_type='model/gltf-binary')


class Inquiry(Input):
    artist_id:str
    kind:Literal['스카우트','외주 의뢰']
    name:str=Field(min_length=1,max_length=60)
    email:str=Field(min_length=3,max_length=120)
    message:str=Field(min_length=1,max_length=700)
    request_key:str=Field(min_length=16,max_length=100)

    @field_validator('email')
    @classmethod
    def email_valid(cls,v):
        return Login.email_valid(v)


@app.post('/api/inquiries')
def inquire(body:Inquiry,request:Request):
    with database(True) as c:
        u=current_user(request,c)
        if body.artist_id==u['id']:
            raise HTTPException(403,'본인에게 요청할 수 없습니다.')
        if not c.execute('SELECT 1 FROM artworks WHERE artist_id=?',(body.artist_id,)).fetchone():
            raise HTTPException(404,'작가를 찾을 수 없습니다.')
        old=c.execute('SELECT * FROM inquiries WHERE sender_id=? AND request_key=?',(u['id'],body.request_key)).fetchone()
        if old:
            if any(old[k]!=getattr(body,k) for k in ('artist_id','kind','name','email','message')):
                raise HTTPException(409,'같은 요청 키의 내용이 변경되었습니다.')
            return {'id':old['id']}
        ident=str(uuid.uuid4())
        c.execute('INSERT INTO inquiries(id,sender_id,artist_id,kind,name,email,message,created,request_key) VALUES(?,?,?,?,?,?,?,?,?)',
                  (ident,u['id'],body.artist_id,body.kind,body.name,body.email,body.message,now_ms(),body.request_key))
    return {'id':ident}


class InquiryState(Input):
    status:Literal['accepted','declined','cancelled']


@app.patch('/api/inquiries/{ident}')
def inquiry_state(ident:str,body:InquiryState,request:Request):
    with database(True) as c:
        u=current_user(request,c)
        row=c.execute('SELECT * FROM inquiries WHERE id=? AND (sender_id=? OR artist_id=?)',(ident,u['id'],u['id'])).fetchone()
        if not row:
            raise HTTPException(404,'요청을 찾을 수 없습니다.')
        required=row['sender_id'] if body.status=='cancelled' else row['artist_id']
        if required!=u['id']:
            raise HTTPException(403,'이 요청을 변경할 권한이 없습니다.')
        if row['status']!='pending':
            raise HTTPException(409,'이미 처리된 요청입니다.')
        c.execute('UPDATE inquiries SET status=? WHERE id=?',(body.status,ident))
    return {'ok':True}
