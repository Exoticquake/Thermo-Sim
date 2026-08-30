import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';
import * as MeshBVHLib from 'three-mesh-bvh';
import {
  defaultParams, cupDerived, coneProfile, domeProfile, paraboloidProfile, ellipseProfile,
  buildLatheMirror, buildTargets, buildPresetGeometry, runSimulation
} from './raytrace_core.js';

// ---------------------------------------------------------------- state ----
let params = defaultParams();
let currentShapeSource = { kind: 'preset', name: 'ellipse' };
let currentMirrorGeometry = null;
let history = [];
let stlParts = [];        // { id, name, geometry (untransformed), posX, posY, posZ, rotX, rotY, rotZ }
let partIdCounter = 0;

const PARAM_FIELDS = [
  'bulbWattage','radiantFraction','bulbHeight','beamHalfAngleDeg','bulbDiskRadius',
  'cubeSize','cupRTop','cupRBot','cupHeight','cupBottomY','waterVolumeML','sleeveThickness','sleeveClearance',
  'cupWallCredit','mirrorReflectivity','maxBounces','rayCount','randomSeed'
];

function syncInputsFromParams() {
  for (const f of PARAM_FIELDS) {
    const el = document.getElementById('p_' + f);
    if (el) el.value = params[f];
  }
}
function syncParamsFromInputs() {
  for (const f of PARAM_FIELDS) {
    const el = document.getElementById('p_' + f);
    if (el) params[f] = parseFloat(el.value);
  }
}
PARAM_FIELDS.forEach(f => {
  const el = document.getElementById('p_' + f);
  if (el) el.addEventListener('change', syncParamsFromInputs);
});
syncInputsFromParams();

const CODE_TEMPLATE = `// Build and return a THREE.BufferGeometry for the reflector's mirror shell.
// (THREE, params, helpers) are provided for you - no imports needed.
//
// helpers.cupDerived(params) -> { rimH, topY... actually just rimH, waterH, waterR, rMin }
//   rimH  = cup-rim height (mm) - the mirror should start at/above this
//   rMin  = reflector throat radius (mm), already includes the sleeve
// params.cubeSize is the full 30cm-cube edge length (mm); half of it is your max radius.
//
// helpers.lathe(profileFn, rimH, topY) revolves a radius(y)->mm function around
// the vertical axis for you (handy for any shape of revolution).

function buildGeometry(THREE, params, helpers) {
  const cd = helpers.cupDerived(params);
  const rimH = cd.rimH;
  const topY = params.cubeSize - 5;      // stay just inside the cube
  const rTop = params.cubeSize / 2;      // use the full available radius
  const rMin = cd.rMin;

  // Example: a simple cone. Replace this with your own profile function,
  // or build a totally custom THREE.BufferGeometry / THREE.LatheGeometry /
  // CSG-style shape - anything Three.js can produce.
  const profile = (y) => rMin + (rTop - rMin) * (y - rimH) / (topY - rimH);

  return helpers.lathe(profile, rimH, topY);
}
`;
document.getElementById('customCode').value = CODE_TEMPLATE;

// ---------------------------------------------------------------- 3D scene --
const wrap = document.getElementById('viewport-wrap');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
document.getElementById('viewport').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0f1115);
const camera = new THREE.PerspectiveCamera(45, 1, 1, 5000);
camera.position.set(450, 380, 450);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 120, 0);
controls.update();

scene.add(new THREE.AmbientLight(0xffffff, 0.7));
const dl = new THREE.DirectionalLight(0xffffff, 0.8);
dl.position.set(300, 500, 200);
scene.add(dl);

const gridHelper = new THREE.GridHelper(300, 10, 0x333844, 0x22262f);
scene.add(gridHelper);

let mirrorMeshVis = null, cupMeshVis = null, waterMeshVis = null, bulbVis = null, cubeVis = null, rayGroup = null;

function resizeRenderer() {
  const w = wrap.clientWidth, h = wrap.clientHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resizeRenderer);
resizeRenderer();

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}
animate();

function clearVis(obj) { if (obj) { scene.remove(obj); } }

