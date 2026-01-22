// js/route.js
// GS.cpp の graph[LENGTH][LENGTH][HEIGHT] を元に「隣接（繋がり）＋コスト」を自動生成し、最短経路を返す
// - セル値: 0以上=ノードID / 負=通路コスト(-18なら18) / INF=通行不可
// - 6方向（上下左右＋階上下）に伸ばして最初に当たったノードを隣接とする（GS.cpp SearchNear相当）
(function () {
  const INF = 1000;
  const LENGTH = 5;
  const HEIGHT = 5;

  // ======= 地図データ（GS.cppのgraph） =======
  const G = [
    [
      [16, -18, 8, -18, 0],
      [INF, INF, INF, INF, -30],
      [19, -18, 11, -18, 3],
      [INF, INF, INF, INF, -30],
      [22, -18, 14, -18, 6],
    ],
    [
      [-27, INF, -27, INF, INF],
      [INF, INF, INF, INF, INF],
      [-27, INF, -27, INF, INF],
      [INF, INF, INF, INF, INF],
      [-27, INF, -27, INF, INF],
    ],
    [
      [17, -23, 9, -23, 1],
      [-30, INF, -30, INF, -30],
      [20, -33, 12, -33, 4],
      [-30, INF, -30, INF, -30],
      [23, INF, 15, INF, 7],
    ],
    [
      [-36, INF, -36, INF, -36],
      [INF, INF, INF, INF, INF],
      [-37, INF, -33, INF, -33],
      [INF, INF, INF, INF, INF],
      [INF, INF, INF, INF, INF],
    ],
    [
      [18, -22, 10, -22, 2],
      [INF, INF, INF, INF, INF],
      [21, -19, 13, -18, 5],
      [INF, INF, INF, INF, INF],
      [INF, INF, INF, INF, INF],
    ],
  ];

  // ======= マーカー ↔ ノード対応（Excelから生成） =======
  const NodeMeta = {0: {'name': '機械工学科棟1F', 'floor': 1, 'patt': 'M1F.patt'}, 1: {'name': '北階段前1F', 'floor': 1, 'patt': 'NS1F.patt'}, 2: {'name': '第一講義棟1F', 'floor': 1, 'patt': '1LB1F.patt'}, 3: {'name': '電気電子工学科棟1F', 'floor': 1, 'patt': 'E1F.patt'}, 4: {'name': '中央交差点1F', 'floor': 1, 'patt': 'CI1F.patt'}, 5: {'name': '一般管理棟1F', 'floor': 1, 'patt': 'G1F.patt'}, 6: {'name': '建築学科棟1F', 'floor': 1, 'patt': 'A1F.patt'}, 7: {'name': '南L字角1F', 'floor': 1, 'patt': 'SL1F.patt'}, 8: {'name': '機械工学科棟2F', 'floor': 2, 'patt': 'M2F.patt'}, 9: {'name': '北階段前2F', 'floor': 2, 'patt': 'NS2F.patt'}, 10: {'name': '第一講義棟2F', 'floor': 2, 'patt': '1LB2F.patt'}, 11: {'name': '電気電子工学科棟2F', 'floor': 2, 'patt': 'E2F.patt'}, 12: {'name': '中央交差点2F', 'floor': 2, 'patt': 'CI2F.patt'}, 13: {'name': '一般管理棟2F', 'floor': 2, 'patt': 'G2F.patt'}, 14: {'name': '建築学科棟2F', 'floor': 2, 'patt': 'A2F.patt'}, 15: {'name': '南L字角2F', 'floor': 2, 'patt': 'SL2F.patt'}, 16: {'name': '機械工学科棟3F', 'floor': 3, 'patt': 'M3F.patt'}, 17: {'name': '北階段前3F', 'floor': 3, 'patt': 'NS3F.patt'}, 18: {'name': '第一講義棟3F', 'floor': 3, 'patt': '1LB3F.patt'}, 19: {'name': '電気電子工学科棟3F', 'floor': 3, 'patt': 'E3F.patt'}, 20: {'name': '中央交差点3F', 'floor': 3, 'patt': 'CI3F.patt'}, 21: {'name': '一般管理棟3F', 'floor': 3, 'patt': 'G3F.patt'}, 22: {'name': '建築学科棟3F', 'floor': 3, 'patt': 'A3F.patt'}, 23: {'name': '南L字角3F', 'floor': 3, 'patt': 'SL3F.patt'}};
  const MarkerMap = {'M1F.patt': 0, 'NS1F.patt': 1, '1LB1F.patt': 2, 'E1F.patt': 3, 'CI1F.patt': 4, 'G1F.patt': 5, 'A1F.patt': 6, 'SL1F.patt': 7, 'M2F.patt': 8, 'NS2F.patt': 9, '1LB2F.patt': 10, 'E2F.patt': 11, 'CI2F.patt': 12, 'G2F.patt': 13, 'A2F.patt': 14, 'SL2F.patt': 15, 'M3F.patt': 16, 'NS3F.patt': 17, '1LB3F.patt': 18, 'E3F.patt': 19, 'CI3F.patt': 20, 'G3F.patt': 21, 'A3F.patt': 22, 'SL3F.patt': 23};

  // 6方向（GS.cppと同じ）
  const vec = [
    { dx: 0, dy: -1, dz: 0 }, // 0:上（y-1）
    { dx: 1, dy: 0, dz: 0 },  // 1:右（x+1）
    { dx: 0, dy: 1, dz: 0 },  // 2:下（y+1）
    { dx: -1, dy: 0, dz: 0 }, // 3:左（x-1）
    { dx: 0, dy: 0, dz: -1 }, // 4:下階（z-1）
    { dx: 0, dy: 0, dz: 1 },  // 5:上階（z+1）
  ];

  function inRange(x, y, z) {
    return x >= 0 && y >= 0 && z >= 0 && x < LENGTH && y < LENGTH && z < HEIGHT;
  }

  // ノードID -> 座標(x,y,z)
  function buildNodePos() {
    const pos = new Map();
    for (let x = 0; x < LENGTH; x++) {
      for (let y = 0; y < LENGTH; y++) {
        for (let z = 0; z < HEIGHT; z++) {
          const v = G[x][y][z];
          if (v >= 0 && v < 9999) pos.set(v, { x, y, z });
        }
      }
    }
    return pos;
  }

  // 方向dirに伸ばして隣接を見つける
  function neighborsOf(nodeId, nodePos) {
    const p = nodePos.get(nodeId);
    if (!p) return [];
    const out = [];

    for (let dir = 0; dir < 6; dir++) {
      let x = p.x, y = p.y, z = p.z;
      let cost = 0;
      let found = null;

      while (true) {
        x += vec[dir].dx; y += vec[dir].dy; z += vec[dir].dz;
        if (!inRange(x, y, z)) break;

        const v = G[x][y][z];
        if (v === INF) break;

        if (v < 0) {
          cost += -v;
          continue;
        }

        found = v;
        break;
      }

      if (found !== null) out.push({ to: found, cost, dirHint: dir });
    }

    return out;
  }

  function buildAdj() {
    const nodePos = buildNodePos();
    const nodes = Array.from(nodePos.keys()).sort((a, b) => a - b);
    const adj = {};
    for (const id of nodes) adj[id] = neighborsOf(id, nodePos);
    return { adj, nodePos };
  }

  // 最短経路（ダイクストラ）
  function dijkstra(adj, start, goal, sameFloorOnly) {
    if (start == null || goal == null) return null;
    if (start === goal) return [start];
    if (!adj[start] || !adj[goal]) return null;

    if (sameFloorOnly) {
      const sf = NodeMeta[start]?.floor ?? null;
      const gf = NodeMeta[goal]?.floor ?? null;
      if (sf != null && gf != null && sf !== gf) return null;
    }

    const dist = new Map();
    const prev = new Map();
    const used = new Set();

    for (const k of Object.keys(adj)) dist.set(Number(k), Infinity);
    dist.set(start, 0);

    while (true) {
      let u = null, best = Infinity;
      for (const [n, d] of dist.entries()) {
        if (!used.has(n) && d < best) { best = d; u = n; }
      }
      if (u === null) break;
      if (u === goal) break;

      used.add(u);
      for (const e of adj[u]) {
        const v = e.to;
        if (sameFloorOnly) {
          const sf = NodeMeta[start]?.floor ?? null;
          const vf = NodeMeta[v]?.floor ?? null;
          if (sf != null && vf != null && sf !== vf) continue;
        }
        const nd = dist.get(u) + e.cost;
        if (nd < dist.get(v)) {
          dist.set(v, nd);
          prev.set(v, u);
        }
      }
    }

    if (!prev.has(goal)) return null;

    const path = [];
    let cur = goal;
    while (cur !== start) {
      path.push(cur);
      cur = prev.get(cur);
      if (cur == null) return null;
    }
    path.push(start);
    path.reverse();
    return path;
  }

  function nextNode(path, current) {
    if (!path || current == null) return null;
    const i = path.indexOf(current);
    if (i < 0 || i === path.length - 1) return null;
    return path[i + 1];
  }

  // 隣接方向（AR矢印用）：隣接リストから from->to を引いて dirHint を返す（見つからなければnull）
  function dirHintBetween(adj, fromId, toId) {
    const edges = adj[fromId] || [];
    const hit = edges.find(e => e.to === toId);
    return hit ? hit.dirHint : null;
  }

  const built = buildAdj();

  // ======= NodeMeta に座標(x,y,z)を付与（矢印を正確に回すため） =======
  // すでにGS.cpp由来の3Dグリッド上で nodePos(nodeId->{x,y,z}) を持っているので、
  // NodeMetaにも同じ座標を埋めておく。
  // - AR側は NodeMeta[id].x/y/z を参照して yaw を計算できる
  // - 既存のExcel由来データは保持しつつ拡張する
  try {
    for (const key of Object.keys(NodeMeta)) {
      const id = Number(key);
      const p = built.nodePos.get(id);
      if (p) {
        NodeMeta[id].x = p.x;
        NodeMeta[id].y = p.y;
        NodeMeta[id].z = p.z;
        // floorが未定義なら z+1 を採用（1F=1,2F=2...）
        if (typeof NodeMeta[id].floor === "undefined") NodeMeta[id].floor = (p.z + 1);
      }
    }
  } catch (e) {
    console.warn("[Route] failed to enrich NodeMeta coords:", e);
  }

  // ======= 追加/削除エッジのパッチ =======
  // 要望:
  // 1) 0-1, 3-4, 6-7 を重み27で双方向接続
  // 2) 1Fで 0-3 と 3-6 の接続を削除（双方向）
  function addUndirected(a, b, w) {
    if (!built.adj[a]) built.adj[a] = [];
    if (!built.adj[b]) built.adj[b] = [];
    if (!built.adj[a].some(e => e.to === b)) built.adj[a].push({ to: b, cost: w, dirHint: null });
    if (!built.adj[b].some(e => e.to === a)) built.adj[b].push({ to: a, cost: w, dirHint: null });
  }
  function removeUndirected(a, b) {
    if (built.adj[a]) built.adj[a] = built.adj[a].filter(e => e.to !== b);
    if (built.adj[b]) built.adj[b] = built.adj[b].filter(e => e.to !== a);
  }

  // 追加（不具合が出たらコメントアウト可）
  addUndirected(0, 1, 27);
  addUndirected(3, 4, 27);
  addUndirected(6, 7, 27);

  // 削除（1Fのみに限るなら floor でガード）
  const f0 = NodeMeta?.[0]?.floor, f3 = NodeMeta?.[3]?.floor, f6 = NodeMeta?.[6]?.floor;
  if (f0 === 1 && f3 === 1) removeUndirected(0, 3);
  if (f3 === 1 && f6 === 1) removeUndirected(3, 6);

  window.Route = {
    INF, LENGTH, HEIGHT,
    G,
    adj: built.adj,
    nodePos: built.nodePos,
    NodeMeta,
    MarkerMap,
    dijkstra: (start, goal, sameFloorOnly = true) => dijkstra(built.adj, start, goal, sameFloorOnly),
    nextNode,
    dirHintBetween: (fromId, toId) => dirHintBetween(built.adj, fromId, toId),
  };

  console.log("[Route] ready. nodes =", Object.keys(window.Route.adj).length);
})();
