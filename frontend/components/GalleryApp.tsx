"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  ArrowUpRight,
  ArrowRight,
  ArrowLeft,
  Heart,
  Search,
  SlidersHorizontal,
  UserRound,
  Plus,
  Check,
  Clock3,
  Box,
  MoveUpRight,
  Mail,
  LogOut,
  ChevronDown,
  ImagePlus,
  Bookmark,
  LayoutGrid,
  LoaderCircle,
  Leaf,
  CheckCircle2,
  X,
} from "lucide-react";
import SculptureScene from "./SculptureScene";
import Brand from "./Brand";
import SpaceDemo from "./SpaceDemo";
import Modal from "./Modal";
import ArtworkImage from "./ArtworkImage";
import ArtworkPreview, { type PreviewArt } from "./ArtworkPreview";
import {
  api,
  Art,
  Artist,
  User,
  Gallery,
  Activity,
  Inquiry,
  money,
  dimensions,
  remaining,
} from "./types";

const categories = ["전체", "회화", "조소", "공예", "디지털"];
const spaces = ["거실", "침실", "서재", "카페·매장", "디지털 공간", "기타"];
const date = (t: number) =>
  new Date(t).toLocaleString("ko-KR", {
    timeZone: "Asia/Seoul",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }) + " KST";
const errorMessage = (e: unknown) =>
  e instanceof Error ? e.message : "다시 시도해 주세요.";

