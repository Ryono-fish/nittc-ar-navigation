/*
 ARprocess_refactored_full.js (v3 fix)
 - Route.NodeMeta の x,y,z を使用して矢印のyawを算出
 - ゴール到達時は矢印を消す（演出は後で差し替え可能）
 - HUD（目的地/次/現在地）更新＆保持
*/

let scene, camera, renderer;
let source, context;

const HOLD_MS = 700;
const SAME_FLOOR_ONLY = false;

// グリッド座標 → AR yaw へのオフセット（必要なら 0, ±Math.PI/2, Math.PI などで調整）
const YAW_OFFSET = 0;

const lastSeenAt = new Map();
const lastMatrix = new Map();
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

  // 地面に水平
  group.rotation.x = -Math.PI / 2;
  group.position.y = 0.08;

  return group;
}

function getNodePos(id) {
  const m = window.Route?.NodeMeta?.[id];
  if (!m) return null;
  const x = Number(m.x), y = Number(m.y), z = Number(m.z);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  return { x, y, z };
}

function applyYawFromPos(curId, nextId) {
  if (!arrowGroup) return false;
  const c = getNodePos(curId);
  const n = getNodePos(nextId);
  if (!c || !n) return false;

  const dx = n.x - c.x;
  const dy = n.y - c.y;

  if (dx === 0 && dy === 0) return false;

  // グリッドの「上」は y-1。つまり前方向は -dy。
  // yaw: 0 を「上（y-1）」に合わせるなら atan2(dx, -dy)
  const yaw = Math.atan2(dx, -dy) + YAW_OFFSET;

  arrowGroup.rotation.x = -Math.PI / 2;
  arrowGroup.rotation.y = yaw;
  return true;
}

function applyDirectionByDirHint(dir) {
  if (!arrowGroup) return;
  arrowGroup.rotation.x = -Math.PI / 2;
  arrowGroup.rotation.y = 0;

  // vecのdirに合わせる（Route.vec: 0=上(y-1), 1=右(x+1), 2=下(y+1), 3=左(x-1)）
  switch (dir) {
    case 0: arrowGroup.rotation.y = 0 + YAW_OFFSET; break;
    case 1: arrowGroup.rotation.y = -Math.PI / 2 + YAW_OFFSET; break;
    case 2: arrowGroup.rotation.y = Math.PI + YAW_OFFSET; break;
    case 3: arrowGroup.rotation.y = Math.PI / 2 + YAW_OFFSET; break;
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

      arrowGroup = makeArrowMesh();
      holdGroup.add(arrowGroup);

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

          // 現在地HUD：新しいマーカーが「見えた瞬間」に更新し、次まで保持
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
                arrowGroup.visible = true;
              } else if (currentNodeId === goalNodeId) {
                const goalName = window.Route.NodeMeta?.[goalNodeId]?.name ?? `Node ${goalNodeId}`;
                setNavText(`ナビ：目的地「${goalName}」に到達！`);
                setNextHudText("次の通過地点：GOAL");
                arrowGroup.visible = false; // ゴールでは矢印を出さない
              } else {
                const path = window.Route.dijkstra(currentNodeId, goalNodeId, SAME_FLOOR_ONLY);
                if (!path) {
                  setNavText("ナビ：経路が見つかりません");
                  setNextHudText("次の通過地点：—");
                  arrowGroup.visible = false;
                } else {
                  const next = window.Route.nextNode(path, currentNodeId);
                  if (next == null) {
                    const goalName = window.Route.NodeMeta?.[goalNodeId]?.name ?? `Node ${goalNodeId}`;
                    setNavText(`ナビ：目的地「${goalName}」に到達！`);
                    setNextHudText("次の通過地点：GOAL");
                    arrowGroup.visible = false;
                  } else {
                    const nextName = window.Route.NodeMeta?.[next]?.name ?? `Node ${next}`;
                    setNavText(`ナビ：次は「${nextName}」へ`);
                    setNextHudText(`次の通過地点：${nextName}`);
                    arrowGroup.visible = true;

                    const ok = applyYawFromPos(currentNodeId, next);
                    if (!ok && typeof window.Route.dirHintBetween === "function") {
                      const dir = window.Route.dirHintBetween(currentNodeId, next);
                      if (dir != null) applyDirectionByDirHint(dir);
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

window.addEventListener("load", AR);
