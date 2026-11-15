// 3D map: the analysed terrain grid as a shaded mesh with the route, markers and (during guidance) your
// position. Loaded on first use. "Hazard" colours vertices by the planner's hazard score; "Gray" is plain
// shaded terrain and is switched on automatically if the frame rate drops, as is a lighter mesh.

const THREE_URL = "three";   // resolved by the import map in index.html (three@0.160.0 on jsDelivr)
const CONTROLS_URL = "https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/controls/OrbitControls.js";
const DEG = Math.PI / 180;

let T = null, Controls = null;
let el, renderer, scene, camera, controls, terrain, routeObj, markers, meObj, raf = 0;
let state = { site: null, track: null, points: [], exag: 1.5, color: "hazard", lite: false, ox: 0, oz: 0, z0: 0 };
let onPick = null, slowFrames = 0, frames = 0, fpsT0 = 0, visible = false;

export const is3dOpen = () => visible;

export async function open3d(container, { site, track, points, pick }) {
  el = container; onPick = pick;
  if (!T) {
    T = await import(THREE_URL);
    ({ OrbitControls: Controls } = await import(CONTROLS_URL));
  }
  if (!renderer) init();
  visible = true; el.classList.remove("hidden");
  resize();
  update({ site, track, points }, true);
  fpsT0 = performance.now(); frames = 0; slowFrames = 0;
  loop();
}
export function close3d() {
  visible = false; el?.classList.add("hidden");
  cancelAnimationFrame(raf);
}

function init() {
  const lite = state.lite || (navigator.hardwareConcurrency || 8) <= 4;
  state.lite = lite;
  renderer = new T.WebGLRenderer({ antialias: !lite, powerPreference: "high-performance" });
  renderer.setPixelRatio(lite ? 1 : Math.min(2, devicePixelRatio));
  el.querySelector(".m3-canvas").appendChild(renderer.domElement);
  scene = new T.Scene();
  scene.background = new T.Color(0x14100e);
  camera = new T.PerspectiveCamera(45, 1, 1, 5e6);
  controls = new Controls(camera, renderer.domElement);
  controls.enableDamping = true; controls.maxPolarAngle = 88 * DEG;
  scene.add(new T.HemisphereLight(0xfff1e0, 0x3a2416, 0.9));
  const sun = new T.DirectionalLight(0xffffff, 1.6); sun.position.set(-1, 1.2, -0.6); scene.add(sun);
  markers = new T.Group(); scene.add(markers);
  addEventListener("resize", resize);
  // click (not drag) on the terrain picks a point
  let down = null;
  renderer.domElement.addEventListener("pointerdown", (e) => { down = [e.clientX, e.clientY]; });
  renderer.domElement.addEventListener("pointerup", (e) => {
    if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5 || !terrain || !onPick) return;
    const r = renderer.domElement.getBoundingClientRect();
    const ray = new T.Raycaster(); ray.setFromCamera(new T.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
    const hit = ray.intersectObject(terrain)[0];
    if (hit) { const ll = toLatLon(hit.point.x, hit.point.z); onPick(ll[0], ll[1]); }
  });
  // controls bar
  el.querySelector("#m3Exag").addEventListener("input", (e) => { state.exag = +e.target.value; el.querySelector("#m3ExagOut").textContent = `${state.exag.toFixed(1)}×`; rebuild(); });
  el.querySelector("#m3Color").addEventListener("change", (e) => { state.color = e.target.value; colorize(); });
  el.querySelector("#m3Reset").addEventListener("click", () => frame());
}

function resize() {
  if (!renderer || !el) return;
  const w = el.clientWidth, h = el.clientHeight;
  renderer.setSize(w, h, false); camera.aspect = w / Math.max(1, h); camera.updateProjectionMatrix();
}