function updateStaticVis() {
  clearVis(cupMeshVis); clearVis(waterMeshVis); clearVis(bulbVis); clearVis(cubeVis);
  const cd = cupDerived(params);

  // cup (wireframe-ish translucent)
  const cupPts = [];
  const N = 20;
  for (let i = 0; i <= N; i++) {
    const h = (params.cupHeight * i) / N;
    const r = params.cupRBot + (params.cupRTop - params.cupRBot) * (h / params.cupHeight);
    cupPts.push(new THREE.Vector2(r, cd.bottomY + h));
  }
  const cupGeo = new THREE.LatheGeometry(cupPts, 32);
  cupMeshVis = new THREE.Mesh(cupGeo, new THREE.MeshStandardMaterial({ color: 0x88a0ff, transparent: true, opacity: 0.28, side: THREE.DoubleSide }));
  scene.add(cupMeshVis);

  // water surface disc
  const waterGeo = new THREE.CircleGeometry(cd.waterR, 32);
  waterGeo.rotateX(-Math.PI / 2);
  waterGeo.translate(0, cd.waterH, 0);
  waterMeshVis = new THREE.Mesh(waterGeo, new THREE.MeshStandardMaterial({ color: 0x3ac6ff, side: THREE.DoubleSide }));
  scene.add(waterMeshVis);

  // bulb marker
  const bulbGeo = new THREE.SphereGeometry(Math.max(params.bulbDiskRadius, 6), 16, 16);
  bulbVis = new THREE.Mesh(bulbGeo, new THREE.MeshStandardMaterial({ color: 0xfff2c2, emissive: 0xffcc33, emissiveIntensity: 0.6 }));
  bulbVis.position.set(0, params.bulbHeight, 0);
  scene.add(bulbVis);

  // cube boundary (wireframe)
  const cs = params.cubeSize;
  const cubeGeo = new THREE.BoxGeometry(cs, cs, cs);
  const edges = new THREE.EdgesGeometry(cubeGeo);
  cubeVis = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: 0x3a4050 }));
  cubeVis.position.set(0, cs / 2, 0);
  scene.add(cubeVis);
}

function updateMirrorVis(geometry) {
  clearVis(mirrorMeshVis);
  mirrorMeshVis = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({
    color: 0xd7dde6, metalness: 0.3, roughness: 0.25, side: THREE.DoubleSide, transparent: true, opacity: 0.85
  }));
  scene.add(mirrorMeshVis);
}

function updateRayVis(sampleRays) {
  if (rayGroup) scene.remove(rayGroup);
  rayGroup = new THREE.Group();
  const colors = { water: 0x4ade80, cup: 0xfbbf24, lost: 0xf87171 };
  for (const r of sampleRays) {
    const pts = r.path;
    if (pts.length < 2) continue;
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    const mat = new THREE.LineBasicMaterial({ color: colors[r.outcome] || 0x888888, transparent: true, opacity: 0.55 });
    rayGroup.add(new THREE.Line(geo, mat));
  }
  scene.add(rayGroup);
}

// ---------------------------------------------------------------- errors ----
const errBox = document.getElementById('err');
function showError(msg) { errBox.textContent = msg; errBox.style.display = 'block'; }
function clearError() { errBox.style.display = 'none'; errBox.textContent = ''; }

// ---------------------------------------------------------------- tabs -----
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tabpane').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
  });
});

document.querySelectorAll('.preset-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
    currentShapeSource = { kind: 'preset', name: btn.dataset.shape };
    try {
      syncParamsFromInputs();
      const geo = buildPresetGeometry(THREE, btn.dataset.shape, params);
      currentMirrorGeometry = geo;
      updateStaticVis();
      updateMirrorVis(geo);
      clearError();
    } catch (e) { showError('Preset build error: ' + e.message); }
  });
});
document.querySelector('.preset-btn[data-shape="ellipse"]').classList.add('selected');

document.getElementById('stlFile').addEventListener('change', (ev) => {
  const files = Array.from(ev.target.files || []);
  if (!files.length) return;
  currentShapeSource = { kind: 'stl' };
  let remaining = files.length;
  files.forEach(file => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const loader = new STLLoader();
        const geo = loader.parse(e.target.result);
        geo.computeVertexNormals();
        stlParts.push({
          id: ++partIdCounter, name: file.name, geometry: geo,
          posX: 0, posY: 0, posZ: 0, rotX: 0, rotY: 0, rotZ: 0,
        });
        clearError();
      } catch (err) {
        showError('STL parse error (' + file.name + '): ' + err.message);
      } finally {
        remaining--;
        if (remaining === 0) { renderPartsList(); refreshSTLPreview(); ev.target.value = ''; }
      }
    };
    reader.readAsArrayBuffer(file);
  });
});

