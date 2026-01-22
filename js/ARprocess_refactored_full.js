/*
 ARprocess_refactored_full.js (v2 patch)
 --------------------------------
 ✅ 右上HUD：目的地 / 次の通過地点 / 現在地（読み込むたび更新、次まで保持）
 ✅ 1Fの接続除去：0-3 と 3-6 を切断
 ✅ 追加エッジ：0-1, 3-4, 6-7 を重み 27 で接続
 ✅ 矢印向き：可能ならノード座標から yaw を計算して目的地方向へ回す
*/

if (!window.THREE) console.error("THREE is not defined. three.min.js の読み込み順を確認してください。");
if (!window.THREEx) console.error("THREEx is not defined. ar-threex.min.js が読み込めていません（404 or 順序ミス）。");
if (!window.Route) console.warn("Route is not defined. js/route.js を先に読み込んでください。");

let scene, camera, renderer;
let source, context;

const HOLD_MS = 700;

// true: 同一フロア限定 / false: 全フロア
const SAME_FLOOR_ONLY = false;

const lastSeenAt = new Map(); // nodeId -> time
const lastMatrix = new Map(); // nodeId -> THREE.Matrix4
let currentNodeId = null;
let goalNodeId = null;
let lastReadNodeId = null;

let holdGroup = null;
let arrowGroup = null;

function setNavText(text) {
  const el = document.getElementById("nav");
  if (el) el.textContent = text;
}
function setGoalHudText(text) {
  const el = document.getElementById("goalHud");
  if (el) el.textContent = text;
}
function setNextHudText(text) {
  const el = document.getElementById("nextHud");
  if (el) el.textContent = text;
}
function setCurrentHudText(text) {
  const el = document.getElementById("currentHud");
  if (el) el.textContent = text;
}

window.setGoalNode = function (nodeId) {
  const n = Number(nodeId);
  goalNodeId = Number.isFinite(n) ? n : null;

  if (goalNodeId == null) {
    setNavText("ナビ：目的地を選択してください");
    setGoalHudText("目的地：未選択");
    setNextHudText("次の通過地点：—");
  } else {
    const name = window.Route?.NodeMeta?.[goalNodeId]?.name ?? `Node ${goalNodeId}`;
    setNavText(`ナビ：目的地「${name}」を設定しました。マーカーを映してください`);
    setGoalHudText(`目的地：${name}`);
    setNextHudText("次の通過地点：—");
  }
};

function makeArrowMesh() {
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

  // 水平に寝かせる
  group.rotation.x = -Math.PI / 2;
  group.position.y = 0.08;

  return group;
}

// ===== Route graph patch helpers =====
function addEdgeCompat(a, b, w) {
  const R = window.Route;
  if (!R) return false;

  if (typeof R.addEdge === "function") {
    R.addEdge(a, b, w);
    return true;
  }
  if (Array.isArray(R.adj) && Array.isArray(R.adj[a])) {
    R.adj[a].push({ to: b, cost: w });
    return true;
  }
  if (Array.isArray(R.graph) && Array.isArray(R.graph[a])) {
    R.graph[a][b] = w;
    return true;
  }
  return false;
}

function removeEdgeCompat(a, b) {
  const R = window.Route;
  if (!R) return false;

  let ok = false;

  if (Array.isArray(R.adj) && Array.isArray(R.adj[a])) {
    const before = R.adj[a].length;
    R.adj[a] = R.adj[a].filter(e => e.to !== b);
    ok = ok || (R.adj[a].length !== before);
  }

  if (Array.isArray(R.graph) && Array.isArray(R.graph[a])) {
    if (typeof R.graph[a][b] !== "undefined") {
      R.graph[a][b] = 0; // "no edge" を 0 扱いしている実装が多い
      ok = true;
    }
  }

  if (typeof R.removeEdge === "function") {
    R.removeEdge(a, b);
    ok = true;
  }

  return ok;
}

function applyGraphPatches() {
  const R = window.Route;
  if (!R || R.__graphPatchesApplied) return;

  // 追加エッジ（重み27）
  const addPairs = [
    [0, 1, 27],
    [3, 4, 27],
    [6, 7, 27],
  ];
  for (const [a, b, w] of addPairs) {
    addEdgeCompat(a, b, w);
    addEdgeCompat(b, a, w);
  }

  // 1Fの接続除去：0-3 と 3-6
  const cutPairs = [
    [0, 3],
    [3, 6],
  ];
  for (const [a, b] of cutPairs) {
    removeEdgeCompat(a, b);
    removeEdgeCompat(b, a);
  }

  R.__graphPatchesApplied = true;
  console.log("[Route] graph patches applied (add/cut).");
}

// ===== Arrow direction: use coords if available =====
function getNodePos(id) {
  const m = window.Route?.NodeMeta?.[id];
  if (!m) return null;

  // examples supported: {x,y,z} or {pos:{x,y,z}} or {gx,gy,gz}
  const p = m.pos || m.position || null;
  const x = (p && Number.isFinite(p.x)) ? p.x : (Number.isFinite(m.x) ? m.x : (Number.isFinite(m.gx) ? m.gx : null));
  const y = (p && Number.isFinite(p.y)) ? p.y : (Number.isFinite(m.y) ? m.y : (Number.isFinite(m.gy) ? m.gy : null));
  const z = (p && Number.isFinite(p.z)) ? p.z : (Number.isFinite(m.z) ? m.z : (Number.isFinite(m.gz) ? m.gz : null));

  if (x == null || y == null || z == null) return null;
  return { x, y, z };
}

