/*
 ARprocess_refactored_full.js
 --------------------------------
 ✅ 複数マーカー対応（MarkerMap: patt名→nodeId を使用）
 ✅ 目的地選択 → 最短経路(Route.dijkstra) → 次ノード方向を矢印で表示
 ✅ 表示安定化：見失っても一定時間は表示を保持（ホールド）
 ✅ 到着時演出：GOAL表示（矢印OFF）
 ✅ 矢印は地面に水平（-90°寝かせ、Y回転のみ）
*/

if (!window.THREE) console.error("THREE is not defined. three.min.js の読み込み順を確認してください。");
if (!window.THREEx) console.error("THREEx is not defined. ar-threex.min.js が読み込めていません（404 or 順序ミス）。");
if (!window.Route) console.warn("Route is not defined. js/route.js を先に読み込んでください。");

let scene, camera, renderer;
let source, context;

// 表示安定化（見失っても一定時間は表示を保持）
const HOLD_MS = 700; // 500〜900で調整
const lastSeenAt = new Map();     // nodeId -> time
const lastMatrix = new Map();     // nodeId -> THREE.Matrix4
let currentNodeId = null;
let goalNodeId = null;

// 表示用（現在地マーカーの座標に追従）
let holdGroup = null;
let arrowGroup = null;
let goalObj = null; // GOAL演出

function setNavText(text) {
  const el = document.getElementById("nav");
  if (el) el.textContent = text;
}

function setGoalHudText(text) {
  const el = document.getElementById("goalHud");
  if (el) el.textContent = text;
}

// 目的地セット（HTMLから呼ばれる）
window.setGoalNode = function (nodeId) {
  const n = Number(nodeId);
  goalNodeId = Number.isFinite(n) ? n : null;

  if (goalNodeId == null) {
    setNavText("ナビ：目的地を選択してください");
    setGoalHudText("目的地：未選択");
  } else {
    const name = window.Route?.NodeMeta?.[goalNodeId]?.name ?? `Node ${goalNodeId}`;
    setNavText(`ナビ：目的地「${name}」を設定しました。マーカーを映してください`);
    setGoalHudText(`目的地：${name}`);
  }
};

function makeArrowMesh() {
  // シンプルな矢印（円柱 + 円錐）
  const group = new THREE.Group();

  const shaft = new THREE.Mesh(
    new THREE.CylinderGeometry(0.07, 0.07, 0.6, 12),
    new THREE.MeshNormalMaterial()
  );
  shaft.position.y = 0.3;
  group.add(shaft);

  const head = new THREE.Mesh(
    new THREE.ConeGeometry(0.16, 0.25, 16),
    new THREE.MeshNormalMaterial()
  );
  head.position.y = 0.75;
  group.add(head);

  // 矢印を地面に水平に寝かせる
  group.rotation.x = -Math.PI / 2;

  // 全体を少し浮かせる（地面に埋まるの防止）
  group.position.y = 0.08;

  return group;
}

// ===== Minimal OBJ loader (materials ignored) =====
function parseOBJ(text) {
  const positions = [];
  const vertices = [null]; // 1-indexed
  const faces = [];

  const lines = text.split(/\r?\n/);
  for (let line of lines) {
    line = line.trim();
    if (!line || line.startsWith("#")) continue;

    const parts = line.split(/\s+/);
    const head = parts[0];

    if (head === "v") {
      const x = parseFloat(parts[1]), y = parseFloat(parts[2]), z = parseFloat(parts[3]);
      vertices.push([x, y, z]);
    } else if (head === "f") {
      const idx = parts.slice(1).map(tok => {
        const v = tok.split("/")[0];
        return parseInt(v, 10);
      }).filter(n => Number.isFinite(n));
      if (idx.length >= 3) faces.push(idx);
    }
  }

  // triangulate faces with a fan
  for (const f of faces) {
    for (let i = 1; i < f.length - 1; i++) {
      const a = vertices[f[0]], b = vertices[f[i]], c = vertices[f[i + 1]];
      if (!a || !b || !c) continue;
      positions.push(
        a[0], a[1], a[2],
        b[0], b[1], b[2],
        c[0], c[1], c[2]
      );
    }
  }

  const geo = new THREE.BufferGeometry();
  // three.js r8x compatibility: setAttribute may not exist
  const posArray = new Float32Array(positions);
  if (typeof geo.setAttribute === "function") {
    geo.setAttribute("position", new THREE.BufferAttribute(posArray, 3));
  } else if (typeof geo.addAttribute === "function") {
    geo.addAttribute("position", new THREE.BufferAttribute(posArray, 3));
  } else {
    throw new Error("BufferGeometry attribute API not found");
  }
  geo.computeVertexNormals();
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}