function partMatrix(part) {
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(
    THREE.MathUtils.degToRad(part.rotX), THREE.MathUtils.degToRad(part.rotY), THREE.MathUtils.degToRad(part.rotZ), 'XYZ'
  ));
  const m = new THREE.Matrix4();
  m.compose(new THREE.Vector3(part.posX, part.posY, part.posZ), q, new THREE.Vector3(1, 1, 1));
  return m;
}

function transformedPartGeometry(part) {
  const g = part.geometry.clone();
  g.applyMatrix4(partMatrix(part));
  return g;
}

function mergedSTLGeometry() {
  if (!stlParts.length) throw new Error('Upload at least one STL file first.');
  if (stlParts.length === 1) return transformedPartGeometry(stlParts[0]);
  const geos = stlParts.map(transformedPartGeometry);
  const merged = BufferGeometryUtils.mergeGeometries(geos, false);
  if (!merged) throw new Error('Could not merge the uploaded STL parts (mismatched attributes?).');
  return merged;
}

function renderPartsList() {
  const el = document.getElementById('stlPartsList');
  el.innerHTML = '';
  stlParts.forEach(part => {
    const card = document.createElement('div');
    card.className = 'part-card';
    card.innerHTML = `
      <div class="ph"><span class="nm" title="${part.name}">${part.name}</span><button class="rm" data-id="${part.id}">✕ remove</button></div>
      <div class="xyz-title">Position (mm)</div>
      <div class="xyz-grid">
        <div><label>X</label><input type="number" data-id="${part.id}" data-field="posX" value="${part.posX}" step="1"></div>
        <div><label>Y</label><input type="number" data-id="${part.id}" data-field="posY" value="${part.posY}" step="1"></div>
        <div><label>Z</label><input type="number" data-id="${part.id}" data-field="posZ" value="${part.posZ}" step="1"></div>
      </div>
      <div class="xyz-title">Rotation (°)</div>
      <div class="xyz-grid">
        <div><label>X</label><input type="number" data-id="${part.id}" data-field="rotX" value="${part.rotX}" step="1"></div>
        <div><label>Y</label><input type="number" data-id="${part.id}" data-field="rotY" value="${part.rotY}" step="1"></div>
        <div><label>Z</label><input type="number" data-id="${part.id}" data-field="rotZ" value="${part.rotZ}" step="1"></div>
      </div>`;
    el.appendChild(card);
  });
  el.querySelectorAll('input[data-field]').forEach(inp => {
    inp.addEventListener('change', () => {
      const id = parseInt(inp.dataset.id, 10);
      const part = stlParts.find(p => p.id === id);
      if (part) { part[inp.dataset.field] = parseFloat(inp.value) || 0; refreshSTLPreview(); }
    });
  });
  el.querySelectorAll('.rm').forEach(btn => {
    btn.addEventListener('click', () => {
      stlParts = stlParts.filter(p => p.id !== parseInt(btn.dataset.id, 10));
      renderPartsList();
      refreshSTLPreview();
    });
  });
}

function refreshSTLPreview() {
  if (!stlParts.length) { clearVis(mirrorMeshVis); mirrorMeshVis = null; return; }
  try {
    const geo = mergedSTLGeometry();
    currentMirrorGeometry = geo;
    syncParamsFromInputs();
    updateStaticVis();
    updateMirrorVis(geo);
    clearError();
  } catch (e) { showError('STL assembly error: ' + e.message); }
}

// ---------------------------------------------------------------- run ------
const helpers = {
  cupDerived,
  lathe: (profileFn, rimH, topY) => buildLatheMirror(THREE, profileFn, rimH, topY),
  profiles: { coneProfile, domeProfile, paraboloidProfile, ellipseProfile },
};

