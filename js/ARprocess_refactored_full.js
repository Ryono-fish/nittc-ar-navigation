/*
 ARprocess_refactored_full.js
 --------------------------------
 スマホでも安定するように初期化順序を整理した版

 ポイント
 - AR() は二重起動しない（ガード付き）
 - ArToolkitSource → ArToolkitContext の順で初期化
 - getProjectionMatrix() / ArMarkerControls は arController 準備後（context.init callback内）で実行
 - resize は新API（onResizeElement/copyElementSizeTo）優先、なければ旧APIにフォールバック
 - HTMLから window.setGoalNode(id) を呼べる（目的地選択用）
*/

let scene, camera, renderer;
let source, context;

// マーカー検出用（複数マーカー対応）
const markerGroups = []; // { id, patt, group }

// 状態
let started = false;
let currentNode = null;
let goalNode = null;

// HTML側から目的地を設定するための関数
window.setGoalNode = function (id) {
  goalNode = (id === null || id === undefined || id === "") ? null : Number(id);
  console.log("[NAV] goalNode =", goalNode);
};

// pattファイル一覧（あなたの対応表に基づく）
// ※ CI2F / CI3F は、実ファイル名が C12F / C13F などの場合があります。
//    もしマーカーが認識しない場合は、pattフォルダ内の実ファイル名に合わせてここを直してください。
const MARKERS = [
  { id: 0,  patt: "patt/M1F.patt"   },
  { id: 1,  patt: "patt/NS1F.patt"  },
  { id: 2,  patt: "patt/1LB1F.patt" },
  { id: 3,  patt: "patt/E1F.patt"   },
  { id: 4,  patt: "patt/CI1F.patt"   },
  { id: 5,  patt: "patt/G1F.patt"   },
  { id: 6,  patt: "patt/A1F.patt"   },
  { id: 7,  patt: "patt/SL1F.patt"  },

  { id: 8,  patt: "patt/M2F.patt"   },
  { id: 9,  patt: "patt/NS2F.patt"  },
  { id: 10, patt: "patt/1LB2F.patt" },
  { id: 11, patt: "patt/E2F.patt"   },
  { id: 12, patt: "patt/CI2F.patt"  },
  { id: 13, patt: "patt/G2F.patt"   },
  { id: 14, patt: "patt/A2F.patt"   },
  { id: 15, patt: "patt/SL2F.patt"  },

  { id: 16, patt: "patt/M3F.patt"   },
  { id: 17, patt: "patt/NS3F.patt"  },
  { id: 18, patt: "patt/1LB3F.patt" },
  { id: 19, patt: "patt/E3F.patt"   },
  { id: 20, patt: "patt/CI3F.patt"  },
  { id: 21, patt: "patt/G3F.patt"   },
  { id: 22, patt: "patt/A3F.patt"   },
  { id: 23, patt: "patt/SL3F.patt"  },
];

function AR() {
  if (started) return;
  started = true;

  // --- three.js ---
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

  // --- AR source ---
  source = new THREEx.ArToolkitSource({ sourceType: "webcam" });

  function onResize() {
    // 新API優先（ar.js 3.4.5）
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

    // --- AR context (after source ready) ---
    context = new THREEx.ArToolkitContext({
      cameraParametersUrl: "camera_para.dat",
      detectionMode: "mono"
    });

    context.init(() => {
      // arController ができた後だけ実行
      if (!context.arController) return;

      camera.projectionMatrix.copy(context.getProjectionMatrix());

      // --- markers（ここで作るのが安全）---
      setupMarkers();
    });
  });

  window.addEventListener("resize", onResize);

  // --- animate ---
  function animate() {
    requestAnimationFrame(animate);

    // arController 準備後だけ update
    if (source && source.ready !== false && context && context.arController) {
      context.update(source.domElement);

      // 現在地（見えているマーカー）を推定：最初に visible になったもの
      let found = null;
      for (const m of markerGroups) {
        if (m.group.visible) { found = m.id; break; }
      }

      if (found !== currentNode) {
        currentNode = found;
        if (currentNode !== null) console.log("[NAV] currentNode =", currentNode);
      }
    }

    renderer.render(scene, camera);
  }

  animate();
}

function setupMarkers() {
  // 二重生成防止
  if (markerGroups.length > 0) return;

  for (const def of MARKERS) {
    const group = new THREE.Group();
    scene.add(group);

    new THREEx.ArMarkerControls(context, group, {
      type: "pattern",
      patternUrl: def.patt,
      size: 1.0
    });

    // デバッグ用：箱（各マーカーに表示）
    const box = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshNormalMaterial()
    );
    group.add(box);

    markerGroups.push({ id: def.id, patt: def.patt, group });
  }

  console.log("[AR] markers set:", markerGroups.length);
}

// ページロード時に1回だけ起動
window.addEventListener("load", () => AR());