// local metres: x east, z south, y up (exaggerated)
function toXZ(site, lat, lon) { return [(lon - site.bbox.west) * site.mPerDegLon - state.ox, (site.bbox.north - lat) * site.mPerDegLat - state.oz]; }
function toLatLon(x, z) { const s = state.site; return [s.bbox.north - (z + state.oz) / s.mPerDegLat, s.bbox.west + (x + state.ox) / s.mPerDegLon]; }
function heightAt(site, lat, lon) {
  const i = Math.min(site.nx - 1, Math.max(0, Math.floor((lon - site.bbox.west) / site.dLon))), j = Math.min(site.ny - 1, Math.max(0, Math.floor((site.bbox.north - lat) / site.dLat)));
  return (site.elev[j * site.nx + i] - state.z0) * state.exag;
}

export function update({ site, track, points }, refit = false) {
  if (!renderer) { Object.assign(state, { site, track, points }); return; }
  const siteChanged = site !== state.site;
  state.track = track; state.points = points || [];
  if (siteChanged) { state.site = site; rebuild(); refit = true; }
  else { drawRoute(); drawMarkers(); }
  if (refit) frame();
}

function rebuild() {
  const site = state.site; if (!site || !T) return;
  if (terrain) { scene.remove(terrain); terrain.geometry.dispose(); terrain.material.dispose(); terrain = null; }
  const maxV = state.lite ? 200 : 420, step = Math.max(1, Math.ceil(Math.max(site.nx, site.ny) / maxV));
  const cols = Math.floor((site.nx - 1) / step) + 1, rows = Math.floor((site.ny - 1) / step) + 1;
  const W = site.nx * site.dLon * site.mPerDegLon, H = site.ny * site.dLat * site.mPerDegLat;
  state.ox = W / 2; state.oz = H / 2; state.vis = Math.max(W, H) / 140;   // marker scale that reads at the default view
  let zmin = Infinity; for (let k = 0; k < site.elev.length; k += 7) zmin = Math.min(zmin, site.elev[k]); state.z0 = zmin;
  const g = new T.BufferGeometry(), pos = new Float32Array(cols * rows * 3), idx = [];
  state.cells = new Int32Array(cols * rows);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const i = Math.min(site.nx - 1, c * step), j = Math.min(site.ny - 1, r * step), v = r * cols + c, k = j * site.nx + i;
    pos[v * 3] = (i + 0.5) * site.dLon * site.mPerDegLon - state.ox;
    pos[v * 3 + 1] = (site.elev[k] - state.z0) * state.exag;
    pos[v * 3 + 2] = (j + 0.5) * site.dLat * site.mPerDegLat - state.oz;
    state.cells[v] = k;
  }
  for (let r = 0; r < rows - 1; r++) for (let c = 0; c < cols - 1; c++) { const a = r * cols + c; idx.push(a, a + cols, a + 1, a + 1, a + cols, a + cols + 1); }
  g.setAttribute("position", new T.BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals();
  g.setAttribute("color", new T.BufferAttribute(new Float32Array(cols * rows * 3), 3));
  terrain = new T.Mesh(g, new T.MeshLambertMaterial({ vertexColors: true }));
  scene.add(terrain);
  colorize(); drawRoute(); drawMarkers();
}

function colorize() {
  if (!terrain) return;
  const site = state.site, col = terrain.geometry.getAttribute("color"), a = col.array, gray = state.color === "gray";
  for (let v = 0; v < state.cells.length; v++) {
    const k = state.cells[v];
    let r = 0.62, g = 0.6, b = 0.58;
    if (!gray) {
      const h = site.hazard[k];
      if (site.nogo[k]) { r = 0.85; g = 0.25; b = 0.28; }
      else if (h > 0.5) { r = 0.9; g = 0.55; b = 0.25; }
      else if (h > 0.3) { r = 0.85; g = 0.78; b = 0.38; }
      else { r = 0.66; g = 0.56; b = 0.48; }
    }
    a[v * 3] = r; a[v * 3 + 1] = g; a[v * 3 + 2] = b;
  }
  col.needsUpdate = true;
  el.querySelector("#m3Color").value = state.color;
  el.querySelector("#m3Legend")?.classList.toggle("hidden", gray);
}

