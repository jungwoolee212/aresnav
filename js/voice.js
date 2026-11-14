// Voice assistant: route setting while planning, and navigation help during guidance.
//  * Planning: "route from the landing plain to the upper boxwork ridges", "take me to the nearest
//    shelter", "start from 4.80 S 137.39 E", "add a checkpoint 300 metres east", "start navigation".
//  * Guidance: speaks turns, steep sections, checkpoints and safety alerts as they come up; answers
//    questions (oxygen, next turn, ETA, slope, sun, shelter...); obeys commands (pause, resume, faster,
//    slower, repeat, mute, HUD, end); "take me back to base" re-routes from the current position.
//  * Works fully onboard with no network: Mars-Earth light delay rules out a cloud assistant for
//    anything time-critical. If a Claude API key is entered in Settings, other requests also go to
//    Claude with a live snapshot, and Claude can plan routes through the same set_route logic.
// Browser APIs: speechSynthesis (output) and SpeechRecognition (input, Chrome / Edge / Safari).

import { bearingDeg, distM, inSite, cellOf, cellLatLon, passable, profileFor, horizons, skyOpen, MARS_R } from "./planner.js";
import { compassWord } from "./nav.js";
import { PLACES, SITES } from "./mission.js";
import { PLACES_DATA } from "./places.js";
import { inExtent } from "./terrain-live.js";
import { hasHangul, koToEnglish, koPlace, enToKo, romanize } from "./voice-ko.js";

const $ = (s) => document.querySelector(s);
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const SDK_URL = "https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@1.3.0/+esm";
const MODEL = "claude-opus-5-5";
const RATES = [10, 30, 60, 240];
const PREF_KEY = "marswalk.voice", PLACES_KEY = "marswalk.places";
const M_PER_DEG = (MARS_R * Math.PI) / 180;

