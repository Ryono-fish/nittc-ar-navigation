/*
 ARprocess_refactored_full.js
 --------------------------------
 初期化順序修正版（arController null エラー対策済み）
*/
// ==== Safety guard ====
if (!window.THREEx) {
  console.error("THREEx is not defined. ar-threex.min.js が読み込めていません（404 or 順序ミス）。");
}



let scene, camera, renderer;
let source, context;
let markerRoot;

function AR() {

  // === three.js basic ===
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

  // === AR source ===
  source = new THREEx.ArToolkitSource({
    sourceType: "webcam"
  });

  function onResize() {
    source.onResize();
    source.copySizeTo(renderer.domElement);
    if (context && context.arController) {
      source.copySizeTo(context.arController.canvas);
    }
  }

  source.init(() => {
    onResize();

    // === AR context（source準備後に初期化）===
    context = new THREEx.ArToolkitContext({
      cameraParametersUrl: "camera_para.dat",
      detectionMode: "mono"
    });

    context.init(() => {
  if (!context.arController) return; 
  camera.projectionMatrix.copy(context.getProjectionMatrix());

  setupMarkers(); 
});

  });

  window.addEventListener("resize", onResize);

  // === Marker ===
  markerRoot = new THREE.Group();
  scene.add(markerRoot);

 source.init(() => {
  onResize();

  context = new THREEx.ArToolkitContext({
    cameraParametersUrl: "camera_para.dat",
    detectionMode: "mono"
  });

  context.init(() => {
    camera.projectionMatrix.copy(context.getProjectionMatrix());

    // ★ マーカーはここで作る
    new THREEx.ArMarkerControls(context, markerRoot, {
      type: "pattern",
      patternUrl: "https://raw.githubusercontent.com/AR-js-org/AR.js/master/data/data/patt.hiro",
      size: 1.0
    });
  });
});


  // === Debug Box ===
  const box = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshNormalMaterial()
  );
  markerRoot.add(box);

  // === animate ===
  function animate() {
    requestAnimationFrame(animate);

    if (source.ready !== false && context) {
      context.update(source.domElement);

      // === Hold（見失い吸収）===
      const now = (typeof performance !== \"undefined\" && performance.now) ? performance.now() : Date.now();
      let found = null;
      for (const m of markerGroups) {
        if (m.group.visible) {
          m.lastSeenAt = now;
          m.lastMatrix.copy(m.group.matrix);
          if (found === null) found = m.id;
        }
      }
      for (const m of markerGroups) {
        const stableVisible = (now - m.lastSeenAt) < HOLD_MS;
        if (stableVisible && !m.group.visible) {
          m.group.visible = true;
          m.group.matrix.copy(m.lastMatrix);
        }
      }
      if (found !== currentNode) {
        currentNode = found;
        if (currentNode !== null) console.log(\"[NAV] currentNode =\", currentNode);
      }
      console.log("marker visible:", markerRoot.visible);
    }

    renderer.render(scene, camera);
  }

  animate();
}

window.addEventListener("load", AR);

