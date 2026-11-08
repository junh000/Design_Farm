import * as T from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import type { Art } from "./types";

// These are photo-inspired studies, not scans. All space previews use metres.
export const sculptedIds = new Set([
  "sculpture",
  "bronze",
  "ceramic",
  "porcelain",
]);

function surface(kind: "plaster" | "stone" | "bronze" | "glaze" | "porcelain") {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 512;
  const ctx = canvas.getContext("2d")!;
  const pixels = ctx.createImageData(512, 512);
  const palette = {
    plaster: [202, 196, 182],
    stone: [167, 160, 141],
    bronze: [106, 78, 45],
    glaze: [104, 115, 69],
    porcelain: [236, 232, 218],
  }[kind];
  let seed = 721;
  const random = () => {
    seed = (1664525 * seed + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (let y = 0; y < 512; y++)
    for (let x = 0; x < 512; x++) {
      const i = (y * 512 + x) * 4;
      const waves =
        Math.sin(x * 0.067 + Math.cos(y * 0.035) * 3) * Math.sin(y * 0.041) * 7;
      const grain = (random() - 0.5) * (kind === "porcelain" ? 10 : 24);
      const pore = random() > 0.988 ? -45 * random() : 0;
      for (let c = 0; c < 3; c++)
        pixels.data[i + c] = palette[c] + waves + grain + pore;
      pixels.data[i + 3] = 255;
    }
  ctx.putImageData(pixels, 0, 0);
  // Scattered shallow pores stay readable at a catalogue viewing distance.
  const pores = kind === "plaster" ? 1600 : kind === "porcelain" ? 280 : 1400;
  for (let i = 0; i < pores; i++) {
    const x = random() * 512,
      y = random() * 512,
      r = 0.3 + random() * (kind === "plaster" ? 3.5 : 1.3);
    ctx.fillStyle =
      kind === "porcelain"
        ? `rgba(91,67,38,${0.18 + random() * 0.35})`
        : `rgba(79,71,52,${0.15 + random() * 0.4})`;
    ctx.beginPath();
    ctx.ellipse(
      x,
      y,
      r,
      r * (0.45 + random() * 0.5),
      random() * Math.PI,
      0,
      Math.PI * 2,
    );
    ctx.fill();
    if (kind === "plaster") {
      ctx.fillStyle = "rgba(255,252,237,.4)";
      ctx.beginPath();
      ctx.arc(x + 0.6, y + 0.9, r * 0.45, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  const map = new T.CanvasTexture(canvas);
  map.colorSpace = T.SRGBColorSpace;
  map.wrapS = map.wrapT = T.RepeatWrapping;
  map.repeat.set(1, 1);
  const bump = map.clone();
  bump.colorSpace = T.NoColorSpace;
  bump.needsUpdate = true;
  return new T.MeshPhysicalMaterial({
    map,
    bumpMap: bump,
    bumpScale: kind === "plaster" ? 0.012 : 0.008,
    roughnessMap: kind === "bronze" || kind === "glaze" ? bump : undefined,
    roughness:
      kind === "bronze"
        ? 0.44
        : kind === "glaze"
          ? 0.27
          : kind === "porcelain"
            ? 0.38
            : 0.93,
    metalness: kind === "bronze" ? 0.8 : 0,
    clearcoat: kind === "glaze" ? 0.6 : kind === "porcelain" ? 0.24 : 0,
    clearcoatRoughness: 0.3,
  });
}

function organicLoop(tube: number, phase: number) {
  const g = new T.TorusGeometry(0.77, tube, 48, 144);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i),
      y = p.getY(i),
      z = p.getZ(i);
    const angle = Math.atan2(y, x);
    const uneven =
      1 + 0.04 * Math.sin(angle * 3 + phase) + 0.012 * Math.cos(angle * 7);
    p.setXYZ(
      i,
      x * uneven,
      y * uneven,
      z + 0.075 * Math.sin(angle * 2 + phase),
    );
  }
  g.computeVertexNormals();
  return g;
}

export function createSculpture(bronze = false) {
  const group = new T.Group();
  const material = surface(bronze ? "bronze" : "plaster");
  const first = new T.Mesh(organicLoop(bronze ? 0.2 : 0.235, 0.4), material);
  first.scale.set(0.84, 1.3, 0.95);
  first.rotation.set(0.1, -0.3, -0.25);
  first.position.set(bronze ? 0 : -0.2, 1.65, 0);
  group.add(first);
  if (!bronze) {
    const second = new T.Mesh(organicLoop(0.22, 1.3), material);
    second.scale.set(0.68, 0.92, 0.84);
    second.rotation.set(-0.15, 1.05, 0.38);
    second.position.set(0.3, 1.1, 0.15);
    group.add(second);
  }
  const baseMaterial = surface("stone");
  if (bronze) baseMaterial.color.set("#555b53");
  const base = new T.Mesh(
    new RoundedBoxGeometry(1.85, 0.42, 1.3, 3, 0.018),
    baseMaterial,
  );
  base.position.y = 0.21;
  group.add(base);
  group.traverse((o) => {
    if (o instanceof T.Mesh) {
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });
  return group;
}

function createVase(white: boolean) {
  const group = new T.Group();
  const outer = white
    ? [
        [0.28, 0],
        [0.34, 0.06],
        [0.6, 0.24],
        [0.82, 0.6],
        [0.88, 0.96],
        [0.77, 1.34],
        [0.48, 1.64],
        [0.31, 1.76],
        [0.31, 1.86],
      ]
    : [
        [0.34, 0],
        [0.42, 0.1],
        [0.65, 0.3],
        [0.77, 0.65],
        [0.71, 1.08],
        [0.52, 1.43],
        [0.47, 1.68],
        [0.51, 1.75],
      ];
  const points = outer.map(([r, y]) => new T.Vector2(r, y));
  const inner = outer
    .slice(1)
    .reverse()
    .map(([r, y]) => new T.Vector2(r - 0.045, y - 0.02));
  const curve = new T.SplineCurve([
    ...points,
    ...inner,
    new T.Vector2(0, 0.08),
  ]);
  const geo = new T.LatheGeometry(curve.getPoints(100), 100);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i),
      angle = Math.atan2(pos.getZ(i), pos.getX(i));
    const ripple =
      1 + 0.01 * Math.sin(y * 34) + 0.014 * Math.sin(angle * 3 + y * 2);
    pos.setX(i, pos.getX(i) * ripple);
    pos.setZ(i, pos.getZ(i) * ripple);
  }
  geo.computeVertexNormals();
  const vase = new T.Mesh(geo, surface(white ? "porcelain" : "glaze"));
  vase.castShadow = vase.receiveShadow = true;
  group.add(vase);
  return group;
}

export function fitToDimensions(
  group: T.Group,
  width: number,
  height: number,
  depth: number,
) {
  const box = new T.Box3().setFromObject(group);
  const size = box.getSize(new T.Vector3());
  const center = box.getCenter(new T.Vector3());
  if ([size.x, size.y, size.z, width, height, depth].some((v) => !Number.isFinite(v) || v <= 0)) {
    disposeObject(group);
    throw new Error("입체 모형의 가로·세로·깊이를 확인해 주세요.");
  }
  // A wrapper keeps the object's origin at the centre of its footprint, on the floor.
  const centered = new T.Group();
  centered.add(group);
  centered.position.set(-center.x, -box.min.y, -center.z);
  const wrapper = new T.Group();
  wrapper.add(centered);
  wrapper.scale.set(width / size.x, height / size.y, depth / size.z);
  return wrapper;
}

export async function createArtModel(art: Art) {
  const { width, height, depth } = art.dimensions;
  let group: T.Group;
  if (art.model_url) {
    const { GLTFLoader } = await import("three/addons/loaders/GLTFLoader.js");
    const result = await new GLTFLoader().loadAsync(art.model_url);
    group = result.scene;
    group.traverse((object) => {
      if (object instanceof T.Mesh) object.castShadow = object.receiveShadow = true;
    });
  } else if (art.id === "sculpture" || art.id === "bronze")
    group = createSculpture(art.id === "bronze");
  else if (art.id === "ceramic" || art.id === "porcelain")
    group = createVase(art.id === "porcelain");
  else {
    group = new T.Group();
    const texture = await new T.TextureLoader().loadAsync(art.image);
    texture.colorSpace = T.SRGBColorSpace;
    texture.anisotropy = 4;
    const back = new T.Mesh(
      new T.BoxGeometry(
        width / 100,
        height / 100,
        Math.max(depth / 100, 0.008),
      ),
      new T.MeshStandardMaterial({ color: "#675444", roughness: 0.86 }),
    );
    const face = new T.Mesh(
      new T.PlaneGeometry(width / 100, height / 100),
      new T.MeshStandardMaterial({ map: texture, roughness: 0.92 }),
    );
    face.position.z = Math.max(depth / 100, 0.008) / 2 + 0.0005;
    back.castShadow = true;
    group.add(back, face);
  }
  return fitToDimensions(
    group,
    width / 100,
    height / 100,
    Math.max(depth / 100, 0.008),
  );
}

export function disposeObject(root: T.Object3D) {
  const textures = new Set<T.Texture>(),
    materials = new Set<T.Material>(),
    geometries = new Set<T.BufferGeometry>();
  root.traverse((o) => {
    if (o instanceof T.Mesh || o instanceof T.LineSegments) {
      geometries.add(o.geometry);
      const ms = Array.isArray(o.material) ? o.material : [o.material];
      ms.forEach((m) => {
        materials.add(m);
        Object.values(m).forEach((v) => {
          if (v instanceof T.Texture) textures.add(v);
        });
      });
    }
  });
  textures.forEach((t) => t.dispose());
  materials.forEach((m) => m.dispose());
  geometries.forEach((g) => g.dispose());
}
