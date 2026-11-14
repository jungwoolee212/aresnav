// Helmet heads-up display: synthetic 3D terrain view of what's ahead, next maneuver, compass tape,
// life-support / rover readouts, sky-open shielding, sun, minimap. Driven by app.js's nav loop.

import { renderTerrainView } from "./terrain3d.js";
import { maneuverIcon, compassWord } from "./nav.js";
import { sampleAt } from "./planner.js";

const $ = (s) => document.querySelector(s);
const fmt = (n, d = 0) => Number(n).toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d });
const hhmm = (sec) => { const m = Math.round(sec / 60); return `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(((m % 60) + 60) % 60).padStart(2, "0")}`; };
const dur = (sec) => { const neg = sec < 0, m = Math.round(Math.abs(sec) / 60); return `${neg ? "−" : ""}${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`; };
const distTxt = (m) => (m >= 1000 ? `${fmt(m / 1000, 1)} km` : `${fmt(Math.max(0, Math.round(m / 5) * 5))} m`);
const PPD = 4; // compass tape pixels per degree

let api = null, open = false, last3d = 0, lastKey = "";

export const hudIsOpen = () => open;

export function openHud(a) {
  api = a; open = true;
  const el = $("#hud");
  el.classList.remove("hidden"); el.setAttribute("aria-hidden", "false");
  sizeCanvas();
  buildTape();
  $("#hudPlay").textContent = api.isPlaying() ? "❚❚" : "▶";
  $("#hudPlay").onclick = () => api.togglePlay();
  $("#hudMap").onclick = () => api.toMap();
  $("#hudExit").onclick = () => api.exit();
  addEventListener("resize", sizeCanvas);
  lastKey = ""; last3d = 0;
}
export function closeHud() {
  open = false;
  const el = $("#hud");
  el.classList.add("hidden"); el.setAttribute("aria-hidden", "true");
  removeEventListener("resize", sizeCanvas);
}
function sizeCanvas() {
  const cv = $("#hudView"), s = Math.min(1, 1400 / innerWidth);
  cv.width = Math.round(innerWidth * s); cv.height = Math.round(innerHeight * s);
  lastKey = "";
}
function buildTape() {
  const names = { 0: "N", 45: "NE", 90: "E", 135: "SE", 180: "S", 225: "SW", 270: "W", 315: "NW" };
  let h = "";
  for (let d = -360; d <= 720; d += 15) {
    const n = ((d % 360) + 360) % 360;
    h += `<span class="${names[n] ? "maj" : ""}" style="left:${d * PPD}px">${names[n] || (n % 30 === 0 ? n : "·")}</span>`;
  }
  h += `<span class="tgt" id="hudTgt">▼</span>`;
  $("#hudTape").innerHTML = h;
}