const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const store = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
const prefs = { auto: true, key: "", lang: "en", ...load(PREF_KEY, {}) };
const KO = () => prefs.lang === "ko";
export const voiceLang = () => prefs.lang;
// everything the assistant says or shows goes through here: Korean when the voice language is Korean
const tr = (s) => (KO() && s && ((!hasHangul(s) && /[A-Za-z]{2,}/.test(s)) || /[A-Za-z]{2,}[\s,:]+[A-Za-z"(]{2,}/.test(s)) ? enToKo(s) : s);   // skip text that is already Korean
const savePrefs = () => store(PREF_KEY, prefs);
let userPlaces = load(PLACES_KEY, []).filter((p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lon) && p.name);

// ---------- spoken formatting ----------
const r10 = (m) => Math.max(10, Math.round(m / 10) * 10);
function spokenDist(m) {
  if (m >= 975) { const k = (m / 1000).toFixed(1).replace(/\.0$/, ""); return `${k} kilometre${k === "1" ? "" : "s"}`; }
  if (m >= 100) return `${Math.round(m / 50) * 50} metres`;
  return `${r10(m)} metres`;
}
function spokenDur(sec) {
  const neg = sec < 0, m = Math.round(Math.abs(sec) / 60), h = Math.floor(m / 60), mm = m % 60;
  const s = h ? `${h} hour${h > 1 ? "s" : ""}${mm ? ` ${mm} minute${mm > 1 ? "s" : ""}` : ""}` : `${mm} minute${mm === 1 ? "" : "s"}`;
  return neg ? `minus ${s}` : s;
}
const hhmm = (sec) => { const m = Math.round(sec / 60); return `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(((m % 60) + 60) % 60).padStart(2, "0")}`; };
// display strings from nav.js / app.js read aloud cleanly
const speakable = (s) => String(s)
  .replace(/·/g, ",").replace(/°/g, " degrees").replace(/O₂/g, "oxygen").replace(/−/g, "minus ")
  .replace(/(\d+)\s?m\b/g, "$1 metres").replace(/(\d+)\s?min\b/g, "$1 minutes").replace(/km\/h/g, "kilometres per hour")
  .replace(/\bLMST\b/g, "local time").replace(/\s+,/g, ",").replace(/\s{2,}/g, " ").trim();
const lc1 = (s) => (s ? s.charAt(0).toLowerCase() + s.slice(1) : s);
const placeNames = () => [...PLACES, ...userPlaces].map((p) => p.name).join(", ");
const siteNames = () => SITES.map((s) => s.name).join(", ");

// ---------- state ----------
let C = null;           // context from app.js
let rec = null, listening = false;
let current = null;     // utterance in progress {pri}
let lastSaid = "";
let ann = null;         // announcement bookkeeping for the current guidance
let home = null;        // where the EVA began (for "take me back to base")
let history = [];       // Claude conversation (append-only; restarted when long)
let claude = null;      // SDK client, loaded on first use
let mode = "plan";

export function initVoice(ctx) {
  C = ctx;
  $("#voiceForm").addEventListener("submit", (e) => { e.preventDefault(); const q = $("#voiceText").value.trim(); $("#voiceText").value = ""; if (q) handle(q); });
  $("#voiceMic").addEventListener("click", toggleListen);
  $("#voiceMute").addEventListener("click", () => setAuto(!prefs.auto));
  if (!SR) { $("#voiceMic").disabled = true; $("#voiceMic").title = "Voice input isn't supported in this browser. Type instead."; }
  if (!("speechSynthesis" in window)) $("#voiceMute").disabled = true;
  const auto = $("#inVoiceAuto"), key = $("#inVoiceKey");
  auto.checked = prefs.auto;
  auto.addEventListener("change", () => setAuto(auto.checked));
  key.value = prefs.key;
  key.addEventListener("change", () => { prefs.key = key.value.trim(); claude = null; history = []; savePrefs(); renderMode(); });
  $("#btnVoiceTest").addEventListener("click", () => say("Voice guidance is working. Try: route from the landing plain to the upper boxwork ridges.", 2, { force: true }));
  $("#inVoiceLang").value = prefs.lang;
  $("#inVoiceLang").addEventListener("change", (e) => setLang(e.target.value));
  $("#voiceLang").addEventListener("click", () => setLang(KO() ? "en" : "ko"));
  renderMute(); renderMode(); renderLang(); placePanel("plan"); C.onLang?.();
  $("#voice").dataset.ready = "1";
}

function placePanel(m) {
  mode = m;
  const p = $("#voice");
  if (m === "plan") { $("#planView").insertBefore(p, $("#pickBanner")); p.classList.add("in-plan"); p.classList.remove("hud-mode"); }
  else { document.body.appendChild(p); p.classList.remove("in-plan"); }
  p.classList.remove("hidden");
  $("#voiceText").placeholder = placeholder();
}
const placeholder = () => (KO() ? (mode === "plan" ? "말하거나 입력: ○○에서 ○○까지 안내해 줘" : "질문: 산소? 다음 방향? 대피소?")
  : mode === "plan" ? "Say or type: route from … to …" : "Ask: oxygen? next turn? shelter?");

function setLang(l) {
  prefs.lang = l === "ko" ? "ko" : "en"; savePrefs(); stopListening(); voiceCache = null;
  $("#inVoiceLang").value = prefs.lang; renderLang(); renderMode(); C.onLang?.();
  say(KO() ? "한국어 음성으로 바꿨습니다." : "Voice language set to English.", 2, { force: true, remember: false });
}
function renderLang() {
  const b = $("#voiceLang");
  b.textContent = KO() ? "한" : "EN";
  b.title = KO() ? "음성 언어: 한국어 (눌러서 영어로)" : "Voice language: English (tap for Korean)";
  b.setAttribute("aria-label", b.title);
  $("#voiceText").placeholder = placeholder();
}
function setAuto(on) {
  prefs.auto = on; savePrefs();
  $("#inVoiceAuto").checked = on;
  if (!on) stopSpeaking();
  renderMute();
}
function renderMute() {
  const b = $("#voiceMute");
  b.classList.toggle("off", !prefs.auto);
  b.setAttribute("aria-label", prefs.auto ? "Mute spoken guidance" : "Unmute spoken guidance");
  b.title = prefs.auto ? "Mute spoken guidance" : "Unmute spoken guidance";
  b.innerHTML = prefs.auto
    ? '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11"/></svg>'
    : '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M17 9l5 6M22 9l-5 6"/></svg>';
}
function renderMode() {
  $("#voiceMode").textContent = KO() ? (prefs.key ? `온보드 어시스턴트 + Claude (${MODEL})` : "온보드 어시스턴트 · 오프라인 작동")
    : prefs.key ? `Onboard assistant + Claude (${MODEL})` : "Onboard assistant · works offline";
}

// ---------- speech output ----------
// pri 1 = guidance, 2 = safety alert / answer. A newer prompt replaces an older one of the same or
// lower priority, so at high simulation speed the crew always hears the current instruction.
function say(text, pri = 1, { force = false, remember = true } = {}) {
  if (!text) return;
  if (remember) lastSaid = text;
  if (!("speechSynthesis" in window) || (!prefs.auto && !force)) return;
  const ss = window.speechSynthesis;
  if (ss.speaking && current && current.pri > pri) return;
  ss.cancel();
  const out = tr(text), ko = hasHangul(out);
  const u = new SpeechSynthesisUtterance(ko ? out.replace(/°/g, "도").replace(/·/g, ",") : speakable(out));
  const v = pickVoice(ko); if (v) u.voice = v;
  u.lang = v?.lang || (ko ? "ko-KR" : "en-US"); u.rate = ko ? 1.1 : 1.05;
  current = { pri };
  u.onend = u.onerror = () => { current = null; };
  ss.speak(u);
}
function stopSpeaking() { try { window.speechSynthesis.cancel(); } catch {} current = null; }
let voiceCache = null;
function pickVoice(ko = false) {
  const key = ko ? "ko" : "en";
  if (voiceCache?.[key] !== undefined) return voiceCache[key];
  const vs = window.speechSynthesis.getVoices();
  const v = ko ? vs.find((x) => /ko[-_]KR/i.test(x.lang) && /Google|Natural|SunHi|Heami|Yuna/i.test(x.name)) || vs.find((x) => /^ko/i.test(x.lang)) || null
    : vs.find((x) => /en-US/i.test(x.lang) && /Google|Natural|Samantha|Aria|Jenny/i.test(x.name)) || vs.find((x) => /^en/i.test(x.lang)) || null;
  if (vs.length) (voiceCache ||= {})[key] = v;
  return v;
}
if ("speechSynthesis" in window) window.speechSynthesis.addEventListener?.("voiceschanged", () => { voiceCache = null; });

// ---------- automatic guidance ----------
// intro: undefined = standard spoken start, false = silent (the caller speaks), string = say this first
export function voiceNavStart(Lv, intro) {
  ann = { far: new Set(), now: new Set(), alert: "", alertAt: 0, t: Lv.t };
  placePanel("nav");
  const S = C.S;
  if (S.start && S.start.name !== "Current position") home = { lat: S.start.lat, lon: S.start.lon, name: S.start.name || "the start" };
  const m = Lv.man, tr = S.track;
  if (m && m.type === "depart") { ann.far.add(m); ann.now.add(m); }
  if (intro === false) return;
  const first = m ? `${m.text}${m.sub ? `, ${m.sub}` : ""}. ` : "";
  say(`${intro ? `${intro} ` : ""}Guidance started. ${first}${spokenDist(tr.total.dist)} to go, about ${spokenDur(tr.total.time)}. Arrival around ${hhmm(Lv.arrive)} local time.`, 2);
}
export function voiceNavEnd() {
  ann = null; stopListening();
  placePanel("plan");
}

export function voiceTick(Lv) {
  if (!ann) return;
  const hud = !$("#hud").classList.contains("hidden");
  $("#voice").classList.toggle("hud-mode", hud);
  // scrubbing backwards: forget what was announced past the current position
  if (Lv.t < ann.t - 1) for (const s of [ann.far, ann.now]) for (const m of [...s]) if (m.d > Lv.st.dist) s.delete(m);
  // scrubbing forwards: don't read out everything that was skipped
  for (const m of C.S.mans) if (m.d < Lv.st.dist - 1 && m !== Lv.man) { ann.far.add(m); ann.now.add(m); }
  ann.t = Lv.t;

  if (Lv.alert && Lv.alert !== ann.alert) {
    const now = performance.now();
    if (now - ann.alertAt > 4000) { say(`Caution. ${Lv.alert}.`, 2); ann.alert = Lv.alert; ann.alertAt = now; }
  } else if (!Lv.alert) ann.alert = "";

  if (Lv.done) return;
  const m = Lv.man;
  if (!m || Lv.st.dwell > 0) return;
  const NEAR = Lv.walk ? 12 : 30, FAR = Lv.walk ? 80 : 200, d = Lv.distTo;
  if (d <= NEAR && !ann.now.has(m)) {
    ann.now.add(m); ann.far.add(m);
    say(nowPhrase(m), m.type === "arrive" ? 2 : 1);
  } else if (d <= FAR && d > NEAR * 2 && !ann.far.has(m)) {
    ann.far.add(m);
    say(`In ${spokenDist(d)}, ${lc1(m.text)}${m.sub ? `, ${m.sub}` : ""}.`, 1);
  }
}
function nowPhrase(m) {
  if (m.type === "arrive") {
    if (/^Arrive/.test(m.text)) return `${m.text.replace(/^Arrive at/, "You have arrived at")}. End of route.`;
    return `${m.text}. ${m.sub || ""}`;
  }
  if (m.type === "steep") return `${m.text.split(" ·")[0]} starts now. ${m.sub?.split(" · ")[1] || ""}`;
  return `${m.text} now${m.sub ? `, ${m.sub}` : ""}.`;
}

// ---------- speech input ----------
// Among the recogniser's guesses, prefer one that parses as a command or names a known place.
function pickAlternative(res) {
  const alts = Array.from({ length: res.length }, (_, k) => res[k].transcript);
  const ok = (t) => { const q = clean(hasHangul(t) ? koToEnglish(t) : t); return !hasHangul(q) && (routeCommandMatches(q) || /oxygen|next|how far|slope|danger|sun|shelter|checkpoint|elevation|time|where am i|status|help|pause|resume|repeat|mute|hud|map|3d|2d|refine|end navigation|start navigation/.test(q)); };
  return alts.find(ok) || alts[0];
}
function toggleListen() { listening ? stopListening() : startListening(); }
export function voiceToggleListen() { toggleListen(); }
// run a phrase as if the crew had said it (used by the on-screen emergency buttons)
export function voiceAsk(text) { return handle(text); }
function startListening() {
  if (!SR) { $("#voiceText").focus(); return; }
  stopSpeaking();
  rec = new SR();
  rec.lang = KO() ? "ko-KR" : "en-US"; rec.interimResults = true; rec.maxAlternatives = 5; rec.continuous = false;
  let final = "";
  rec.onresult = (e) => {
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (e.results[i].isFinal) final += pickAlternative(e.results[i]); else interim += e.results[i][0].transcript;
    }
    $("#voiceText").value = final || interim;
  };
  rec.onerror = (e) => {
    const msg = e.error === "not-allowed" || e.error === "service-not-allowed" ? (KO() ? "마이크 권한이 막혀 있습니다. 브라우저에서 허용하거나 입력창에 적어 주세요." : "Microphone access is blocked. Allow it in the browser, or type instead.")
      : e.error === "no-speech" ? (KO() ? "아무 소리도 듣지 못했습니다. 마이크를 다시 누르세요." : "I didn't hear anything. Tap the mic and try again.")
      : e.error === "network" ? (KO() ? "이 브라우저의 음성 인식은 인터넷 연결이 필요합니다. 입력창에 적어 주세요." : "Speech recognition needs a network connection in this browser. Type instead.") : "";
    if (msg) log(null, msg);
  };
  rec.onend = () => {
    listening = false; $("#voiceMic").classList.remove("on"); $("#voiceText").placeholder = placeholder();
    const q = final.trim(); $("#voiceText").value = "";
    if (q) handle(q);
  };
  try { rec.start(); listening = true; $("#voiceMic").classList.add("on"); $("#voiceText").placeholder = KO() ? "듣고 있습니다…" : "Listening…"; }
  catch { listening = false; }
}
function stopListening() {
  try { rec?.stop(); } catch {}
  listening = false; $("#voiceMic")?.classList.remove("on");
  const t = $("#voiceText"); if (t) t.placeholder = placeholder();
}

// ---------- understanding ----------
const clean = (s) => s.toLowerCase().replace(/[’`]/g, "'").replace(/[!?;]+/g, " ").replace(/\.(?!\d)/g, " ")
  .replace(/^(hey |ok |okay )?(assistant|navigator|computer)[, ]+/, "").replace(/^((please|can you|could you|would you|will you|i'd like you to)\s+)+/, "")
  .replace(/\s+please$/, "").replace(/,/g, " ").replace(/\s+/g, " ").trim()
  // everyday phrasings for questions the parser already answers
  .replace(/^.*\b(?:can|could|will|do) (?:i|we) (?:make it|get|walk|drive|have time to (?:get|go)) back\b.*$/, "how long to walk back")
  .replace(/^.*\b(?:am i|are we) (?:going|heading|walking|on) (?:the )?(?:right|correct) (?:way|track|direction|route|path)\b.*$|^.*\bon (?:the right )?track\b.*$/, "what's next")
  .replace(/^.*\b(?:are we (?:there|close)(?: yet)?|almost there|nearly there)\b.*$/, "how far to go")
  .replace(/^.*\b(?:(?:get|take) (?:me|us) (?:to|under) cover|take cover|find cover)\b.*$/, "take me to the nearest shelter");

// requests run one at a time, in the order they were said
let queue = Promise.resolve();
function handle(raw) { queue = queue.then(() => handleRaw(raw)).catch(() => {}); return queue; }
async function handleRaw(raw) {
  // a Korean sentence can carry several commands ("A 거쳐서 B까지 안내해 줘" = route + checkpoint + start)
  const parts = hasHangul(raw) ? koToEnglish(raw).split(" ;; ") : [raw];
  if (parts.length > 1) { for (const p of parts) await handleOne(raw, p); return; }
  return handleOne(raw, parts[0]);
}
async function handleOne(raw, text) {
  const q = clean(text), Lv = C.live();
  const rc = routeCommand(q);
  if (rc) {
    log(raw, "Working on it…");
    let text;
    try { text = await rc; } catch (e) { text = `Sorry, that didn't work: ${e.message}`; }
    if (text) reply(raw, text);
    else log(raw, C.live() ? "Guidance started." : "Done.");   // the guidance start already spoke
    return;
  }
  const cmd = command(q, !!Lv);
  if (cmd) { log(raw, cmd); say(cmd, 2, { force: true, remember: false }); return; }
  const local = Lv ? answer(q, Lv) : planAnswer(q);
  if (!prefs.key) { reply(raw, local); return; }
  log(raw, "Thinking…");
  try {
    const text = await askClaude(raw, C.live());
    reply(raw, text || local, !text);
  } catch (e) {
    reply(raw, local, true, e?.status === 401 ? "Claude key rejected: onboard answer" : "Claude unreachable: onboard answer");
  }
}
function reply(q, text, onboard = false, note = "") {
  log(q, text, note || (prefs.key && onboard ? "onboard answer" : ""));
  say(text, 2, { force: true });
}

const has = (q, re) => re.test(q);
function command(q, nav) {
  if (has(q, /\b(help|what can (i|you)|commands?)\b/)) return nav
    ? "Ask me about oxygen, the next turn, time to arrival, slope, dangers, sunlight, shelter or the next checkpoint. Say pause, resume, faster, slower, repeat, mute, open HUD, take me back to base, take me to the nearest shelter, or end navigation."
    : `Say a route, like: route from the landing plain to the upper boxwork ridges. Places can be names (${placeNames()}), nearest shelter, highest point, a distance and direction like 500 metres north, or coordinates. Then say start navigation.`;
  if (has(q, /\b(repeat|say (that|it) again|pardon|come again)\b/)) return lastSaid || "Nothing to repeat yet.";
  if (has(q, /\b3d\b|three.?d|3 d view/)) { C.setView("3d"); return "Showing the 3D terrain."; }
  if (has(q, /\b2d\b|flat map|two.?d/)) { C.setView("2d"); return "Back to the 2D map."; }
  if (has(q, /\brefine\b|higher resolution|more detail|finer (grid|terrain)/)) return C.refine() ? "Re-analysing the terrain along this route on a finer grid." : "There's no route to refine yet.";
  if (has(q, /\b(unmute|voice on|sound on|speak again)\b/)) { setAuto(true); return "Spoken guidance is on."; }
  if (has(q, /\b(mute|be quiet|quiet|silence|voice off|sound off)\b/)) { setTimeout(() => setAuto(false), 1800); return "Muting spoken guidance. I'll still answer your questions out loud."; }
  const navOnly = (r) => (nav ? r() : "Guidance hasn't started. Plan a route, then say start navigation.");
  if (has(q, /\b(end|exit|cancel|stop|finish)\b.*\b(navigation|guidance|nav)\b/)) return navOnly(() => { C.endNav(); return "Ending navigation."; });
  if (has(q, /\b(faster|speed up)\b/)) return navOnly(() => setRate(+1));
  if (has(q, /\b(slower|slow down)\b/)) return navOnly(() => setRate(-1));
  if (has(q, /\b(open|show|switch to)\b.*\b(hud|helmet|heads.?up)\b/) || q === "hud") return navOnly(() => { C.openHud(); return "Opening the helmet display."; });
  if (has(q, /\b(close|hide)\b.*\b(hud|helmet)\b|\b(show|back to)\b.*\bmap\b/)) return navOnly(() => { C.closeHud(); return "Back to the map."; });
  if (has(q, /\b(next stop|checkpoint|waypoint)\b/)) return null; // a question, not "stop"
  if (has(q, /^(pause|hold on|hold|wait|freeze|stop)\b/)) return navOnly(() => { C.setPlaying(false); return "Paused."; });
  if (has(q, /^(resume|continue|go on|keep going|unpause|carry on)\b/)) return navOnly(() => { C.setPlaying(true); return "Resuming guidance."; });
  return null;
}
function setRate(dir) {
  const cur = C.getRate(), i = RATES.indexOf(cur), n = RATES[Math.max(0, Math.min(RATES.length - 1, (i < 0 ? 2 : i) + dir))];
  if (n === cur) return dir > 0 ? `Already at the fastest simulation speed, ${n} times.` : `Already at the slowest simulation speed, ${n} times.`;
  C.setRate(n);
  return `Simulation speed ${n} times.`;
}

// ---------- places ----------
const BEARINGS = { north: 0, "north east": 45, northeast: 45, east: 90, "south east": 135, southeast: 135, south: 180, "south west": 225, southwest: 225, west: 270, "north west": 315, northwest: 315 };
const NUMS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twenty: 20, thirty: 30, forty: 40, fifty: 50, hundred: 100 };
function numberOf(s) {
  s = s.trim();
  if (/^\d+(\.\d+)?$/.test(s)) return +s;
  if (/^half( a| an)?$/.test(s)) return 0.5;
  let total = 0, cur = 0;
  for (const w of s.split(/[\s-]+/)) {
    if (w === "and") continue;
    if (w === "hundred") cur = (cur || 1) * 100;
    else if (w === "thousand") { total += (cur || 1) * 1000; cur = 0; }
    else if (NUMS[w] != null) cur += NUMS[w];
    else return null;
  }
  return total + cur || null;
}
const here = () => { const Lv = C.live(); return Lv ? { lat: Lv.st.lat, lon: Lv.st.lon, name: "Current position" } : null; };
const ptOf = (p, name) => ({ lat: p.lat, lon: p.lon, name: name ?? p.name ?? null });
const NEAR_START_M = 5000;   // when the destination is out of reach, the route starts this far from it
function offset(p, brgDeg, m) {
  const r = (brgDeg * Math.PI) / 180;
  return { lat: p.lat + (Math.cos(r) * m) / M_PER_DEG, lon: p.lon + (Math.sin(r) * m) / (M_PER_DEG * Math.cos((p.lat * Math.PI) / 180)) };
}


// ---------- every place Trek marks, with fuzzy matching ----------
// Bookmarks, mission waypoints and the 1,783 IAU names. Names are compared on a phonetic key so speech-
// recognition slips ("olimpus mons") and Korean pronunciations ("올림푸스 산") still find "Olympus Mons".
const GENERIC = /^the\s+|\b(buttes?|craters?|mons|montes|vallis|valles|planitia|planum|chasma|chasmata|tholus|patera|fossae?|colles|mensae?|dorsum|dorsa|labyrinthus|landing site|landing area|site)\b/g;
function canon(s) {
  return String(s).toLowerCase().replace(GENERIC, " ").replace(/ph/g, "f").replace(/th/g, "t").replace(/sh/g, "s").replace(/ch/g, "k")
    .replace(/[cqkg]/g, "k").replace(/[bpfv]/g, "p").replace(/[dt]/g, "t").replace(/[jzsx]/g, "s").replace(/[lr]/g, "r").replace(/y/g, "i").replace(/w/g, "u")
    .replace(/[^a-z]/g, "").replace(/(.)\1+/g, "$1");
}
function ratio(a, b) {
  if (!a || !b) return 0;
  if (Math.abs(a.length - b.length) > Math.max(a.length, b.length) * 0.5) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return 1 - prev[b.length] / Math.max(a.length, b.length);
}
let marked = null;
function markedPlaces() {
  if (marked) return marked;
  marked = [
    ...PLACES_DATA.bookmarks.map((b) => ({ name: b.name, lat: b.lat, lon: b.lon, aliases: [b.name.toLowerCase()], site: { lat: b.lat, lon: b.lon, zoom: 6, bounds: b.bbox[2] - b.bbox[0] < 60 ? [[b.bbox[1], b.bbox[0]], [b.bbox[3], b.bbox[2]]] : null } })),
    ...PLACES_DATA.waypoints.map(([name, m, lat, lon]) => ({ name, lat, lon, aliases: [name.toLowerCase(), `${m} ${name}`.toLowerCase()], site: { lat, lon, zoom: 15 } })),
    ...PLACES_DATA.names.map(([name, lat, lon, k]) => ({ name, lat, lon, aliases: [name.toLowerCase()], site: { lat, lon, zoom: k === "Crater" ? 10 : 7 } })),
  ];
  for (const p of marked) { p.key = canon(p.name); p.skel = p.key.replace(/[aeiou]/g, ""); }
  return marked;
}
const KIND_KO = [[/산|몬스/, "mons"], [/크레이터|분화구/, "crater"], [/협곡|계곡|발리스|발레스/, "vall"], [/평원|플라니티아/, "planitia"], [/고원|플라눔/, "planum"], [/테라/, "terra"]];
function fuzzyPlace(text, min = 0.78, said = text) {
  const k = canon(text); if (k.length < 4) return null;
  const kinds = [...(String(said).toLowerCase().match(/mons|crater|vall|planitia|planum|terra|chasma|tholus|patera|fossa/g) || []), ...KIND_KO.filter(([re]) => re.test(said)).map(([, k2]) => k2)];
  let best = null, bs = 0;
  const sk = k.replace(/[aeiou]/g, "");
  for (const p of markedPlaces()) {
    const full = ratio(k, p.key), skel = sk.length >= 3 && p.skel.length >= 3 ? ratio(sk, p.skel) * 0.9 : 0;
    const r = Math.max(full, skel) + (kinds.some((w) => p.name.toLowerCase().includes(w)) ? 0.05 : 0);
    if (r > bs) { bs = r; best = p; }
  }
  return bs >= min ? best : null;
}

// Resolve a spoken place to {lat, lon, name} or {error}.
async function resolvePlace(raw, depth = 0) {
  const S = C.S, rawKo = hasHangul(raw) ? raw : null;
  if (rawKo) raw = koPlace(raw);
  const t0 = clean(raw).trim(), named = markedPlaces().find((p) => p.aliases.includes(t0));
  if (named && /^the /.test(t0)) return { ...ptOf(named), site: named.site };
  // "200 m left", "1 km ahead", "a bit to the right": relative to the way you're heading
  const rel = t0.match(/^(?:(.+?)\s*(m|metres?|meters?|km|kilometres?|kilometers?)\s+|(?:a bit|a little|slightly)\s+)?(?:to (?:my|the)\s+)?(left|right|ahead|forward|straight ahead|straight|back|behind)$/);
  if (rel && depth < 2) {
    const n = rel[1] ? numberOf(rel[1]) : 100; if (n == null) return { error: `I didn't understand the distance "${rel[1]}".` };
    const metres = rel[2] && /^k/.test(rel[2]) ? n * 1000 : n, Lv = C.live();
    const head = Lv ? Lv.st.heading : S.start && S.end ? bearingDeg([S.start.lat, S.start.lon], [S.end.lat, S.end.lon]) : null;
    const base = here() || (S.start && ptOf(S.start, S.start.name || "the start"));
    if (head == null || !base) return { error: "Left or right of what? Before guidance starts, use compass directions, like 200 metres north." };
    const turn = { left: -90, right: 90, back: 180, behind: 180 }[rel[3]] ?? 0;
    return checkArea({ ...offset(base, (head + turn + 360) % 360, metres), name: `${Math.round(metres)} m ${rel[3].replace("straight ahead", "ahead").replace("straight", "ahead").replace("forward", "ahead").replace("behind", "back")} of ${here() ? "your position" : "the start"}` });
  }
  let t = clean(raw).replace(/([a-z])-([a-z])/g, "$1 $2").replace(/^(the|a)\s+/, "").replace(/\s+(please|now)$/, "").trim();
  if (/^(here|my (current )?(position|location)|current (position|location)|where i am( now)?|this (spot|place|point))$/.test(t))
    return here() || { error: "Before guidance starts I don't know where you are. Name a place, or tap the map." };
  if (/^(start|starting point|start point|origin|base|home|camp|habitat|where (i|we) (started|began)|beginning)$/.test(t)) {
    const p = home || S.start; return p ? ptOf(p, p.name || "the start") : { error: "There's no start yet." };
  }
  if (/^(destination|end|finish|goal|end point)$/.test(t)) return S.end ? ptOf(S.end, S.end.name || "the destination") : { error: "There's no destination yet." };
  let m = t.match(/^checkpoint (\d+|[a-z]+)$/);
  if (m) { const k = numberOf(m[1]); const c = S.cps[(k || 0) - 1]; if (c) return ptOf(c); }
  const cp = S.cps.find((c) => c.name && c.name.toLowerCase() === t); if (cp) return ptOf(cp);

  // terrain-derived places
  if (/\b(shelter|cover|safe (spot|place)|hiding place)\b/.test(t)) return findShelter();
  if (/\b(highest|summit|top)\b/.test(t)) return extreme(+1);
  if (/\b(lowest|bottom)\b/.test(t)) return extreme(-1);

  // "500 metres north", "1.5 km south east of the landing plain"
  m = t.match(/^(.+?)\s*(m|metres?|meters?|km|kilometres?|kilometers?)\s+(?:to the\s+|due\s+)?(north\s?east|north\s?west|south\s?east|south\s?west|north|south|east|west)(?:\s+(?:of|from)\s+(.+))?$/);
  if (m && depth < 2) {
    const n = numberOf(m[1]); if (n == null) return { error: `I didn't understand the distance "${m[1]}".` };
    const metres = /^k/.test(m[2]) ? n * 1000 : n;
    const base = m[4] ? await resolvePlace(m[4], depth + 1) : here() || (S.start ? ptOf(S.start, S.start.name || "the start") : null);
    if (!base) return { error: "A distance and direction from where? Set a start first, or say 'of' a place." };
    if (base.error) return base;
    const brg = BEARINGS[m[3].replace(/\s+/, " ")] ?? BEARINGS[m[3].replace(/\s+/, "")];
    return checkArea({ ...offset(base, brg, metres), name: `${m[1]} ${/^k/.test(m[2]) ? "km" : "m"} ${m[3]} of ${m[4] ? base.name || "the start" : here() ? "your position" : "the start"}` });
  }
  // coordinates: "4.80 south 137.39 east", "-4.8 137.39"
  m = t.match(/^(-?\d+(?:\.\d+)?)\s*(?:°|degrees?)?\s*(n|s|north|south)?\s+(-?\d+(?:\.\d+)?)\s*(?:°|degrees?)?\s*(e|w|east|west)?$/);
  if (m) {
    let lat = +m[1], lon = +m[3];
    if (m[2] && /^s/.test(m[2])) lat = -Math.abs(lat); if (m[2] && /^n/.test(m[2])) lat = Math.abs(lat);
    if (m[4] && /^w/.test(m[4])) lon = 360 - Math.abs(lon);
    return checkArea({ lat, lon, name: `${Math.abs(lat).toFixed(3)} ${lat < 0 ? "South" : "North"} ${lon.toFixed(3)} East` });
  }
  // named places (built-in and saved)
  const all = [...PLACES, ...userPlaces.map((p) => ({ ...p, aliases: [p.name.toLowerCase()] })), ...SITES.map((x) => ({ ...x, site: true }))];
  // exact names among everything Trek marks (bookmarks, waypoints, IAU names)
  const exact = markedPlaces().find((p) => p.aliases.includes(t));
  if (exact && !all.some((p) => p.name.toLowerCase() === t || (p.aliases || []).includes(t))) return { ...ptOf(exact), site: exact.site };
  let best = null, bestLen = 0;
  for (const p of all) for (const a of [p.name.toLowerCase(), ...(p.aliases || [])]) {
    if (t === a) return p.site ? { ...ptOf(p), site: p } : ptOf(p);
    if ((t.includes(a) || a.includes(t)) && Math.min(a.length, t.length) > bestLen && Math.min(a.length, t.length) >= 4) { best = p; bestLen = Math.min(a.length, t.length); }
  }
  if (best) return best.site ? { ...ptOf(best), site: best } : ptOf(best);
  // close spellings, then Korean pronunciations of foreign names
  const fz = (!hasHangul(t) && fuzzyPlace(t)) || (rawKo && (fuzzyPlace(romanize(rawKo), 0.72, rawKo) || fuzzyPlace(romanize(raw), 0.72, rawKo)));
  if (fz) return { ...ptOf(fz), site: fz.site };
  return { error: `I don't know "${raw}". Known places: ${placeNames()}. Sites: ${siteNames()}. You can also say nearest shelter, highest point, a distance and direction like 500 metres north, or coordinates.` };
}
const checkArea = (p) => (inExtent(p.lat, p.lon) ? p : { error: `${p.name} is too close to a pole for this map. Pick a point between 88 south and 88 north.` });

// Most sheltered (least open sky) usable spot within 400 m of the crew, or of the start while planning.
function findShelter() {
  const S = C.S, site = S.site, o = here() || (S.start && ptOf(S.start, S.start.name || "the start"));
  if (!o) return { error: "Nearest shelter to where? Set a start first." };
  if (!inSite(site, o.lat, o.lon)) return { error: "The terrain around there isn't loaded yet. Plan a route there first, then ask again." };
  const prof = profileFor(S.mode, S.opts), skyHere = skyOpen(horizons(site, o.lat, o.lon));
  // look close first; if nothing there is meaningfully more enclosed than where you stand, look further
  const search = (R, step) => {
    let best = null;
    for (let dy = -R; dy <= R; dy += step) for (let dx = -R; dx <= R; dx += step) {
      const d = Math.hypot(dx, dy); if (d > R) continue;
      const lat = o.lat + dy / M_PER_DEG, lon = o.lon + dx / (M_PER_DEG * Math.cos((o.lat * Math.PI) / 180));
      if (!inSite(site, lat, lon) || !passable(site, cellOf(site, lat, lon), prof)) continue;
      const sky = skyOpen(horizons(site, lat, lon)), score = sky + d / (R * 10);
      if (!best || score < best.score) best = { lat, lon, sky, score, d };
    }
    return best;
  };
  // a "shelter" has to block clearly more sky than where you stand: widen the search until one does
  let best = null;
  for (const [R, step] of [[400, 25], [1500, Math.max(50, site.cell_m * 3)], [3000, Math.max(100, site.cell_m * 5)], [6000, Math.max(150, site.cell_m * 8)]]) {
    const b = search(R, step);
    if (b && (!best || b.sky < best.sky - 0.02)) best = b;
    if (best && skyHere - best.sky >= 0.1) break;
  }
  const blocks = (sky) => Math.round((1 - sky) * 100);
  if (!best || skyHere - best.sky < 0.05)
    return { error: `There's no real shelter near here: the terrain blocks only ${blocks(skyHere)} percent of the sky where you are, and no reachable spot within 6 kilometres blocks much more. Terrain only shields you where cliffs or crater walls block the sky. In a solar storm, head back to base: say take me back to base.` };
  return { lat: best.lat, lon: best.lon, name: `Nearest shelter (terrain blocks ${blocks(best.sky)}% of the sky)`,
    shelterNote: `The terrain blocks ${blocks(skyHere)} percent of the sky here and ${blocks(best.sky)} percent there.` };
}
function extreme(sign) {
  const S = C.S, site = S.site, prof = profileFor(S.mode, S.opts);
  let bk = -1, bv = -Infinity;
  for (let k = 0; k < site.nx * site.ny; k++) if (passable(site, k, prof) && sign * site.elev[k] > bv) { bv = sign * site.elev[k]; bk = k; }
  if (bk < 0) return { error: "No usable ground found in the analysed area." };
  const [lat, lon] = cellLatLon(site, bk);
  return { lat, lon, name: `${sign > 0 ? "Highest" : "Lowest"} point (${Math.round(site.elev[bk])} m)` };
}

// ---------- route commands ----------
// does this (English) text look like a route request? used to choose between recognition alternatives
const routeCommandMatches = (q) => /^(route|show|take|guide|bring|lead|navigate|go|head|start|begin|set|add|switch|save|clear|example|from|how (do|can)|directions|i want|let's go)\b/.test(q);
function routeCommand(q) {
  const nav = !!C.live();
  let m;
  if ((m = q.match(/^(?:(?:show|give|find|plan|get|tell|make)\s+(?:me\s+|us\s+)?)?(?:a\s+|the\s+)?(?:route|path|way|directions?|navigation|traverse)\s+(?:to|towards?|for)\s+(.+)$/))
    || (m = q.match(/^(?:how (?:do|can|would|should) (?:i|we) (?:get|go|walk|drive) to|how to get to|how far is it to|i want a route to)\s+(.+)$/)))
    return setRoute({ end: m[1], fromHere: true });
  if ((m = q.match(/^(?:show(?: me)?|fly to|zoom to|go to the site|take me to the site|open|jump to|move the map to)\s+(.+)$/)) && !nav && !/\b(?:hud|helmet|heads.?up|map|example|demo|3d|2d|settings|help)\b/.test(m[1]))
    return resolvePlace(m[1]).then((p) => { if (p.error) return p.error; if (p.site) C.flyTo(p.site); else C.flyTo({ lat: p.lat, lon: p.lon, zoom: 15 });
      return `Showing ${p.name}. Say start from a place there, or tap the map, to plan a route.`; });
  if ((m = q.match(/^(?:(?:plan|make|find|give me|show me|get me|set|create|i need|i want)\s+(?:me\s+)?(?:a\s+|the\s+)?(?:route|path|way|traverse)\s+)?(?:(?:route|path|go|walk|drive|navigate)\s+)?from\s+(.+?)\s+to\s+(.+?)(?:\s+(?:and|then)\s+(start|go|navigate|begin|guide me)\b.*)?$/)))
    return setRoute({ start: m[1], end: m[2], go: !!m[3] });
  if (/^(?:(?:go|head|take me|bring me|guide me|get me|walk me|drive me|lead me|return|navigate|turn)\s+)?(?:back\s+)?(?:home|to (?:the )?(?:start|base|camp|habitat|starting point))$/.test(q) && /\b(back|home|return)\b/.test(q) || /^(go|head|turn) back$|^return$|^abort( the)? (eva|route|traverse)$/.test(q))
    return setRoute({ end: "base", fromHere: true });
  if ((m = q.match(/^(?:(?:take|guide|bring|lead|get|route|walk|drive)\s+(?:me|us)\s+(?:to|towards?)|(?:navigate|go|head|drive|walk|travel)\s+(?:to|towards?)|(?:i want to go|i need to go|let's go|lets go)\s+to)\s+(.+)$/)))
    return setRoute({ end: m[1], fromHere: true });
  if ((m = q.match(/^(?:start|begin|depart|leave|i'm|i am|we're|we are)\s+(?:from|at)\s+(.+)$/)) || (m = q.match(/^(?:set\s+)?(?:the\s+)?start(?:ing point)?\s+(?:to|at|as|is)\s+(.+)$/)))
    return setRoute({ start: m[1] });
  if ((m = q.match(/^(?:set\s+)?(?:the\s+)?destination\s+(?:to|at|as|is)\s+(.+)$/)))
    return setRoute({ end: m[1] });
  if ((m = q.match(/^add\s+(?:a\s+)?(?:checkpoint|stop|waypoint)\s+(?:at|to|near|in|by)?\s*(.+)$/)))
    return setRoute({ addCp: m[1] });
  if (!nav && /^(start|begin)( the)?( navigation| guidance| nav| route| eva| walk| drive)?$|^let's go$|^go( now)?$|^guide me$/.test(q))
    return Promise.resolve(C.startNav() ? "" : C.S.error || "There's no route yet. Say a route first, like: route from the landing plain to the upper boxwork ridges.");
  if (/\b(rover|drive|driving)\b/.test(q) && /\b(switch|use|mode|change|take)\b/.test(q)) return setRoute({ mode: "drive" });
  if (/\b(on foot|walk|walking|suit)\b/.test(q) && /\b(switch|use|mode|change)\b/.test(q)) return setRoute({ mode: "walk" });
  if (/\b(example|demo) route\b/.test(q)) { C.exampleRoute(); return waitPlan("Loading the example route."); }
  if (/^(clear|reset)( the)? route$/.test(q)) { C.clearRoute(); return Promise.resolve("Route cleared. Where do you start?"); }
  if ((m = q.match(/^(?:save|mark|name|call|remember)\s+(this spot|this place|this point|this|here|my position|current position|the start|start|the destination|destination)\s+as\s+(.+)$/)))
    return savePlace(m[1], m[2]);
  if (/\b(what|which|list|known) (places|sites)\b|where can (i|we) go/.test(q)) return Promise.resolve(`Sites: ${siteNames()}. Places: ${placeNames()}. I can also find the nearest shelter, the highest or lowest point, a spot by distance and direction, or coordinates anywhere on Mars. The sharpest terrain is in the outlined regions.`);
  return null;
}

async function setRoute({ start, end, addCp, mode: newMode, go = false, fromHere = false }) {
  const S = C.S, nav = !!C.live(), spec = {};
  if (newMode) { if (newMode === S.mode) return `Already in ${newMode === "drive" ? "rover" : "on-foot"} mode.`; spec.mode = newMode; }
  if (start) { const p = await resolvePlace(start); if (p.error) return p.error; spec.start = p; }
  else if (fromHere && nav) spec.start = here();
  shelterNote = "";
  if (end) {
    const p = end === "base" ? (home || S.start ? ptOf(home || S.start, (home || S.start).name || "the start") : { error: "There's no start to go back to." }) : await resolvePlace(end);
    if (p.error) return p.error;
    if (p.shelterNote) shelterNote = `${p.shelterNote} `;
    if (p.site && !nav && !(spec.start || S.start)) C.flyTo(p.site);
    spec.end = p;
  }
  if (addCp) { const p = await resolvePlace(addCp); if (p.error) return p.error; spec.addCp = p; }
  if (fromHere && nav) spec.cps = [];   // a new destination mid-route replaces the old plan
  let farNote = "";
  {
    const a = spec.start || S.start, b = spec.end || S.end;
    // "go to Olympus Mons" with no start, or with a start on the other side of Mars: begin the walk a few km from it
    // (on the side facing the old start) instead of stopping at "pick a start"
    if (b && spec.end && !nav && !spec.start && end !== "base") {
      const km = a ? distM([a.lat, a.lon], [b.lat, b.lon]) / 1000 : 0;
      if (!a || km > 1500 || Math.abs(a.lon - b.lon) > 180) {
        let brg = 180;
        if (a) { let dl = a.lon - b.lon; dl = ((dl + 540) % 360) - 180; brg = ((Math.atan2(dl * Math.cos((b.lat * Math.PI) / 180), a.lat - b.lat) * 180) / Math.PI + 360) % 360; }
        const dir = ["north", "north east", "east", "south east", "south", "south west", "west", "north west"][Math.round(brg / 45) % 8];
        spec.start = { ...offset(b, brg, NEAR_START_M), name: `${NEAR_START_M / 1000} km ${dir} of ${b.name}` };
        farNote = a ? `${b.name} is ${Math.round(km).toLocaleString("en-US")} kilometres from ${a.name || "your start"}, too far to walk, so the route starts ${NEAR_START_M / 1000} kilometres ${dir} of it. `
          : `No start was set, so the route starts ${NEAR_START_M / 1000} kilometres ${dir} of ${b.name}. `;
        if (b.site) C.flyTo(b.site);
      }
    }
  }
  {
    const a = spec.start || S.start, b = spec.end || S.end;
    if (a && b && spec.end) {
      const km = distM([a.lat, a.lon], [b.lat, b.lon]) / 1000;
      if (km > 1500 || Math.abs(a.lon - b.lon) > 180) {
        C.flyTo(b.site || { lat: b.lat, lon: b.lon, zoom: 9 });
        return `${b.name || "That place"} is ${Math.round(km).toLocaleString("en-US")} kilometres away: too far for a surface traverse (this planner goes up to 1,500 km). I moved the map there. Pick a start near it, or tap the map.`;
      }
    }
  }
  const a = spec.start || S.start, b = spec.end || S.end;
  if (a && b && distM([a.lat, a.lon], [b.lat, b.lon]) < 20) return "You're already there.";
  spec.autoStart = go || nav;
  spec.navIntro = false;
  const res = await routeAndWait(spec);
  if (newMode && !start && !end && !addCp && res.need) return `Switched to ${newMode === "drive" ? "rover" : "on-foot"} mode.`;
  if (res.need === "start") return `Destination set${spec.end ? ` to ${spec.end.name}` : ""}. Where do you start? Say "start from" a place, or tap the map.`;
  if (res.need === "end") return `Start set${spec.start ? ` at ${spec.start.name}` : ""}. Where are you going?`;
  if (!res.ok) return res.error || "I couldn't plan that route.";
  return farNote + routeSpoken(res.navigating);
}
function routeAndWait(spec) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve({ ok: false, error: "Planning is taking a while. The route will appear on the map when it's ready." }), 90000);
    C.routeTo(spec, (r) => { clearTimeout(t); resolve(r); });
  });
}
function waitPlan(first) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const poll = () => {
      if (C.S.busy && performance.now() - t0 < 90000) return setTimeout(poll, 200);
      resolve(C.S.track ? `${first} ${routeSpoken(false)}` : C.S.error || first);
    };
    setTimeout(poll, 300);
  });
}
let shelterNote = "";   // set when the destination is a shelter: how much better it is than where you stand
function routeSpoken(navigating) {
  const P = C.planSummary(); if (!P) return "Route planned.";
  const st = P.status === "All checks passed" ? "All safety checks passed." : `Watch out: ${P.status}.`;
  if (navigating) {
    const Lv = C.live(), m = Lv?.man;
    const first = !m ? "" : Lv.distTo > 15 ? `In ${spokenDist(Lv.distTo)}, ${lc1(m.text)}${m.sub ? `, ${m.sub}` : ""}.` : `${m.text}${m.sub ? `, ${m.sub}` : ""}.`;
    return `Guiding you to ${P.to}: ${spokenDist(P.dist)}, about ${spokenDur(P.time)}. ${st} ${shelterNote}${first}`;
  }
  return `Route planned from ${P.from} to ${P.to}${P.checkpoints.length ? ` via ${P.checkpoints.join(", ")}` : ""}: ${spokenDist(P.dist)}, about ${spokenDur(P.time)}, arriving around ${hhmm(P.arrive)} local time. ${st} Say start navigation to begin.`;
}
async function savePlace(what, name) {
  const S = C.S, nm = name.replace(/\b\w/g, (c) => c.toUpperCase()).trim();
  const p = /start/.test(what) ? S.start : /destination/.test(what) ? S.end : here();
  if (!p) return /start|destination/.test(what) ? `There's no ${what.replace(/^the /, "")} yet.` : "I only know your position during guidance. Say save the start as, or save the destination as.";
  userPlaces = userPlaces.filter((x) => x.name.toLowerCase() !== nm.toLowerCase()).concat({ name: nm, lat: p.lat, lon: p.lon });
  store(PLACES_KEY, userPlaces);
  return `Saved ${nm}. You can now say: take me to ${nm}.`;
}

// ---------- answers ----------
function planAnswer(q) {
  if (has(q, /\b(highest|lowest|summit)\b/)) {
    const p = extreme(has(q, /lowest/) ? -1 : +1);
    return p.error || `The ${p.name.replace(/ \(.*/, "").toLowerCase()} in the analysed area is at ${Math.round(C.S.site.elev[cellOf(C.S.site, p.lat, p.lon)])} metres. Say take me to the ${has(q, /lowest/) ? "lowest" : "highest"} point to plan a route there.`;
  }
  const P = C.planSummary();
  if (!P) return C.S.error || `There's no route yet. Say something like: route from the landing plain to the upper boxwork ridges. Known places: ${placeNames()}.`;
  if (has(q, /how (far|long)|distance|time|arriv|\beta\b|when/)) return `${spokenDist(P.dist)}, about ${spokenDur(P.time)}. Arrival around ${hhmm(P.arrive)} local time.`;
  if (has(q, /safe|check|danger|hazard|status|risk|oxygen|o2|sun|shadow|radiation|shelter|slope|steep/)) return P.checks.map((c) => `${c.title}.`).join(" ");
  return `Route from ${P.from} to ${P.to}: ${spokenDist(P.dist)}, about ${spokenDur(P.time)}. ${P.status}. Say start navigation to begin.`;
}

function answer(q, Lv) {
  const S = C.S, A = S.ana, o = S.opts, tr = S.track, hereLL = [Lv.st.lat, Lv.st.lon];
  const nextStop = () => tr.stops.find((s, k) => k > 0 && tr.pts[s.idx].dist > Lv.st.dist + 1);
  const o2 = () => Lv.walk
    ? `${spokenDur(Lv.o2Left)} of oxygen left. Walk-back margin is ${spokenDur(Lv.margin)}${Lv.margin < 0 ? ": turn back now" : Lv.margin < 1800 ? ": plan to turn back soon" : ", that's fine"}.`
    : "You're in the pressurized rover, so suit oxygen isn't being drawn. Cabin life support isn't modelled here.";
  const next = () => {
    if (Lv.done) return "You've arrived. There are no more turns.";
    if (Lv.st.dwell > 0) return `You're stopped at ${tr.stops[Lv.st.dwell].stop.name} for another ${spokenDur(Lv.station?.left ?? 0)}.`;
    const m = Lv.man;
    if (!m) return `Continue ${compassWord(Lv.st.heading)}.`;
    return Lv.distTo > 250 && m.type !== "depart"
      ? `Continue ${compassWord(Lv.st.heading)} for ${spokenDist(Lv.distTo)}, then ${lc1(m.text)}${m.sub ? `, ${m.sub}` : ""}.`
      : `In ${spokenDist(Lv.distTo)}, ${lc1(m.text)}${m.sub ? `, ${m.sub}` : ""}.`;
  };
  const remain = () => Lv.done ? "You've arrived." : `${spokenDist(Lv.remainDist)} to go, about ${spokenDur(Lv.remainTime)}. You'll arrive around ${hhmm(Lv.arrive)} local time.`;

  if (has(q, /oxygen|\bo2\b|\bair\b|plss|life support|suit|breath|consumables/)) return o2();
  if (has(q, /turn back|go back|walk back|head (back|home)|return|abort/)) {
    if (!Lv.walk) return `Driving back from here takes about ${spokenDur(Lv.back)}. Say take me back to base to re-route.`;
    return `Walking back to the start from here takes about ${spokenDur(Lv.back)}. ${o2()} Say take me back to base to re-route.`;
  }
  if (has(q, /shelter|radiation|solar|flare|storm|particle|shield|cover|hide/)) {
    const sh = A.shelter;
    if (!sh) return `The sky is ${Math.round(Lv.sky * 100)} percent open here. No better shelter was found near the route.`;
    const d = distM(hereLL, [sh.lat, sh.lon]), b = compassWord(bearingDeg(hereLL, [sh.lat, sh.lon]));
    return `Sky is ${Math.round(Lv.sky * 100)} percent open here. The most sheltered spot near the route is ${spokenDist(d)} to the ${b}, with ${Math.round(sh.sky * 100)} percent of the sky open. Say take me to the nearest shelter to go there. Shielding is relative to terrain only, not a dose.`;
  }
  if (has(q, /next stop|checkpoint|waypoint/)) {
    const s = nextStop();
    if (!s) return "There are no more checkpoints. " + remain();
    const d = tr.pts[s.idx].dist - Lv.st.dist;
    if (s === tr.stops[tr.stops.length - 1]) return `No checkpoints left. The destination is ${spokenDist(d)} ahead.`;
    return `${s.stop.name} is ${spokenDist(d)} ahead${s.stop.dwell ? `, with a ${s.stop.dwell} minute stop` : ""}.`;
  }
  if (has(q, /how (far|long|much longer)|remaining|left to go|\beta\b|arriv|when will|distance|time left|how much further/)) return remain();
  if (has(q, /slope|steep|grade|incline|climb|footing|gradient/)) {
    const lim = Lv.walk ? o.maxSlope : o.roverMaxSlope;
    return `Slope here is ${Math.round(Lv.st.p.slope)} degrees. The steepest in the next 50 metres is ${Math.round(Lv.slopeAhead)} degrees, against a limit of ${lim}.`;
  }
  if (has(q, /danger|hazard|rock|risk|safe|ahead|watch out|obstacle/)) {
    const dz = A.dangers.find((x) => tr.pts[x.j].dist > Lv.st.dist);
    if (!dz) return "No more marked dangers on the rest of the route.";
    const start = dz.dist - Lv.st.dist;
    return start <= 0 ? `You're in it now: ${dz.title}. ${dz.sub}.` : `Next: ${dz.title}, in ${spokenDist(start)}. ${dz.sub}.`;
  }
  if (has(q, /\bsun|shadow|shade|dark|light|sunset|sunrise|night/)) {
    const set = A.day?.set != null ? ` Sunset is at ${hhmm(A.day.set * 3600)} local time.` : "";
    if (Lv.sun.el <= 0) return `The sun is below the horizon.${set}`;
    return `${Lv.shade ? "You're in terrain shadow" : `Sun is ${Math.round(Lv.sun.el)} degrees up in the ${compassWord(Lv.sun.az)}`}.${set}`;
  }
  if (has(q, /elevation|altitude|height|how high/)) return `Elevation is ${Math.round(Lv.st.p.elev)} metres. The route ranges from ${Math.round(A.emin)} to ${Math.round(A.emax)} metres.`;
  if (has(q, /how fast|my speed|speed\b|pace/)) return Lv.walk ? `Planned walking pace on flat ground is ${o.flatSpeed} kilometres per hour.` : `Rover speed is ${Lv.speed.toFixed(1)} kilometres per hour.`;
  if (has(q, /where am i|position|location|coordinates/)) return `You're ${spokenDist(Lv.st.dist)} along the route to ${tr.stops[tr.stops.length - 1] ? (S.end?.name || "the destination") : "the destination"}, heading ${compassWord(Lv.st.heading)}, at ${Math.round(Lv.st.p.elev)} metres.`;
  if (has(q, /what time|local time|clock|\bsol\b/)) return `It's ${hhmm(Lv.lmst)} local mean solar time.`;
  if (has(q, /next|which way|direction|where (do|should|to)|turn|heading|go now|what now|what do i do|what should i do|guide me/)) return next();
  if (has(q, /status|how am i|how are we|summary|report|overview|update/)) return [Lv.alert ? `Caution: ${Lv.alert}.` : "", next(), remain(), Lv.walk ? o2() : ""].filter(Boolean).join(" ");
  return "I didn't catch that. Ask about oxygen, the next turn, time to arrival, slope, dangers, sunlight or shelter. Or say pause, resume, repeat, or take me to a place.";
}

// ---------- Claude (optional) ----------
const SYSTEM = `You are the voice assistant inside AresNav, a route planning and guidance tool for crew walking in spacesuits or driving a pressurized rover in Gale crater, Mars. Each message comes with a JSON snapshot of the app: the planning state, or live telemetry during guidance.

Your reply is read aloud by text-to-speech to someone who may be walking or driving, so answer in one to three short sentences with no lists, markdown, emoji or symbols, and write units as words. Reply in the language the crew member used.

To plan, change or start a route, call set_route. Describe places with the short phrases it accepts and let it resolve them; don't invent coordinates. Routes can only go where Gale crater's HiRISE terrain data exists; if set_route returns an error, tell the crew plainly what to change. After a successful call, summarise the route and any safety check that isn't passed.

Take every number from the snapshot or the tool result. If neither contains what was asked, say you don't have it rather than estimating. Put safety first: if an alert is active or the walk-back margin is low or negative, say so before anything else. Radiation shielding here is relative terrain shielding (share of sky open), not a dose.

The app itself handles pause, resume, faster, slower, repeat, mute, open HUD and end navigation; if asked for those, tell the crew to say the command.`;

const TOOLS = [{
  name: "set_route",
  description: "Plan a route in Gale crater, and optionally start turn-by-turn guidance. Places are short phrases the app resolves itself: a known place name, 'current position' (only during guidance), 'start' (where the EVA began), 'destination', 'nearest shelter', 'highest point', 'lowest point', a distance and direction such as '500 m north' or '1 km south east of Landing plain', or coordinates such as '4.80 S 137.39 E'. Pass null to keep the current value. During guidance, a null start re-routes from the current position. Returns the planned route (distance, time, arrival, safety checks) or an error saying what couldn't be resolved.",
  strict: true,
  input_schema: {
    type: "object",
    properties: {
      start: { type: ["string", "null"], description: "Where the route begins, or null to keep it." },
      destination: { type: ["string", "null"], description: "Where the route ends, or null to keep it." },
      checkpoints: { type: ["array", "null"], items: { type: "string" }, description: "All checkpoints in order (replaces existing ones), [] to remove them, or null to keep them." },
      mode: { type: ["string", "null"], enum: ["walk", "drive", null], description: "walk = crew on foot, drive = pressurized rover, null = keep." },
      start_navigation: { type: "boolean", description: "true to begin guidance as soon as the route is planned." },
    },
    required: ["start", "destination", "checkpoints", "mode", "start_navigation"],
    additionalProperties: false,
  },
}];

async function runSetRoute(input) {
  const S = C.S, nav = !!C.live(), spec = {};
  const res = async (s) => { const p = await resolvePlace(s); if (p.error) throw new Error(p.error); return p; };
  try {
    if (input.mode === "walk" || input.mode === "drive") spec.mode = input.mode;
    if (input.start) spec.start = await res(input.start); else if (nav) spec.start = here();
    if (input.destination) spec.end = /^(start|base|home|camp)$/i.test(input.destination.trim()) && (home || S.start) ? ptOf(home || S.start, (home || S.start).name || "the start") : await res(input.destination);
    if (Array.isArray(input.checkpoints)) spec.cps = [];
    if (Array.isArray(input.checkpoints)) for (const c of input.checkpoints) spec.cps.push(await res(c));
    else if (nav && input.destination) spec.cps = [];
  } catch (e) { return { error: e.message }; }
  spec.autoStart = !!input.start_navigation || nav;
  spec.navIntro = false;
  const r = await routeAndWait(spec);
  if (r.need) return { error: r.need === "start" ? "The route still needs a start." : "The route still needs a destination." };
  if (!r.ok) return { error: r.error || "Planning failed." };
  const P = C.planSummary();
  return { from: P.from, to: P.to, checkpoints: P.checkpoints, mode: P.mode === "drive" ? "rover" : "on foot", distance_m: Math.round(P.dist), time_min: Math.round(P.time / 60), arrival_lmst: hhmm(P.arrive), safety_checks: P.checks, guidance_started: !!r.navigating };
}

function snapshot(Lv) {
  const S = C.S, r = (x, d = 0) => +Number(x).toFixed(d);
  const places = [...PLACES, ...userPlaces].map((p) => p.name);
  if (!Lv) {
    const P = C.planSummary();
    return { phase: "planning", mode: S.mode === "drive" ? "pressurized rover" : "crew on foot", start: S.start?.name || (S.start ? "set on the map" : null), destination: S.end?.name || (S.end ? "set on the map" : null),
      planning_error: S.error || null, route: P ? { distance_m: r(P.dist), time_min: r(P.time / 60), arrival_lmst: hhmm(P.arrive), checkpoints: P.checkpoints, safety_checks: P.checks } : null, known_places: places };
  }
  const A = S.ana, tr = S.track, o = S.opts, hereLL = [Lv.st.lat, Lv.st.lon], sh = A.shelter;
  const nextStop = tr.stops.find((s, k) => k > 0 && tr.pts[s.idx].dist > Lv.st.dist + 1);
  return {
    phase: "guidance",
    mode: Lv.walk ? "crew on foot" : "pressurized rover",
    destination: S.end?.name || "destination",
    local_time_lmst: hhmm(Lv.lmst),
    arrived: Lv.done,
    active_alert: Lv.alert || null,
    position: { along_route_m: r(Lv.st.dist), heading: compassWord(Lv.st.heading), elevation_m: r(Lv.st.p.elev), slope_here_deg: r(Lv.st.p.slope, 1), rock_density_pct: r(Lv.st.p.rough * 100) },
    at_checkpoint: Lv.st.dwell > 0 ? { name: tr.stops[Lv.st.dwell].stop.name, time_left_min: r((Lv.station?.left ?? 0) / 60) } : null,
    next_instruction: Lv.man ? { text: Lv.man.text, detail: Lv.man.sub || "", in_m: r(Lv.distTo) } : null,
    then: Lv.after ? Lv.after.text : null,
    remaining: { distance_m: r(Lv.remainDist), time_min: r(Lv.remainTime / 60), arrival_lmst: hhmm(Lv.arrive) },
    life_support: Lv.walk ? { oxygen_left_min: r(Lv.o2Left / 60), reserve_min: r(o.reserveHours * 60), walk_back_time_min: r(Lv.back / 60), walk_back_margin_min: r(Lv.margin / 60) } : { rover_speed_kmh: r(Lv.speed, 1), drive_back_time_min: r(Lv.back / 60) },
    terrain_ahead: { max_slope_next_50m_deg: r(Lv.slopeAhead, 1), slope_limit_deg: Lv.walk ? o.maxSlope : o.roverMaxSlope },
    sun: { elevation_deg: r(Lv.sun.el, 1), direction: compassWord(Lv.sun.az), in_terrain_shadow: Lv.shade, sunrise_lmst: A.day?.rise != null ? hhmm(A.day.rise * 3600) : null, sunset_lmst: A.day?.set != null ? hhmm(A.day.set * 3600) : null },
    shielding: { sky_open_here_pct: r(Lv.sky * 100), best_shelter_near_route: sh ? { sky_open_pct: r(sh.sky * 100), distance_m: r(distM(hereLL, [sh.lat, sh.lon])), direction: compassWord(bearingDeg(hereLL, [sh.lat, sh.lon])) } : null },
    next_checkpoint: nextStop ? { name: nextStop.stop.name, in_m: r(tr.pts[nextStop.idx].dist - Lv.st.dist), stop_min: nextStop.stop.dwell || 0 } : null,
    dangers_ahead: A.dangers.filter((x) => tr.pts[x.j].dist > Lv.st.dist).slice(0, 4).map((x) => ({ what: x.title, detail: x.sub, starts_in_m: r(Math.max(0, x.dist - Lv.st.dist)), severity: x.sev })),
    route_elevation_range_m: [r(A.emin), r(A.emax)],
    known_places: places,
  };
}

async function askClaude(q, Lv) {
  if (!claude) {
    const { default: Anthropic } = await import(SDK_URL);
    // The key lives only in this browser (localStorage) and goes straight to the Anthropic API.
    claude = new Anthropic({ apiKey: prefs.key, dangerouslyAllowBrowser: true });
  }
  if (history.length > 30) history = [];   // start a fresh conversation rather than editing an old one
  const messages = [...history, { role: "user", content: `Snapshot now:\n${JSON.stringify(snapshot(Lv))}\n\nCrew: ${q}` }];
  for (let turn = 0; turn < 4; turn++) {
    const res = await claude.beta.messages.create({
      model: MODEL,
      max_tokens: 4096,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "low" },
      system: SYSTEM,
      tools: TOOLS,
      messages,
    });
    messages.push({ role: "assistant", content: res.content });   // full content, thinking blocks included
    if (res.stop_reason === "refusal") { history = messages; return ""; }
    const calls = res.content.filter((b) => b.type === "tool_use");
    if (res.stop_reason !== "tool_use" || !calls.length) {
      history = messages;
      return res.content.filter((b) => b.type === "text").map((b) => b.text).join(" ").trim();
    }
    log(q, "Planning the route…");
    const results = [];
    for (const b of calls) {
      const out = b.name === "set_route" ? await runSetRoute(b.input || {}) : { error: `Unknown tool ${b.name}` };
      results.push({ type: "tool_result", tool_use_id: b.id, content: JSON.stringify(out), ...(out.error ? { is_error: true } : {}) });
    }
    messages.push({ role: "user", content: results });
  }
  history = [];
  return "";
}

// ---------- panel ----------
function log(q, a, note = "") {
  const el = $("#voiceLog");
  if (q == null && a == null) { el.innerHTML = ""; return; }
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const shown = tr(a);
  el.innerHTML = `${q ? `<div class="vq">${esc(q)}</div>` : ""}<div class="va">${esc(hasHangul(shown) ? shown : speakable(shown))}${note ? ` <span class="vn">${esc(note)}</span>` : ""}</div>`;
}
