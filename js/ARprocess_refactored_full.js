
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

// ===== models (local files) =====
const MODEL_ARROW = "models/nav_arrow.glb";
const MODEL_GOAL  = "models/goal_pin.glb";


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

function setModelStatus(msg){
  const el = document.getElementById('nav');
  if (el) el.textContent = msg;
}

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


function loadGLBMinimal(url, label) {
  // Minimal GLB (glTF 2.0) loader for simple meshes (no textures/skins).
  // Returns THREE.Group.
  return new Promise(async (resolve, reject) => {
    try {
      const bustUrl = url + (url.includes("?") ? "&" : "?") + "v=" + Date.now();
      const res = await fetch(bustUrl, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status} while fetching ${bustUrl}`);
      const arrayBuffer = await res.arrayBuffer();

      const u8 = new Uint8Array(arrayBuffer);
      const magic = String.fromCharCode(u8[0]||0, u8[1]||0, u8[2]||0, u8[3]||0);
      const dv = new DataView(arrayBuffer);
      const version = dv.getUint32(4, true);
      const totalLen = dv.getUint32(8, true);
      console.log("[MODEL] fetch:", { label, url: bustUrl, status: res.status, type: res.headers.get("content-type"), byteLength: u8.byteLength, magic, version, totalLen });

      if (magic !== "glTF") throw new Error(`Not a GLB (magic=${magic})`);
      if (version !== 2) throw new Error(`Unsupported GLB version ${version}`);
      if (totalLen !== u8.byteLength) throw new Error(`Truncated GLB (headerLen=${totalLen}, got=${u8.byteLength})`);

      // Parse chunks
      let offset = 12;
      let jsonChunk = null;
      let binChunk = null;
      while (offset + 8 <= u8.byteLength) {
        const chunkLen  = dv.getUint32(offset, true);
        const chunkType = dv.getUint32(offset + 4, true);
        offset += 8;
        const chunkData = u8.slice(offset, offset + chunkLen);
        offset += chunkLen;

        if (chunkType === 0x4E4F534A) jsonChunk = chunkData;       // JSON
        else if (chunkType === 0x004E4942) binChunk = chunkData;  // BIN
      }
      if (!jsonChunk) throw new Error("GLB missing JSON chunk");

      const gltf = JSON.parse(new TextDecoder("utf-8").decode(jsonChunk));
      const binBuf = binChunk ? binChunk.buffer.slice(binChunk.byteOffset, binChunk.byteOffset + binChunk.byteLength) : null;

      if ((gltf.extensionsRequired && gltf.extensionsRequired.length) || (gltf.extensionsUsed && gltf.extensionsUsed.length)) {
        // If compressed extensions are used, this minimal loader can't decode them.
        const used = gltf.extensionsUsed || [];
        const req = gltf.extensionsRequired || [];
        const list = Array.from(new Set([...used, ...req]));
        if (list.length) {
          throw new Error("Unsupported glTF extensions: " + list.join(", "));
        }
      }

      function accessorTypedArray(accessorIndex) {
        const acc = gltf.accessors[accessorIndex];
        const bv = gltf.bufferViews[acc.bufferView];
        const byteOffset = (bv.byteOffset || 0) + (acc.byteOffset || 0);
        const count = acc.count;

        const compType = acc.componentType;
        const type = acc.type;

        const typeToNum = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
        const numComp = typeToNum[type];
        if (!numComp) throw new Error(`Unsupported accessor type ${type}`);

        let ArrayType;
        if (compType === 5126) ArrayType = Float32Array;
        else if (compType === 5123) ArrayType = Uint16Array;
        else if (compType === 5125) ArrayType = Uint32Array;
        else if (compType === 5121) ArrayType = Uint8Array;
        else throw new Error(`Unsupported componentType ${compType}`);

        const elemSize = ArrayType.BYTES_PER_ELEMENT * numComp;

        if (bv.byteStride && bv.byteStride !== elemSize) {
          // Strided data: copy to packed array
          const out = new ArrayType(count * numComp);
          const view = new DataView(binBuf, byteOffset, count * bv.byteStride);
          for (let i = 0; i < count; i++) {
            const base = i * bv.byteStride;
            for (let c = 0; c < numComp; c++) {
              const bo = base + c * ArrayType.BYTES_PER_ELEMENT;
              let v;
              if (ArrayType === Float32Array) v = view.getFloat32(bo, true);
              else if (ArrayType === Uint16Array) v = view.getUint16(bo, true);
              else if (ArrayType === Uint32Array) v = view.getUint32(bo, true);
              else v = view.getUint8(bo);
              out[i * numComp + c] = v;
            }
          }
          return out;
        }

        return new ArrayType(binBuf, byteOffset, count * numComp);
      }

      function buildMesh(primitive) {
        const geom = new THREE.BufferGeometry();

        const attrs = primitive.attributes || {};
        if (attrs.POSITION != null) {
          const arr = accessorTypedArray(attrs.POSITION);
          if (geom.setAttribute) {
          geom.setAttribute("position", new THREE.BufferAttribute(arr, 3));
        } else {
          geom.addAttribute("position", new THREE.BufferAttribute(arr, 3));
        }
        } else {
          throw new Error("Primitive missing POSITION");
        }
        if (attrs.NORMAL != null) {
          const arr = accessorTypedArray(attrs.NORMAL);
          if (geom.setAttribute) {
          geom.setAttribute("normal", new THREE.BufferAttribute(arr, 3));
        } else {
          geom.addAttribute("normal", new THREE.BufferAttribute(arr, 3));
        }
        } else {
          geom.computeVertexNormals();
        }
        if (primitive.indices != null) {
          const idxArr = accessorTypedArray(primitive.indices);
          if (geom.setIndex) {
          geom.setIndex(new THREE.BufferAttribute(idxArr, 1));
        } else {
          geom.addAttribute("index", new THREE.BufferAttribute(idxArr, 1));
        }
        }

        geom.computeBoundingSphere();

        const mat = new THREE.MeshNormalMaterial();
        return new THREE.Mesh(geom, mat);
      }

      function buildNode(nodeIndex) {
        const nodeDef = gltf.nodes[nodeIndex];
        const nodeObj = new THREE.Group();
        nodeObj.name = nodeDef.name || `node_${nodeIndex}`;
        if (nodeDef.translation) nodeObj.position.fromArray(nodeDef.translation);
        if (nodeDef.rotation) nodeObj.quaternion.fromArray(nodeDef.rotation);
        if (nodeDef.scale) nodeObj.scale.fromArray(nodeDef.scale);

        if (nodeDef.mesh != null) {
          const meshDef = gltf.meshes[nodeDef.mesh];
          for (const prim of (meshDef.primitives || [])) nodeObj.add(buildMesh(prim));
        }
        if (nodeDef.children) for (const c of nodeDef.children) nodeObj.add(buildNode(c));
        return nodeObj;
      }

      const group = new THREE.Group();
      const sceneIndex = gltf.scene ?? 0;
      const sceneDef = gltf.scenes?.[sceneIndex];
      if (!sceneDef) throw new Error("No default scene in glTF");
      for (const n of (sceneDef.nodes || [])) group.add(buildNode(n));

      resolve(group);
    } catch (e) {
      reject(e);
    }
  });
}

function makeArrowMesh() {
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
      // fallback primitive arrow
      (function(){
        const g = new THREE.Group();
        const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.07,0.07,0.6,12), new THREE.MeshNormalMaterial());
        shaft.position.y = 0.3;
        g.add(shaft);
        const head = new THREE.Mesh(new THREE.ConeGeometry(0.16,0.25,16), new THREE.MeshNormalMaterial());
        head.position.y = 0.75;
        g.add(head);
        g.position.y = 0.1;
        arrowGroup.add(g);
      })();



      // ===== load models (minimal loader). If fails, keep fallback arrow mesh. =====
      (async () => {
        try {
          arrowVisual = await loadGLBMinimal(MODEL_ARROW, "arrow");
          arrowVisual.position.set(0, 0, 0);
          arrowVisual.rotation.set(0, 0, 0);
          arrowVisual.scale.set(1, 1, 1);
          // Remove fallback geometry children if any
          arrowGroup.clear();
          arrowGroup.add(arrowVisual);
          console.log("[MODEL] arrow loaded:", MODEL_ARROW);
        } catch (e) {
          console.warn("[MODEL] arrow load failed:", e);
          // keep fallback arrow mesh (cylinder+cone) to not break navigation visibility
          setNavText("モデル読込失敗：矢印（fallbackで表示）");
        }

        try {
          goalPin = await loadGLBMinimal(MODEL_GOAL, "goal");
          goalPin.position.set(0, 0.15, 0);
          goalPin.rotation.set(0, 0, 0);
          goalPin.scale.set(1, 1, 1);
          goalPin.visible = false;
          holdGroup.add(goalPin);
          console.log("[MODEL] goal loaded:", MODEL_GOAL);
        } catch (e) {
          console.warn("[MODEL] goal load failed:", e);
          setNavText("モデル読込失敗：GOAL（文字のみ）");
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
