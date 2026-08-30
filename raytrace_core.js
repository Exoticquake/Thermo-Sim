// ============================================================================
// CORE RAY-TRACING PHYSICS ENGINE
// Shared, dependency-injected module: works identically in Node (for testing)
// and in the browser (for the actual app) because THREE is passed in rather
// than imported globally.
// ============================================================================

export function defaultParams() {
  return {
    // --- rules-derived scale (mm) ---
    cubeSize: 300,          // 30.0 cm cube (corrected value)
    // --- lamp / bulb ---
    bulbWattage: 100,       // W, electrical
    radiantFraction: 0.90,  // fraction of electrical power radiated as light+heat
    bulbHeight: 470,        // mm above testing surface
    beamHalfAngleDeg: 75,   // half-angle of the emission cone from the bulb (90 = full hemisphere)
    bulbDiskRadius: 13,     // mm, 0 = ideal point source
    // --- cup (9oz party cup, from event rules) ---
    cupRTop: 37.4, cupRBot: 26.0, cupHeight: 101.6,
    cupBottomY: 0,           // mm, height of the cup's own bottom above the testing surface (riser/stand)
    waterVolumeML: 100,
    // --- sleeve (blackened conductive liner around the cup) ---
    sleeveThickness: 3.0, sleeveClearance: 3.0,
    cupWallCredit: 0.70,    // fraction of energy landing on the sleeve/cup that reaches the water
    // --- mirror ---
    mirrorReflectivity: 0.92,
    maxBounces: 25,
    // --- simulation ---
    rayCount: 6000,
    randomSeed: 12345,
  };
}

// deterministic PRNG (mulberry32) so runs are reproducible for a given seed
export function makeRNG(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- derived cup/water geometry (mm), matches the Python model exactly ----
export function cupDerived(p) {
  const bottomY = p.cupBottomY || 0;
  function cupRadiusAt(h) { return p.cupRBot + (p.cupRTop - p.cupRBot) * (h / p.cupHeight); }
  function frustumVol(h) {
    const r = cupRadiusAt(h);
    return (Math.PI * h / 3) * (p.cupRBot * p.cupRBot + p.cupRBot * r + r * r);
  }
  // bisection to find fill height for target volume (mm^3 = mL * 1000)
  const targetMM3 = p.waterVolumeML * 1000;
  let lo = 0.01, hi = p.cupHeight;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (frustumVol(mid) < targetMM3) lo = mid; else hi = mid;
  }
  const waterHRel = (lo + hi) / 2;
  const waterR = cupRadiusAt(waterHRel);
  const rMin = p.cupRTop + p.sleeveThickness + p.sleeveClearance; // reflector throat radius
  return {
    waterH: bottomY + waterHRel,   // absolute height (from testing surface)
    waterR,
    rimH: bottomY + p.cupHeight,   // absolute height of cup rim
    bottomY,                        // absolute height of cup bottom
    rMin,
    cupRadiusAt,
  };
}

// ---- preset mirror profile functions: radius(y) for y in [rimH, topY] ----
export function domeProfile(rimH, topY, rMin, rTop) {
  // circle centered on-axis at height zc, passing through (rMin,rimH) and (rTop,topY)
  const zc = (rMin*rMin - rTop*rTop + rimH*rimH - topY*topY) / (2*(rimH - topY));
  const R = Math.sqrt(rMin*rMin + (rimH - zc)*(rimH - zc));
  return (y) => Math.sqrt(Math.max(R*R - (y - zc)*(y - zc), 0));
}
export function coneProfile(rimH, topY, rMin, rTop) {
  const m = (rTop - rMin) / (topY - rimH);
  return (y) => rMin + m * (y - rimH);
}
export function paraboloidProfile(rimH, topY, rMin, rTop) {
  const fourP = (rTop*rTop - rMin*rMin) / (topY - rimH);
  const yv = rimH - rMin*rMin/fourP;
  return (y) => Math.sqrt(Math.max(fourP*(y - yv), 0));
}
export function ellipseProfile(rimH, topY, rMin, rTop, bulbH, targetH) {
  const c = Math.abs(bulbH - targetH) / 2;
  const zc = (bulbH + targetH) / 2;
  const d1 = Math.hypot(rTop, topY - bulbH);
  const d2 = Math.hypot(rTop, topY - targetH);
  const A = (d1 + d2) / 2;   // semi-major axis, sized so the curve passes through (rTop, topY)
  const b2 = A * A - c * c;  // semi-minor axis squared
  return (y) => Math.sqrt(Math.max(b2 * (1 - ((y - zc) * (y - zc)) / (A * A)), 0));
}