async function loadOBJGeometry(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`OBJ load failed: ${res.status} ${res.statusText}`);
  const text = await res.text();
  return parseOBJ(text);
}

function normalizeToMarker(geo, targetSize = 0.9) {
  geo.computeBoundingBox();
  const box = geo.boundingBox;

  const size = new THREE.Vector3();
  box.getSize(size);

  const center = new THREE.Vector3();
  box.getCenter(center);

  geo.translate(-center.x, -center.y, -center.z);

  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  const s = targetSize / maxDim;
  geo.scale(s, s, s);
  geo.computeVertexNormals();
  return geo;
}

async function loadGoalModel(url = "models/GS.obj") {
  const geo = await loadOBJGeometry(url);
  normalizeToMarker(geo, 0.9);

  const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(geo, mat);

  const group = new THREE.Group();
  group.add(mesh);

  // Slightly above the marker plane
  group.position.set(0, 0.35, 0);

  // Safer default: no rotation first (adjust later if needed)
  group.rotation.set(0, 0, 0);
group.visible = false;
  return group;
}

function applyDirectionToArrow(dir) {
  if (!arrowGroup) return;
  if (dir == null) return;

  // Y回転だけ初期化
  arrowGroup.rotation.y = 0;

  switch (dir) {
    case 0: // 上（前）
      arrowGroup.rotation.y = 0;
      break;
    case 1: // 右
      arrowGroup.rotation.y = -Math.PI / 2;
      break;
    case 2: // 下（後）
      arrowGroup.rotation.y = Math.PI;
      break;
    case 3: // 左
      arrowGroup.rotation.y = Math.PI / 2;
      break;
    case 5: // 上階（演出用）
      arrowGroup.rotation.x = -Math.PI / 2 - Math.PI / 6;
      break;
    case 4: // 下階（演出用）
      arrowGroup.rotation.x = -Math.PI / 2 + Math.PI / 6;
      break;
    default:
      break;
  }
}

