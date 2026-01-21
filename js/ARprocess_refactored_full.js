/*
 ARprocess_refactored_full.js
 --------------------------------
 ✅ SyntaxError 対策：ファイル中に紛れた「...」などの無効トークンを排除
 ✅ スマホで判定が厳しい対策：ホールド（見失っても一定時間表示を保持）を実装
 ✅ 初期化順序：ArToolkitSource → ArToolkitContext → getProjectionMatrix → MarkerControls
*/

// ==== Safety guard ====
if (!window.THREE) {
  console.error("THREE is not defined. three.min.js の読み込み順を確認してください。");
}
if (!window.THREEx) {
  console.error("THREEx is not defined. ar-threex.min.js が読み込めていません（404 or 順序ミス）。");
}

let scene, camera, renderer;
let source, context;
let markerRoot;

// 表示安定化（見失っても一定時間は表示を保持）
const HOLD_MS = 700; // 500〜900 で調整
let lastSeenAt = 0;
const lastMatrix = new THREE.Matrix4();

// マーカーが見えなくなっても表示するためのホールド用グループ
let holdGroup = null;

// ★ ここをあなたの patt に合わせて変更してください（例: patt/M1F.patt）
// Hiroマーカーを使う場合：patt/hiro.patt を用意するか、下の URL をあなたの環境に合わせてください。
const PATTERN_URL = "patt/M1F.patt";

function AR() {
  // === three.js basic ===
  scene = new THREE.Scene();

  camera = new THREE.Camera();
  scene.add(camera);

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(window.devicePixelRatio || 1);
  renderer.setClearColor(0x000000, 0);

  // Androidで重なり順が崩れる対策
  renderer.domElement.style.position = "absolute";
  renderer.domElement.style.top = "0px";
  renderer.domElement.style.left = "0px";
  renderer.domElement.style.zIndex = "2";

  document.body.appendChild(renderer.domElement);

  const light = new THREE.DirectionalLight(0xffffff);
  light.position.set(0, 0, 2);
  scene.add(light);

  // === AR.js source ===
  source = new THREEx.ArToolkitSource({ sourceType: "webcam" });

  function onResize() {
    if (typeof source.onResizeElement === "function") {
      source.onResizeElement();
    } else {
      source.onResize();
    }

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

    // === AR.js context ===
    context = new THREEx.ArToolkitContext({
      cameraParametersUrl: "camera_para.dat",
      detectionMode: "mono"
    });

    context.init(() => {
      if (!context.arController) return;

      camera.projectionMatrix.copy(context.getProjectionMatrix());

      // === Marker root (検出用) ===
      markerRoot = new THREE.Group();
      markerRoot.matrixAutoUpdate = false;
      scene.add(markerRoot);

      new THREEx.ArMarkerControls(context, markerRoot, {
        type: "pattern",
        patternUrl: PATTERN_URL,
        size: 1.0
      });

      // === Hold group（描画用：ここに箱を置く）===
      holdGroup = new THREE.Group();
      holdGroup.matrixAutoUpdate = false;
      holdGroup.visible = false;
      scene.add(holdGroup);

      const box = new THREE.Mesh(
        new THREE.BoxGeometry(1.2, 1.2, 1.2), // 少し大きめ
        new THREE.MeshNormalMaterial()
      );
      holdGroup.add(box);

      console.log("[AR] initialized. pattern =", PATTERN_URL);
    });
  });

  window.addEventListener("resize", onResize);

  // === animate ===
  function animate() {
    requestAnimationFrame(animate);

    if (source && source.ready !== false && context && context.arController) {
      context.update(source.domElement);

      // 判定ログ（必要なら）
      // console.log("marker visible:", markerRoot && markerRoot.visible);

      const now = (performance && performance.now) ? performance.now() : Date.now();

      if (markerRoot && markerRoot.visible) {
        lastSeenAt = now;
        lastMatrix.copy(markerRoot.matrix);
        if (holdGroup) {
          holdGroup.visible = true;
          holdGroup.matrix.copy(lastMatrix);
        }
      } else {
        // 見失っても HOLD_MS の間は表示を維持
        const stableVisible = (now - lastSeenAt) < HOLD_MS;
        if (holdGroup) {
          holdGroup.visible = stableVisible;
          if (stableVisible) holdGroup.matrix.copy(lastMatrix);
        }
      }
    }

    renderer.render(scene, camera);
  }

  animate();
}

window.addEventListener("load", AR);