function applyDirectionToArrowByYaw(curId, nextId) {
  if (!arrowGroup) return false;
  const c = getNodePos(curId);
  const n = getNodePos(nextId);
  if (!c || !n) return false;

  const dx = n.x - c.x;
  const dz = n.z - c.z;
  if (dx === 0 && dz === 0) return false;

  // yaw only (XZ plane)
  const yaw = Math.atan2(dx, dz);

  arrowGroup.rotation.x = -Math.PI / 2;
  arrowGroup.rotation.y = yaw;
  return true;
}

function applyDirectionToArrowByDirHint(dir) {
  if (!arrowGroup) return;
  arrowGroup.rotation.x = -Math.PI / 2;
  arrowGroup.rotation.y = 0;

  switch (dir) {
    case 0: arrowGroup.rotation.y = 0; break;
    case 1: arrowGroup.rotation.y = -Math.PI / 2; break;
    case 2: arrowGroup.rotation.y = Math.PI; break;
    case 3: arrowGroup.rotation.y = Math.PI / 2; break;
    default: break;
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

    context = new THREEx.ArToolkitContext({
      cameraParametersUrl: "camera_para.dat",
      detectionMode: "mono"
    });

    context.init(() => {
      if (!context.arController) return;

      camera.projectionMatrix.copy(context.getProjectionMatrix());

      // Apply graph patches once Route is available
      applyGraphPatches();

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

      holdGroup = new THREE.Group();
      holdGroup.matrixAutoUpdate = false;
      holdGroup.visible = false;
      scene.add(holdGroup);

      arrowGroup = makeArrowMesh();
      holdGroup.add(arrowGroup);

      setGoalHudText(goalNodeId == null ? "目的地：未選択" : `目的地：${goalNodeId}`);
      setNextHudText("次の通過地点：—");
      setCurrentHudText("現在地：—");

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

          // マーカーを「読み込んだ」タイミングでHUD更新（保持）
          if (currentNodeId != null) {
            const isVisibleNow = (markerRoots.get(currentNodeId)?.visible === true);
            if (isVisibleNow && lastReadNodeId !== currentNodeId) {
              lastReadNodeId = currentNodeId;
              const curName = window.Route?.NodeMeta?.[currentNodeId]?.name ?? `Node ${currentNodeId}`;
              setCurrentHudText(`現在地：${curName}`);
            }
          }

          if (currentNodeId != null) {
            const stableVisible = (now - (lastSeenAt.get(currentNodeId) ?? -Infinity)) < HOLD_MS;
            if (stableVisible) {
              holdGroup.visible = true;
              holdGroup.matrix.copy(lastMatrix.get(currentNodeId));

              if (goalNodeId == null || !window.Route) {
                const curName = window.Route?.NodeMeta?.[currentNodeId]?.name ?? `Node ${currentNodeId}`;
                setNavText(`ナビ：現在地「${curName}」 / 目的地未選択`);
                setNextHudText("次の通過地点：—");
              } else {
                if (currentNodeId === goalNodeId) {
                  const goalName = window.Route.NodeMeta?.[goalNodeId]?.name ?? `Node ${goalNodeId}`;
                  setNavText(`ナビ：目的地「${goalName}」に到達！`);
                  setNextHudText("次の通過地点：GOAL");
                } else {
                  const path = window.Route.dijkstra(currentNodeId, goalNodeId, SAME_FLOOR_ONLY);
                  if (!path) {
                    setNavText("ナビ：経路が見つかりません");
                    setNextHudText("次の通過地点：—");
                  } else {
                    const next = window.Route.nextNode(path, currentNodeId);
                    if (next == null) {
                      const goalName = window.Route.NodeMeta?.[goalNodeId]?.name ?? `Node ${goalNodeId}`;
                      setNavText(`ナビ：目的地「${goalName}」に到達！`);
                      setNextHudText("次の通過地点：GOAL");
                    } else {
                      const nextName = window.Route.NodeMeta?.[next]?.name ?? `Node ${next}`;
                      setNavText(`ナビ：次は「${nextName}」へ`);
                      setNextHudText(`次の通過地点：${nextName}`);

                      // 向き：座標が取れるなら yaw、無理なら dirHint
                      const ok = applyDirectionToArrowByYaw(currentNodeId, next);
                      if (!ok && typeof window.Route.dirHintBetween === "function") {
                        const dir = window.Route.dirHintBetween(currentNodeId, next);
                        applyDirectionToArrowByDirHint(dir);
                      }
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

  window.addEventListener("resize", () => {
    // onResize is inside AR(); keep simple by reloading sizes via source hooks if possible
    // (This minimal handler avoids breaking if source isn't ready)
    try {
      if (!source) return;
      if (typeof source.onResizeElement === "function") source.onResizeElement();
      else source.onResize();
      if (renderer) {
        if (typeof source.copyElementSizeTo === "function") source.copyElementSizeTo(renderer.domElement);
        else source.copySizeTo(renderer.domElement);
      }
      if (context && context.arController) {
        if (typeof source.copyElementSizeTo === "function") source.copyElementSizeTo(context.arController.canvas);
        else source.copySizeTo(context.arController.canvas);
      }
    } catch(e) {}
  });
}

window.AR = AR;
window.addEventListener("load", () => {
  if (!window.THREEx || !window.THREE) return;
  AR();
});