function AR() {
  scene = new THREE.Scene();

  camera = new THREE.Camera();
  scene.add(camera);

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(window.devicePixelRatio || 1);
  renderer.setClearColor(0x000000, 0);
  renderer.domElement.style.position = "absolute";
  renderer.domElement.style.top = "0px";
  renderer.domElement.style.left = "0px";
  renderer.domElement.style.zIndex = "2";
  document.body.appendChild(renderer.domElement);

  const light = new THREE.DirectionalLight(0xffffff);
  light.position.set(0, 0, 2);
  scene.add(light);

  // AR.js source
  source = new THREEx.ArToolkitSource({ sourceType: "webcam" });

  function onResize() {
    if (typeof source.onResizeElement === "function") source.onResizeElement();
    else source.onResize();

    if (typeof source.copyElementSizeTo === "function") {
      source.copyElementSizeTo(renderer.domElement);
      if (context && context.arController) source.copyElementSizeTo(context.arController.canvas);
    } else {
      source.copySizeTo(renderer.domElement);
      if (context && context.arController) source.copySizeTo(context.arController.canvas);
    }
  }

  source.init(() => {
    onResize();

    // AR.js context
    context = new THREEx.ArToolkitContext({
      cameraParametersUrl: "camera_para.dat",
      detectionMode: "mono"
    });

    context.init(() => {
      if (!context.arController) return;

      camera.projectionMatrix.copy(context.getProjectionMatrix());

      // マーカー登録
      const markerMap = window.Route?.MarkerMap || {};
      const ids = Object.values(markerMap);

      const markerRoots = new Map();

      for (const nodeId of ids) {
        const root = new THREE.Group();
        root.matrixAutoUpdate = false;
        root.visible = false;
        scene.add(root);
        markerRoots.set(nodeId, root);
        lastMatrix.set(nodeId, new THREE.Matrix4());

        const pattName = Object.keys(markerMap).find(k => markerMap[k] === nodeId);
        if (!pattName) continue;

        new THREEx.ArMarkerControls(context, root, {
          type: "pattern",
          patternUrl: "patt/" + pattName,
          size: 1.0
        });
      }

      // 表示（ホールド）
      holdGroup = new THREE.Group();
      holdGroup.matrixAutoUpdate = false;
      holdGroup.visible = false;
      scene.add(holdGroup);

      arrowGroup = makeArrowMesh();
      holdGroup.add(arrowGroup);

      // GOAL演出（OBJモデル）
      // models/GS.obj を読み込む（失敗したらスプライトにフォールバック）
      (async () => {
        try {
          goalObj = await loadGoalModel("models/GS.obj");
        } catch (e) {
          console.warn("[GOAL] OBJ load failed, fallback to sprite:", e);
          const canvas = document.createElement("canvas");
          canvas.width = 512; canvas.height = 256;
          const ctx = canvas.getContext("2d");
          ctx.fillStyle = "rgba(0,0,0,0.45)";
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.font = "bold 120px sans-serif";
          ctx.fillStyle = "white";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText("GOAL", canvas.width/2, canvas.height/2);
          const texture = new THREE.CanvasTexture(canvas);
          const material = new THREE.SpriteMaterial({ map: texture, transparent: true });
          goalObj = new THREE.Sprite(material);
          goalObj.scale.set(1.2, 0.6, 1);
          goalObj.position.set(0, 0.35, 0);
          if (goalObj) goalObj.visible = false;
        }

      })();

      // HUD初期化（HTML側が無い場合もあるので安全に）
      setGoalHudText(goalNodeId == null ? "目的地：未選択" : `目的地：${goalNodeId}`);

      console.log("[AR] initialized. markers =", markerRoots.size);

      function animate() {
        requestAnimationFrame(animate);

        if (source && source.ready !== false && context && context.arController) {
          context.update(source.domElement);

          const now = (performance && performance.now) ? performance.now() : Date.now();

          let bestId = null;
          let bestSeen = -Infinity;

          for (const [nodeId, root] of markerRoots.entries()) {
            if (root.visible) {
              lastSeenAt.set(nodeId, now);
              lastMatrix.get(nodeId).copy(root.matrix);
            }
            const seen = lastSeenAt.get(nodeId) ?? -Infinity;
            if (root.visible && seen >= bestSeen) {
              bestSeen = seen;
              bestId = nodeId;
            }
          }

          if (bestId == null) {
            for (const [nodeId, seen] of lastSeenAt.entries()) {
              if ((now - seen) < HOLD_MS && seen > bestSeen) {
                bestSeen = seen;
                bestId = nodeId;
              }
            }
          }

          currentNodeId = bestId;

          if (currentNodeId != null) {
            const stableVisible = (now - (lastSeenAt.get(currentNodeId) ?? -Infinity)) < HOLD_MS;
            if (stableVisible) {
              holdGroup.visible = true;
              holdGroup.matrix.copy(lastMatrix.get(currentNodeId));

              if (goalNodeId == null || !window.Route) {
                const curName = window.Route?.NodeMeta?.[currentNodeId]?.name ?? `Node ${currentNodeId}`;
                setNavText(`ナビ：現在地「${curName}」 / 目的地未選択`);
                arrowGroup.visible = true;
                if (goalObj) goalObj.visible = false;
              } else {
                if (currentNodeId === goalNodeId) {
                  const goalName = window.Route.NodeMeta?.[goalNodeId]?.name ?? `Node ${goalNodeId}`;
                  setNavText(`ナビ：目的地「${goalName}」に到達！`);
                  arrowGroup.visible = false;
                  if (goalObj) { goalObj.visible = true; console.log('[GOAL] showing goalObj'); }
                } else {
                  const path = window.Route.dijkstra(currentNodeId, goalNodeId, true);
                  if (!path) {
                    setNavText("ナビ：同一フロアで経路が見つかりません");
                    arrowGroup.visible = false;
                    if (goalObj) goalObj.visible = false;
                  } else {
                    const next = window.Route.nextNode(path, currentNodeId);
                    if (next == null) {
                      const goalName = window.Route.NodeMeta?.[goalNodeId]?.name ?? `Node ${goalNodeId}`;
                      setNavText(`ナビ：目的地「${goalName}」に到達！`);
                      arrowGroup.visible = false;
                      if (goalObj) { goalObj.visible = true; console.log('[GOAL] showing goalObj'); }
                    } else {
                      const dir = window.Route.dirHintBetween(currentNodeId, next);
                      const nextName = window.Route.NodeMeta?.[next]?.name ?? `Node ${next}`;
                      setNavText(`ナビ：次は「${nextName}」へ`);
                      arrowGroup.visible = true;
                      if (goalObj) goalObj.visible = false;

                      arrowGroup.rotation.x = -Math.PI / 2;
                      applyDirectionToArrow(dir);
                    }
                  }
                }
              }
            } else {
              holdGroup.visible = false;
            }
          } else {
            holdGroup.visible = false;
            if (goalNodeId == null) setNavText("ナビ：目的地を選択してください");
            else setNavText("ナビ：マーカーを映してください");
          }
        }

        renderer.render(scene, camera);
      }

      animate();
    });
  });

  window.addEventListener("resize", onResize);
}

// グローバルにも生やしておく（デバッグ用）
window.AR = AR;

// 二重起動防止：loadで一回だけ起動
window.addEventListener("load", () => {
  if (!window.THREEx || !window.THREE) return;
  AR();
});
