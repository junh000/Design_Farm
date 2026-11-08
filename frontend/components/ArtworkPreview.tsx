"use client";

import { useEffect, useRef, useState } from "react";
import ArtworkImage from "./ArtworkImage";
import type { Art } from "./types";

export type PreviewArt = Pick<
  Art,
  | "id"
  | "title"
  | "image"
  | "model_url"
  | "dimensions"
  | "category"
  | "material"
  | "story"
  | "space"
  | "placement"
>;

export default function ArtworkPreview({
  art,
  onReady,
}: {
  art: PreviewArt;
  onReady: (ready: boolean) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [message, setMessage] = useState("3D 모형을 확인하고 있어요…");
  useEffect(() => {
    onReady(!art.model_url);
    if (!art.model_url || !host.current) return;
    const element = host.current;
    let cancelled = false;
    let cleanup = () => {};
    async function renderModel() {
      const [T, { OrbitControls }, { createArtModel, disposeObject }, { RoomEnvironment }] =
        await Promise.all([
          import("three"),
          import("three/addons/controls/OrbitControls.js"),
          import("./art-models"),
          import("three/addons/environments/RoomEnvironment.js"),
        ]);
      const model = await createArtModel(art);
      if (cancelled) {
        disposeObject(model);
        return;
      }
      let renderer: InstanceType<typeof T.WebGLRenderer>;
      try {
        renderer = new T.WebGLRenderer({ antialias: true, alpha: true });
      } catch (error) {
        disposeObject(model);
        throw error;
      }
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.toneMapping = T.ACESFilmicToneMapping;
      element.appendChild(renderer.domElement);
      renderer.domElement.setAttribute("aria-label", "첨부 모형 회전 미리보기");
      const scene = new T.Scene();
      const environmentScene = new RoomEnvironment();
      const generator = new T.PMREMGenerator(renderer);
      const environment = generator.fromScene(environmentScene);
      environmentScene.dispose();
      generator.dispose();
      scene.environment = environment.texture;
      scene.add(model, new T.HemisphereLight(0xffffff, 0x635849, 3));
      const light = new T.DirectionalLight(0xffffff, 4);
      light.position.set(2, 4, 3);
      scene.add(light);
      const bounds = new T.Box3().setFromObject(model);
      const center = bounds.getCenter(new T.Vector3());
      const size = bounds.getSize(new T.Vector3()).length();
      const camera = new T.PerspectiveCamera(
        40,
        1,
        Math.max(size / 1000, 0.0001),
        size * 100,
      );
      camera.position.set(
        center.x + size,
        center.y + size * 0.5,
        center.z + size * 1.7,
      );
      const controls = new OrbitControls(camera, renderer.domElement);
      controls.target.copy(center);
      controls.enablePan = false;
      controls.minDistance = size * 0.3;
      controls.maxDistance = size * 5;
      controls.update();
      const draw = () => renderer.render(scene, camera);
      const resize = new ResizeObserver(() => {
        const width = element.clientWidth,
          height = element.clientHeight;
        if (!width || !height) return;
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
        renderer.setSize(width, height);
        draw();
      });
      resize.observe(element);
      controls.addEventListener("change", draw);
      cleanup = () => {
        resize.disconnect();
        controls.dispose();
        disposeObject(model);
        environment.dispose();
        renderer.dispose();
        renderer.domElement.remove();
      };
      setMessage("");
      onReady(true);
    }
    void renderModel().catch(() => {
      if (!cancelled) {
        setMessage(
          "모형을 표시할 수 없어요. 파일을 변경하거나 첨부를 해제한 뒤 다시 확인해 주세요.",
        );
        onReady(false);
      }
    });
    return () => {
      cancelled = true;
      cleanup();
    };
  }, [art, onReady]);

  return (
    <div className="artwork-preview">
      <div className="preview-media">
        <ArtworkImage src={art.image} alt={art.title + " 등록 사진"} />
      </div>
      <div className="preview-information">
        <h2>{art.title}</h2>
        <p>
          {art.category} · {art.material}
        </p>
        <p>
          <strong>
            {art.dimensions.width} × {art.dimensions.height}
            {art.dimensions.unit === "cm" && art.dimensions.depth > 0
              ? ` × ${art.dimensions.depth}`
              : ""} {art.dimensions.unit}
          </strong>
        </p>
        <p>{art.story}</p>
        <p>
          {art.space} · {art.placement}
        </p>
        <p className="fine-print">
          사진 전체가 표시됩니다. 사진 속 작품과 입력한 치수가 일치하는지 확인해
          주세요.
        </p>
      </div>
      {art.model_url && (
        <div className="preview-model-section">
          <div className="preview-model" ref={host} />
          {message && <p role="status">{message}</p>}
          <p className="fine-print">
            드래그로 회전 · 스크롤로 확대. 입력한 가로·세로·깊이에 맞춘
            모형입니다.
          </p>
        </div>
      )}
    </div>
  );
}
