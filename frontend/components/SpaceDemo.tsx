"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowUpRight,
  Box,
  Camera,
  Check,
  Move,
  RotateCcw,
  X,
} from "lucide-react";
import ArtworkImage from "./ArtworkImage";
import type { Art } from "./types";

type Settings = {
  x: number;
  height: number;
  rotation: number;
  scale: number;
  wall: string;
};
const defaults: Settings = {
  x: 0,
  height: 145,
  rotation: 0,
  scale: 100,
  wall: "#e6e1d5",
};
type SceneApi = {
  update: (s: Settings) => void;
  reset: () => void;
  startAR: () => Promise<void>;
  endAR: () => void;
  place: () => void;
};
const modelIds = new Set(["sculpture", "ceramic", "bronze", "porcelain"]);

export default function SpaceDemo({ artworks }: { artworks: Art[] }) {
  const works = artworks.filter((a) => a.dimensions.unit === "cm");
  const [chosen, setChosen] = useState("");
  const [settings, setSettings] = useState<Settings>(defaults);
  const [ready, setReady] = useState(false),
    [error, setError] = useState("");
  const [xrSupport, setXrSupport] = useState<"checking" | "yes" | "no">(
    "checking",
  );
  const [xrActive, setXrActive] = useState(false),
    [xrBusy, setXrBusy] = useState(false);
  const [xrMessage, setXrMessage] = useState(""),
    [canPlace, setCanPlace] = useState(false);
  const host = useRef<HTMLDivElement>(null),
    overlay = useRef<HTMLDivElement>(null);
  const sceneApi = useRef<SceneApi | null>(null);
  const latestSettings = useRef(settings);
  const art =
    works.find((a) => a.id === chosen) ||
    works.find((a) => a.id === "sculpture") ||
    works[0];
  const wallArt = art?.mounting === "wall";

  useEffect(() => {
    const read = () =>
      setChosen(
        new URLSearchParams(location.search).get("artwork") || "sculpture",
      );
    read();
    window.addEventListener("popstate", read);
    let cancelled = false;
    if (window.isSecureContext && navigator.xr)
      navigator.xr
        .isSessionSupported("immersive-ar")
        .then((v) => {
          if (!cancelled) setXrSupport(v ? "yes" : "no");
        })
        .catch(() => {
          if (!cancelled) setXrSupport("no");
        });
    else setXrSupport("no");
    return () => {
      cancelled = true;
      window.removeEventListener("popstate", read);
    };
  }, []);

  useEffect(() => {
    latestSettings.current = settings;
    sceneApi.current?.update(settings);
  }, [settings]);

  useEffect(() => {
    const el = host.current;
    if (!el || !art) return;
    let cancelled = false,
      cleanup = () => {};
    setReady(false);
    setError("");
    async function init() {
      const [
        T,
        { OrbitControls },
        { RoomEnvironment },
        { createArtModel, disposeObject },
      ] = await Promise.all([
        import("three"),
        import("three/addons/controls/OrbitControls.js"),
        import("three/addons/environments/RoomEnvironment.js"),
        import("./art-models"),
      ]);
      if (cancelled) return;
      const renderer = new T.WebGLRenderer({ antialias: true, alpha: true });
      renderer.setPixelRatio(Math.min(devicePixelRatio, 1.7));
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = T.PCFSoftShadowMap;
      renderer.toneMapping = T.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 0.9;
      renderer.xr.enabled = true;
      renderer.xr.setReferenceSpaceType("local");
      el!.appendChild(renderer.domElement);
      renderer.domElement.setAttribute(
        "aria-label",
        `${art.title} 공간 배치 미리보기. 시점은 드래그하고 배치는 옆의 조절 항목을 이용하세요.`,
      );
      const scene = new T.Scene();
      scene.background = new T.Color("#e6e1d5");
      const environmentScene = new RoomEnvironment();
      const pmrem = new T.PMREMGenerator(renderer),
        environment = pmrem.fromScene(environmentScene, 0.04);
      scene.environment = environment.texture;
      scene.environmentIntensity = 0.45;
      environmentScene.dispose();
      pmrem.dispose();
      const camera = new T.PerspectiveCamera(38, 1, 0.01, 30);
      const initialCamera = new T.Vector3(1.65, 1.8, 3.1);
      camera.position.copy(initialCamera);
      const controls = new OrbitControls(camera, renderer.domElement);
      controls.target.set(0, 1.05, -0.5);
      controls.enableDamping = true;
      controls.enablePan = false;
      controls.minDistance = 1.1;
      controls.maxDistance = 6;
      controls.minPolarAngle = 0.45;
      controls.maxPolarAngle = Math.PI / 2 - 0.04;
      controls.minAzimuthAngle = -1;
      controls.maxAzimuthAngle = 1;
      scene.add(new T.HemisphereLight(0xfffaf0, 0x767063, 0.85));
      const key = new T.DirectionalLight(0xfff4e0, 2);
      key.position.set(-2, 4, 3);
      key.castShadow = true;
      key.shadow.mapSize.set(2048, 2048);
      key.shadow.camera.left = -3;
      key.shadow.camera.right = 3;
      key.shadow.camera.top = 4;
      key.shadow.camera.bottom = -2;
      key.shadow.normalBias = 0.006;
      scene.add(key);
      const room = new T.Group();
      scene.add(room);
      const wallMaterial = new T.MeshStandardMaterial({
        color: latestSettings.current.wall,
        roughness: 1,
      });
      const wall = new T.Mesh(new T.BoxGeometry(6, 3.5, 0.08), wallMaterial);
      wall.position.set(0, 1.75, -0.85);
      wall.receiveShadow = true;
      room.add(wall);
      const floor = new T.Mesh(
        new T.PlaneGeometry(12, 12),
        new T.MeshStandardMaterial({ color: "#c9bea9", roughness: 0.86 }),
      );
      floor.rotation.x = -Math.PI / 2;
      floor.receiveShadow = true;
      room.add(floor);
      const trim = new T.Mesh(
        new T.BoxGeometry(6, 0.055, 0.025),
        new T.MeshStandardMaterial({ color: "#f2eee5", roughness: 0.85 }),
      );
      trim.position.set(0, 0.0275, -0.79);
      room.add(trim);
      const consoleTop = new T.Mesh(
        new T.BoxGeometry(1.85, 0.075, 0.62),
        new T.MeshStandardMaterial({ color: "#a88b64", roughness: 0.8 }),
      );
      consoleTop.position.set(0, 0.72 - 0.0375, -0.42);
      consoleTop.castShadow = consoleTop.receiveShadow = true;
      const consoleGroup = new T.Group();
      consoleGroup.add(consoleTop);
      for (const x of [-0.8, 0.8]) {
        const leg = new T.Mesh(
          new T.BoxGeometry(0.08, 0.65, 0.52),
          new T.MeshStandardMaterial({ color: "#826b4f", roughness: 0.9 }),
        );
        leg.position.set(x, 0.325, -0.42);
        leg.castShadow = true;
        consoleGroup.add(leg);
      }
      consoleGroup.visible = art.mounting === "surface";
      room.add(consoleGroup);
      // A metre-wide inlaid floor mark gives a stable human-scale reference.
      const lineMat = new T.MeshStandardMaterial({
        color: "#7c7666",
        roughness: 1,
      });
      const ruler = new T.Mesh(new T.BoxGeometry(1, 0.002, 0.007), lineMat);
      ruler.position.set(0, 0.002, 0.5);
      room.add(ruler);
      for (const x of [-0.5, 0.5]) {
        const tick = new T.Mesh(new T.BoxGeometry(0.006, 0.002, 0.06), lineMat);
        tick.position.set(x, 0.002, 0.5);
        room.add(tick);
      }
      const pivot = new T.Group();
      scene.add(pivot);
      let model: InstanceType<typeof T.Group> | null = null;
      const reticle = new T.Mesh(
        new T.RingGeometry(0.065, 0.085, 48).rotateX(-Math.PI / 2),
        new T.MeshBasicMaterial({ color: 0xeacdaa }),
      );
      reticle.matrixAutoUpdate = false;
      reticle.visible = false;
      scene.add(reticle);
      let session: XRSession | null = null,
        hitSource: XRHitTestSource | null = null;
      let visible = true,
        surfaceFound = false;
      const size = () => {
        if (renderer.xr.isPresenting) return;
        const w = el!.clientWidth,
          h = el!.clientHeight;
        renderer.setSize(w, h);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
      };
      const resize = new ResizeObserver(size);
      resize.observe(el!);
      size();
      const observer = new IntersectionObserver(([entry]) => {
        visible = entry.isIntersecting;
      });
      observer.observe(el!);
      const update = (s: Settings) => {
        wallMaterial.color.set(s.wall);
        if (session) return;
        scene.background = new T.Color(s.wall);
        pivot.scale.setScalar(s.scale / 100);
        pivot.rotation.set(
          0,
          wallArt ? 0 : T.MathUtils.degToRad(s.rotation),
          0,
        );
        const scaledHeight = ((art.dimensions.height / 100) * s.scale) / 100;
        pivot.position.set(
          s.x / 100,
          wallArt
            ? s.height / 100 - scaledHeight / 2
            : art.mounting === "surface"
              ? 0.72
              : 0,
          wallArt ? -0.8 + art.dimensions.depth / 200 : -0.42,
        );
      };
      const restore = () => {
        hitSource?.cancel();
        hitSource = null;
        session = null;
        surfaceFound = false;
        room.visible = true;
        pivot.visible = true;
        reticle.visible = false;
        controls.enabled = true;
        camera.position.copy(initialCamera);
        controls.target.set(0, 1.05, -0.5);
        controls.update();
        update(latestSettings.current);
        size();
        if (!cancelled) {
          setXrActive(false);
          setXrBusy(false);
          setCanPlace(false);
          setXrMessage("");
        }
      };
      const place = () => {
        if (!session || !reticle.visible) return;
        pivot.position.setFromMatrixPosition(reticle.matrix);
        const viewerPosition = new T.Vector3().setFromMatrixPosition(
          renderer.xr.getCamera().matrixWorld,
        );
        pivot.rotation.set(
          0,
          Math.atan2(
            viewerPosition.x - pivot.position.x,
            viewerPosition.z - pivot.position.z,
          ),
          0,
        );
        pivot.visible = true;
        if (!cancelled)
          setXrMessage(
            "작품을 놓았어요. 다른 자리를 비춘 뒤 다시 배치할 수 있어요.",
          );
      };
      // Prevent the DOM controls from also placing the object in the XR scene.
      const preventSelect = (e: Event) => {
        if (e.target instanceof Element && e.target.closest("button")) e.preventDefault();
      };
      const overlayEl = overlay.current;
      overlayEl?.addEventListener("beforexrselect", preventSelect);
      const controller = renderer.xr.getController(0);
      controller.addEventListener("select", place);
      scene.add(controller);
      cleanup = () => {
        session?.removeEventListener("end", restore);
        if (session) void session.end().catch(() => {});
        hitSource?.cancel();
        observer.disconnect();
        resize.disconnect();
        controls.dispose();
        overlayEl?.removeEventListener("beforexrselect", preventSelect);
        controller.removeEventListener("select", place);
        renderer.setAnimationLoop(null);
        disposeObject(scene);
        environment.dispose();
        renderer.dispose();
        renderer.domElement.remove();
        sceneApi.current = null;
      };
      try {
        model = await createArtModel(art);
      } catch {
        if (!cancelled)
          throw new Error(
            "작품 사진 또는 3D 모형을 불러오지 못했어요. 파일과 연결 상태를 확인해 주세요.",
          );
      }
      if (cancelled) {
        if (model) disposeObject(model);
        return;
      }
      if (!model) return;
      pivot.add(model);
      update(latestSettings.current);
      sceneApi.current = {
        update,
        reset: () => {
          camera.position.copy(initialCamera);
          controls.target.set(0, 1.05, -0.5);
          controls.update();
        },
        place,
        endAR: () => {
          void session?.end();
        },
        startAR: async () => {
          if (!navigator.xr || session) return;
          let requested: XRSession | null = null;
          try {
            requested = await navigator.xr.requestSession("immersive-ar", {
              requiredFeatures: ["hit-test", "dom-overlay"],
              domOverlay: { root: overlayEl! },
            });
            if (cancelled) {
              await requested.end();
              return;
            }
            session = requested;
            session.addEventListener("end", restore);
            const viewer = await session.requestReferenceSpace("viewer");
            if (!session.requestHitTestSource)
              throw new Error(
                "이 브라우저에서는 표면 인식을 사용할 수 없어요.",
              );
            hitSource =
              (await session.requestHitTestSource({ space: viewer })) || null;
            if (!hitSource) throw new Error("표면 인식을 시작할 수 없어요.");
            await renderer.xr.setSession(session);
            if (cancelled) {
              await requested.end();
              return;
            }
            room.visible = false;
            pivot.visible = false;
            pivot.scale.setScalar(1);
            reticle.visible = false;
            scene.background = null;
            controls.enabled = false;
            setXrActive(true);
            setXrMessage(
              "카메라를 천천히 움직여 바닥이나 테이블의 평평한 면을 찾아주세요.",
            );
          } catch (e) {
            if (requested) {
              await requested.end().catch(() => {});
              restore();
            }
            throw e;
          }
        },
      };
      renderer.setAnimationLoop((_time, frame) => {
        if (cancelled) return;
        if (frame && session && hitSource) {
          const reference = renderer.xr.getReferenceSpace();
          const hits = frame.getHitTestResults(hitSource);
          const pose = reference && hits[0]?.getPose(reference);
          // Only accept horizontal surfaces: wall pictures stand upright as photo panels.
          const valid = Boolean(pose && pose.transform.matrix[5] > 0.85);
          reticle.visible = valid;
          if (pose && valid) reticle.matrix.fromArray(pose.transform.matrix);
          if (valid !== surfaceFound) {
            surfaceFound = valid;
            setCanPlace(valid);
            setXrMessage(
              valid
                ? "표면을 찾았어요. ‘여기에 놓기’를 눌러 배치하세요."
                : "평평한 바닥이나 테이블을 다시 비춰주세요.",
            );
          }
        }
        if (renderer.xr.isPresenting || (visible && !document.hidden)) {
          if (!session) controls.update();
          renderer.render(scene, camera);
        }
      });
      setReady(true);
    }
    init().catch((e) => {
      cleanup();
      if (!cancelled)
        setError(
          e instanceof Error
            ? e.message
            : "이 브라우저에서 3D를 열 수 없어요. 그래픽 가속을 확인해 주세요.",
        );
    });
    return () => {
      cancelled = true;
      cleanup();
    };
  }, [
    art?.id,
    art?.image,
    art?.model_url,
    art?.dimensions.width,
    art?.dimensions.height,
    art?.dimensions.depth,
    art?.mounting,
    wallArt,
  ]);

  if (!art)
    return (
      <section className="container standalone">
        <h1>배치할 작품을 준비하고 있어요.</h1>
        <Link href="/gallery">작품 둘러보기</Link>
      </section>
    );
  function choose(a: Art) {
    setChosen(a.id);
    setSettings(defaults);
    host.current?.scrollIntoView({
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      block: "center",
    });
    history.pushState(null, "", `/space?artwork=${encodeURIComponent(a.id)}`);
  }
  function change(key: keyof Settings, value: number | string) {
    setSettings((s) => ({ ...s, [key]: value }));
  }
  return (
    <section className="container space-demo">
      <div className="space-demo-heading">
        <div>
          <p className="eyebrow">ART IN YOUR SPACE / DEMO</p>
          <h1 className="page-title">작품이 머무를 자리.</h1>
          <p className="section-description">
            마음에 든 작품, 공간 속에서 먼저 만나보세요.
          </p>
        </div>
        <span className="demo-badge">
          <Box size={15} /> 3D · AR 데모
        </span>
      </div>
      <div className="placement-layout">
        <div className="placement-view">
          <div ref={host} className="room-canvas" />
          <div className="room-top">
            <span>THE QUIET ROOM</span>
            <span>
              {settings.scale === 100
                ? "등록 크기 1:1"
                : `크기 ${settings.scale}%`}
            </span>
          </div>
          {!ready && (
            <div className="room-loading" role="status">
              {error || "작품과 공간을 불러오는 중…"}
            </div>
          )}
          <div className="room-bottom">
            <span>
              <Move size={14} /> 드래그로 시점 이동 · 스크롤로 확대
            </span>
            <span>바닥 눈금 1m</span>
          </div>
          <button
            className="room-reset icon-button"
            aria-label="공간과 시점 초기화"
            onClick={() => {
              setSettings(defaults);
              sceneApi.current?.reset();
            }}
          >
            <RotateCcw size={18} />
          </button>
        </div>
        <aside className="placement-panel">
          <p className="eyebrow">SELECTED ARTWORK</p>
          <h2>{art.title}</h2>
          <p className="placement-artist">
            {art.artist.name} · {art.category}
          </p>
          <div className="dimension-strip">
            <span>
              가로 <strong>{art.dimensions.width}</strong>
            </span>
            <span>
              높이 <strong>{art.dimensions.height}</strong>
            </span>
            <span>
              깊이 <strong>{art.dimensions.depth}</strong>
            </span>
            <small>cm</small>
          </div>
          <p className="model-note">
            {art.model_url
              ? "작가가 첨부한 3D 모형입니다. 등록한 가로·세로·깊이에 맞춰 표시합니다."
              : modelIds.has(art.id)
              ? "작품 사진을 참고한 3D 재질·형태 스터디입니다. 실제 작품을 스캔한 모델은 아닙니다."
              : "등록 사진을 작품 크기의 패널로 배치합니다. 사진 속 배경과 프레임이 함께 표시됩니다."}
          </p>
          <fieldset
            className="placement-controls"
            disabled={!ready || xrActive}
          >
            <legend>공간에 맞춰보기</legend>
            <label>
              좌우 위치 <output>{settings.x} cm</output>
              <input
                aria-label="좌우 위치"
                type="range"
                min="-60"
                max="60"
                value={settings.x}
                onChange={(e) => change("x", +e.target.value)}
              />
            </label>
            {wallArt ? (
              <label>
                작품 중심 높이 <output>{settings.height} cm</output>
                <input
                  aria-label="작품 중심 높이"
                  type="range"
                  min="80"
                  max="200"
                  value={settings.height}
                  onChange={(e) => change("height", +e.target.value)}
                />
              </label>
            ) : (
              <label>
                작품 회전 <output>{settings.rotation}°</output>
                <input
                  aria-label="작품 회전"
                  type="range"
                  min="-180"
                  max="180"
                  value={settings.rotation}
                  onChange={(e) => change("rotation", +e.target.value)}
                />
              </label>
            )}
            <label>
              크기 비교{" "}
              <output>
                {settings.scale}%{settings.scale === 100 ? " · 등록 크기" : ""}
              </output>
              <input
                aria-label="크기 비교"
                type="range"
                min="50"
                max="150"
                step="5"
                value={settings.scale}
                onChange={(e) => change("scale", +e.target.value)}
              />
            </label>
            <div className="wall-colors">
              <span>벽 색상</span>
              {[
                { color: "#e6e1d5", name: "웜 아이보리" },
                { color: "#abb3a0", name: "세이지 그린" },
                { color: "#aeb5ba", name: "쿨 그레이" },
              ].map((c) => (
                <button
                  key={c.color}
                  type="button"
                  aria-label={c.name}
                  aria-pressed={settings.wall === c.color}
                  style={{ background: c.color }}
                  onClick={() => change("wall", c.color)}
                >
                  {settings.wall === c.color && <Check size={13} />}
                </button>
              ))}
            </div>
          </fieldset>
          <button
            className="button dark camera-ar"
            disabled={!ready || xrSupport !== "yes" || xrBusy}
            onClick={async () => {
              setXrBusy(true);
              setError("");
              try {
                await sceneApi.current?.startAR();
              } catch {
                setError(
                  "카메라 AR을 시작하지 못했어요. 권한과 브라우저 지원을 확인한 뒤 다시 시도해 주세요.",
                );
              } finally {
                setXrBusy(false);
              }
            }}
          >
            <Camera size={17} />
            {xrBusy ? "AR 연결 중…" : "카메라 AR로 보기"}
            <ArrowUpRight size={16} />
          </button>
          <p className="ar-support">
            {xrSupport === "checking"
              ? "카메라 AR 지원 여부를 확인하고 있어요."
              : xrSupport === "yes"
                ? "지원 기기에서 카메라와 표면 인식 권한을 허용하면 등록 크기(100%)로 배치합니다. 벽 작품은 수평면에 세운 사진 패널로 표시됩니다."
                : "현재 브라우저에서는 가상 공간 데모를 이용할 수 있어요. 카메라 AR은 WebXR을 지원하는 모바일 기기와 보안 연결(HTTPS)이 필요합니다."}
          </p>
          {error && ready && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
        </aside>
      </div>
      <div className="space-artworks-heading">
        <h2>다른 작품도 놓아보세요.</h2>
        <span>{works.length} ARTWORKS</span>
      </div>
      <div className="space-artworks">
        {works.map((a) => (
          <button
            className={`space-artwork ${a.id === art.id ? "selected" : ""}`}
            key={a.id}
            aria-pressed={a.id === art.id}
            aria-label={`${a.title} 배치하기`}
            onClick={() => choose(a)}
          >
            <ArtworkImage src={a.image} alt={a.title} />
            <span>
              <strong>{a.title}</strong>
              <small>
                {a.category} · {a.dimensions.width} × {a.dimensions.height} cm
              </small>
            </span>
            {a.id === art.id && <Check size={16} />}
          </button>
        ))}
      </div>
      <p className="space-demo-note">
        가상 전시 공간의 비율을 비교하는 데모입니다. 화면에서 보이는 크기는
        시점에 따라 달라집니다. 실제 설치 전에는 치수와 지지면을 확인해 주세요.
      </p>
      <div
        ref={overlay}
        className={`xr-overlay ${xrActive ? "is-active" : ""}`}
      >
        {xrActive && (
          <>
            <div className="xr-status">
              <strong>{art.title} · 등록 크기 1:1</strong>
              <p role="status">{xrMessage}</p>
              {wallArt && (
                <small>
                  벽 작품은 수평면 위에 세운 사진 패널로 표시됩니다.
                </small>
              )}
            </div>
            <div className="xr-actions">
              <button
                className="button dark"
                disabled={!canPlace}
                onClick={() => sceneApi.current?.place()}
              >
                <Box size={17} /> 여기에 놓기
              </button>
              <button
                className="button secondary"
                onClick={() => sceneApi.current?.endAR()}
              >
                <X size={17} /> AR 종료
              </button>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