export function updateHud(L) {
  if (!open) return;
  const tr = api.track, pts = tr.pts, st = L.st, o = api.opts;
  // 3D view: re-render when the position or heading changes (max ~20 fps)
  const now = performance.now();
  const key = `${st.dist.toFixed(1)}|${st.heading.toFixed(0)}`;
  if (key !== lastKey && now - last3d > 50) {
    lastKey = key; last3d = now;
    const pins = tr.stops.slice(1).filter((s) => pts[s.idx].dist > st.dist + 3).slice(0, 2)
      .map((s, k) => ({ lat: pts[s.idx].lat, lon: pts[s.idx].lon, label: s.stop.name, hi: k === 0 }));
    renderTerrainView($("#hudView"), api.site, { lat: st.lat, lon: st.lon, heading: st.heading, eyeH: tr.kind === "drive" ? 2.6 : 1.8, route: pts, dist: st.dist, pins });
  }
  // maneuver
  const m = L.man, man = $("#hudMan");
  man.classList.toggle("steep", L.disp.m?.type === "steep");
  if (L.done) { $("#hudManIco").innerHTML = maneuverIcon({ type: "arrive" }, 44); $("#hudManDist").textContent = "ARRIVED"; $("#hudManTxt").textContent = tr.kind === "drive" ? "Park and level the rover" : "You have arrived"; }
  else if (st.dwell > 0) { $("#hudManIco").innerHTML = maneuverIcon({ type: "arrive" }, 44); $("#hudManDist").textContent = `STOP ${dur(L.station?.left ?? 0)}`; $("#hudManTxt").textContent = tr.stops[st.dwell].stop.name; }
  else { $("#hudManIco").innerHTML = maneuverIcon(L.disp.m, 44); $("#hudManDist").textContent = distTxt(L.distTo); $("#hudManTxt").textContent = `${L.disp.text}${L.disp.sub ? " · " + L.disp.sub : ""}`; }
  // compass tape
  const tape = $("#hudTape"), w = tape.parentElement.clientWidth;
  tape.style.transform = `translateX(${w / 2 - st.heading * PPD}px)`;
  const nextStop = tr.stops.find((s, k) => k > 0 && pts[s.idx].dist > st.dist + 1);
  const tgt = $("#hudTgt");
  if (nextStop) {
    const p = pts[nextStop.idx], dy = (p.lat - st.lat) * api.site.mPerDegLat, dx = (p.lon - st.lon) * api.site.mPerDegLon;
    let b = (Math.atan2(dx, dy) * 180) / Math.PI; b = ((b % 360) + 360) % 360;
    let rel = ((b - st.heading + 540) % 360) - 180;
    tgt.style.left = `${(st.heading + rel) * PPD}px`; tgt.style.display = "";
    tgt.title = `${nextStop.stop.name} ${compassWord(b)}`;
  } else tgt.style.display = "none";
  // left column
  const box = (id, lvl) => { const b = $(id).closest(".hud-box"); b.classList.toggle("warn", lvl === "warn"); b.classList.toggle("bad", lvl === "bad"); };
  if (L.walk) {
    $("#hudK1").textContent = "O₂ LEFT";
    $("#hudV1").textContent = dur(L.o2Left);
    $("#hudBar1").style.width = `${Math.max(0, Math.min(1, L.o2Left / (o.plssHours * 3600))) * 100}%`;
    box("#hudV1", L.o2Left < o.reserveHours * 3600 ? "bad" : "");
    $("#hudK2").textContent = "WALK-BACK MARGIN";
    $("#hudV2").textContent = dur(L.margin);
    box("#hudV2", L.margin < 0 ? "bad" : L.margin < 1800 ? "warn" : "");
  } else {
    $("#hudK1").textContent = "SPEED";
    $("#hudV1").textContent = `${fmt(L.speed, 1)} km/h`;
    $("#hudBar1").style.width = `${Math.min(1, L.speed / o.roverSpeed) * 100}%`;
    box("#hudV1", "");
    $("#hudK2").textContent = "TILT / LIMIT";
    $("#hudV2").textContent = `${fmt(st.p.slope)}° / ${o.roverMaxSlope}°`;
    box("#hudV2", st.p.slope > o.roverMaxSlope * 0.85 ? "warn" : "");
  }
  $("#hudSky").textContent = `${fmt(L.sky * 100)}% open\n${L.sky < 0.9 ? "terrain shielding" : "exposed plain"}`;
  // right column
  $("#hudEta").textContent = `${hhmm(L.arrive)} LMST\n${distTxt(L.remainDist)} · ${dur(L.remainTime)}`;
  $("#hudSlope").textContent = `${fmt(L.slopeAhead)}°`;
  box("#hudSlope", L.slopeAhead > (L.walk ? 20 : o.roverMaxSlope * 0.85) ? "warn" : "");
  $("#hudSun").textContent = L.sun.el <= 0 ? "below horizon" : `${fmt(L.sun.el)}° ${compassWord(L.sun.az)}\n${L.shade ? "IN SHADOW" : "sunlit"}`;
  box("#hudSun", L.shade ? "warn" : "");
  // alert & station
  $("#hudAlert").classList.toggle("hidden", !L.alert);
  $("#hudAlert").textContent = L.alert ? `⚠ ${L.alert}` : "";
  const sc = $("#hudStation");
  if (L.station) {
    sc.classList.remove("hidden");
    sc.innerHTML = L.station.here ? `CHECKPOINT<br><b>${L.station.s.stop.name}</b><br>stop ${dur(L.station.left)} remaining` : `<b>${L.station.s.stop.name}</b> in ${distTxt(L.station.dist)}`;
  } else sc.classList.add("hidden");
  $("#hudClock").textContent = `LMST ${hhmm(L.lmst)} · ${fmt(st.p.elev)} m`;
  $("#hudPlay").textContent = api.isPlaying() ? "❚❚" : "▶";
  drawMini(L);
}

// heading-up minimap: route, no-go ground and next stop within 150 m
function drawMini(L) {
  const cv = $("#hudMini"), ctx = cv.getContext("2d"), W = cv.width, R = W / 2, site = api.site, st = L.st;
  const scale = R / 150, h = (st.heading * Math.PI) / 180, cs = Math.cos(h), sn = Math.sin(h);
  const toXY = (lat, lon) => { const e = (lon - st.lon) * site.mPerDegLon, n = (lat - st.lat) * site.mPerDegLat; return [R + (e * cs - n * sn) * scale, R - (e * sn + n * cs) * scale]; };
  ctx.clearRect(0, 0, W, W);
  ctx.save(); ctx.beginPath(); ctx.arc(R, R, R - 1, 0, Math.PI * 2); ctx.clip();
  ctx.fillStyle = "rgba(0,20,12,.55)"; ctx.fillRect(0, 0, W, W);
  ctx.fillStyle = "rgba(255,80,100,.55)";
  for (let y = -150; y <= 150; y += 8) for (let x = -150; x <= 150; x += 8) {
    const e = x * cs + y * sn, n = -x * sn + y * cs;
    const s = sampleAt(site, st.lat + n / site.mPerDegLat, st.lon + e / site.mPerDegLon);
    if (s && s.nogo) ctx.fillRect(R + x * scale - 3, R - y * scale - 3, 6, 6);
  }
  ctx.strokeStyle = "rgba(125,255,200,.95)"; ctx.lineWidth = 4; ctx.lineJoin = "round"; ctx.beginPath();
  let started = false;
  for (const p of api.track.pts) { if (Math.abs(p.dist - st.dist) > 260) continue; const [x, y] = toXY(p.lat, p.lon); started ? ctx.lineTo(x, y) : ctx.moveTo(x, y); started = true; }
  ctx.stroke();
  for (const s of api.track.stops.slice(1)) {
    const p = api.track.pts[s.idx], [x, y] = toXY(p.lat, p.lon);
    ctx.fillStyle = "#e8743b"; ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
  ctx.fillStyle = "#7dffc8"; ctx.beginPath(); ctx.moveTo(R, R - 10); ctx.lineTo(R + 7, R + 8); ctx.lineTo(R, R + 4); ctx.lineTo(R - 7, R + 8); ctx.closePath(); ctx.fill();
  ctx.fillStyle = "rgba(125,255,200,.8)"; ctx.font = "600 14px JetBrains Mono, monospace"; ctx.textAlign = "center";
  const nx = R - sn * (R - 14), ny = R - cs * (R - 14);
  ctx.fillText("N", nx, ny + 5);
}
