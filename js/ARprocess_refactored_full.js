/*
 ARprocess_refactored_full.js
 --------------------------------
 初期化順序修正版（arController null エラー対策済み）
*/

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
  renderer.setClearColor(0x000000, 0);
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
      camera.projectionMatrix.copy(context.getProjectionMatrix());
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
      console.log("marker visible:", markerRoot.visible);
    }

    renderer.render(scene, camera);
  }

  animate();
}

window.addEventListener("load", AR);