// convenience: build a named preset mirror geometry directly from params
export function buildPresetGeometry(THREE, shapeName, params) {
  const cd = cupDerived(params);
  const rimH = cd.rimH, topY = params.cubeSize - 5, rMin = cd.rMin, rTop = params.cubeSize / 2;
  let profileFn;
  if (shapeName === 'cone') profileFn = coneProfile(rimH, topY, rMin, rTop);
  else if (shapeName === 'dome') profileFn = domeProfile(rimH, topY, rMin, rTop);
  else if (shapeName === 'paraboloid') profileFn = paraboloidProfile(rimH, topY, rMin, rTop);
  else if (shapeName === 'ellipse') profileFn = ellipseProfile(rimH, topY, rMin, rTop, params.bulbHeight, cd.waterH);
  else throw new Error('unknown preset: ' + shapeName);
  return buildLatheMirror(THREE, profileFn, rimH, topY);
}

// build a THREE.LatheGeometry mirror shell from a radius(y) profile function.
// NOTE: only the optical curve (rimH..topY) is reflective, matching the validated
// physics model exactly. A separate, non-reflective structural skirt can be added
// for CAD/visualization purposes but must never be part of the raycasting target.
export function buildLatheMirror(THREE, profileFn, rimH, topY, nSeg = 64, nSamples = 80) {
  const pts = [];
  for (let i = 0; i <= nSamples; i++) {
    const y = rimH + ((topY - rimH) * i) / nSamples;
    pts.push(new THREE.Vector2(Math.max(profileFn(y), 0.1), y));
  }
  const geo = new THREE.LatheGeometry(pts, nSeg);
  geo.computeVertexNormals();
  return geo;
}

// optional, purely structural/visual skirt (0..rimH) - NOT reflective, NOT a raycast target
export function buildStructuralSkirt(THREE, rimRadius, rimH, rBase = 55) {
  const pts = [
    new THREE.Vector2(Math.max(rBase, 0.1), 0),
    new THREE.Vector2(Math.max(rimRadius, 0.1), rimH),
  ];
  return new THREE.LatheGeometry(pts, 48);
}

// build the water-surface target (a disc) and the cup-exterior target (a frustum shell).
// The cup target is a linear taper from (waterR, waterH) to (rMin, rimH) - this matches
// the validated physics model exactly: it represents the combined cup+sleeve absorbing
// boundary as a single simplified taper (rMin already includes sleeve thickness+clearance),
// not the bare party cup's own geometry.
export function buildTargets(THREE, p, cd) {
  const waterGeo = new THREE.CircleGeometry(cd.waterR, 48);
  waterGeo.rotateX(-Math.PI / 2);
  waterGeo.translate(0, cd.waterH, 0);

  const pts = [
    new THREE.Vector2(Math.max(cd.waterR, 0.01), cd.waterH),
    new THREE.Vector2(Math.max(cd.rMin, 0.01), cd.rimH),
  ];
  const cupGeo = new THREE.LatheGeometry(pts, 32);
  return { waterGeo, cupGeo };
}

