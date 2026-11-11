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
import type { PlacementPose } from "./ar-placement";

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
  reposition: () => void;
  downloadDiagnostics: () => void;
  adjustWall: (x: number, y: number) => void;
  resetWallOffset: () => void;
};
type XRDiagnostic = {
  state: string;
  distanceMetres: number | null;
  normalY: number | null;
  hitCount: number;
  tracking: string;
  anchor: string;
  progress: number;
};
const emptyDiagnostic: XRDiagnostic = {
  state: "표면 탐색 중", distanceMetres: null, normalY: null, hitCount: 0,
  tracking: "확인 중", anchor: "배치 전", progress: 0,
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
  const [xrPlaced, setXrPlaced] = useState(false);
  const [xrTracking, setXrTracking] = useState(false);
  const [xrDiagnostic, setXrDiagnostic] = useState<XRDiagnostic>(emptyDiagnostic);
  const [hasDiagnostics, setHasDiagnostics] = useState(false);
  const [xrOffset, setXrOffset] = useState({ x: 0, y: 0 });
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
    setHasDiagnostics(false);
    setXrDiagnostic({ ...emptyDiagnostic });
    async function init() {
      const [
        T,
        { OrbitControls },
        { RoomEnvironment },
        { createArtModel, disposeObject },
        { placementFromHit, positionWithWallOffset, isFreshHit, MAX_WALL_OFFSET_METRES },
        { createPlacementGate },
      ] = await Promise.all([
        import("three"),
        import("three/addons/controls/OrbitControls.js"),
        import("three/addons/environments/RoomEnvironment.js"),
        import("./art-models"),
        import("./ar-placement"),
        import("./ar-tracking"),
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
        new T.MeshBasicMaterial({ color: 0xeacdaa, side: T.DoubleSide }),
      );
      reticle.matrixAutoUpdate = false;
      reticle.visible = false;
      scene.add(reticle);
      let session: XRSession | null = null,
        hitSource: XRHitTestSource | null = null;
      let visible = true,
        surfaceFound = false;
      let candidate: PlacementPose | null = null,
        placed: PlacementPose | null = null,
        hitTime = -Infinity,
        scanStarted = 0,
        statusMessage = "";
      let wallOffset = { x: 0, y: 0 };
      let xrReference: XRReferenceSpace | null = null;
      const gate = createPlacementGate();
      let placementRequested = false, trackingValid = false;
      let anchor: XRAnchor | null = null, anchorRevision = 0;
      let anchorState = "배치 전";
      let startedAt = 0, diagnosticAt = -Infinity, loggedAt = -Infinity;
      let diagnostic: XRDiagnostic = { ...emptyDiagnostic };
      const diagnosticLog: Array<XRDiagnostic & { elapsedMs: number; event: string }> = [];
      let modelBoundsCm = { width: 0, height: 0, depth: 0 };
      const record = (event: string) => {
        diagnosticLog.push({ ...diagnostic, elapsedMs: Math.round(performance.now() - startedAt), event });
        if (diagnosticLog.length > 600) diagnosticLog.shift();
      };
      const clearAnchor = () => {
        anchorRevision++;
        anchor?.delete();
        anchor = null;
        anchorState = "배치 전";
      };
      const message = (text: string) => {
        if (statusMessage === text || cancelled) return;
        statusMessage = text;
        setXrMessage(text);
      };
      const invalidateHit = () => {
        gate.reset();
        placementRequested = false;
        candidate = null;
        hitTime = -Infinity;
        surfaceFound = false;
        reticle.visible = false;
        if (!cancelled) setCanPlace(false);
      };
      const onVisibilityChange = () => {
        invalidateHit();
        trackingValid = false;
        pivot.visible = false;
        if (!cancelled) setXrTracking(false);
        scanStarted = performance.now();
        message("추적이 잠시 중단됐어요. 주변을 천천히 비춰 표면을 다시 확인해 주세요.");
      };
      const onReferenceReset = () => {
        invalidateHit();
        clearAnchor();
        placed = null;
        wallOffset = { x: 0, y: 0 };
        pivot.visible = false;
        if (!cancelled) {
          setXrPlaced(false);
          setXrOffset({ x: 0, y: 0 });
        }
        record("reference-reset");
        message("공간 기준이 바뀌었어요. 표면을 다시 찾아 작품을 배치해 주세요.");
      };
      const size = () => {
        if (renderer.xr.isPresenting) return;
        const w = Math.max(el!.clientWidth, 1),
          h = Math.max(el!.clientHeight, 1);
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
        if (session) record("session-ended");
        session?.removeEventListener("end", onSessionEnd);
        session?.removeEventListener("visibilitychange", onVisibilityChange);
        xrReference?.removeEventListener("reset", onReferenceReset);
        xrReference = null;
        hitSource?.cancel();
        hitSource = null;
        session = null;
        clearAnchor();
        gate.reset();
        placementRequested = false;
        trackingValid = false;
        surfaceFound = false;
        candidate = null;
        placed = null;
        hitTime = -Infinity;
        statusMessage = "";
        wallOffset = { x: 0, y: 0 };
        room.visible = true;
        pivot.visible = true;
        reticle.visible = false;
        controls.enabled = true;
        camera.fov = 38;
        camera.zoom = 1;
        camera.position.copy(initialCamera);
        controls.target.set(0, 1.05, -0.5);
        controls.update();
        update(latestSettings.current);
        size();
        if (!cancelled) {
          setXrActive(false);
          setXrBusy(false);
          setCanPlace(false);
          setXrPlaced(false);
          setXrOffset({ x: 0, y: 0 });
          setXrMessage("");
          setXrTracking(false);
        }
      };
      // XRManager must restore its framebuffer before the desktop camera/viewport.
      // The raw session event also covers failures before setSession completed.
      const onSessionEnd = () => {
        queueMicrotask(() => { if (!cancelled && !renderer.xr.isPresenting && session) restore(); });
      };
      renderer.xr.addEventListener("sessionend", restore);
      const place = () => {
        if (!session || placed || !candidate || !reticle.visible ||
            !isFreshHit(hitTime, performance.now(), session.visibilityState === "visible")) return;
        // Confirm on the next active XR frame, using a fresh hit and anchor pose.
        placementRequested = true;
      };
      const reposition = () => {
        if (!session) return;
        record("reposition");
        clearAnchor();
        invalidateHit();
        placed = null;
        pivot.visible = false;
        wallOffset = { x: 0, y: 0 };
        scanStarted = performance.now();
        setXrPlaced(false);
        setXrOffset({ x: 0, y: 0 });
        message("새 위치를 비춰주세요. 표식이 안정되면 다시 배치할 수 있어요.");
      };
      // Prevent the DOM controls from also placing the object in the XR scene.
      const preventSelect = (e: Event) => {
        if (e.target instanceof Element && e.target.closest("button, .xr-status, .xr-action-stack")) e.preventDefault();
      };
      const overlayEl = overlay.current;
      overlayEl?.addEventListener("beforexrselect", preventSelect);
      const controller = renderer.xr.getController(0);
      controller.addEventListener("select", place);
      scene.add(controller);
      cleanup = () => {
        session?.removeEventListener("end", onSessionEnd);
        session?.removeEventListener("visibilitychange", onVisibilityChange);
        xrReference?.removeEventListener("reset", onReferenceReset);
        if (session) void session.end().catch(() => {});
        clearAnchor();
        renderer.xr.removeEventListener("sessionend", restore);
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
      const bounds = new T.Box3().setFromObject(model).getSize(new T.Vector3());
      modelBoundsCm = { width: bounds.x * 100, height: bounds.y * 100, depth: bounds.z * 100 };
      update(latestSettings.current);
      sceneApi.current = {
        update,
        reset: () => {
          camera.position.copy(initialCamera);
          controls.target.set(0, 1.05, -0.5);
          controls.update();
        },
        place,
        reposition,
        downloadDiagnostics: () => {
          const report = {
            version: "ar-stability-v1", exportedAt: new Date().toISOString(),
            browser: navigator.userAgent, artwork: art.id, mounting: art.mounting,
            registeredCm: art.dimensions, modelBoundsCm,
            note: "기기 추정값이며 실측 오차가 아닙니다. 사진·영상·공간 좌표는 포함하지 않습니다.",
            samples: diagnosticLog,
          };
          const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }));
          const link = document.createElement("a");
          link.href = url;
          link.download = "design-farm-ar-diagnostics.json";
          link.click();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        },
        adjustWall: (x, y) => {
          if (!session || !wallArt || !placed || !trackingValid || !pivot.visible) return;
          const clamp = (value: number) => Math.max(-MAX_WALL_OFFSET_METRES, Math.min(MAX_WALL_OFFSET_METRES, value));
          wallOffset = { x: clamp(wallOffset.x + x), y: clamp(wallOffset.y + y) };
          pivot.position.copy(positionWithWallOffset(placed, wallOffset.x, wallOffset.y));
          setXrOffset({ x: Math.round(wallOffset.x * 100), y: Math.round(wallOffset.y * 100) });
        },
        resetWallOffset: () => {
          if (!session || !wallArt || !placed || !trackingValid || !pivot.visible) return;
          wallOffset = { x: 0, y: 0 };
          pivot.position.copy(placed.position);
          setXrOffset({ x: 0, y: 0 });
        },
        endAR: () => {
          void session?.end();
        },
        startAR: async () => {
          if (!navigator.xr || session) return;
          let requested: XRSession | null = null;
          try {
            requested = await navigator.xr.requestSession("immersive-ar", {
              requiredFeatures: ["hit-test", "dom-overlay"],
              optionalFeatures: ["anchors"],
              domOverlay: { root: overlayEl! },
            });
            if (cancelled) {
              await requested.end();
              return;
            }
            session = requested;
            session.addEventListener("end", onSessionEnd);
            session.addEventListener("visibilitychange", onVisibilityChange);
            const viewer = await session.requestReferenceSpace("viewer");
            if (cancelled || session !== requested) {
              await requested.end().catch(() => {});
              return;
            }
            if (!session.requestHitTestSource)
              throw new Error(
                "이 브라우저에서는 표면 인식을 사용할 수 없어요.",
              );
            const requestedSource =
              (await session.requestHitTestSource({ space: viewer, entityTypes: ["plane"] })) || null;
            if (cancelled || session !== requested) {
              requestedSource?.cancel();
              await requested.end().catch(() => {});
              return;
            }
            hitSource = requestedSource;
            if (!hitSource) throw new Error("표면 인식을 시작할 수 없어요.");
            await renderer.xr.setSession(session);
            if (cancelled || session !== requested) {
              await requested.end().catch(() => {});
              return;
            }
            room.visible = false;
            xrReference = renderer.xr.getReferenceSpace();
            xrReference?.addEventListener("reset", onReferenceReset);
            pivot.visible = false;
            pivot.scale.setScalar(1);
            reticle.visible = false;
            scene.background = null;
            controls.enabled = false;
            scanStarted = performance.now();
            startedAt = scanStarted;
            diagnosticAt = loggedAt = -Infinity;
            diagnosticLog.length = 0;
            diagnostic = { ...emptyDiagnostic };
            gate.reset();
            setXrDiagnostic(diagnostic);
            setHasDiagnostics(true);
            record("session-started");
            setXrActive(true);
            message(wallArt
              ? "카메라를 천천히 움직여 세로 벽을 찾아주세요. 표식이 작품의 중심이 됩니다."
              : "카메라를 천천히 움직여 바닥이나 테이블의 평평한 면을 찾아주세요.");
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
          const now = performance.now();
          const reference = renderer.xr.getReferenceSpace();
          const viewerPose = reference && frame.getViewerPose(reference);
          trackingValid = !!viewerPose && !viewerPose.emulatedPosition && session.visibilityState === "visible";
          const viewerPosition = viewerPose
            ? new T.Vector3().copy(viewerPose.transform.position) : new T.Vector3();
          let state = "위치 추적 불안정", progress = 0;
          let distance: number | null = null, normalY: number | null = null, hitCount = 0;
          candidate = null;
          if (!placed) {
            const hits = trackingValid ? frame.getHitTestResults(hitSource) : [];
            hitCount = hits.length;
            // Never skip a nearer, unsuitable surface and place on a distant one behind it.
            const pose = reference && hits[0]?.getPose(reference);
            const point = pose ? new T.Vector3().setFromMatrixPosition(new T.Matrix4().fromArray(pose.transform.matrix)) : null;
            const normal = pose ? new T.Vector3(pose.transform.matrix[4], pose.transform.matrix[5], pose.transform.matrix[6]).normalize() : null;
            const proposed = pose && trackingValid
              ? placementFromHit(pose.transform.matrix, viewerPosition, wallArt, art.dimensions) : null;
            const result = gate.update(proposed && pose && point && normal ? {
              time: now, point, normal, viewer: viewerPosition, emulated: pose.emulatedPosition,
            } : null);
            distance = point ? viewerPosition.distanceTo(point) : null;
            normalY = normal?.y ?? null;
            progress = result.progress;
            if (!trackingValid || pose?.emulatedPosition) {
              state = "위치 추적 불안정";
              message("거리 추적이 불안정해 배치를 잠시 막았어요. 밝은 곳에서 주변을 천천히 비춰주세요.");
            } else if (!pose) {
              state = "표면 미검출";
              message(wallArt
                ? now - scanStarted > 10000
                  ? "벽을 아직 찾지 못했어요. 무늬 없는 벽에는 인쇄된 종이를 임시로 붙이고, 주변과 함께 천천히 비춰보세요. 계속 실패하면 3D 미리보기를 이용하세요."
                  : "벽과 주변을 천천히 비춰주세요. 벽의 무늬·모서리가 함께 보이면 인식에 도움이 됩니다."
                : "평평하고 단단한 바닥·테이블과 주변을 천천히 비춰주세요. 침구나 몸 위에서는 정확도를 확인하기 어려워요.");
            } else if (!proposed) {
              state = "다른 방향의 표면";
              message(wallArt
                ? "표면은 찾았지만 세로 벽이 아니에요. 바닥 대신 벽의 무늬나 모서리 쪽을 비춰주세요."
                : "수평면이 아니에요. 바닥이나 테이블 윗면을 비춰주세요.");
            } else if (result.reason === "too-close" || result.reason === "too-far") {
              state = result.reason === "too-close" ? "표면이 너무 가까움" : "표면이 너무 멂";
              message(result.reason === "too-close"
                ? "표면에 너무 가까워요. 휴대폰을 조금 뒤로 옮겨주세요."
                : "먼 표면이 잡혔어요. 원하는 위치에 가까이 가서 다시 비춰주세요.");
            } else {
              state = result.ready ? "배치 준비됨" : "표면 안정화 중";
              message(result.ready
                ? "표식이 원하는 면에 있는지 확인한 뒤 배치하세요. 인식된 거리는 진단 정보에서 볼 수 있어요."
                : "표면을 찾았어요. 같은 지점에 표식을 잠시 유지해 주세요.");
              if (pose) reticle.matrix.fromArray(pose.transform.matrix);
            }
            reticle.visible = !!proposed && !pose?.emulatedPosition && (result.reason === "stabilizing" || result.ready);
            reticle.material.color.set(result.ready ? 0x7bbd93 : 0xeacdaa);
            if (result.ready) {
              candidate = proposed;
              hitTime = now;
            }
            if (placementRequested && candidate && reference && result.ready) {
              placed = candidate;
              wallOffset = { x: 0, y: 0 };
              setXrOffset({ x: 0, y: 0 });
              pivot.position.copy(placed.position);
              pivot.quaternion.copy(placed.quaternion);
              pivot.scale.setScalar(1);
              pivot.visible = true;
              reticle.visible = false;
              setXrPlaced(true);
              anchorState = "미지원 · 위치 고정";
              const placementSession = session, revision = anchorRevision;
              if (frame.createAnchor) {
                anchorState = "고정점 생성 중";
                try {
                  // createAnchor must run inside an active XR frame, not a DOM event.
                  const promise = frame.createAnchor(new XRRigidTransform(placed.position, placed.quaternion), reference);
                  void promise.then((created) => {
                    if (cancelled || session !== placementSession || anchorRevision !== revision || !placed) {
                      created.delete();
                      return;
                    }
                    anchor = created;
                    anchorState = "고정점 추적";
                  }).catch(() => {
                    if (session === placementSession && anchorRevision === revision) anchorState = "사용 불가 · 위치 고정";
                  });
                } catch {
                  anchorState = "사용 불가 · 위치 고정";
                }
              }
              diagnostic = { ...diagnostic, state: "배치 확정", distanceMetres: distance, normalY, hitCount, anchor: anchorState, progress: 1 };
              record("placed");
            }
            placementRequested = false;
          }
          if (placed) {
            let located = trackingValid;
            if (anchor && reference) {
              const pose = frame.getPose(anchor.anchorSpace, reference);
              located = located && !!pose && !pose.emulatedPosition;
              if (pose && located) {
                placed.position.copy(pose.transform.position);
                placed.quaternion.copy(pose.transform.orientation);
                placed.right.set(1, 0, 0).applyQuaternion(placed.quaternion);
                placed.up.set(0, 1, 0).applyQuaternion(placed.quaternion);
                placed.normal.set(0, wallArt ? 0 : 1, wallArt ? 1 : 0).applyQuaternion(placed.quaternion);
              }
              anchorState = located ? "고정점 추적" : "고정점 재탐색";
            }
            pivot.visible = located;
            reticle.visible = false;
            if (located) {
              pivot.position.copy(positionWithWallOffset(placed, wallOffset.x, wallOffset.y));
              pivot.quaternion.copy(placed.quaternion);
            }
            state = located ? "배치됨 · 실제 크기 검증 필요" : "배치 위치 재탐색";
            distance = trackingValid ? viewerPosition.distanceTo(pivot.position) : null;
            progress = 1;
            message(!located
              ? "위치를 다시 찾는 중이에요. 작품을 잠시 숨겼어요. 원래 배치한 곳과 주변을 비춰주세요."
              : anchorState.includes("위치 고정")
                ? "작품을 놓았어요. 이 환경에서는 고정점 보정을 사용할 수 없으니 움직인 뒤 위치와 크기를 확인해 주세요."
                : "작품을 놓았어요. 위치를 바꾸려면 ‘다시 배치’를 눌러 새 표면을 찾아주세요.");
          }
          const valid = !placed && candidate !== null;
          if (valid !== surfaceFound) {
            surfaceFound = valid;
            setCanPlace(valid);
          }
          diagnostic = { state, distanceMetres: distance, normalY, hitCount, progress,
            tracking: trackingValid ? "위치 추적 중" : "위치 추적 불안정", anchor: anchorState };
          if (now - diagnosticAt >= 250) {
            diagnosticAt = now;
            setXrDiagnostic(diagnostic);
            setXrTracking(trackingValid && (!placed || pivot.visible));
          }
          if (now - loggedAt >= 1000) {
            loggedAt = now;
            record("sample");
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
  function diagnostics() {
    return (
      <details className="xr-diagnostics">
        <summary>AR 진단 정보 · 기기 추정값</summary>
        <dl>
          <div><dt>상태</dt><dd>{xrDiagnostic.state}</dd></div>
          <div><dt>검출·배치 지점까지</dt><dd>{xrDiagnostic.distanceMetres === null ? "확인 중" : `${xrDiagnostic.distanceMetres.toFixed(2)} m`}</dd></div>
          <div><dt>위치 추적</dt><dd>{xrDiagnostic.tracking}</dd></div>
          <div><dt>배치 고정점</dt><dd>{xrDiagnostic.anchor}</dd></div>
          <div><dt>검출된 표면 수</dt><dd>{xrDiagnostic.hitCount}</dd></div>
          <div><dt>표면 방향 Y</dt><dd>{xrDiagnostic.normalY?.toFixed(2) ?? "—"}</dd></div>
        </dl>
        <p>실측 정확도가 아닙니다. 기록은 이 화면에만 보관하며 사진·영상을 포함하지 않아요.</p>
        <button type="button" className="xr-diagnostics-download" onClick={() => sceneApi.current?.downloadDiagnostics()}>진단 기록 내려받기</button>
      </details>
    );
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
                ? "등록 치수 적용"
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
                ? wallArt
                  ? "지원 기기에서 세로 벽을 인식하면 그림을 등록 크기(100%)로 걸어봅니다. 기기별 벽 인식과 실제 크기 정확도는 실기기 검증이 필요합니다."
                  : "지원 기기에서 카메라와 표면 인식 권한을 허용하면 바닥·테이블에 등록 크기(100%)로 배치합니다."
                : "현재 브라우저에서는 가상 공간 데모를 이용할 수 있어요. 카메라 AR은 WebXR을 지원하는 모바일 기기와 보안 연결(HTTPS)이 필요합니다."}
          </p>
          {error && ready && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          {hasDiagnostics && !xrActive && diagnostics()}
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
              <strong>{art.title} · 등록 치수 적용</strong>
              <small>가로 {art.dimensions.width} × 높이 {art.dimensions.height} × 깊이 {art.dimensions.depth} cm · 실제 크기 정확도 검증 중</small>
              <p role="status">{xrMessage}</p>
              {!xrPlaced && <div className="xr-confidence" data-state={canPlace ? "ready" : "unstable"}>
                <span>{canPlace ? "배치 준비됨" : xrDiagnostic.state}</span>
                <progress aria-label="배치 전 표면 안정화" value={xrDiagnostic.progress} max={1} />
                <small>노란 표식이 초록색이 될 때까지 같은 지점을 비춰주세요.{wallArt ? " 표식은 그림 중심입니다." : " 표식은 작품 바닥 중심입니다."}</small>
              </div>}
              {diagnostics()}
            </div>
            <div className="xr-action-stack">
              {wallArt && xrPlaced && (
                <fieldset className="xr-adjustments" disabled={!xrTracking}>
                  <legend>벽 위에서 위치 조절 · 2cm씩</legend>
                  <p>처음 배치한 중심 기준 · 좌우 {xrOffset.x}cm / 높이 {xrOffset.y}cm</p>
                  <div>
                    <button type="button" disabled={xrOffset.x <= -50} onClick={() => sceneApi.current?.adjustWall(-0.02, 0)}>← 왼쪽</button>
                    <button type="button" disabled={xrOffset.y >= 50} onClick={() => sceneApi.current?.adjustWall(0, 0.02)}>↑ 위로</button>
                    <button type="button" disabled={xrOffset.x >= 50} onClick={() => sceneApi.current?.adjustWall(0.02, 0)}>오른쪽 →</button>
                    <button type="button" onClick={() => sceneApi.current?.resetWallOffset()}>조절 초기화</button>
                    <button type="button" disabled={xrOffset.y <= -50} onClick={() => sceneApi.current?.adjustWall(0, -0.02)}>↓ 아래로</button>
                  </div>
                </fieldset>
              )}
              <div className="xr-actions">
                <button
                  className="button dark"
                  disabled={!xrPlaced && !canPlace}
                  onClick={() => xrPlaced ? sceneApi.current?.reposition() : sceneApi.current?.place()}
                >
                  <Box size={17} /> {xrPlaced ? "다시 배치" : wallArt ? "여기에 걸기" : "여기에 놓기"}
                </button>
                <button
                  className="button secondary xr-exit"
                  onClick={() => sceneApi.current?.endAR()}
                >
                  <X size={17} /> AR 종료
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
