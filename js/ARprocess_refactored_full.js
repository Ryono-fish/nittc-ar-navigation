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
let goalObj = null; // ★ GOAL演出

function setNavText(text) {
  const el = document.getElementById("nav");
  if (el) el.textContent = text;
}

// 目的地セット（HTMLから呼ばれる）
window.setGoalNode = function (nodeId) {
  // ★ 文字列でも数値化して保持（改善1）
  const n = Number(nodeId);
  goalNodeId = Number.isFinite(n) ? n : null;

  if (goalNodeId == null) {
    setNavText("ナビ：目的地を選択してください");
  } else {
    const name = window.Route?.NodeMeta?.[goalNodeId]?.name ?? `Node ${goalNodeId}`;
    setNavText(`ナビ：目的地「${name}」を設定しました。マーカーを映してください`);
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

  // ★ 矢印を地面に水平に寝かせる（改善3）
  // もともとY方向に伸びてるので、X軸に-90°回してXZ平面に寝かせる
  group.rotation.x = -Math.PI / 2;

  // 全体を少し浮かせる（地面に埋まるの防止）
  group.position.y = 0.08;

  return group;
}

function makeGoalSprite() {
  // ★ 軽い GOAL 演出（Sprite）
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 256;
  const ctx = canvas.getContext("2d");

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "rgba(0,0,0,0.45)";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.font = "bold 120px sans-serif";
  ctx.fillStyle = "white";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("GOAL", canvas.width / 2, canvas.height / 2);

  const texture = new THREE.CanvasTexture(canvas);
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true });
  const sprite = new THREE.Sprite(material);

  sprite.scale.set(1.2, 0.6, 1);
  sprite.position.set(0, 0.35, 0); // 少し上に
  sprite.visible = false;
  return sprite;
}

function applyDirectionToArrow(dir) {
  if (!arrowGroup) return;

  // 到着などで方向無しなら何もしない
  if (dir == null) return;

  // ★ 矢印は「寝かせた状態」を維持しつつ、Y回転だけ変える（改善3）
  // いったんY回転だけ初期化
  arrowGroup.rotation.y = 0;

  // GS.cppのdirec/dirHint: 0上 1右 2下 3左 4下階 5上階
  // ※同一フロア限定なら 0〜3 だけでOK。4/5は将来用に残す。
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
    case 5: // 上階（演出用：少し立てる）
      arrowGroup.rotation.x = -Math.PI / 2 - Math.PI / 6;
      break;
    case 4: // 下階（演出用：少し立てる）
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

  // --- AR.js source ---
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

    // --- AR.js context ---
    context = new THREEx.ArToolkitContext({
      cameraParametersUrl: "camera_para.dat",
      detectionMode: "mono"
    });

    context.init(() => {
      if (!context.arController) return;

      camera.projectionMatrix.copy(context.getProjectionMatrix());

      // --- マーカーを全部登録 ---
      const markerMap = window.Route?.MarkerMap || {};
      const ids = Object.values(markerMap);

      // nodeId -> markerRoot
      const markerRoots = new Map();

      for (const nodeId of ids) {
        const root = new THREE.Group();
        root.matrixAutoUpdate = false;
        root.visible = false;
        scene.add(root);
        markerRoots.set(nodeId, root);
        lastMatrix.set(nodeId, new THREE.Matrix4());

        // pattファイル名を探す（MarkerMapは patt名→id なので逆引き）
        const pattName = Object.keys(markerMap).find(k => markerMap[k] === nodeId);
        if (!pattName) continue;

        new THREEx.ArMarkerControls(context, root, {
          type: "pattern",
          patternUrl: "patt/" + pattName,
          size: 1.0
        });
      }

      // --- 表示（ホールド） ---
      holdGroup = new THREE.Group();
      holdGroup.matrixAutoUpdate = false;
      holdGroup.visible = false;
      scene.add(holdGroup);

      arrowGroup = makeArrowMesh();
      holdGroup.add(arrowGroup);

      // ★ GOAL 演出
      goalObj = makeGoalSprite();
      holdGroup.add(goalObj);

      console.log("[AR] initialized. markers =", markerRoots.size);

      // --- animate ---
      function animate() {
        requestAnimationFrame(animate);

        if (source && source.ready !== false && context && context.arController) {
          context.update(source.domElement);

          const now = (performance && performance.now) ? performance.now() : Date.now();

          // 現在見えているマーカーを選ぶ（最後に見えたもの優先）
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

          // 見えてない場合は「ホールド中の候補」から選ぶ
          if (bestId == null) {
            for (const [nodeId, seen] of lastSeenAt.entries()) {
              if ((now - seen) < HOLD_MS && seen > bestSeen) {
                bestSeen = seen;
                bestId = nodeId;
              }
            }
          }

          currentNodeId = bestId;

          // 表示更新
          if (currentNodeId != null) {
            const stableVisible = (now - (lastSeenAt.get(currentNodeId) ?? -Infinity)) < HOLD_MS;
            if (stableVisible) {
              holdGroup.visible = true;
              holdGroup.matrix.copy(lastMatrix.get(currentNodeId));

              // 目的地未選択
              if (goalNodeId == null || !window.Route) {
                const curName = window.Route?.NodeMeta?.[currentNodeId]?.name ?? `Node ${currentNodeId}`;
                setNavText(`ナビ：現在地「${curName}」 / 目的地未選択`);
                arrowGroup.visible = true;
                goalObj.visible = false;
              } else {
                // ★ 到着判定（改善2）
                if (currentNodeId === goalNodeId) {
                  const goalName = window.Route.NodeMeta?.[goalNodeId]?.name ?? `Node ${goalNodeId}`;
                  setNavText(`ナビ：目的地「${goalName}」に到達！`);
                  arrowGroup.visible = false;
                  goalObj.visible = true;
                } else {
                  // ナビ計算（同一フロア限定）
                  const path = window.Route.dijkstra(currentNodeId, goalNodeId, true);
                  if (!path) {
                    setNavText("ナビ：同一フロアで経路が見つかりません");
                    arrowGroup.visible = false;
                    goalObj.visible = false;
                  } else {
                    const next = window.Route.nextNode(path, currentNodeId);
                    if (next == null) {
                      // 念のため（到着扱い）
                      const goalName = window.Route.NodeMeta?.[goalNodeId]?.name ?? `Node ${goalNodeId}`;
                      setNavText(`ナビ：目的地「${goalName}」に到達！`);
                      arrowGroup.visible = false;
                      goalObj.visible = true;
                    } else {
                      const dir = window.Route.dirHintBetween(currentNodeId, next);
                      const nextName = window.Route.NodeMeta?.[next]?.name ?? `Node ${next}`;
                      setNavText(`ナビ：次は「${nextName}」へ`);
                      arrowGroup.visible = true;
                      goalObj.visible = false;

                      // 矢印は水平のままY回転で方向を示す
                      // （階移動dirは演出で少し傾ける）
                      // 寝かせ角度が変わる可能性があるのでここで補正
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

// ★ 二重起動防止：loadで一回だけ起動
window.addEventListener("load", () => {
  // THREExが無い場合は起動しても落ちるので止める
  if (!window.THREEx || !window.THREE) return;
  AR();
});
