
/*
 ARprocess_refactored_full.js (world-yaw fix)
 ------------------------------------------------
 Fix: Arrow orientation was constant because it was applied in marker-local space.
 Solution:
  - Compute world yaw from node coordinates (x,y grid)
  - Subtract marker yaw so arrow faces correct world direction
*/

let scene, camera, renderer;
let source, context;

const HOLD_MS = 700;
const SAME_FLOOR_ONLY = false;

// Adjust if your printed marker "front" differs from grid up-direction
const YAW_OFFSET = 0;

// ===== glb models =====
const MODEL_ARROW = new URL("models/nav_arrow.glb", window.location.href).href;
const MODEL_GOAL  = new URL("models/goal_pin.glb", window.location.href).href;


const lastSeenAt = new Map();
const lastMatrix = new Map();
let currentNodeId = null;
let goalNodeId = null;
let lastReadNodeId = null;

let holdGroup = null;
let yawCorrector = null;
let arrowGroup = null;
let arrowVisual = null;
let goalPin = null;

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
    setGoalHudText("目的地：未選択");
    setNextHudText("次の通過地点：—");
    setNavText("ナビ：目的地を選択してください");
  } else {
    const name = window.Route?.NodeMeta?.[goalNodeId]?.name ?? `Node ${goalNodeId}`;
    setGoalHudText(`目的地：${name}`);
    setNextHudText("次の通過地点：—");
    setNavText(`ナビ：目的地「${name}」を設定しました。マーカーを映してください`);
  }
};

function loadGLB(url) {
  return new Promise(async (resolve, reject) => {
    try {
      if (!THREE || !THREE.GLTFLoader) {
        reject(new Error("THREE.GLTFLoader is not available. Check GLTFLoader script include."));
        return;
      }
      // Fetch as ArrayBuffer (avoids responseType/caching quirks)
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) {
        reject(new Error(`HTTP ${res.status} while fetching ${url}`));
        return;
      }
      const arrayBuffer = await res.arrayBuffer();

      const loader = new THREE.GLTFLoader();
      const basePath = url.replace(/[^\/]*$/, "");
      loader.parse(arrayBuffer, basePath, (gltf) => resolve(gltf), (err) => reject(err));
    } catch (e) {
      reject(e);
    }
  });
}

function makeArrowMesh() {
  // Container group rotated to lie flat on marker plane.
  // The loaded glb arrow will be attached under this group as 'arrowVisual'.
  const group = new THREE.Group();
  group.rotation.x = -Math.PI / 2;
  group.position.y = 0.08;
  return group;
}

function getNodePos(id) {
  const m = window.Route?.NodeMeta?.[id];
  if (!m) return null;
  const x = Number(m.x), y = Number(m.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

// Compute desired world yaw from grid coordinates
function computeWorldYaw(curId, nextId) {
  const c = getNodePos(curId);
  const n = getNodePos(nextId);
  if (!c || !n) return null;

  const dx = n.x - c.x;
  const dy = n.y - c.y;

  if (dx === 0 && dy === 0) return null;

  // Grid: up is y-1, so forward vector is (0,-1)
  return Math.atan2(-dx, -dy) + YAW_OFFSET;
}

// Extract marker yaw from holdGroup.matrix (world transform of marker)
function getMarkerYaw() {
  const m = new THREE.Matrix4();
  m.copy(holdGroup.matrix);
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const scl = new THREE.Vector3();
  m.decompose(pos, quat, scl);
  const e = new THREE.Euler().setFromQuaternion(quat, "YXZ");
  return e.y;
}

function AR() {
  scene = new THREE.Scene();
  camera = new THREE.Camera();
  scene.add(camera);

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(window.devicePixelRatio || 1);
  renderer.setClearColor(0x000000, 0);
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
      camera.projectionMatrix.copy(context.getProjectionMatrix());

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

      // yawCorrector removes marker yaw, arrowGroup applies world yaw
      yawCorrector = new THREE.Group();
      yawCorrector.rotation.set(0, 0, 0);
      holdGroup.add(yawCorrector);

      arrowGroup = makeArrowMesh();
      yawCorrector.add(arrowGroup);


      // ===== load glb models (arrow + goal) =====
      (async () => {
        try {
          const gltfArrow = await loadGLB(MODEL_ARROW);
          arrowVisual = gltfArrow.scene || (gltfArrow.scenes && gltfArrow.scenes[0]);
          if (arrowVisual) {
            arrowVisual.position.set(0, 0, 0);
            arrowVisual.rotation.set(0, 0, 0);
            arrowVisual.scale.set(1, 1, 1);
            arrowGroup.add(arrowVisual);
          }
          console.log("[MODEL] arrow loaded:", MODEL_ARROW);
        } catch (e) {
          console.warn("[MODEL] arrow load failed:", e);
        }

        try {
          const gltfGoal = await loadGLB(MODEL_GOAL);
          goalPin = gltfGoal.scene || (gltfGoal.scenes && gltfGoal.scenes[0]);
          if (goalPin) {
            goalPin.position.set(0, 0.15, 0);
            goalPin.rotation.set(0, 0, 0);
            goalPin.scale.set(1, 1, 1);
            goalPin.visible = false;
            holdGroup.add(goalPin);
          }
          console.log("[MODEL] goal loaded:", MODEL_GOAL);
        } catch (e) {
          console.warn("[MODEL] goal load failed:", e);
        }
      })();


      setGoalHudText(goalNodeId == null ? "目的地：未選択" : `目的地：${goalNodeId}`);
      setNextHudText("次の通過地点：—");
      setCurrentHudText("現在地：—");

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
          // 現在地HUD：新しく認識されたマーカーで更新（次に別マーカーを見るまで保持）
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

              if (goalNodeId != null && window.Route) {
                if (currentNodeId === goalNodeId) {
                  arrowGroup.visible = false;
                  if (goalPin) goalPin.visible = true;
                  setNextHudText("次の通過地点：GOAL");
                  setNavText("ナビ：目的地に到達！");
                } else {
                  const path = window.Route.dijkstra(currentNodeId, goalNodeId, SAME_FLOOR_ONLY);
                  if (path) {
                    const next = window.Route.nextNode(path, currentNodeId);
                    if (next != null) {
                      arrowGroup.visible = true;
                if (goalPin) goalPin.visible = false;
                      if (goalPin) goalPin.visible = false;
                      const worldYaw = computeWorldYaw(currentNodeId, next);
                      if (worldYaw != null) {
                        const markerYaw = getMarkerYaw();
                        // Remove marker yaw, then apply world yaw
                        yawCorrector.rotation.y = -markerYaw + worldYaw;
                      }
                      const nextName = window.Route.NodeMeta?.[next]?.name ?? `Node ${next}`;
                      setNextHudText(`次の通過地点：${nextName}`);
                      setNavText(`ナビ：次は「${nextName}」へ`);
                    }
                  }
                }
              } else {
                arrowGroup.visible = true;
                if (goalPin) goalPin.visible = false;
              }
            } else {
              holdGroup.visible = false;
            }
          } else {
            holdGroup.visible = false;
            setNavText("ナビ：マーカーを映してください");
          }
        }

        renderer.render(scene, camera);
      }

      animate();
    });
  });

  window.addEventListener("resize", onResize);
}

window.addEventListener("load", AR);
