"use client";

import { useEffect, useRef, useState } from "react";

/** Inspect provider output without reshaping it to the registration dimensions. */
export default function GeneratedModelPreview({ url, onReady }: {
  url: string;
  onReady: (ready: boolean) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [message, setMessage] = useState("모형을 불러오고 있어요…");
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    let cancelled = false;
    let cleanup = () => {};
    onReady(false);
    setMessage("모형을 불러오고 있어요…");
    async function load() {
      const [T, { GLTFLoader }, { OrbitControls }, { RoomEnvironment }, { disposeObject }] =
        await Promise.all([
          import("three"), import("three/addons/loaders/GLTFLoader.js"),
          import("three/addons/controls/OrbitControls.js"),
          import("three/addons/environments/RoomEnvironment.js"), import("./art-models"),
        ]);
      const { scene: model } = await new GLTFLoader().loadAsync(url);
      if (cancelled) { disposeObject(model); return; }
      const box = new T.Box3().setFromObject(model);
      const center = box.getCenter(new T.Vector3());
      const size = box.getSize(new T.Vector3()).length();
      if (!Number.isFinite(size) || size <= 0) {
        disposeObject(model);
        throw new Error("Empty model");
      }
      let renderer: InstanceType<typeof T.WebGLRenderer>;
      try { renderer = new T.WebGLRenderer({ antialias: true, alpha: true }); }
      catch (error) { disposeObject(model); throw error; }
      const scene = new T.Scene();
      const camera = new T.PerspectiveCamera(40, 1, Math.max(size / 1000, 0.0001), size * 100);
      camera.position.set(center.x + size, center.y + size * 0.5, center.z + size * 1.7);
      const controls = new OrbitControls(camera, renderer.domElement);
      const room = new RoomEnvironment();
      const generator = new T.PMREMGenerator(renderer);
      let environment: ReturnType<typeof generator.fromScene> | undefined;
      const observer = new ResizeObserver(() => {
        const width = element!.clientWidth, height = element!.clientHeight;
        if (!width || !height) return;
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
        renderer.setSize(width, height);
        renderer.render(scene, camera);
      });
      cleanup = () => {
        observer.disconnect(); controls.dispose(); disposeObject(model);
        environment?.dispose(); generator.dispose(); room.dispose();
        renderer.dispose(); renderer.domElement.remove();
      };
      try {
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        renderer.toneMapping = T.ACESFilmicToneMapping;
        environment = generator.fromScene(room);
        scene.environment = environment.texture;
        scene.add(model, new T.HemisphereLight(0xffffff, 0x635849, 3));
        const light = new T.DirectionalLight(0xffffff, 4);
        light.position.set(2, 4, 3); scene.add(light);
        controls.target.copy(center);
        controls.enablePan = false;
        controls.minDistance = size * 0.3;
        controls.maxDistance = size * 5;
        controls.update();
        controls.addEventListener("change", () => renderer.render(scene, camera));
        renderer.domElement.setAttribute("aria-label", "생성 모형 원래 비율로 회전 미리보기");
        element!.appendChild(renderer.domElement);
        observer.observe(element!);
        setMessage(""); onReady(true);
      } catch (error) { cleanup(); cleanup = () => {}; throw error; }
    }
    void load().catch(() => {
      if (!cancelled) {
        setMessage("모형을 표시할 수 없어요. 잠시 후 다시 열어 확인해 주세요.");
        onReady(false);
      }
    });
    return () => { cancelled = true; cleanup(); };
  }, [url, onReady]);
  return <div>
    <div className="preview-model" ref={host} />
    {message && <p role="status">{message}</p>}
    <p className="fine-print">드래그로 회전 · 스크롤로 확대. 생성된 모형의 원래 비율입니다. 실측 치수는 등록 전 미리보기에서 반영됩니다.</p>
  </div>;
}
