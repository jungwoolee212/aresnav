// Korean for the on-screen route card, summary sheet and guidance view, used when the voice language is
// Korean. Dynamic strings are translated by pattern; static labels are swapped in place (and restored).

import { manKo, alertKo, checkKo, durKo, namesKo } from "./voice-ko.js";

const DIR = { north: "북", "north-east": "북동", east: "동", "south-east": "남동", south: "남", "south-west": "남서", west: "서", "north-west": "북서" };
const dur = (s) => s.replace(/(\d+) h (\d+) min/g, (_, h, m) => `${h}시간 ${m}분`).replace(/(\d+) min/g, "$1분");

// short dynamic strings (summary, status, checks, progress messages)
const RULES = [
  [/^No route$/, "경로 없음"],
  [/^Move the start, destination or a checkpoint, or relax the limits in Settings\.$/, "출발지·목적지·체크포인트를 옮기거나, 설정에서 한계를 완화하세요."],
  [/^(Walk|Drive) · arrive (\S+) LMST · (.+?)(?: · (\d+) checkpoints?)?$/, (_, m, t, rest, n) => `${m === "Walk" ? "도보" : "로버"} · 도착 ${t} LMST · ${rest}${n ? ` · 체크포인트 ${n}개` : ""}`],
  [/^Safe to go: all checks passed$/, "출발 가능: 모든 점검 통과"],
  [/^Go with caution: (\d+) things? to watch$/, "주의하며 출발: 확인할 항목 $1개"],
  [/^Tap to choose on the map$/, "지도를 눌러 선택"],
  [/^These points are (.+) km apart\. The planner handles surface traverses up to 1,500 km: pick points closer together, or plan in legs\.$/, "두 지점이 $1 km 떨어져 있습니다. 지표 이동 경로는 최대 1,500 km까지 계산합니다. 더 가까운 지점을 고르거나 구간을 나눠 계획하세요."],
  [/^Tap the map to set your start point$/, "지도를 눌러 출발지를 정하세요"], [/^Tap the map to set your destination$/, "지도를 눌러 목적지를 정하세요"],
  [/^Tap the map where you want a checkpoint$/, "체크포인트를 둘 곳을 지도에서 누르세요"],
  [/^Finding the safest route…$/, "가장 안전한 경로를 찾는 중…"], [/^Loading (.+)…$/, "$1 불러오는 중…"],
  [/^Analysing terrain around your route \((.+)\)… (\d+)%$/, "경로 주변 지형 분석 중($1)… $2%"],
  [/^No safe (walkable|drivable) path reaches (.+): it's cut off by ground steeper than (\d+)°(.*)\.$/, (_, w, to, d, r) => `${to.replace("the destination", "목적지").replace(/^stop (\d+)$/, "$1번째 지점")}까지 ${w === "walkable" ? "걸어서" : "로버로"} 갈 수 있는 안전한 경로가 없습니다. ${d}°보다 가파른 지형${r ? "이나 바위 지대" : ""}에 막혀 있습니다.`],
  [/^No safe ground near (.+)\.$/, (_, p) => `${p.replace("the start", "출발지").replace("the destination", "목적지")} 근처에 안전한 땅이 없습니다.`],
  [/^Longest gap (.+?), from (.+?) along\. Base antenna (\d+) m, suit (\d+) m\. Guidance keeps working offline there\.$/, "가장 긴 음영 $1, $2 지점부터. 기지 안테나 $3 m, 우주복 $4 m. 그 구간에서도 안내는 오프라인으로 계속됩니다."],
  [/^Base antenna (\d+) m, suit (\d+) m: the terrain never blocks the straight path\.$/, "기지 안테나 $1 m, 우주복 $2 m: 지형이 직선 경로를 가리는 곳이 없습니다."],
  [/^Couldn't load terrain from NASA Mars Trek(.*)$/, "NASA Mars Trek에서 지형을 불러오지 못했습니다$1"],
  [/^No connection, and the terrain for this area isn't saved.*$/, "연결이 없고, 이 지역 지형은 아직 이 기기에 저장되지 않았어요. 이미 불러온 경로와 장소는 오프라인에서도 됩니다. 여기서 경로를 짜려면 한 번 연결해 주세요."],
];
// check subtitles from app.js assess()
const SUBS = [
  [/^(?:O₂ out|Out) (.+) \+ back (.+) = (.+) of (.+) usable \((.+) h suit − (.+) h reserve\)\. (?:Lowest walk-back margin (.+)\.|Walk-back margin runs out (.+) along\.)$/,
    (_, o, b, n, u, s, r, low, out) => `산소: 가는 데 ${dur(o)} + 돌아오는 데 ${dur(b)} = ${dur(n)} / 사용 가능 ${dur(u)} (우주복 ${s}시간 − 예비 ${r}시간). ${low ? `최저 귀환 여유 ${dur(low)}.` : `${out} 지점에서 귀환 여유가 바닥납니다.`}`],
  [/^Sunrise (\S+), sunset (\S+) LMST today\. (?:Back at the start|Arrive) by (\S+)\.$/, "오늘 일출 $1, 일몰 $2 LMST. $3까지 마칩니다."],
  [/^(\d+) steep sections? · (\d+) rocky stretch(?:es)?\. Open the report for where\.$/, "급경사 $1구간 · 바위 지대 $2구간. 위치는 보고서에서 확인하세요."],
  [/^No sections over (\S+)°\. (\d+) rocky stretch(?:es)?\.$/, "$1°를 넘는 구간 없음. 바위 지대 $2구간."],
  [/^From the Sun's position at the time you pass each point and the terrain horizon\.$/, "각 지점을 지나는 시각의 태양 위치와 지형 지평선으로 계산했습니다."],
  [/^Most sheltered spot near the route: (\d+)% sky open, (?:(\d+) m off the route|on the route) at (.+)\. Use it if a solar particle event is called\.$/,
    (_, p, off, at) => `경로 근처에서 가장 잘 가려진 곳: 하늘 ${p}% 개방, ${off ? `경로에서 ${off} m 떨어진` : "경로 위"} ${at} 지점. 태양 입자 폭풍 경보 때 이용하세요.`],
  [/^No sharp elevation model covers this route.+$/, "이 경로를 덮는 정밀 고도 데이터가 없어 거친 전 지구 데이터를 씁니다. 수백 미터보다 작은 절벽·급경사·바위 지대는 보이지 않으므로 EVA 안전 판정이 아닙니다."],
  [/^No HiRISE image mosaic covers this ground.+$/, "이 지역에는 HiRISE 영상이 없어 경사만 점검했습니다. 바위와 능선에 주의하세요."],
];
export function uiKo(s) {
  if (s == null) return s;
  for (const [re, to] of [...RULES, ...SUBS]) if (re.test(s)) return s.replace(re, to);
  if (/^(?:Not safe as planned: )?[A-Z]/.test(s)) { const c = checkKo(s.replace(/^Not safe as planned: /, "")); if (c !== s.replace(/^Not safe as planned: /, "")) return /^Not safe/.test(s) ? `현재 계획은 위험: ${c}` : c; }
  return dur(s);
}

// guidance view pieces
export const navKo = {
  man: (text, sub) => { const k = manKo(text, sub || ""); return { text: namesKo(k.text), sub: namesKo(k.sub) }; },
  cont: (dir, then) => ({ text: `${DIR[dir] || dir}쪽으로 계속 진행`, sub: then ? `그다음 ${manKo(then).text}` : "" }),
  alert: (a) => alertKo(a),
  dur: (sec) => durKo(sec),
  dir: (d) => DIR[d] || d,
};

// static labels: [selector, Korean]; the original text is kept on the element to switch back
const STATIC = [
  ["#offlineCard .eyebrow", "오프라인 경로"], ["#offlineCard .hint:not(#offlineStatus)", "실제 로버 탐사지의 주요 경로예요. 연결이 있을 때 저장해 두면, 모래 폭풍 등으로 연결이 끊겨도 경로를 열고, 계획하고, 안내받을 수 있어요."],
  ["#btnSaveOffline", "모두 오프라인 저장"],
  ["#fieldStart .rc-k", "출발지"], ["#fieldEnd .rc-k", "목적지"], ["#btnAddCp", "+ 체크포인트 추가"], ["#btnExample", "예시 경로"], ["#btnClear", "지우기"],
  ['.mode[data-mode="walk"]', "도보"], ['.mode[data-mode="drive"]', "로버"], ["#btnStart", "안내 시작"], ["#btnSteps", "단계"], ["#btnReport", "보고서"],
  [".profile-head .eyebrow", "고도"], ["#sheet > .hint", "출발지·목적지·체크포인트를 끌어서 옮기면 경로가 자동으로 다시 계산됩니다."],
  ["#navExit", "종료"], ["#navRecenter", "다시 중앙으로"], [".sim-note", "모의 위치입니다. 화성에서는 우주복의 항법 위치를 따릅니다(GPS 없음)."],
  [".empty-title", "어디로 가나요?"], ["#emptyCard p", "지도를 눌러 <b>출발지</b>를 정하고, 한 번 더 눌러 <b>목적지</b>를 정하세요. 급경사, 바위, 햇빛, 그늘, 방사선 차폐를 점검한 가장 안전한 경로를 찾아 줍니다.", true],
  ["#pickCancel", "취소"], [".m3-bar label", "높이"], ["#m3Reset", "시점 초기화"], ["#m3Color option[value=hazard]", "위험도 색상"], ["#m3Color option[value=gray]", "회색"],
  [".m3-hint", "드래그: 회전 · 스크롤: 확대 · 오른쪽 드래그: 이동 · 땅을 클릭하면 지점 선택. 분석한 지역(2D의 주황 상자)을 보여 줍니다."], [".view-toggle #view2d", "2D"], [".view-toggle #view3d", "3D"],
];
// replace the last text node (buttons also hold an icon)
function lastText(el) { const t = [...el.childNodes].filter((n) => n.nodeType === 3 && n.textContent.trim()); return t[t.length - 1]; }
export function applyStatic(ko) {
  for (const [sel, kor, html] of STATIC) for (const el of document.querySelectorAll(sel)) {
    if (html) { if (el.dataset.en == null) el.dataset.en = el.innerHTML; el.innerHTML = ko ? kor : el.dataset.en; continue; }
    const tn = lastText(el); if (!tn) continue;
    if (el.dataset.en == null) el.dataset.en = tn.textContent;
    tn.textContent = ko ? (tn.textContent.match(/^\s*/)[0] + kor + " ") : el.dataset.en;
  }
  document.documentElement.lang = ko ? "ko" : "en";
}