function drawRoute() {
  if (routeObj) { scene.remove(routeObj); routeObj.geometry.dispose(); routeObj = null; }
  const tr = state.track, site = state.site;
  if (!tr || !site) return;
  // sizes follow the view (grid extent), not the cell size: on a coarse 200 m grid cell-sized markers swamp the route
  const lift = Math.max(2, state.vis * 0.15) * state.exag, pts = [];
  const stride = Math.max(1, Math.floor(tr.pts.length / 1500));
  for (let i = 0; i < tr.pts.length; i += stride) { const p = tr.pts[i], [x, z] = toXZ(site, p.lat, p.lon); pts.push(new T.Vector3(x, heightAt(site, p.lat, p.lon) + lift, z)); }
  if (pts.length < 2) return;
  const radius = Math.max(1.5, state.vis * 0.12);
  routeObj = new T.Mesh(new T.TubeGeometry(new T.CatmullRomCurve3(pts), Math.min(2000, pts.length * 2), radius, 6, false), new T.MeshBasicMaterial({ color: 0x2fd68f }));
  scene.add(routeObj);
}
function drawMarkers() {
  if (!markers) return;
  markers.clear();
  const site = state.site; if (!site) return;
  const size = Math.max(4, state.vis * 0.5);
  for (const p of state.points) {
    const [x, z] = toXZ(site, p.lat, p.lon), y = heightAt(site, p.lat, p.lon);
    const m = new T.Mesh(new T.SphereGeometry(size, 16, 12), new T.MeshBasicMaterial({ color: p.kind === "start" ? 0x2fd68f : p.kind === "end" ? 0xe9354f : 0xe8743b }));
    m.position.set(x, y + size * 1.6, z); markers.add(m);
    const stem = new T.Mesh(new T.CylinderGeometry(size * 0.15, size * 0.15, size * 1.6, 6), new T.MeshBasicMaterial({ color: 0xffffff }));
    stem.position.set(x, y + size * 0.8, z); markers.add(stem);
  }
}
// Your position in 3D: a small model of a suited astronaut (on foot) or a pressurized rover (driving), facing the
// direction of travel. Model units: about 1 = its height; it is rescaled every frame to stay readable at any zoom.
function part(geo, color, x, y, z) { const m = new T.Mesh(geo, new T.MeshLambertMaterial({ color })); m.position.set(x, y, z); return m; }
function astronaut() {
  const g = new T.Group(), suit = 0xf1f1ee, B = (w, h, d) => new T.BoxGeometry(w, h, d);
  g.add(part(B(0.13, 0.42, 0.16), suit, -0.09, 0.21, 0), part(B(0.13, 0.42, 0.16), suit, 0.09, 0.21, 0));   // legs
  g.add(part(B(0.38, 0.4, 0.26), suit, 0, 0.62, 0));                                                          // torso
  g.add(part(B(0.32, 0.38, 0.16), 0xcfd3d8, 0, 0.64, 0.2));                                                   // life-support pack (behind)
  g.add(part(B(0.1, 0.38, 0.13), suit, -0.25, 0.6, 0), part(B(0.1, 0.38, 0.13), suit, 0.25, 0.6, 0));        // arms
  g.add(part(new T.SphereGeometry(0.17, 20, 14), suit, 0, 0.98, 0));                                          // helmet
  const visor = part(new T.SphereGeometry(0.13, 20, 14), 0xe0a83a, 0, 0.99, -0.08); visor.scale.z = 0.6; g.add(visor);
  g.add(part(B(0.2, 0.07, 0.02), 0x4aa3ff, 0, 0.72, -0.14));                                                 // chest display
  return g;
}
function rover() {
  const g = new T.Group(), B = (w, h, d) => new T.BoxGeometry(w, h, d);
  g.add(part(B(0.7, 0.34, 1.15), 0xeeeeea, 0, 0.42, 0));                                                     // pressurized cabin
  g.add(part(B(0.62, 0.16, 0.06), 0x24476f, 0, 0.5, -0.58));                                                 // front windows
  g.add(part(B(0.74, 0.03, 0.5), 0x1f3a66, 0, 0.61, 0.26));                                                  // solar panel
  g.add(part(new T.CylinderGeometry(0.025, 0.025, 0.3, 8), 0xbbbbbb, 0.22, 0.77, -0.2));                     // mast
  g.add(part(B(0.16, 0.08, 0.08), 0xdddddd, 0.22, 0.94, -0.2));                                              // camera head
  const wheel = new T.CylinderGeometry(0.15, 0.15, 0.11, 16);
  for (const x of [-0.4, 0.4]) for (const z of [-0.4, 0, 0.4]) { const w = part(wheel, 0x2f2f2f, x, 0.15, z); w.rotation.z = Math.PI / 2; g.add(w); }
  return g;
}
export function updatePosition(lat, lon, mode = "walk", heading = 0) {
  if (!visible || !state.site) return;
  const site = state.site;
  if (meObj && meObj.userData.mode !== mode) clearPosition();
  if (!meObj) {
    meObj = new T.Group(); meObj.userData.mode = mode;
    meObj.add(mode === "drive" ? rover() : astronaut());
    const halo = new T.Mesh(new T.CircleGeometry(mode === "drive" ? 0.85 : 0.45, 32), new T.MeshBasicMaterial({ color: 0x4aa3ff, transparent: true, opacity: 0.55 }));
    halo.rotation.x = -Math.PI / 2; halo.position.y = 0.01; meObj.add(halo);   // blue disc on the ground so it's easy to spot
    scene.add(meObj);
  }
  const [x, z] = toXZ(site, lat, lon); meObj.position.set(x, heightAt(site, lat, lon), z);
  meObj.rotation.y = -heading * DEG;   // heading: degrees clockwise from north; north is -z, the models face -z
  scaleMe();
}
function scaleMe() {   // keep the model about 7% of the view height, whatever the zoom
  if (!meObj || !camera) return;
  const d = camera.position.distanceTo(meObj.position);
  meObj.scale.setScalar(Math.max(1, d * 2 * Math.tan((camera.fov * DEG) / 2) * 0.07));
}
export function clearPosition() { if (meObj) { scene.remove(meObj); meObj.traverse((o) => { o.geometry?.dispose(); o.material?.dispose(); }); meObj = null; } }

