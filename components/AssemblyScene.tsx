"use client";
import { useEffect, useRef, useState } from "react";
import type { InputAsset } from "../lib/eda/types";
import { validateVrml } from "../lib/models/assets";
import { convertStep } from "../lib/models/step-pool";
import { modelCacheForAsset } from "../lib/models/model-cache";
import { useSceneAnimation } from "./useSceneAnimation";
export function AssemblyScene({ asset,active=true }: { asset: InputAsset;active?:boolean }) {
  const host = useRef<HTMLDivElement>(null),
    reset = useRef(() => {});
  const [status, setStatus] = useState("正在加载实体模型…");
  const animate=useSceneAnimation(active);
  useEffect(() => {
    let cancelled = false,
      dispose = () => {};
    const abort=new AbortController();
    async function run() {
      const [T, { OrbitControls }] = await Promise.all([
        import("three"),
        import("three/examples/jsm/controls/OrbitControls.js"),
      ]);
      if (cancelled) return;
      const group = new T.Group();
      const resources = new Set<{ dispose: () => void }>();
      dispose = () => resources.forEach((r) => r.dispose());
      if (/\.wrl$/i.test(asset.path)) {
        const text = new TextDecoder().decode(asset.bytes);
        validateVrml(text);
        const { VRMLLoader } = await import(
          "three/examples/jsm/loaders/VRMLLoader.js"
        );
        if (cancelled) return;
        const { optimizeAssembly } = await import("../lib/models/optimize");
        if (cancelled) return;
        const parsed = new VRMLLoader().parse(text, "");
        const holder = new T.Group();
        holder.add(parsed);
        group.add(optimizeAssembly(holder));
      } else {
        const data=await modelCacheForAsset(asset).get(asset.path,abort.signal,async()=>({kind:"step",meshes:await convertStep(asset.bytes,abort.signal)}));
        if(data.kind!=="step")throw new Error("STEP 缓存类型错误");
        if (cancelled) return;
        const {createStepAssembly}=await import('../lib/models/step');
        if(cancelled)return;
        group.add(createStepAssembly(data.meshes));
      }
      group.traverse((obj) => {
        if (obj instanceof T.Mesh) {
          resources.add(obj.geometry);
          (Array.isArray(obj.material) ? obj.material : [obj.material]).forEach(
            (m) => resources.add(m),
          );
        }
      });
      const bounds = new T.Box3().setFromObject(group),
        size = bounds.getSize(new T.Vector3());
      const extent = Math.max(size.x, size.y, size.z);
      if (bounds.isEmpty() || !Number.isFinite(extent) || extent <= 0)
        throw new Error("模型为空或坐标无效");
      group.position.sub(bounds.getCenter(new T.Vector3()));
      group.scale.setScalar(100 / extent);
      group.position.multiplyScalar(100 / extent);
      if (cancelled || !host.current) {
        dispose();
        return;
      }
      const scene = new T.Scene();
      scene.background = new T.Color("#dde5df");
      scene.add(group);
      scene.add(new T.HemisphereLight(0xffffff, 0x66776d, 3));
      const light = new T.DirectionalLight(0xffffff, 2);
      light.position.set(40, -80, 100);
      scene.add(light);
      const camera = new T.PerspectiveCamera(40, 1, 0.1, 2000);
      camera.up.set(0, 0, 1);
      camera.position.set(50, -100, 120);
      const renderer = new T.WebGLRenderer({ antialias: true });
      renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
      host.current.appendChild(renderer.domElement);
      const controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true;
      controls.update();
      controls.saveState();
      reset.current = () => controls.reset();
      const observer = new ResizeObserver(() => {
        if (!host.current) return;
        const w = host.current.clientWidth,
          h = host.current.clientHeight;
        if(!w||!h)return;
        renderer.setSize(w, h);
        camera.aspect = w / Math.max(h, 1);
        camera.updateProjectionMatrix();
      });
      observer.observe(host.current);
      const stopAnimation=animate(renderer,() => {
        controls.update();
        renderer.render(scene, camera);
      });
      dispose = () => {
        observer.disconnect();
        stopAnimation();
        controls.dispose();
        resources.forEach((r) => r.dispose());
        renderer.dispose();
        renderer.domElement.remove();
      };
      setStatus(
        `已加载实体模型 · ${asset.path.split("/").at(-1)} · ${group.getObjectsByProperty("type", "Mesh").length} 个网格`,
      );
    }
    run().catch((e) => {
      dispose();
      if (!cancelled)
        setStatus(`加载失败：${e instanceof Error ? e.message : String(e)}`);
    });
    return () => {
      cancelled = true;
      abort.abort();
      dispose();
    };
  }, [asset,animate]);
  return (
    <div>
      <div className="viewer-toolbar">
        <span role="status">{status}</span>
        <button onClick={() => reset.current()}>重置视角</button>
      </div>
      <div
        ref={host}
        aria-label="实体器件模型视图"
        style={{ height: 600, width: "100%" }}
      />
    </div>
  );
}