function buildGeometryFromCurrentSource() {
  syncParamsFromInputs();
  const activeTab = document.querySelector('.tab.active').dataset.tab;

  if (activeTab === 'presets') {
    return buildPresetGeometry(THREE, currentShapeSource.name || 'ellipse', params);
  }
  if (activeTab === 'code') {
    const code = document.getElementById('customCode').value;
    const wrapped = code + '\nreturn buildGeometry(THREE, params, helpers);';
    const fn = new Function('THREE', 'params', 'helpers', wrapped);
    const geo = fn(THREE, params, helpers);
    if (!geo || !geo.isBufferGeometry) throw new Error('Your code must return a THREE.BufferGeometry (got: ' + (geo && geo.constructor && geo.constructor.name) + ')');
    return geo;
  }
  if (activeTab === 'stl') {
    return mergedSTLGeometry();
  }
  throw new Error('no shape source selected');
}

function fmtPct(x) { return (100 * x).toFixed(2) + '%'; }

function estimateDeltaT(score100) {
  const P_radiant = params.bulbWattage * params.radiantFraction;
  const P_delivered = P_radiant * (score100 / 100);
  const t = 20 * 60;
  const m = params.waterVolumeML; // 1 mL water ~= 1 g
  const c = 4.186;
  return (P_delivered * t) / (m * c);
}

document.getElementById('runBtn').addEventListener('click', () => {
  clearError();
  const loading = document.getElementById('loading');
  loading.style.display = 'flex';
  document.getElementById('runBtn').disabled = true;
  setTimeout(() => {
    try {
      const geo = buildGeometryFromCurrentSource();
      currentMirrorGeometry = geo;
      syncParamsFromInputs();
      updateStaticVis();
      updateMirrorVis(geo);

      const t0 = performance.now();
      const result = runSimulation(THREE, MeshBVHLib, geo.clone(), params, { collectSamplesCount: 180 });
      const ms = (performance.now() - t0).toFixed(0);

      updateRayVis(result.sampleRays);

      document.getElementById('scoreBig').textContent = result.score.toFixed(1);
      document.getElementById('scoreBig').style.color =
        result.score > 20 ? '#4ade80' : result.score > 8 ? '#fbbf24' : '#f87171';
      document.getElementById('statWater').textContent = fmtPct(result.waterFrac);
      document.getElementById('statCup').textContent = fmtPct(result.cupFrac);
      document.getElementById('statLost').textContent = fmtPct(result.lostFrac);
      document.getElementById('barWater').style.width = fmtPct(result.waterFrac);
      document.getElementById('barCup').style.width = fmtPct(result.cupFrac);
      document.getElementById('barLost').style.width = fmtPct(result.lostFrac);

      const dT = estimateDeltaT(result.score);
      document.getElementById('statDT').textContent = dT.toFixed(1) + ' °C';
      document.getElementById('dtHint').textContent =
        `Naive energy-in estimate only (no evaporative/convective losses modeled): ` +
        `${params.bulbWattage}W × ${params.radiantFraction} radiant × score/100, over 20 min, into ${params.waterVolumeML}mL water. Ran ${params.rayCount} rays in ${ms}ms.`;

      const label = currentShapeSource.kind === 'preset' ? currentShapeSource.name
        : currentShapeSource.kind === 'stl' ? `STL (${stlParts.length} part${stlParts.length===1?'':'s'})`
        : 'custom code';
      history.unshift({ label, score: result.score, beam: params.beamHalfAngleDeg });
      history = history.slice(0, 12);
      renderHistory();
    } catch (e) {
      showError('Simulation error: ' + e.message + (e.stack ? ('\n' + e.stack.split('\n').slice(0,4).join('\n')) : ''));
      console.error(e);
    } finally {
      loading.style.display = 'none';
      document.getElementById('runBtn').disabled = false;
    }
  }, 30);
});

function renderHistory() {
  const el = document.getElementById('historyList');
  el.innerHTML = '';
  for (const h of history) {
    const div = document.createElement('div');
    div.className = 'history-item';
    const color = h.score > 20 ? '#4ade80' : h.score > 8 ? '#fbbf24' : '#f87171';
    div.innerHTML = `<span class="nm">${h.label} (${h.beam}°)</span><span class="sc" style="color:${color}">${h.score.toFixed(1)}</span>`;
    el.appendChild(div);
  }
}

// initial view
updateStaticVis();
try {
  const geo = buildPresetGeometry(THREE, 'ellipse', params);
  currentMirrorGeometry = geo;
  updateMirrorVis(geo);
} catch (e) { showError('Init error: ' + e.message); }
