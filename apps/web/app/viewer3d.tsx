"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { placementMatrix, type Placement, type RoomGeometry, type Vec2 } from "@roomrelay/spatial";
import { disposeObject3D } from "@/lib/dispose";
import type { FrameStats, ViewerItem } from "@/lib/viewer-types";

interface Props {
  room: RoomGeometry;
  items: ViewerItem[];
  placements: Record<string, Placement>;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onMove: (itemId: string, placement: Placement) => void;
  onStats: (s: FrameStats) => void;
}

/** xz-boundary → THREE.Shape (shape Y maps to world -Z after rotateX(-π/2)). */
function floorShape(boundary: Vec2[]): THREE.Shape {
  const s = new THREE.Shape();
  boundary.forEach(([x, z], i) => (i === 0 ? s.moveTo(x, -z) : s.lineTo(x, -z)));
  return s;
}

function labelSprite(text: string): THREE.Sprite {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 64;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "rgba(28,36,33,0.85)";
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.fillStyle = "#fff";
  ctx.font = "26px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, c.width / 2, c.height / 2);
  const tex = new THREE.CanvasTexture(c);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false }));
  sprite.scale.set(0.9, 0.225, 1);
  return sprite;
}

export default function Viewer3D({ room, items, placements, selectedId, onSelect, onMove, onStats }: Props) {
  const mountRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef<{
    renderer: THREE.WebGLRenderer;
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    controls: OrbitControls;
    itemGroups: Map<string, THREE.Group>;
    selectionHelper: THREE.BoxHelper | null;
    placements: Record<string, Placement>;
    items: ViewerItem[];
    selectedId: string | null;
    frames: number[];
    lastT: number;
    raf: number;
    dragging: string | null;
    raycaster: THREE.Raycaster;
    floorPlane: THREE.Plane;
    loader: GLTFLoader;
    setLoadError: (e: string | null) => void;
    onStatsRef: { current: (s: FrameStats) => void };
  } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const onStatsRef = useRef(onStats);
  onStatsRef.current = onStats;

  // Keep latest props visible to the render loop without re-init.
  useEffect(() => {
    const s = stateRef.current;
    if (!s) return;
    s.placements = placements;
    s.items = items;
    s.selectedId = selectedId;
    syncItems(s);
    syncPlacements(s);
    syncSelection(s);
  });

  function syncPlacements(s: NonNullable<typeof stateRef.current>) {
    for (const [id, g] of s.itemGroups) {
      const p = s.placements[id];
      if (!p) continue;
      g.matrixAutoUpdate = false;
      g.matrix.fromArray(placementMatrix(p));
      // Force-compose the whole subtree now: updateWorldMatrix (used by
      // BoxHelper/Box3.setFromObject) skips children whose matrixWorldNeedsUpdate
      // flag is unset, so freshly attached GLB meshes would contribute stale
      // identity-space bounds until the next render pass.
      g.updateMatrixWorld(true);
    }
    s.selectionHelper?.update();
  }

  function syncSelection(s: NonNullable<typeof stateRef.current>) {
    if (s.selectionHelper) {
      s.scene.remove(s.selectionHelper);
      s.selectionHelper.geometry.dispose();
      (s.selectionHelper.material as THREE.Material).dispose();
      s.selectionHelper = null;
    }
    if (s.selectedId && s.itemGroups.has(s.selectedId)) {
      const g = s.itemGroups.get(s.selectedId)!;
      g.updateMatrixWorld(true);
      const helper = new THREE.BoxHelper(g, 0x22635a);
      s.selectionHelper = helper;
      s.scene.add(helper);
    }
  }

  function syncItems(s: NonNullable<typeof stateRef.current>) {
    const wanted = new Set(s.items.map((i) => i.id));
    for (const [id, g] of [...s.itemGroups]) {
      if (!wanted.has(id)) {
        s.scene.remove(g);
        disposeObject3D(g);
        s.itemGroups.delete(id);
      }
    }
    for (const item of s.items) {
      if (s.itemGroups.has(item.id)) continue;
      const group = new THREE.Group();
      group.name = `item:${item.id}`;
      group.userData.itemId = item.id;
      s.itemGroups.set(item.id, group);
      s.scene.add(group);
      s.loader.load(
        item.assetUrl,
        (gltf) => {
          const inner = new THREE.Group();
          inner.matrixAutoUpdate = false;
          inner.matrix.fromArray(item.localMatrix);
          inner.add(gltf.scene);
          inner.traverse((o) => {
            if ((o as THREE.Mesh).isMesh) {
              o.castShadow = true;
              o.receiveShadow = true;
              o.userData.itemId = item.id;
            }
          });
          group.add(inner);
          syncPlacements(s);
          syncSelection(s);
        },
        undefined,
        () => {
          s.setLoadError(`Could not load model for ${item.title}. The 2D footprint below is still accurate.`);
          // Fallback: footprint proxy box so the item still renders.
          const proxy = new THREE.Mesh(
            new THREE.BoxGeometry(item.dimsM.widthM, item.dimsM.heightM, item.dimsM.depthM),
            new THREE.MeshStandardMaterial({ color: 0x8a9b94, transparent: true, opacity: 0.5 }),
          );
          proxy.position.y = item.dimsM.heightM / 2;
          proxy.userData.itemId = item.id;
          group.add(proxy);
          syncPlacements(s);
          syncSelection(s);
        },
      );
    }
  }

  useEffect(() => {
    const mount = mountRef.current!;
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    mount.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xe8e5db);
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

    const xs = room.boundaryXZ.map((p) => p[0]);
    const zs = room.boundaryXZ.map((p) => p[1]);
    const cx = (Math.max(...xs) + Math.min(...xs)) / 2;
    const cz = (Math.max(...zs) + Math.min(...zs)) / 2;
    const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs));

    const camera = new THREE.PerspectiveCamera(45, 1, 0.05, 100);
    camera.position.set(cx + span * 1.15, span * 1.05, cz + span * 1.35);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(cx, 0.4, cz);
    controls.enableDamping = true;
    controls.maxPolarAngle = Math.PI / 2 - 0.06; // never under the floor
    controls.minDistance = 0.5;
    controls.maxDistance = span * 4;

    // Lighting: env gives base PBR fill; one directional for soft shadows.
    const sun = new THREE.DirectionalLight(0xfff4e0, 2.4);
    sun.position.set(cx + 3, 5, cz + 2);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -span;
    sun.shadow.camera.right = span;
    sun.shadow.camera.top = span;
    sun.shadow.camera.bottom = -span;
    sun.shadow.bias = -0.0002;
    scene.add(sun);
    scene.add(new THREE.HemisphereLight(0xffffff, 0xd8d2c4, 0.4));

    // Floor.
    const floor = new THREE.Mesh(
      new THREE.ShapeGeometry(floorShape(room.boundaryXZ)).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: 0xd9d3c4, roughness: 0.9, metalness: 0 }),
    );
    floor.receiveShadow = true;
    scene.add(floor);
    // Grid-ish border.
    const borderPts = room.boundaryXZ.map(([x, z]) => new THREE.Vector3(x, 0.005, z));
    borderPts.push(borderPts[0]!.clone());
    scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(borderPts), new THREE.LineBasicMaterial({ color: 0x8b8474 })));

    // Low translucent walls (0.28m) with door-opening gap on z=0 edge.
    const wallMat = new THREE.MeshStandardMaterial({ color: 0xb8c4bd, transparent: true, opacity: 0.28, side: THREE.DoubleSide, depthWrite: false });
    const WALL_H = 0.28;
    const door = room.doors[0];
    for (let i = 0; i < room.boundaryXZ.length; i++) {
      const a = room.boundaryXZ[i]!;
      const b = room.boundaryXZ[(i + 1) % room.boundaryXZ.length]!;
      const dx = b[0] - a[0];
      const dz = b[1] - a[1];
      const len = Math.hypot(dx, dz);
      // Split the edge if a door opening lies on it.
      let segments: [number, number][] = [[0, 1]];
      if (door) {
        const [o1, o2] = door.openingXZ;
        const onSeg = (p: Vec2) =>
          Math.abs(dx * (p[1] - a[1]) - dz * (p[0] - a[0])) < 1e-6;
        if (onSeg(o1!) && onSeg(o2!)) {
          const t = (p: Vec2) => ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / (len * len);
          const [t1, t2] = [t(o1!), t(o2!)].sort((x, y) => x - y);
          segments = ([[0, t1!], [t2!, 1]] as [number, number][]).filter(([s0, s1]) => s1! - s0! > 0.001);
        }
      }
      for (const [t0, t1] of segments) {
        const segLen = len * (t1 - t0);
        const wall = new THREE.Mesh(new THREE.PlaneGeometry(segLen, WALL_H), wallMat);
        const mx = a[0] + dx * (t0 + t1) / 2;
        const mz = a[1] + dz * (t0 + t1) / 2;
        wall.position.set(mx, WALL_H / 2, mz);
        wall.rotation.y = -Math.atan2(dz, dx);
        scene.add(wall);
      }
    }

    // Door swing fan on the floor.
    if (door && door.swingPolygonXZ.length > 0) {
      const fan = new THREE.Mesh(
        new THREE.ShapeGeometry(floorShape(door.swingPolygonXZ)).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({ color: 0x8a5a13, transparent: true, opacity: 0.18, side: THREE.DoubleSide }),
      );
      fan.position.y = 0.008;
      scene.add(fan);
      const swingBorder = door.swingPolygonXZ.map(([x, z]) => new THREE.Vector3(x, 0.012, z));
      scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(swingBorder), new THREE.LineBasicMaterial({ color: 0x8a5a13 })));
    }

    // Kept obstacles as labeled boxes.
    for (const ob of room.obstacles) {
      const oxs = ob.footprintXZ.map((p) => p[0]);
      const ozs = ob.footprintXZ.map((p) => p[1]);
      const w = Math.max(...oxs) - Math.min(...oxs);
      const d = Math.max(...ozs) - Math.min(...ozs);
      const h = ob.heightM ?? 0.5;
      const box = new THREE.Mesh(
        new THREE.BoxGeometry(w, h, d),
        new THREE.MeshStandardMaterial({ color: 0x7b857e, roughness: 0.95 }),
      );
      box.position.set((Math.max(...oxs) + Math.min(...oxs)) / 2, h / 2, (Math.max(...ozs) + Math.min(...ozs)) / 2);
      box.castShadow = true;
      box.receiveShadow = true;
      scene.add(box);
      const label = labelSprite(`kept: ${ob.label}`);
      label.position.set(box.position.x, h + 0.18, box.position.z);
      scene.add(label);
    }

    const s = {
      renderer,
      scene,
      camera,
      controls,
      itemGroups: new Map<string, THREE.Group>(),
      selectionHelper: null as THREE.BoxHelper | null,
      placements,
      items,
      selectedId,
      frames: [] as number[],
      lastT: performance.now(),
      raf: 0,
        dragging: null as string | null,
      raycaster: new THREE.Raycaster(),
      floorPlane: new THREE.Plane(new THREE.Vector3(0, 1, 0), 0),
      loader: new GLTFLoader(),
      setLoadError,
      onStatsRef,
    };
    stateRef.current = s;
    syncItems(s);
    syncPlacements(s);
    syncSelection(s);

    // Pointer interaction: click select + floor-plane drag.
    const ndc = (ev: PointerEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      return new THREE.Vector2(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
    };
    const pick = (ev: PointerEvent): string | null => {
      s.raycaster.setFromCamera(ndc(ev), camera);
      const hits = s.raycaster.intersectObjects([...s.itemGroups.values()], true);
      for (const h of hits) {
        let o: THREE.Object3D | null = h.object;
        while (o && !o.userData.itemId) o = o.parent;
        if (o?.userData.itemId) return o.userData.itemId as string;
      }
      return null;
    };
    const down = (ev: PointerEvent) => {
      const id = pick(ev);
      if (id) {
        s.dragging = id;
        onSelect(id);
        controls.enabled = false;
        renderer.domElement.setPointerCapture(ev.pointerId);
      } else {
        onSelect(null);
      }
    };
    const move = (ev: PointerEvent) => {
      if (!s.dragging) return;
      s.raycaster.setFromCamera(ndc(ev), camera);
      const hit = new THREE.Vector3();
      if (s.raycaster.ray.intersectPlane(s.floorPlane, hit)) {
        const prev = s.placements[s.dragging]!;
        onMove(s.dragging, { xM: hit.x, zM: hit.z, yawRad: prev.yawRad });
      }
    };
    const up = (ev: PointerEvent) => {
      if (s.dragging) {
        s.dragging = null;
        controls.enabled = true;
        try {
          renderer.domElement.releasePointerCapture(ev.pointerId);
        } catch {
          /* already released */
        }
      }
    };
    renderer.domElement.addEventListener("pointerdown", down);
    renderer.domElement.addEventListener("pointermove", move);
    renderer.domElement.addEventListener("pointerup", up);

    const resize = () => {
      const w = mount.clientWidth;
      const h = mount.clientHeight;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(mount);

    const loop = () => {
      const now = performance.now();
      const dt = now - s.lastT;
      s.lastT = now;
      s.frames.push(dt);
      if (s.frames.length > 120) s.frames.shift();
      if (s.frames.length % 20 === 0) {
        const sorted = [...s.frames].sort((a, b) => a - b);
        s.onStatsRef.current({ medianMs: sorted[Math.floor(sorted.length / 2)]! });
      }
      controls.update();
      renderer.render(scene, camera);
      s.raf = requestAnimationFrame(loop);
    };
    s.raf = requestAnimationFrame(loop);

    // Test-only hook: projected screen centers of an item's model bbox and the
    // selection helper, used by e2e to verify they share one transform.
    (window as unknown as Record<string, unknown>).__rrDebug = {
      centers: (itemId: string) => {
        const g = s.itemGroups.get(itemId);
        if (!g) return null;
        const modelC = new THREE.Box3().setFromObject(g).getCenter(new THREE.Vector3()).project(camera);
        const toPx = (v: THREE.Vector3) => ({
          x: Math.round((v.x * 0.5 + 0.5) * mount.clientWidth),
          y: Math.round((-v.y * 0.5 + 0.5) * mount.clientHeight),
        });
        const out: { model: { x: number; y: number }; helper: { x: number; y: number } | null } = {
          model: toPx(modelC),
          helper: null,
        };
        if (s.selectionHelper) {
          const hb = new THREE.Box3().setFromBufferAttribute(
            s.selectionHelper.geometry.getAttribute("position") as THREE.BufferAttribute,
          );
          out.helper = toPx(hb.getCenter(new THREE.Vector3()).project(camera));
        }
        return out;
      },
    };

    return () => {
      cancelAnimationFrame(s.raf);
      ro.disconnect();
      renderer.domElement.removeEventListener("pointerdown", down);
      renderer.domElement.removeEventListener("pointermove", move);
      renderer.domElement.removeEventListener("pointerup", up);
      controls.dispose();
      disposeObject3D(scene);
      pmrem.dispose();
      renderer.dispose();
      mount.removeChild(renderer.domElement);
      stateRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room]);

  // Reset / fit-to-room button via a custom event on the DOM node.
  const fit = () => {
    const s = stateRef.current;
    if (!s) return;
    const xs = room.boundaryXZ.map((p) => p[0]);
    const zs = room.boundaryXZ.map((p) => p[1]);
    const cx = (Math.max(...xs) + Math.min(...xs)) / 2;
    const cz = (Math.max(...zs) + Math.min(...zs)) / 2;
    const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs));
    s.camera.position.set(cx + span * 1.15, span * 1.05, cz + span * 1.35);
    s.controls.target.set(cx, 0.4, cz);
    s.controls.update();
  };

  return (
    <div style={{ position: "absolute", inset: 0 }}>
      <div ref={mountRef} style={{ position: "absolute", inset: 0 }} data-testid="viewer3d" />
      <div style={{ position: "absolute", top: 12, right: 12, display: "flex", gap: 8 }}>
        <button className="btn" onClick={fit} data-testid="fit-camera">
          Fit room
        </button>
      </div>
      {loadError ? (
        <div className="notice" style={{ position: "absolute", left: 12, bottom: 12, maxWidth: 380 }} role="alert">
          {loadError}
        </div>
      ) : null}
    </div>
  );
}