// ============================================================================
// MONTE CARLO RAY TRACER
// ============================================================================
export function runSimulation(THREE, MeshBVHLib, mirrorGeometry, params, opts = {}) {
  const { computeBoundsTree, acceleratedRaycast } = MeshBVHLib;
  const p = params;
  const cd = cupDerived(p);
  const { waterGeo, cupGeo } = buildTargets(THREE, p, cd);

  const mirrorMat = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
  const waterMat = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
  const cupMat = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });

  const mirrorMesh = new THREE.Mesh(mirrorGeometry, mirrorMat);
  const waterMesh = new THREE.Mesh(waterGeo, waterMat);
  const cupMesh = new THREE.Mesh(cupGeo, cupMat);
  mirrorMesh.userData.kind = 'mirror';
  waterMesh.userData.kind = 'water';
  cupMesh.userData.kind = 'cup';

  mirrorGeometry.boundsTree ? null : (mirrorGeometry.computeBoundsTree = computeBoundsTree, mirrorGeometry.computeBoundsTree());
  mirrorMesh.raycast = acceleratedRaycast;

  const targets = [mirrorMesh, waterMesh, cupMesh];
  const raycaster = new THREE.Raycaster();
  raycaster.firstHitOnly = true;
  const EPS = 1e-3;

  const rng = makeRNG(p.randomSeed);
  const N = p.rayCount;
  let waterW = 0, cupW = 0, lostW = 0;
  let waterHits = 0, cupHits = 0, lostRays = 0;
  const sampleRays = []; // for visualization

  const halfAng = (p.beamHalfAngleDeg * Math.PI) / 180;
  const wantSamples = opts.collectSamplesCount || 0;

  for (let i = 0; i < N; i++) {
    // sample bulb position (extended disk source)
    let bx = 0, bz = 0;
    if (p.bulbDiskRadius > 0) {
      const rr = p.bulbDiskRadius * Math.sqrt(rng());
      const th = 2 * Math.PI * rng();
      bx = rr * Math.cos(th); bz = rr * Math.sin(th);
    }
    const origin = new THREE.Vector3(bx, p.bulbHeight, bz);

    // sample direction: uniform over solid angle within halfAng cone around -Y
    const cosT = 1 - rng() * (1 - Math.cos(halfAng));
    const sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT));
    const phi = 2 * Math.PI * rng();
    let dir = new THREE.Vector3(sinT * Math.cos(phi), -cosT, sinT * Math.sin(phi)).normalize();

    let weight = 1.0;
    let pos = origin.clone();
    let bounces = 0;
    let outcome = 'lost';
    const path = wantSamples > 0 && i < wantSamples ? [pos.clone()] : null;

    while (bounces <= p.maxBounces) {
      raycaster.set(pos, dir);
      raycaster.near = EPS;
      raycaster.far = 1e5;
      const hits = raycaster.intersectObjects(targets, false);
      if (!hits.length) { outcome = 'lost'; break; }
      const hit = hits[0];
      const kind = hit.object.userData.kind;
      if (path) path.push(hit.point.clone());

      if (kind === 'water') { outcome = 'water'; break; }
      if (kind === 'cup') { outcome = 'cup'; break; }
      // mirror: reflect
      let n = hit.face.normal.clone().transformDirection(hit.object.matrixWorld).normalize();
      if (n.dot(dir) > 0) n.negate(); // ensure normal opposes incoming ray
      const d = dir.clone();
      const reflected = d.sub(n.multiplyScalar(2 * d.dot(n)));
      weight *= p.mirrorReflectivity;
      pos = hit.point.clone().addScaledVector(reflected, EPS);
      dir = reflected.normalize();
      bounces++;
      if (bounces > p.maxBounces) { outcome = 'lost'; break; }
    }

    if (outcome === 'water') { waterW += weight; waterHits++; }
    else if (outcome === 'cup') { cupW += weight * p.cupWallCredit; cupHits++; }
    else { lostW += weight; lostRays++; }

    if (path) sampleRays.push({ path, outcome });
  }

  const score = 100 * (waterW + cupW) / N;
  return {
    score,
    waterFrac: waterHits / N,
    cupFrac: cupHits / N,
    lostFrac: lostRays / N,
    waterWeightFrac: waterW / N,
    cupWeightFrac: cupW / N,
    sampleRays,
    N,
    cupDerived: cd,
  };
}