export default function GalleryApp() {
  const path = usePathname(),
    router = useRouter();
  const [data, setData] = useState<Gallery | null>(null),
    [error, setError] = useState("");
  const [time, setTime] = useState(Date.now()),
    offset = useRef(0);
  const [selected, setSelected] = useState<string | null>(null),
    [artist, setArtist] = useState<Artist | null>(null);
  const [inquiry, setInquiry] = useState<Artist | null>(null),
    [notice, setNotice] = useState("");
  const [menu, setMenu] = useState(false),
    [authPrompt, setAuthPrompt] = useState(false);
  const [activity, setActivity] = useState<Activity | null>(null),
    [activityError, setActivityError] = useState("");
  const [category, setCategory] = useState("전체"),
    [query, setQuery] = useState(""),
    [space, setSpace] = useState(""),
    [sort, setSort] = useState("new");
  const [tab, setTab] = useState("activity"),
    [busySave, setBusySave] = useState<string | null>(null);
  const user = data?.user;
  const refresh = useCallback(async () => {
    try {
      const d = await api<Gallery>("/gallery");
      offset.current = d.server_time - Date.now();
      setData(d);
      setError("");
      return d;
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);
  const refreshActivity = useCallback(async () => {
    try {
      setActivity(await api<Activity>("/me"));
      setActivityError("");
    } catch (e) {
      setActivityError(errorMessage(e));
    }
  }, []);
  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 15000);
    return () => clearInterval(timer);
  }, [refresh]);
  useEffect(() => {
    const timer = setInterval(() => setTime(Date.now() + offset.current), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    const expired = data?.artworks.some(
      (a) => a.status === "active" && a.ends <= time,
    );
    if (expired) refresh();
  }, [Math.floor(time / 5000), data, refresh]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 4500);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    setMenu(false);
    setSelected(null);
    setArtist(null);
    const p = new URLSearchParams(window.location.search);
    setCategory(p.get("category") || "전체");
    setQuery(p.get("q") || "");
    setSpace(p.get("space") || "");
    setSort(p.get("sort") || "new");
    setTab(p.get("tab") || "activity");
  }, [path]);
  useEffect(() => {
    if (path === "/mypage" && user) refreshActivity();
  }, [path, user?.id, data?.server_time, refreshActivity]);
  useEffect(() => {
    const pop = () => {
      const p = new URLSearchParams(location.search);
      setCategory(p.get("category") || "전체");
      setQuery(p.get("q") || "");
      setSpace(p.get("space") || "");
      setSort(p.get("sort") || "new");
      setTab(p.get("tab") || "activity");
    };
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, []);

  function changeFilters(next: {
    category?: string;
    q?: string;
    space?: string;
    sort?: string;
  }) {
    const values = { category, q: query, space, sort, ...next };
    setCategory(values.category);
    setQuery(values.q);
    setSpace(values.space);
    setSort(values.sort);
    const p = new URLSearchParams();
    Object.entries(values).forEach(([k, v]) => {
      if (v && v !== "전체" && v !== "new") p.set(k, v);
    });
    history.replaceState(
      null,
      "",
      path + (p.size ? "?" + p : "") + (path === "/" ? "#collection" : ""),
    );
  }
  function changeTab(t: string) {
    setTab(t);
    history.pushState(null, "", "/mypage?tab=" + t);
  }
  async function save(a: Art) {
    if (!user) {
      setAuthPrompt(true);
      return;
    }
    if (busySave) return;
    setBusySave(a.id);
    try {
      await api("/artworks/" + a.id + "/save", {
        method: a.saved ? "DELETE" : "PUT",
      });
      await refresh();
      setNotice(
        a.saved
          ? "관심 작품에서 해제했어요."
          : "관심 작품에 담았어요. 마이페이지에서 다시 만나요.",
      );
    } catch (e) {
      setNotice(errorMessage(e));
    } finally {
      setBusySave(null);
    }
  }
  async function logout() {
    try {
      await api("/auth/logout", { method: "POST" });
      setActivity(null);
      await refresh();
      router.push("/");
      setNotice("로그아웃했습니다.");
    } catch (e) {
      setNotice(errorMessage(e));
    }
  }
  function requestInquiry(a: Artist) {
    setArtist(null);
    if (!user) {
      setAuthPrompt(true);
      return;
    }
    setInquiry(a);
  }
  const visible = (data?.artworks || [])
    .filter(
      (a) =>
        (category === "전체" || a.category === category) &&
        (!space || a.space === space) &&
        (!query ||
          `${a.title} ${a.artist.name} ${a.material}`
            .toLowerCase()
            .includes(query.toLowerCase())) &&
        (sort !== "closing" || a.status === "active"),
    )
    .sort((a, b) =>
      sort === "price"
        ? a.current_price - b.current_price || a.id.localeCompare(b.id)
        : sort === "closing"
          ? a.ends - b.ends || a.id.localeCompare(b.id)
          : b.created - a.created || a.id.localeCompare(b.id),
    );
  const current = data?.artworks.find((a) => a.id === selected);

  const cards = (
    <div className="art-grid">
      {visible.map((a) => (
        <ArtCard
          key={a.id}
          a={a}
          time={time}
          onOpen={() => setSelected(a.id)}
          onSave={() => save(a)}
          saving={busySave === a.id}
        />
      ))}
      {data && !visible.length && (
        <div className="empty-state">
          <Search size={28} />
          <h3>아직 이 조건의 작품이 없어요.</h3>
          <p>다른 공간이나 종류로 새로운 작품을 만나보세요.</p>
          <button
            className="button secondary"
            onClick={() =>
              changeFilters({ category: "전체", q: "", space: "", sort: "new" })
            }
          >
            필터 초기화
          </button>
        </div>
      )}
    </div>
  );
  const filters = (
    <div className="filters">
      <div className="category-tabs" aria-label="작품 종류">
        {categories.map((c) => (
          <button
            key={c}
            aria-pressed={category === c}
            className={category === c ? "active" : ""}
            onClick={() => changeFilters({ category: c })}
          >
            {c}
            {c === "전체" && <sup>{data?.artworks.length || 0}</sup>}
          </button>
        ))}
      </div>
      <div className="filter-tools">
        <label className="search-field">
          <Search size={17} />
          <input
            type="search"
            aria-label="작품 또는 작가 검색"
            placeholder="작품, 작가 검색"
            value={query}
            onChange={(e) => changeFilters({ q: e.target.value })}
          />
        </label>
        <label className="select-field">
          <SlidersHorizontal size={15} />
          <select
            aria-label="추천 공간"
            value={space}
            onChange={(e) => changeFilters({ space: e.target.value })}
          >
            <option value="">모든 공간</option>
            {spaces.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </label>
        <select
          aria-label="정렬"
          value={sort}
          onChange={(e) => changeFilters({ sort: e.target.value })}
        >
          <option value="new">새로운 작품순</option>
          <option value="closing">마감 임박순</option>
          <option value="price">낮은 가격순</option>
        </select>
      </div>
      {(query || space || category !== "전체") && (
        <div className="filter-summary">
          {[category !== "전체" ? category : "", space, query]
            .filter(Boolean)
            .join(" · ")}{" "}
          <span>{visible.length}점</span>
          <button
            onClick={() =>
              changeFilters({ category: "전체", q: "", space: "" })
            }
          >
            초기화 <X size={13} />
          </button>
        </div>
      )}
    </div>
  );

  return (
    <>
      <a href="#main" className="skip-link">
        본문으로 건너뛰기
      </a>
      <div className="announcement">
        <span>NEW PERSPECTIVES, EVERYDAY.</span>
        <span>
          새로운 작가의 첫 전시, 당신의 첫 소장 <ArrowUpRight size={12} />
        </span>
      </div>
      <header className="header">
        <div className="header-inner">
          <Brand />
          <nav aria-label="주 메뉴">
            <Link
              href="/gallery"
              className={path === "/gallery" ? "active" : ""}
            >
              작품 둘러보기
            </Link>
            <Link
              href="/artists"
              className={path === "/artists" ? "active" : ""}
            >
              작가 이야기
            </Link>
            <Link href="/space" className={path === "/space" ? "active" : ""}>
              공간과 예술 <span className="new-dot" />
            </Link>
          </nav>
          <div className="header-actions">
            <button
              className="icon-button wishlist-link"
              aria-label="관심 작품"
              onClick={() => {
                if (user) {
                  router.push("/mypage?tab=saved");
                  setTab("saved");
                } else setAuthPrompt(true);
              }}
            >
              <Heart size={19} />
            </button>
            {user ? (
              <div className="account-wrap">
                <button
                  className="account-button"
                  aria-expanded={menu}
                  aria-controls="account-menu"
                  onClick={() => setMenu(!menu)}
                >
                  <UserRound size={17} />
                  <span>마이페이지</span>
                  <ChevronDown size={13} />
                </button>
                {menu && (
                  <div className="account-menu" id="account-menu">
                    <p>
                      {user.name} 님<small>{user.email}</small>
                    </p>
                    <Link
                      href="/mypage"
                      onClick={() => {
                        setTab("activity");
                        setMenu(false);
                      }}
                    >
                      내 활동
                    </Link>
                    <button
                      onClick={() => {
                        router.push("/mypage?tab=profile");
                        setTab("profile");
                        setMenu(false);
                      }}
                    >
                      프로필 설정
                    </button>
                    <button onClick={logout}>
                      <LogOut size={14} /> 로그아웃
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <Link href="/login" className="login-link">
                <UserRound size={16} />
                <span>로그인</span>
              </Link>
            )}
            <Link href="/studio" className="button small dark">
              작품 등록 <Plus size={15} />
            </Link>
          </div>
        </div>
      </header>
      <main id="main">
        {error && (
          <div className="connection-error" role="alert">
            {error}
            <button onClick={refresh}>다시 연결</button>
          </div>
        )}
        {!data && !error && (
          <div className="loading-line" role="status">
            전시를 준비하고 있어요 <LoaderCircle size={15} className="spin" />
          </div>
        )}
        {path === "/" && (
          <>
            <section className="hero container">
              <div className="hero-copy">
                <div className="edition">
                  <span className="dot" /> THE FIRST COLLECTION{" "}
                  <span>VOL. 01 — 2026</span>
                </div>
                <h1>
                  예술이 머무는
                  <br />
                  당신의 <span className="serif-accent">일상.</span>
                </h1>
                <p className="hero-english">
                  A little art. A different everyday.
                </p>
                <p className="hero-description">
                  작업실에서 시작된 새로운 시선이
                  <br />
                  당신의 공간에서 다음 이야기를 만듭니다.
                </p>
                <Link href="/gallery" className="button dark hero-button">
                  나의 첫 작품 발견하기 <ArrowUpRight size={18} />
                </Link>
                <div className="hero-bottom">
                  <span className="hero-line" />
                  <p>
                    회화부터 조소, 공예까지.
                    <br />
                    <b>취향으로 만나고, 오래도록 함께하세요.</b>
                  </p>
                </div>
              </div>
              <div className="hero-exhibit">
                <div className="exhibit-wall">
                  <div className="wall-caption">
                    DESIGN_FARM GALLERY <span>CURATED SELECTION</span>
                  </div>
                  <button
                    className="hero-painting"
                    aria-label="온기가 머무는 자리 작품 보기"
                    onClick={() => setSelected("ochre")}
                  >
                    <ArtworkImage
                      src="/artworks/ochre.png"
                      alt="황토빛 풍경을 그린 유화 온기가 머무는 자리"
                      fetchPriority="high"
                      loading="eager"
                    />
                  </button>
                  <div className="hero-label">
                    <span>윤서하, 〈온기가 머무는 자리〉</span>
                    <small>Oil on canvas · 2026</small>
                  </div>
                  <button
                    className="hero-object"
                    aria-label="사이의 형태 조소 작품 보기"
                    onClick={() => setSelected("sculpture")}
                  >
                    <ArtworkImage
                      src="/artworks/sculpture.png"
                      alt="두 고리가 연결된 석고 조소"
                    />
                    <span>
                      형태를 만나는 새로운 시선 <ArrowUpRight size={15} />
                    </span>
                  </button>
                  <span className="vertical-label">
                    CURATED FOR YOUR EVERYDAY
                  </span>
                </div>
              </div>
            </section>
            <div className="intro-strip container">
              <span>
                <Leaf size={17} /> 새로운 작가를 발견하는 즐거움
              </span>
              <span>
                <Box size={17} /> 당신의 공간에 맞는 작품
              </span>
              <span>
                <Heart size={17} /> 시작가부터 가볍게 만나는 예술
              </span>
              <span className="strip-number">ART GROWS HERE. ↗</span>
            </div>
          </>
        )}
        {(path === "/" || path === "/gallery") && (
          <section
            className={
              "collection container " +
              (path === "/gallery" ? "standalone" : "")
            }
            id="collection"
          >
            <div className="section-title">
              <div>
                <p className="eyebrow">
                  {path === "/" ? "01 / THE COLLECTION" : "THE COLLECTION"}
                </p>
                <h2>
                  {path === "/"
                    ? "지금, 마음에 닿는 작품"
                    : "나의 취향을 발견하는 시간"}
                </h2>
                <p className="section-description">
                  취향이 닿는 곳에서, 새로운 이야기가 시작됩니다.
                </p>
              </div>
              {path === "/" ? (
                <Link href="/gallery" className="text-link">
                  전체 작품 보기 <ArrowUpRight size={16} />
                </Link>
              ) : (
                <span className="collection-count">
                  {data?.artworks.length || 0} WORKS ON VIEW
                </span>
              )}
            </div>
            {filters}
            {cards}
            <div className="catalog-note">
              <span className="dot" /> 현재는 테스트 전시입니다. 작품·작가는
              가상이며, 이미지는 AI로 제작했습니다. 실제 결제는 발생하지
              않습니다.
            </div>
          </section>
        )}
        {path === "/" && (
          <>
            <section id="space" className="space-section container">
              <div className="space-copy">
                <p className="eyebrow">02 / ART & SPACE</p>
                <h2>
                  하나의 작품이
                  <br />
                  공간을 바꾸는 방식.
                </h2>
                <p>
                  빛이 닿는 방향, 바라보는 거리.
                  <br />
                  새로운 시선으로 작품의 형태를 만나보세요.
                </p>
                <div className="coming-label">
                  <Box size={16} />
                  <span>AR 공간 배치 · DEMO</span>
                </div>
                <p className="space-description">
                  작품을 가상 공간에 직접 놓아보고,
                  <br />
                  실제 크기의 비율과 어울림을 확인해 보세요.
                </p>
                <Link className="button dark" href="/space?artwork=sculpture">
                  내 공간에 놓아보기 <ArrowUpRight size={17} />
                </Link>
              </div>
              <SculptureScene />
            </section>
            <section className="artist-feature container">
              <div>
                <p className="eyebrow">03 / BEHIND THE ART</p>
                <h2>
                  작품 너머,
                  <br />
                  새로운 작가를 만나다.
                </h2>
              </div>
              <p>
                한 점의 작품에는 한 사람의 시선이 담겨 있습니다.
                <br />
                좋아하는 작가를 발견하고, 다음 작업을 함께하세요.
              </p>
              <Link href="/artists" className="button secondary">
                작가 이야기 <ArrowUpRight size={18} />
              </Link>
            </section>
          </>
        )}
        {path === "/space" && data && <SpaceDemo artworks={data.artworks} />}
        {path === "/artists" && (
          <section className="container standalone">
            <p className="eyebrow">THE ARTIST INDEX</p>
            <div className="section-title">
              <div>
                <h1 className="page-title">작품 너머의 시선들.</h1>
                <p className="section-description">
                  첫 전시부터 다음 작업까지, 작가의 이야기를 따라가 보세요.
                </p>
              </div>
              <span className="collection-count">EMERGING ARTISTS</span>
            </div>
            <div className="artists-grid">
              {data?.artists.map((a, i) => (
                <article className="artist-card" key={a.id}>
                  <button className="artist-cover" onClick={() => setArtist(a)}>
                    <ArtworkImage
                      src={
                        data.artworks.find((w) => w.artist.id === a.id)?.image
                      }
                      alt={`${a.name} 작가의 대표 작품`}
                    />
                    <span>
                      0{i + 1} <ArrowUpRight size={21} />
                    </span>
                  </button>
                  <div className="artist-card-meta">
                    <h2>{a.name}</h2>
                    <span>{a.study}</span>
                  </div>
                  <p>
                    {a.bio || "작품으로 이야기를 시작하는 새로운 작가입니다."}
                  </p>
                  <div className="artist-stats">
                    <span>전시 작품 {a.works}점</span>
                    <span>
                      {a.rank
                        ? `테스트 순위 ${a.rank}위 · 거래 완료 ${a.sales}건`
                        : "완료된 거래 없음"}
                    </span>
                  </div>
                  <button className="text-link" onClick={() => setArtist(a)}>
                    작가와 작품 보기 <ArrowUpRight size={15} />
                  </button>
                </article>
              ))}
            </div>
            <p className="catalog-note">
              작가는 고유 ID로 구분됩니다. 테스트 거래 완료만 실적에 반영하며,
              낙찰만으로 순위가 올라가지 않습니다.
            </p>
          </section>
        )}
        {path === "/login" && (
          <section className="auth-page container">
            <div className="auth-editorial">
              <ArtworkImage
                src="/artworks/ceramic.png"
                alt="이끼빛 유약을 입힌 도자 작품"
                loading="eager"
              />
              <div>
                <p className="eyebrow">YOUR PERSONAL COLLECTION</p>
                <h1>
                  취향이 쌓이는 곳.
                  <br />
                  당신만의 작은 미술관.
                </h1>
              </div>
            </div>
            <div className="auth-content">
              {user ? (
                <>
                  <p className="eyebrow">WELCOME BACK</p>
                  <h2>{user.name} 님, 반가워요.</h2>
                  <p>마이페이지에서 나만의 컬렉션을 확인하세요.</p>
                  <Link href="/mypage" className="button dark">
                    마이페이지로 <ArrowRight size={17} />
                  </Link>
                </>
              ) : (
                <AuthForm
                  onDone={async () => {
                    await refresh();
                    router.push("/mypage");
                  }}
                />
              )}
            </div>
          </section>
        )}
        {path === "/mypage" && (
          <section className="container mypage standalone">
            {!data ? (
              <div className="empty-state">계정을 확인하고 있어요.</div>
            ) : !user ? (
              <LoginGate />
            ) : (
              <>
                <div className="my-heading">
                  <div>
                    <p className="eyebrow">MY LITTLE GALLERY</p>
                    <h1>
                      {user.name} 님의
                      <br />
                      취향이 머무는 곳.
                    </h1>
                  </div>
                  <Link href="/studio" className="button dark">
                    새 작품 등록 <Plus size={17} />
                  </Link>
                </div>
                <div className="my-layout">
                  <aside className="my-sidebar">
                    <div className="avatar">{user.name.slice(0, 1)}</div>
                    <strong>{user.name}</strong>
                    <small>{user.email}</small>
                    <nav aria-label="마이페이지 메뉴">
                      {[
                        {
                          id: "activity",
                          name: "내 활동",
                          icon: <LayoutGrid size={17} />,
                        },
                        {
                          id: "saved",
                          name: "관심 작품",
                          icon: <Heart size={17} />,
                        },
                        {
                          id: "works",
                          name: "등록한 작품",
                          icon: <ImagePlus size={17} />,
                        },
                        {
                          id: "inquiries",
                          name: "협업 요청함",
                          icon: <Mail size={17} />,
                        },
                        {
                          id: "profile",
                          name: "프로필 설정",
                          icon: <UserRound size={17} />,
                        },
                      ].map((t) => (
                        <button
                          key={t.id}
                          className={tab === t.id ? "active" : ""}
                          aria-current={tab === t.id ? "page" : undefined}
                          onClick={() => changeTab(t.id)}
                        >
                          {t.icon}
                          {t.name}
                          <ArrowUpRight size={14} />
                        </button>
                      ))}
                    </nav>
                    <button className="logout-button" onClick={logout}>
                      <LogOut size={15} /> 로그아웃
                    </button>
                  </aside>
                  <div className="my-content">
                    {activityError && (
                      <p className="error" role="alert">
                        {activityError}
                        <button onClick={refreshActivity}>다시 시도</button>
                      </p>
                    )}
                    {!activity && !activityError ? (
                      <p>내 컬렉션을 불러오고 있어요.</p>
                    ) : (
                      activity && (
                        <>
                          {tab === "profile" ? (
                            <ProfileForm
                              user={user}
                              onDone={async () => {
                                await refresh();
                                setNotice("프로필을 저장했어요.");
                              }}
                            />
                          ) : tab === "inquiries" ? (
                            <InquiryList
                              activity={activity}
                              onUpdate={refreshActivity}
                            />
                          ) : (
                            <>
                              <div className="my-content-title">
                                <h2>
                                  {tab === "saved"
                                    ? "관심 작품"
                                    : tab === "works"
                                      ? "등록한 작품"
                                      : "내 활동"}
                                </h2>
                                <span>
                                  {tab === "activity"
                                    ? "경매 참여와 등록 현황을 한눈에"
                                    : "당신의 컬렉션을 이어가세요"}
                                </span>
                              </div>
                              {tab === "activity" && (
                                <div className="stats-row">
                                  <div>
                                    <span>관심 작품</span>
                                    <strong>
                                      {
                                        activity.artworks.filter((a) => a.saved)
                                          .length
                                      }
                                      <small>점</small>
                                    </strong>
                                  </div>
                                  <div>
                                    <span>참여한 경매</span>
                                    <strong>
                                      {
                                        activity.artworks.filter(
                                          (a) => a.participated,
                                        ).length
                                      }
                                      <small>건</small>
                                    </strong>
                                  </div>
                                  <div>
                                    <span>등록한 작품</span>
                                    <strong>
                                      {
                                        activity.artworks.filter((a) => a.mine)
                                          .length
                                      }
                                      <small>점</small>
                                    </strong>
                                  </div>
                                </div>
                              )}
                              {tab === "saved" ? (
                                <div className="art-grid saved-grid">
                                  {activity.artworks
                                    .filter((a) => a.saved)
                                    .map((a) => (
                                      <ArtCard
                                        key={a.id}
                                        a={a}
                                        time={time}
                                        onOpen={() => setSelected(a.id)}
                                        onSave={() => save(a)}
                                        saving={busySave === a.id}
                                      />
                                    ))}
                                  {!activity.artworks.some((a) => a.saved) && (
                                    <Empty text="아직 마음에 담은 작품이 없어요." />
                                  )}
                                </div>
                              ) : (
                                <>
                                  <h3 className="subheading">
                                    {tab === "works"
                                      ? "나의 전시 작품"
                                      : "내가 참여한 경매"}
                                  </h3>
                                  <div className="activity-rows">
                                    {activity.artworks
                                      .filter((a) =>
                                        tab === "works"
                                          ? a.mine
                                          : a.participated,
                                      )
                                      .map((a) => (
                                        <ActivityRow
                                          key={a.id}
                                          a={a}
                                          time={time}
                                          open={() => setSelected(a.id)}
                                          onFinish={async () => {
                                            await refresh();
                                            await refreshActivity();
                                          }}
                                        />
                                      ))}
                                    {!activity.artworks.some((a) =>
                                      tab === "works" ? a.mine : a.participated,
                                    ) && (
                                      <Empty
                                        text={
                                          tab === "works"
                                            ? "첫 작품의 이야기를 들려주세요."
                                            : "아직 참여한 경매가 없어요."
                                        }
                                      />
                                    )}
                                  </div>
                                </>
                              )}
                            </>
                          )}
                        </>
                      )
                    )}
                  </div>
                </div>
              </>
            )}
          </section>
        )}
        {path === "/studio" && (
          <section className="container studio-page standalone">
            {data && !user ? (
              <LoginGate />
            ) : user ? (
              <>
                <div className="section-title">
                  <div>
                    <p className="eyebrow">THE ARTIST STUDIO</p>
                    <h1 className="page-title">새로운 이야기의 시작.</h1>
                    <p className="section-description">
                      작품의 모습과 크기, 어울리는 공간을 들려주세요.
                    </p>
                  </div>
                </div>
                <RegisterForm
                  user={user}
                  onDone={async () => {
                    await refresh();
                    router.push("/mypage?tab=works");
                    setTab("works");
                    setNotice("작품을 등록했어요. 새로운 전시가 시작됩니다.");
                  }}
                />
              </>
            ) : (
              <p>계정을 확인하고 있어요.</p>
            )}
          </section>
        )}
      </main>
      <footer className="footer container">
        <div className="footer-top">
          <Brand />
          <p>
            새로운 시선이 자라고,
            <br />
            예술이 일상이 되는 곳.
          </p>
          <div>
            <Link href="/gallery">
              작품 둘러보기 <ArrowUpRight size={13} />
            </Link>
            <Link href="/artists">
              작가 이야기 <ArrowUpRight size={13} />
            </Link>
            <Link href="/mypage">
              마이페이지 <ArrowUpRight size={13} />
            </Link>
          </div>
        </div>
        <div className="footer-bottom">
          <span>© 2026 DESIGN_FARM. ART GROWS HERE.</span>
          <span>
            가상 작품·AI 생성 이미지 · 로컬 테스트 전시 · 실제 거래 없음
          </span>
        </div>
      </footer>
      {current && (
        <Modal
          title="THE ARTWORK / 작품 이야기"
          wide
          onClose={() => setSelected(null)}
        >
          <ArtworkDetail
            key={current.id}
            a={current}
            user={user || null}
            time={time}
            onSave={() => save(current)}
            onAuth={() => setAuthPrompt(true)}
            onArtist={() => {
              setSelected(null);
              setArtist(current.artist);
            }}
            onBid={async () => {
              await refresh();
              setNotice("입찰이 접수됐어요. 마이페이지에서 결과를 확인하세요.");
            }}
          />
        </Modal>
      )}
      {artist && (
        <Modal
          title="BEHIND THE ART / 작가 이야기"
          onClose={() => setArtist(null)}
        >
          <div className="artist-modal">
            <p className="eyebrow">EMERGING ARTIST</p>
            <h2>{artist.name}</h2>
            <span className="muted">{artist.study} · 학생 미인증</span>
            <p>{artist.bio || "작품으로 이야기를 시작하는 작가입니다."}</p>
            <div className="mini-portfolio">
              {data?.artworks
                .filter((a) => a.artist.id === artist.id)
                .map((a) => (
                  <button
                    key={a.id}
                    onClick={() => {
                      setArtist(null);
                      setSelected(a.id);
                    }}
                  >
                    <ArtworkImage src={a.image} alt={a.title} />
                    <span>
                      {a.title}
                      <ArrowUpRight size={15} />
                    </span>
                  </button>
                ))}
            </div>
            {user?.id !== artist.id && (
              <button
                className="button dark full"
                onClick={() => requestInquiry(artist)}
              >
                스카우트·외주 제안하기 <ArrowUpRight size={17} />
              </button>
            )}
          </div>
        </Modal>
      )}
      {inquiry && user && (
        <Modal title="새로운 협업의 시작" onClose={() => setInquiry(null)}>
          <InquiryForm
            artist={inquiry}
            user={user}
            onDone={() => {
              setInquiry(null);
              setNotice(
                "요청함에 저장했어요. 마이페이지에서 확인할 수 있습니다.",
              );
            }}
          />
        </Modal>
      )}
      {authPrompt && (
        <Modal
          title="나만의 컬렉션을 시작하세요"
          onClose={() => setAuthPrompt(false)}
        >
          <div className="auth-modal">
            <AuthForm
              onDone={async () => {
                await refresh();
                setAuthPrompt(false);
                setNotice("로그인했어요. 원하시는 작업을 다시 선택해 주세요.");
              }}
            />
          </div>
        </Modal>
      )}
      {notice && (
        <div className="toast" role="status">
          <CheckCircle2 size={17} />
          {notice}
          <button aria-label="알림 닫기" onClick={() => setNotice("")}>
            <X size={16} />
          </button>
        </div>
      )}
    </>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <div className="empty-state">
      <Bookmark size={26} />
      <h3>{text}</h3>
      <Link href="/gallery" className="text-link">
        작품 만나러 가기 <ArrowUpRight size={16} />
      </Link>
    </div>
  );
}
function LoginGate() {
  return (
    <div className="login-gate">
      <UserRound size={34} />
      <p className="eyebrow">YOUR PERSONAL GALLERY</p>
      <h1>로그인하고 이야기를 이어가세요.</h1>
      <p>관심 작품, 참여한 경매, 내 작품을 한곳에서 관리할 수 있어요.</p>
      <Link href="/login" className="button dark">
        로그인 / 회원가입 <ArrowRight size={17} />
      </Link>
    </div>
  );
}
function ArtCard({
  a,
  time,
  onOpen,
  onSave,
  saving,
}: {
  a: Art;
  time: number;
  onOpen: () => void;
  onSave: () => void;
  saving: boolean;
}) {
  return (
    <article className="art-card">
      <div className="art-image-wrap">
        <button
          className="art-image"
          onClick={onOpen}
          aria-label={`${a.title} 상세 보기`}
        >
          <ArtworkImage
            src={a.image}
            alt={`${a.title}, ${a.material}`}
            loading="lazy"
          />
          <span className="image-hover">
            작품 자세히 보기 <ArrowUpRight size={18} />
          </span>
        </button>
        <span className="art-tag">{a.category}</span>
        <button
          className={"save-button " + (a.saved ? "saved" : "")}
          aria-label={`${a.title} 관심 작품 ${a.saved ? "해제" : "저장"}`}
          aria-pressed={a.saved}
          disabled={saving}
          onClick={onSave}
        >
          <Heart size={17} fill={a.saved ? "currentColor" : "none"} />
        </button>
      </div>
      <div className="art-meta">
        <span>{a.artist.name}</span>
        <span>{dimensions(a)}</span>
      </div>
      <button className="art-title" onClick={onOpen}>
        {a.title}
        <ArrowUpRight size={18} />
      </button>
      <p className="art-material">{a.material}</p>
      <div className="art-price">
        <span>
          {a.status === "sold"
            ? "낙찰가"
            : a.bid_count
              ? "현재 입찰가"
              : "시작가"}
        </span>
        <strong>{money(a.current_price)}</strong>
      </div>
      <div className="art-foot">
        <span>
          <span
            className={"status-dot " + (a.status === "active" ? "" : "closed")}
          />
          {remaining(a, time)}
        </span>
        <span>입찰 {a.bid_count}회</span>
      </div>
    </article>
  );
}

function AuthForm({ onDone }: { onDone: () => Promise<void> }) {
  const [mode, setMode] = useState("login"),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [email, setEmail] = useState(""),
    [password, setPassword] = useState("");
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const f = new FormData(e.currentTarget);
    try {
      await api("/auth/" + (mode === "login" ? "login" : "signup"), {
        method: "POST",
        body: JSON.stringify({
          email,
          password,
          ...(mode === "signup" ? { name: f.get("name") } : {}),
        }),
      });
      await onDone();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <p className="eyebrow">WELCOME TO DESIGN_FARM</p>
      <h2>
        {mode === "login" ? "취향의 다음 페이지." : "첫 컬렉션을 시작해요."}
      </h2>
      <p className="form-intro">
        {mode === "login"
          ? "마음에 담은 작품과 새로운 이야기가 기다리고 있어요."
          : "하나의 계정으로 작품을 소장하고, 전시할 수 있어요."}
      </p>
      <div className="auth-tabs">
        <button
          className={mode === "login" ? "active" : ""}
          onClick={() => {
            setMode("login");
            setError("");
          }}
        >
          로그인
        </button>
        <button
          className={mode === "signup" ? "active" : ""}
          onClick={() => {
            setMode("signup");
            setError("");
          }}
        >
          회원가입
        </button>
      </div>
      <form onSubmit={submit} className="form-stack">
        {mode === "signup" && (
          <label>
            이름
            <input
              name="name"
              required
              maxLength={30}
              autoComplete="name"
              placeholder="작가명 또는 표시명"
            />
          </label>
        )}
        <label>
          이메일
          <input
            type="email"
            required
            maxLength={120}
            autoComplete="email"
            placeholder="your@email.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <label>
          비밀번호
          <input
            type="password"
            required
            minLength={10}
            maxLength={128}
            autoComplete={
              mode === "login" ? "current-password" : "new-password"
            }
            placeholder="10자 이상 입력해 주세요"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button className="button dark full" disabled={busy}>
          {busy ? (
            <LoaderCircle className="spin" size={17} />
          ) : (
            <>
              {mode === "login" ? "로그인" : "가입하고 시작하기"}{" "}
              <ArrowRight size={17} />
            </>
          )}
        </button>
      </form>
      <div className="demo-account">
        <p>먼저 둘러보고 싶다면</p>
        <button
          onClick={() => {
            setMode("login");
            setEmail("collector@designfarm.local");
            setPassword("Gallery2026!");
            setError("");
          }}
        >
          체험 계정 입력하기 <ArrowUpRight size={14} />
        </button>
        <small>
          이 PC에 저장되는 로컬 계정입니다.
          <br />
          이메일 인증·비밀번호 재설정은 아직 지원하지 않습니다.
        </small>
      </div>
    </>
  );
}

function ArtworkDetail({
  a,
  user,
  time,
  onSave,
  onAuth,
  onArtist,
  onBid,
}: {
  a: Art;
  user: User | null;
  time: number;
  onSave: () => void;
  onAuth: () => void;
  onArtist: () => void;
  onBid: () => Promise<void>;
}) {
  const [amount, setAmount] = useState(a.minimum_bid || a.current_price),
    [confirm, setConfirm] = useState(false),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const key = useRef("");
  const open = a.status === "active" && a.ends > time;
  async function bid() {
    if (busy) return;
    setBusy(true);
    setError("");
    key.current ||= crypto.randomUUID();
    try {
      await api("/artworks/" + a.id + "/bids", {
        method: "POST",
        body: JSON.stringify({ amount, request_key: key.current }),
      });
      setConfirm(false);
      key.current = "";
      await onBid();
      setAmount(Math.min(amount + 1000, 100000000));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="detail-layout">
      <div className="detail-visual">
        <ArtworkImage src={a.image} alt={a.title} loading="eager" />
        <p className="image-credit">
          {a.is_sample
            ? "AI로 제작한 가상 작품 이미지 · 실제 판매 작품이 아닙니다."
            : "작가가 등록한 작품 이미지 · 현재는 테스트 전시입니다."}
        </p>
        <div className="artist-note">
          <p className="eyebrow">ARTIST'S NOTE</p>
          <h3>작품에 담긴 이야기</h3>
          <p>{a.story}</p>
        </div>
      </div>
      <div className="detail-info">
        <div className="detail-kicker">
          <span>
            {a.category} /{" "}
            {a.created ? new Date(a.created).getFullYear() : 2026}
          </span>
          <button
            className="icon-button"
            onClick={onSave}
            aria-label="관심 작품 저장 또는 해제"
            aria-pressed={a.saved}
          >
            <Heart size={20} fill={a.saved ? "currentColor" : "none"} />
          </button>
        </div>
        <h2>{a.title}</h2>
        <button className="text-link artist-name" onClick={onArtist}>
          {a.artist.name} <ArrowUpRight size={15} />
        </button>
        <dl className="details">
          <div>
            <dt>재료</dt>
            <dd>{a.material}</dd>
          </div>
          <div>
            <dt>작품 크기</dt>
            <dd>{dimensions(a)}</dd>
          </div>
          <div>
            <dt>추천 공간</dt>
            <dd>{a.space}</dd>
          </div>
        </dl>
        <div className="space-guide">
          <Box size={21} />
          <div>
            <strong>작가가 제안하는 자리</strong>
            <p>{a.placement}</p>
            {a.dimensions.unit === "cm" && (
              <Link
                className="text-link"
                href={`/space?artwork=${encodeURIComponent(a.id)}`}
              >
                3D · AR로 공간에 놓아보기 <ArrowUpRight size={15} />
              </Link>
            )}
          </div>
        </div>
        <div className="bid-panel">
          <div className="bid-heading">
            <span>
              {open
                ? a.bid_count
                  ? "현재 입찰가"
                  : "첫 소장을 위한 시작가"
                : a.status === "sold"
                  ? "낙찰 금액"
                  : "시작가"}
            </span>
            <span className="status-pill">
              <Clock3 size={13} />
              {remaining(a, time)}
            </span>
          </div>
          <strong className="large-price">{money(a.current_price)}</strong>
          <p className="auction-date">
            마감 {date(a.ends)} · 입찰 {a.bid_count}회
          </p>
          {!open ? (
            <div className="inline-message">
              {a.status === "sold"
                ? a.winning
                  ? "이 작품에 낙찰되었어요. "
                  : "경매가 낙찰로 마감되었어요. "
                : a.status === "unsold"
                  ? "입찰 없이 마감되었어요."
                  : "마감 결과를 확인하고 있어요."}
              <br />
              {a.status === "sold" &&
                "테스트 낙찰이며 결제·거래 완료는 아닙니다."}
            </div>
          ) : a.mine ? (
            <div className="inline-message">
              내가 등록한 작품입니다. 본인 작품에는 입찰할 수 없어요.
            </div>
          ) : a.minimum_bid === null ? (
            <div className="inline-message">
              최대 입찰 금액에 도달해 추가 입찰을 받지 않습니다.
            </div>
          ) : !user ? (
            <button className="button dark full" onClick={onAuth}>
              로그인하고 입찰하기 <ArrowRight size={17} />
            </button>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                setConfirm(true);
                setError("");
              }}
            >
              <label className="amount-label" htmlFor="bid-amount">
                나의 입찰 금액 <span>최소 {money(a.minimum_bid)}</span>
              </label>
              <div className="amount-input">
                <input
                  id="bid-amount"
                  type="number"
                  required
                  min={a.minimum_bid}
                  max={100000000}
                  step={1000}
                  value={amount}
                  onChange={(e) => {
                    setAmount(Number(e.target.value));
                    setConfirm(false);
                    key.current = "";
                  }}
                />
                <span>원</span>
              </div>
              {!confirm ? (
                <button className="button dark full">
                  입찰 내용 확인 <ArrowUpRight size={17} />
                </button>
              ) : (
                <div className="bid-confirm">
                  <strong>{money(amount)}에 입찰할까요?</strong>
                  <p>
                    입찰이 한 번이어도 시작가 이상이면 낙찰됩니다.
                    <br />
                    이번 전시는 테스트이며 실제 결제는 없습니다.
                  </p>
                  <div>
                    <button
                      type="button"
                      className="button secondary"
                      onClick={() => setConfirm(false)}
                    >
                      돌아가기
                    </button>
                    <button
                      type="button"
                      className="button dark"
                      disabled={busy || amount < (a.minimum_bid || 0)}
                      onClick={bid}
                    >
                      {busy ? "확인 중…" : "입찰 확정"}
                    </button>
                  </div>
                </div>
              )}
              {error && (
                <p className="error" role="alert">
                  {error}
                </p>
              )}
            </form>
          )}
          <p className="fine-print">
            1,000원 단위 입찰 · 실제 결제·배송 없음
            <br />
            단독 입찰도 시작가에 낙찰됩니다.
          </p>
          {a.winning && open && (
            <p className="winning-note">
              <Check size={15} /> 현재 내 입찰이 최고가예요.
            </p>
          )}
        </div>
        <details className="bid-history" open={a.bid_count > 0}>
          <summary>
            입찰 이력{" "}
            <span>
              {a.bid_count}회 <ChevronDown size={14} />
            </span>
          </summary>
          {a.bids.length ? (
            <ol>
              {[...a.bids].reverse().map((b, i) => (
                <li key={i}>
                  <span>
                    {b.mine ? "나의 입찰" : "익명 입찰"}
                    <small>{date(b.created)}</small>
                  </span>
                  <strong>{money(b.amount)}</strong>
                </li>
              ))}
            </ol>
          ) : (
            <p>첫 입찰을 기다리고 있어요.</p>
          )}
        </details>
      </div>
    </div>
  );
}

function ActivityRow({
  a,
  time,
  open,
  onFinish,
}: {
  a: Art;
  time: number;
  open: () => void;
  onFinish: () => Promise<void>;
}) {
  const [confirm, setConfirm] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function finish() {
    setBusy(true);
    try {
      await api("/artworks/" + a.id + "/finish-demo", { method: "POST" });
      setConfirm(false);
      await onFinish();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <article className="activity-row">
      <button className="activity-thumb" onClick={open}>
        <ArtworkImage src={a.image} alt={a.title} />
      </button>
      <div className="activity-main">
        <span>{a.mine ? "내 작품" : a.artist.name}</span>
        <button onClick={open}>{a.title}</button>
        <p>
          {money(a.current_price)} · {remaining(a, time)}
          {a.winning && a.status === "active" ? " · 최고 입찰" : ""}
        </p>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {confirm && (
          <div className="finish-confirm">
            <p>테스트 경매를 지금 마감합니다. 되돌릴 수 없어요.</p>
            <button className="text-link" onClick={() => setConfirm(false)}>
              취소
            </button>
            <button
              className="button small dark"
              onClick={finish}
              disabled={busy}
            >
              마감 확정
            </button>
          </div>
        )}
      </div>
      <div className="activity-actions">
        <button className="text-link" onClick={open}>
          상세 보기 <ArrowUpRight size={14} />
        </button>
        {a.status === "active" && !confirm && (
          <button className="demo-finish" onClick={() => setConfirm(true)}>
            마감 결과 체험
          </button>
        )}
      </div>
    </article>
  );
}

function ProfileForm({
  user,
  onDone,
}: {
  user: User;
  onDone: () => Promise<void>;
}) {
  const fields = [
    "회화 전공",
    "조소 전공",
    "도예 전공",
    "공예 전공",
    "섬유·패션",
    "시각·제품 디자인",
    "사진·영상",
    "디지털 아트",
    "미술·디자인 교육",
    "큐레이터",
    "컬렉터",
    "예술 애호가",
  ];
  const [field, setField] = useState(
    fields.includes(user.study) ? user.study : "custom",
  );
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <form
      className="form-stack profile-form"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError("");
        const f = new FormData(e.currentTarget);
        try {
          await api("/me", {
            method: "PATCH",
            body: JSON.stringify(Object.fromEntries(f)),
          });
          await onDone();
        } catch (e) {
          setError(errorMessage(e));
        } finally {
          setBusy(false);
        }
      }}
    >
      <h2>나를 소개하는 한 페이지.</h2>
      <label>
        표시명
        <input name="name" defaultValue={user.name} required maxLength={30} />
      </label>
      <label>
        전공 또는 소개 분야
        <select
          name={field === "custom" ? undefined : "study"}
          value={field}
          onChange={(e) => setField(e.target.value)}
        >
          {fields.map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
          <option value="custom">직접 입력</option>
        </select>
      </label>
      {field === "custom" && (
        <label>
          소개 분야 직접 입력
          <input
            name="study"
            defaultValue={fields.includes(user.study) ? "" : user.study}
            placeholder="예: 금속공예 · 독립 작가"
            required
            maxLength={100}
          />
        </label>
      )}
      <label>
        작가 소개
        <textarea name="bio" defaultValue={user.bio} maxLength={500} rows={5} />
      </label>
      <p className="fine-print">
        학교·전공은 본인이 작성하는 정보이며 학생 인증을 의미하지 않습니다.
      </p>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <button className="button dark" disabled={busy}>
        {busy ? "저장 중…" : "프로필 저장"}
        <Check size={17} />
      </button>
    </form>
  );
}

function RegisterForm({
  user,
  onDone,
}: {
  user: User;
  onDone: () => Promise<void>;
}) {
  const [preview, setPreview] = useState<{
    art: PreviewArt;
    body: string;
    start: number;
    duration: number;
  } | null>(null);
  const [previewReady, setPreviewReady] = useState(false);
  const publishing = useRef(false);
  const [model, setModel] = useState<{
    id: string;
    url: string;
    name: string;
  } | null>(null);
  const [modelUploading, setModelUploading] = useState(false);
  const [image, setImage] = useState<{ id: string; url: string } | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [uploading, setUploading] = useState(false),
    [category, setCategory] = useState("회화");
  async function uploadModel(file: File | undefined) {
    if (!file) return;
    setModel(null);
    setModelUploading(true);
    setError("");
    try {
      const data = new FormData();
      data.append("file", file);
      const uploaded = await api<{ id: string; url: string }>(
        "/model-uploads",
        {
          method: "POST",
          body: data,
        },
      );
      setModel({ ...uploaded, name: file.name });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setModelUploading(false);
    }
  }
  async function upload(file: File | undefined) {
    if (!file) return;
    setUploading(true);
    setError("");
    try {
      const f = new FormData();
      f.append("file", file);
      setImage(
        await api<{ id: string; url: string }>("/uploads", {
          method: "POST",
          body: f,
        }),
      );
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setUploading(false);
    }
  }
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy || uploading || modelUploading) return;
    if (!image) {
      setError("작품 이미지를 먼저 업로드해 주세요.");
      return;
    }
    setError("");
    const f = new FormData(e.currentTarget),
      v = Object.fromEntries(f);
    delete v.agree;
    const payload = {
      ...v,
      image_id: image.id,
      model_id: category === "디지털" ? null : model?.id || null,
      width: Number(v.width),
      height: Number(v.height),
      depth: Number(v.depth || 0),
      start: Number(v.start),
      duration: Number(v.duration),
      request_key: crypto.randomUUID(),
    };
    setPreviewReady(!payload.model_id);
    setPreview({
      body: JSON.stringify(payload),
      start: payload.start,
      duration: payload.duration,
      art: {
        id: "draft",
        title: String(v.title),
        category,
        material: String(v.material),
        story: String(v.story),
        space: String(v.space),
        placement: String(v.placement),
        image: image.url,
        model_url: payload.model_id ? model!.url : null,
        dimensions: {
          width: payload.width,
          height: payload.height,
          depth: payload.depth,
          unit: category === "디지털" ? "px" : "cm",
        },
      },
    });
  }
  async function publish() {
    if (!preview || !previewReady || publishing.current) return;
    publishing.current = true;
    setBusy(true);
    setError("");
    try {
      await api("/artworks", {
        method: "POST",
        body: preview.body,
      });
      await onDone();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      publishing.current = false;
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit} className="register-layout">
      <div className="register-aside">
        <label className="upload-area">
          {image ? (
            <ArtworkImage src={image.url} alt="등록할 작품 미리보기" />
          ) : (
            <>
              <ImagePlus size={35} />
              <strong>작품의 첫인상을 담아주세요.</strong>
              <span>JPG, PNG, WEBP · 최대 5MB</span>
            </>
          )}
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp"
            aria-label="작품 이미지 업로드"
            disabled={uploading || busy}
            onChange={(e) => upload(e.target.files?.[0])}
          />
          <span className="button secondary">
            {uploading
              ? "이미지 확인 중…"
              : image
                ? "사진 변경"
                : "작품 사진 선택"}{" "}
            <Plus size={16} />
          </span>
        </label>
        <div className="studio-tip">
          <p className="eyebrow">A LITTLE GUIDE</p>
          <h3>작품을 가장 잘 보여주는 방법</h3>
          <p>
            자연광에서 정면으로 촬영해 주세요.
            <br />
            조소·공예는 전체 형태와 받침이 보이도록,
            <br />
            그림은 프레임까지 담아 주세요.
          </p>
        </div>
      </div>
      <div className="form-stack">
        {category !== "디지털" && (
          <div className="form-stack">
            <label>
              3D 파일 첨부 (선택)
              <input
                type="file"
                accept=".glb"
                aria-label="3D 파일 첨부"
                disabled={modelUploading || busy}
                onChange={(e) => {
                  void uploadModel(e.target.files?.[0]);
                  e.target.value = "";
                }}
              />
            </label>
            <p className="fine-print">
              텍스처를 포함한 비압축 GLB · 최대 20MB · 가로·세로·깊이를 cm로
              입력해 주세요.
            </p>
            {modelUploading && <p role="status">3D 파일 확인 중…</p>}
            {model && (
              <div className="inline-message">
                <span>{model.name}</span>
                <button
                  type="button"
                  className="text-link"
                  disabled={busy}
                  onClick={() => setModel(null)}
                >
                  첨부 해제
                </button>
              </div>
            )}
          </div>
        )}
        <div className="form-section">
          <span>01</span>
          <h2>작품의 이야기</h2>
        </div>
        <p className="fine-print">
          작가: {user.name} · 로그인한 계정으로 등록됩니다.
        </p>
        <label>
          작품명
          <input
            name="title"
            required
            maxLength={60}
            placeholder="작품의 이름을 들려주세요"
          />
        </label>
        <div className="field-row">
          <label>
            작품 종류
            <select
              name="category"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
            >
              {categories.slice(1).map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </label>
          <label>
            재료 / 제작 방식
            <input
              name="material"
              required
              maxLength={100}
              placeholder="예: 석고, 캔버스에 유채"
            />
          </label>
        </div>
        <label>
          작가 노트
          <textarea
            name="story"
            required
            maxLength={500}
            rows={4}
            placeholder="어떤 생각에서 시작된 작품인가요?"
          />
        </label>
        <div className="form-section">
          <span>02</span>
          <h2>크기와 어울리는 공간</h2>
        </div>
        <div className="dimension-fields">
          <label>
            가로 ({category === "디지털" ? "px" : "cm"})
            <input
              name="width"
              type="number"
              min="0.01"
              max="10000"
              step={category === "디지털" ? "1" : ".01"}
              required
            />
          </label>
          <label>
            세로 ({category === "디지털" ? "px" : "cm"})
            <input
              name="height"
              type="number"
              min="0.01"
              max="10000"
              step={category === "디지털" ? "1" : ".01"}
              required
            />
          </label>
          <label>
            깊이 (cm)
            <input
              name="depth"
              type="number"
              min={model && category !== "디지털" ? "0.01" : "0"}
              max="10000"
              step=".01"
              defaultValue="0"
            />
          </label>
        </div>
        <div className="field-row">
          <label>
            추천 공간
            <select name="space" required defaultValue="">
              <option value="" disabled>
                공간을 선택해 주세요
              </option>
              {spaces.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </label>
          <label>
            배치 방식
            <select name="mounting">
              <option value="wall">벽에 걸기</option>
              <option value="surface">선반·테이블 위</option>
              <option value="floor">바닥에 놓기</option>
            </select>
          </label>
        </div>
        <label>
          작가의 배치 제안
          <textarea
            name="placement"
            required
            maxLength={180}
            rows={3}
            placeholder="어디에, 어떻게 두면 가장 잘 어울릴까요?"
          />
        </label>
        <div className="inline-message">
          <Box size={18} /> 입력한 크기로 공간 배치 데모를 체험할 수 있어요. 3D
          모델이 없는 입체 작품은 사진 패널로 표시됩니다.
        </div>
        <div className="form-section">
          <span>03</span>
          <h2>테스트 경매 설정</h2>
        </div>
        <div className="field-row">
          <label>
            시작가 (원)
            <input
              name="start"
              type="number"
              required
              min="1000"
              max="100000000"
              step="1000"
              defaultValue="10000"
            />
          </label>
          <label>
            경매 기간
            <select name="duration" defaultValue="3">
              <option value="1">1일</option>
              <option value="3">3일</option>
              <option value="7">7일</option>
            </select>
          </label>
        </div>
        <label className="checkbox">
          <input name="agree" type="checkbox" required />
          등록 즉시 테스트 경매가 시작되며, 한 명만 입찰해도 시작가 이상에
          낙찰되는 것을 확인했어요.
        </label>
        {category === "디지털" && (
          <p className="inline-message">
            디지털 작품의 판매 횟수·독점권·이용 범위는 미정입니다. 실제 판매는
            진행하지 않습니다.
          </p>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button
          className="button dark full"
          disabled={busy || uploading || modelUploading}
        >
          등록 전 미리보기
          <ArrowUpRight size={18} />
        </button>
      </div>
      {preview && (
        <Modal
          title="공개 전 작품 확인"
          wide
          onClose={() => {
            if (!publishing.current) {
              setPreview(null);
              setError("");
            }
          }}
        >
          <div className="registration-review">
            <p className="fine-print">
              아직 공개되지 않았어요. 사진·모형·치수와 작품 정보를 확인해
              주세요.
            </p>
            <ArtworkPreview art={preview.art} onReady={setPreviewReady} />
            <p>
              경매 시작가 {money(preview.start)} · 공개 후 {preview.duration}
              일간 진행
            </p>
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <div className="preview-actions">
              <button
                type="button"
                className="button secondary"
                disabled={busy}
                onClick={() => {
                  setPreview(null);
                  setError("");
                }}
              >
                수정하기
              </button>
              <button
                type="button"
                className="button dark"
                disabled={busy || !previewReady}
                onClick={publish}
              >
                {busy ? "등록 중…" : "작품 공개하고 경매 시작"}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </form>
  );
}

function InquiryForm({
  artist,
  user,
  onDone,
}: {
  artist: Artist;
  user: User;
  onDone: () => void;
}) {
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    key = useRef(crypto.randomUUID());
  return (
    <form
      className="form-stack inquiry-form"
      onChange={() => {
        key.current = crypto.randomUUID();
      }}
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError("");
        const f = new FormData(e.currentTarget);
        try {
          await api("/inquiries", {
            method: "POST",
            body: JSON.stringify({
              ...Object.fromEntries(f),
              artist_id: artist.id,
              request_key: key.current,
            }),
          });
          onDone();
        } catch (e) {
          setError(errorMessage(e));
        } finally {
          setBusy(false);
        }
      }}
    >
      <p className="eyebrow">LET'S CREATE TOGETHER</p>
      <h2>{artist.name} 작가에게</h2>
      <label>
        제안 유형
        <select name="kind">
          <option>스카우트</option>
          <option>외주 의뢰</option>
        </select>
      </label>
      <label>
        이름 / 단체명
        <input name="name" defaultValue={user.name} required maxLength={60} />
      </label>
      <label>
        연락 이메일
        <input
          name="email"
          type="email"
          defaultValue={user.email}
          required
          maxLength={120}
        />
      </label>
      <label>
        제안 내용
        <textarea
          name="message"
          rows={5}
          required
          maxLength={700}
          placeholder="함께하고 싶은 작업, 일정, 예산 등을 들려주세요."
        />
      </label>
      <p className="fine-print">
        요청은 이 로컬 서비스의 당사자 요청함에 저장됩니다. 이메일은 발송하지
        않습니다.
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <button className="button dark full" disabled={busy}>
        {busy ? "저장 중…" : "협업 제안 보내기"}
        <ArrowUpRight size={17} />
      </button>
    </form>
  );
}
function InquiryList({
  activity,
  onUpdate,
}: {
  activity: Activity;
  onUpdate: () => Promise<void>;
}) {
  const [mode, setMode] = useState("received"),
    [error, setError] = useState(""),
    [busy, setBusy] = useState<string | null>(null);
  const rows = activity.inquiries.filter((i) =>
    mode === "received"
      ? i.artist_id === activity.user.id
      : i.sender_id === activity.user.id,
  );
  const labels: Record<string, string> = {
    pending: "답변 대기",
    accepted: "수락",
    declined: "거절",
    cancelled: "취소",
  };
  async function update(i: Inquiry, status: string) {
    setBusy(i.id);
    setError("");
    try {
      await api("/inquiries/" + i.id, {
        method: "PATCH",
        body: JSON.stringify({ status }),
      });
      await onUpdate();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }
  return (
    <>
      <h2>새로운 기회를 만나는 곳.</h2>
      <div className="auth-tabs">
        <button
          className={mode === "received" ? "active" : ""}
          onClick={() => setMode("received")}
        >
          받은 요청
        </button>
        <button
          className={mode === "sent" ? "active" : ""}
          onClick={() => setMode("sent")}
        >
          보낸 요청
        </button>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {rows.map((i) => (
        <article className="inquiry-row" key={i.id}>
          <div>
            <span className="eyebrow">{i.kind}</span>
            <span className="status-pill">{labels[i.status]}</span>
          </div>
          <h3>
            {mode === "received"
              ? i.name + " 님의 제안"
              : i.artist_name + " 작가에게"}
          </h3>
          <p className="inquiry-message">{i.message}</p>
          <a className="text-link" href={"mailto:" + i.email}>
            {i.email}
            <Mail size={14} />
          </a>
          <small>{date(i.created)}</small>
          {i.status === "pending" && (
            <div className="inquiry-actions">
              {mode === "received" ? (
                <>
                  <button
                    className="button secondary small"
                    disabled={busy === i.id}
                    onClick={() => update(i, "declined")}
                  >
                    거절
                  </button>
                  <button
                    className="button dark small"
                    disabled={busy === i.id}
                    onClick={() => update(i, "accepted")}
                  >
                    제안 수락
                  </button>
                </>
              ) : (
                <button
                  className="text-link"
                  disabled={busy === i.id}
                  onClick={() => update(i, "cancelled")}
                >
                  요청 취소
                </button>
              )}
            </div>
          )}
          <p className="fine-print">
            수락은 연락 의향을 뜻하며, 계약이나 결제가 성립하지 않습니다.
          </p>
        </article>
      ))}
      {!rows.length && (
        <div className="empty-state">
          <Mail size={28} />
          <h3>
            {mode === "received"
              ? "아직 받은 제안이 없어요."
              : "아직 보낸 제안이 없어요."}
          </h3>
          <Link href="/artists" className="text-link">
            새로운 작가 만나기 <ArrowUpRight size={16} />
          </Link>
        </div>
      )}
    </>
  );
}