function frame() {
  const site = state.site; if (!site) return;
  // fit the route if there is one, otherwise the whole grid
  let cx = 0, cz = 0, span;
  if (state.track) {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const p of state.track.pts) { const [x, z] = toXZ(site, p.lat, p.lon); x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
    cx = (x0 + x1) / 2; cz = (z0 + z1) / 2; span = Math.max(x1 - x0, z1 - z0, 400);
  } else span = Math.max(state.ox, state.oz) * 2;
  const cy = heightAt(site, ...toLatLon(cx, cz));
  // on wide screens the plan panel covers the left ~400 px: aim left of centre so the route sits in the open area
  const shift = innerWidth > 760 ? span * 0.22 : 0;
  controls.target.set(cx - shift, cy, cz);
  camera.position.set(cx - shift - span * 0.35, cy + span * 0.85, cz + span * 1.05);
  camera.near = Math.max(0.5, span / 2000); camera.far = span * 50; camera.updateProjectionMatrix();
  controls.update();
}

function loop() {
  if (!visible) return;
  raf = requestAnimationFrame(loop);
  controls.update();
  scaleMe();
  renderer.render(scene, camera);
  // fall back to the lite gray mode if this device can't keep ~25 fps
  frames++;
  const now = performance.now();
  if (now - fpsT0 > 1500) {
    const fps = (frames * 1000) / (now - fpsT0); frames = 0; fpsT0 = now;
    if (fps < 25 && !state.lite) { slowFrames++; if (slowFrames >= 2) goLite(); } else slowFrames = 0;
  }
}
function goLite() {
  state.lite = true; state.color = "gray";
  renderer.setPixelRatio(1);
  rebuild(); resize();
  const n = el.querySelector("#m3Note"); n.textContent = "Lite mode: gray terrain, lighter mesh (this device was rendering slowly)."; n.classList.remove("hidden");
}
