// Korean for the voice assistant: turns a Korean utterance into the English command/question forms the
// onboard parser understands, and translates what the assistant says (guidance, alerts, checks, answers).

export const hasHangul = (s) => /[가-힣]/.test(String(s));

// ---------- numbers, directions, places ----------
const DIR = { 북동: "north east", 북서: "north west", 남동: "south east", 남서: "south west", 북: "north", 남: "south", 동: "east", 서: "west" };
const DIR_KO = { north: "북", "north-east": "북동", "north east": "북동", east: "동", "south-east": "남동", "south east": "남동", south: "남", "south-west": "남서", "south west": "남서", west: "서", "north-west": "북서", "north west": "북서" };
const DIST = "(\\d+(?:\\.\\d+)?)\\s*(킬로미터|킬로|km|㎞|미터|m)";
const DIRS = "(북동|북서|남동|남서|북|남|동|서)\\s*(?:쪽|방향)?";
const unit = (u) => (/^(킬로|km|㎞)/.test(u) ? "km" : "m");

const PLACES = [
  [/착륙\s*(?:지점\s*)?평원|랜딩\s*플레인/g, "landing plain"],
  [/(?:상부\s*)?박스\s*워크(?:\s*능선)?/g, "upper boxwork ridges"],
  [/게일\s*크레이터|게일/g, "gale crater"], [/큐리오시티/g, "curiosity"], [/샤프\s*산|마운트\s*샤프/g, "mount sharp"],
  [/(?:예|제)제로\s*크레이터|(?:예|제)제로/g, "jezero"], [/퍼(?:서|시)비어런스/g, "perseverance"],
  [/(?:컬|콜)럼비아\s*힐스?/g, "columbia hills"], [/스피릿/g, "spirit"], [/구세프|구셰프/g, "gusev"],
  [/(?:인|엔)데버\s*크레이터|(?:인|엔)데버/g, "endeavour crater"], [/오퍼튜니티/g, "opportunity"], [/메리디아니/g, "meridiani"],
  [/빅토리아\s*크레이터|빅토리아/g, "victoria crater"], [/인사이트/g, "insight"], [/피닉스/g, "phoenix"],
  [/(?:마스\s*)?패스\s*파인더|소저너/g, "pathfinder"], [/바이킹\s*(?:1|일)\s*호?/g, "viking 1"], [/바이킹\s*(?:2|이)\s*호?/g, "viking 2"], [/주룽|톈원\s*1?\s*호?|천문\s*1?\s*호?/g, "zhurong"],
  [/올림(?:푸|포)스\s*(?:산|몬스)?/g, "olympus mons"], [/매리너(?:스)?\s*(?:협곡|계곡)|마리너\s*(?:협곡|계곡)|발레스\s*마리네리스/g, "valles marineris"],
  [/헬라스\s*(?:평원|분지)?/g, "hellas planitia"], [/엘리시움\s*(?:산|몬스)?/g, "elysium mons"], [/아르시아\s*(?:산|몬스)?/g, "arsia mons"],
  [/파보니스\s*(?:산|몬스)?/g, "pavonis mons"], [/아스크라이우스\s*(?:산|몬스)?/g, "ascraeus mons"], [/유토피아\s*(?:평원)?/g, "utopia planitia"],
  [/가장\s*가까운\s*(?:대피소|대피처|피난처|쉼터|은신처)|(?:대피소|대피처|피난처|은신처)|(?:방사선\s*)?(?:숨을|피할|대피할|가릴)\s*(?:데|곳)/g, "nearest shelter"],
  [/착륙\s*(?:지점|지역|장소)|착륙지/g, "landing site"],
  [/가장\s*높은\s*(?:곳|지점|데)|최고\s*지점/g, "highest point"], [/가장\s*낮은\s*(?:곳|지점|데)|최저\s*지점/g, "lowest point"],
  [/현재\s*위치|지금\s*위치|내\s*위치|여기|이곳/g, "here"],
  [/출발\s*(?:지|점)|기지|베이스|캠프\s*(?=$)|처음\s*위치/g, "start"], [/목적지|도착지/g, "destination"],
];

// a Korean place phrase -> the English phrase resolvePlace() understands
export function koPlace(s) {
  let t = String(s).trim().replace(/[.?!]+$/, "").replace(/\s*(?:쪽|근처|방향)?\s*(?:으로|로|까지|에서|에|을|를|은|는|이|가)$/, "").trim();
  // coordinates: 남위 4.55 동경 137.55
  const c = t.match(/(남위|북위)\s*(\d+(?:\.\d+)?)\s*도?\s*,?\s*(동경|서경)\s*(\d+(?:\.\d+)?)\s*도?/);
  if (c) return `${c[2]} ${c[1] === "남위" ? "south" : "north"} ${c[4]} ${c[3] === "동경" ? "east" : "west"}`;
  // distance + direction, either order, optionally "<base>에서"
  let m = t.match(new RegExp(`^(?:(.+?)(?:에서|로부터)\\s*)?${DIRS}\\s*(?:으로|로)?\\s*${DIST}\\s*(?:떨어진\\s*(?:곳|지점))?$`));
  if (m) return `${m[3]} ${unit(m[4])} ${DIR[m[2]]}${m[1] ? ` of ${koPlace(m[1])}` : ""}`;
  m = t.match(new RegExp(`^(?:(.+?)(?:에서|로부터)\\s*)?${DIST}\\s*${DIRS}\\s*(?:으로|로)?\\s*(?:떨어진\\s*(?:곳|지점))?$`));
  if (m) return `${m[2]} ${unit(m[3])} ${DIR[m[4]]}${m[1] ? ` of ${koPlace(m[1])}` : ""}`;
  for (const [re, en] of PLACES) t = t.replace(re, en);
  return t.replace(/\s+/g, " ").trim();
}

// ---------- utterance -> English command / question ----------
// ---------- utterance -> English command / question ----------
// Korean numbers before a unit ("이 킬로", "오백 미터", "일점오 킬로", "두 키로") -> digits
const SINO = { 영: 0, 공: 0, 일: 1, 이: 2, 삼: 3, 사: 4, 오: 5, 육: 6, 륙: 6, 칠: 7, 팔: 8, 구: 9 };
const NATIVE = { 한: 1, 하나: 1, 두: 2, 둘: 2, 세: 3, 셋: 3, 네: 4, 넷: 4, 다섯: 5, 여섯: 6, 일곱: 7, 여덟: 8, 아홉: 9, 열: 10 };
function koNumber(w) {
  w = w.replace(/\s+/g, "");
  if (NATIVE[w] != null) return NATIVE[w];
  const [ip, fp] = w.split("점");
  let total = 0, cur = 0;
  for (const ch of ip) {
    if (SINO[ch] != null) cur = cur * 10 + SINO[ch];          // digits read one by one: "이오" = 25
    else if (ch === "십") { total += (cur || 1) * 10; cur = 0; }
    else if (ch === "백") { total += (cur || 1) * 100; cur = 0; }
    else if (ch === "천") { total += (cur || 1) * 1000; cur = 0; }
    else return null;
  }
  let n = total + cur;
  if (fp) { let f = ""; for (const ch of fp) { if (SINO[ch] == null) return null; f += SINO[ch]; } n = +`${n}.${f}`; }
  return n;
}
const UNIT_RE = "(킬로미터|킬로\\s*미터|킬로|키로|km|㎞|미터|m)";
function normNumbers(s) {
  return s.replace(/키로/g, "킬로")
    .replace(new RegExp(`((?:[영공일이삼사오육륙칠팔구십백천점]\\s?)+|하나|한|둘|두|셋|세|넷|네|다섯|여섯|일곱|여덟|아홉|열)\\s*${UNIT_RE}`, "g"),
      (all, num, u) => { const n = koNumber(num); return n == null ? all : `${n}${/^(킬로|km|㎞)/.test(u) ? "km" : "m"}`; })
    .replace(/(\d+(?:\.\d+)?)\s*(?:킬로\s*미터|킬로|km|㎞)/g, "$1km").replace(/(\d+(?:\.\d+)?)\s*(?:미터|m)(?![a-z])/g, "$1m")
    // "조금", "살짝" with a direction = 100 m
    .replace(/(왼쪽|오른쪽|좌측|우측|앞쪽?|정면|뒤쪽?|후방|직진|북동|북서|남동|남서|북|남|동|서)(쪽|방향)?\s*(?:으로|로)?\s*(?:조금|약간|살짝|좀)/g, "$1$2 100m");
}
const REL = { 왼쪽: "left", 좌측: "left", 오른쪽: "right", 우측: "right", 앞: "ahead", 앞쪽: "ahead", 정면: "ahead", 직진: "ahead", 뒤: "back", 뒤쪽: "back", 후방: "back" };
const RELS = "(왼쪽|오른쪽|좌측|우측|앞쪽|앞|정면|직진|뒤쪽|뒤|후방)";
const DM = "(\\d+(?:\\.\\d+)?)(km|m)";
const GO = "(?:가|이동|데려|안내|걸어|운전|움직|전진)";

function one(s) {
  let m;
  const start = /(?:안내(?:\s*시작)?|출발하자|가자|데려|길\s*안내|바로\s*출발)/.test(s) && !/(?:경로|길|루트)\s*(?:만\s*)?(?:찾|계획|짜|알려|보여|만들)/.test(s);
  // ---- routes between two places ----
  if ((m = s.match(/^(.+?)(?:에서|부터)\s*(?:출발(?:해서|하고|해)?\s*)?(.+?)(?:을|를)?\s*(?:거쳐서?|경유해서?|들러서?|지나서?)\s*(.+?)(?:까지|으로|로)/)))
    return [`route from ${koPlace(m[1])} to ${koPlace(m[3])}${start ? "" : ""}`, `add a checkpoint at ${koPlace(m[2])}`, ...(start ? ["start navigation"] : [])];
  if ((m = s.match(/^(.+?)(?:에서|부터)\s*(?:출발해서\s*|출발하고\s*)?(.+?)(?:까지|으로|로)\s*(?:가는\s*)?(?:경로|길|루트)?\s*(?:를|을)?\s*(?:안내|계획|찾아|찾|알려|짜|만들|가|이동|데려|출발|보여|갈래|가자)?.*$/)) && !/^\s*(?:\d|북|남|동|서|왼|오른|앞|뒤)/.test(m[2]))
    return `route from ${koPlace(m[1])} to ${koPlace(m[2])}${start ? " and start" : ""}`;
  if ((m = s.match(/^(.+?)\s*(?:에서)?\s*출발(?:해서|하고|해)\s*(.+?)\s*(?:에\s*)?(?:도착|까지|으로|로)/)))
    return `route from ${koPlace(m[1])} to ${koPlace(m[2])}${start ? " and start" : ""}`;
  if ((m = s.match(/^(.+?)까지\s*(?:가는\s*)?(?:길|경로|루트)?\s*(?:을|를)?\s*(.+?)(?:에서|부터)\s*(?:안내|알려|찾|계획|가|출발)/)))
    return `route from ${koPlace(m[2])} to ${koPlace(m[1])}${start ? " and start" : ""}`;
  if ((m = s.match(/^(.+?)\s*(?:→|->|에서|부터)\s*(.+?)\s*(?:까지)?$/)) && !/출발|시작|돌아|복귀/.test(s) && !/^(?:\d|북|남|동|서|왼|오른|앞|뒤)/.test(m[2]))
    return `route from ${koPlace(m[1])} to ${koPlace(m[2])}`;
  if ((m = s.match(/^(.+?)(?:와|과|랑|이랑)\s*(.+?)\s*사이\s*(?:의\s*)?(?:경로|길)/))) return `route from ${koPlace(m[1])} to ${koPlace(m[2])}`;
  // ---- back to base ----
  if (/(?:기지|출발\s*(?:지|점)|베이스|처음\s*(?:위치|자리)|원래\s*자리|집)\s*(?:로|으로)?\s*(?:돌아|복귀|귀환)|^(?:복귀|귀환|철수|후퇴|돌아가(?:자|기)?|되돌아가)/.test(s)) return "take me back to base";
  // ---- start / destination / checkpoint ----
  // ---- shelter: "숨을 데 찾아줘", "방사선 피할 곳으로 가자", "태양 폭풍 오면 어디로 가?" ----
  if (/대피|피난|숨을\s*(?:데|곳)|피할\s*(?:데|곳)|방사선|태양\s*(?:풍|폭풍)|플레어|차폐|가릴\s*(?:데|곳)/.test(s))
    return /(?:데려|가자|가\s*줘|안내|이동|찾아|어디로\s*가)/.test(s) ? "take me to the nearest shelter" : "where is the shelter";
  if ((m = s.match(/^(.+?)(?:이|가)\s*(?:목적지|도착지)/))) return `set destination to ${koPlace(m[1])}`;
  if ((m = s.match(/^(.+?)(?:이|가)\s*출발\s*(?:지|점)/))) return `start from ${koPlace(m[1])}`;
  if ((m = s.match(/^(.+?)에서\s*(?:출발|시작)/))) return `start from ${koPlace(m[1])}`;
  if ((m = s.match(/(?:지금|나|저|우리)\s*(?:는|은)?\s*(.+?)에\s*(?:있어|있어요|있다|있음|있습니다)/))) return `start from ${koPlace(m[1])}`;
  if ((m = s.match(/출발\s*(?:지|점)\s*(?:를|을|은|는|이|가)?\s*(.+?)(?:으로|로)?\s*(?:설정|정해|바꿔|변경|해|야|이야|입니다)?$/)) && !/어디/.test(m[1])) return `start from ${koPlace(m[1])}`;
  if ((m = s.match(/^(.+?)(?:이|가)\s*출발\s*(?:지|점)/))) return `start from ${koPlace(m[1])}`;
  if ((m = s.match(/(?:목적지|도착지|도착\s*지점)\s*(?:를|을|은|는|이|가)?\s*(.+?)(?:으로|로)?\s*(?:설정|정해|바꿔|변경|해|야|이야|입니다)?$/)) && !/어디/.test(m[1])) return `set destination to ${koPlace(m[1])}`;
  if ((m = s.match(/^(.+?)(?:이|가)\s*(?:목적지|도착지)/))) return `set destination to ${koPlace(m[1])}`;
  if ((m = s.match(/^(.+?)(?:에|을|를)?\s*(?:체크\s*포인트|경유지|정류장|중간\s*지점)\s*(?:로|으로)?\s*(?:를|을)?\s*추가/)) || (m = s.match(/(?:체크\s*포인트|경유지)\s*(?:를|을)?\s*(.+?)(?:에|으로|로)\s*(?:추가|넣어|설정)/)) || (m = s.match(/^(.+?)(?:을|를)?\s*(?:경유|들러|거쳐)(?:해|서|가)?\s*(?:줘|가자|가)?$/)))
    return `add a checkpoint at ${koPlace(m[1])}`;
  // ---- save a place ----
  if ((m = s.match(/^(여기|현재\s*위치|이곳|이\s*위치|출발\s*(?:지|점)|목적지)\s*(?:를|을)?\s*(.+?)(?:으로|로|라고)\s*(?:저장|기억|이름\s*붙|등록)/)) || (m = s.match(/^(여기|현재\s*위치|이곳|이\s*위치|출발\s*(?:지|점)|목적지)\s*(?:저장|기억)(?:해|해\s*줘)?\s*(.+)$/))) {
    const what = /출발/.test(m[1]) ? "the start" : /목적지/.test(m[1]) ? "the destination" : "here";
    return `save ${what} as ${m[2].replace(/(?:으로|로|라고)?\s*(?:저장|기억).*$/, "")}`;
  }
  // ---- map, mode, detail ----
  if (/(?:3d|3D|삼\s*차원|입체|쓰리\s*디)/.test(s)) return "3d view";
  if (/(?:2d|2D|이\s*차원|평면\s*지도|투\s*디)/.test(s)) return "2d view";
  if (/(?:해상도|정밀|자세히|세밀)/.test(s) && /(?:높|올|분석|하게|더)/.test(s)) return "refine route terrain";
  if (/(?:로버|차량|탐사차|차로|차\s*타고)/.test(s) && /(?:모드|바꿔|전환|변경|타고|로\s*가|갈래)/.test(s)) return "switch to rover";
  if (/(?:도보|걷기|걸어서|우주복|걸어\s*가)/.test(s) && /(?:모드|바꿔|전환|변경|갈래|가자)/.test(s)) return "switch to on foot mode";
  if (/(?:예시|예제|샘플|데모|기본)\s*경로/.test(s)) return "example route";
  if (/경로\s*(?:를|을)?\s*(?:지워|삭제|초기화|취소|없애|리셋)|처음부터\s*다시/.test(s)) return "clear route";
  // ---- guidance control ----
  if (/(?:안내|내비|네비|길\s*안내|가이드)\s*(?:를|을)?\s*(?:종료|끝|중지|그만|멈춰|꺼|취소)|^(?:그만|종료|끝내|끝)(?:해|하자|할래)?$/.test(s)) return "end navigation";
  if (/^(?:안내\s*)?(?:시작|출발)(?:해|하자|할게|해\s*줘)?$|(?:안내|길\s*안내|내비|네비)\s*(?:를|을)?\s*(?:시작|켜)|출발하자|^가자$|^가$|^출발$/.test(s)) return "start navigation";
  if (/일시\s*정지|멈춰|정지|잠깐|기다려|스톱|멈춤|서\s*봐|대기/.test(s)) return "pause";
  if (/^계속|계속\s*(?:가|진행|해)|재개|다시\s*(?:가|출발|시작|진행)|움직여/.test(s)) return "resume";
  if (/더\s*빠르게|빨리\s*(?:감|가|진행)?|속도\s*(?:올려|높여|빠르게)|배속\s*(?:올려|높여)|가속|빠르게/.test(s) && !/얼마나/.test(s)) return "faster";
  if (/더\s*느리게|천천히|속도\s*(?:내려|낮춰|줄여|느리게)|배속\s*(?:내려|낮춰)|감속|느리게/.test(s)) return "slower";
  if (/다시\s*(?:말해|한\s*번|들려)|반복|뭐라고|못\s*들었|한\s*번\s*더|다시요/.test(s)) return "repeat";
  if (/음소거\s*해제|소리\s*(?:켜|다시)|음성\s*(?:켜|다시)|말해도\s*돼/.test(s)) return "unmute";
  if (/음소거|조용히|소리\s*(?:꺼|끄|없애)|음성\s*(?:꺼|끄)|말\s*하지\s*마|시끄러/.test(s)) return "mute";
  if (/(?:hud|HUD|헤드\s*업|헬멧)\s*(?:화면)?\s*(?:을|를)?\s*(?:열어|보여|켜|띄워)/.test(s)) return "open hud";
  if (/(?:hud|HUD|헤드\s*업|헬멧)\s*(?:을|를)?\s*(?:닫|꺼|내려)|지도\s*(?:로|화면|보여)/.test(s)) return "back to map";
  if (/도움말|도와\s*줘|뭘\s*할\s*수|무엇을\s*할\s*수|명령어|어떻게\s*(?:써|사용)|사용법|기능/.test(s)) return "help";
  if (/(?:어떤|무슨)\s*(?:장소|곳|사이트|지역)|장소\s*목록|갈\s*수\s*있는\s*(?:곳|데)|어디\s*갈\s*수/.test(s)) return "what places";
  // ---- questions that look like "go to" sentences ----
  if (/^다음|어디로\s*가(?:야|면|\?|$)|어느\s*쪽(?:으로)?|이제\s*(?:어떻게|뭐|어디)|뭐\s*해야|어떻게\s*해야|어디\s*가야|길\s*(?:좀\s*)?알려|방향\s*(?:알려|어디)/.test(s) && !/(?:으로|로|까지)\s*(?:데려|가자|가\s*줘)|가는\s*(?:길|경로|방법)/.test(s)) return "what's next";
  // "올림푸스 산 가는 길", "올림푸스 산까지 가는 경로" with no verb
  if ((m = s.match(/^(.+?)\s*(?:으로|로|까지|에)?\s*가는\s*(?:길|경로|방법|루트)\s*(?:은|는|이|가)?\s*(?:뭐야|어떻게\s*돼|알려.*|안내.*|찾아.*|보여.*)?$/))) return `take me to ${koPlace(m[1])}`;
  // ---- relative moves: "왼쪽으로 200m", "앞으로 1km 가", "북서쪽으로 2km 가줘" ----
  if ((m = s.match(new RegExp(`^(?:(.+?)(?:에서|로부터)\\s*)?${RELS}\\s*(?:쪽|방향)?\\s*(?:으로|로)?\\s*${DM}`)))) return `take me to ${m[3]} ${m[4]} ${REL[m[2]]}`;
  if ((m = s.match(new RegExp(`^${DM}\\s*${RELS}`)))) return `take me to ${m[1]} ${m[2]} ${REL[m[3]]}`;
  if ((m = s.match(new RegExp(`^(?:(.+?)(?:에서|로부터)\\s*)?${DIRS}\\s*(?:으로|로)?\\s*${DM}\\s*(?:만큼\\s*)?(?:더\\s*)?${GO}?`))))
    return `take me to ${m[3]} ${m[4]} ${DIR[m[2]]}${m[1] ? ` of ${koPlace(m[1])}` : ""}`;
  if ((m = s.match(new RegExp(`^${DM}\\s*${DIRS}`)))) return `take me to ${m[1]} ${m[2]} ${DIR[m[3]]}`;
  // ---- take me to X ----
  if ((m = s.match(/^(.+?)(?:으로|로|까지|에)\s*(?:나를\s*|우리를\s*)?(?:데려|안내|가\s*줘|가자|가고\s*싶|이동|가는\s*길|갈래|가볼래|향해|출발|가)/))) return `take me to ${koPlace(m[1])}`;
  if ((m = s.match(/^(.+?)\s*(?:가는\s*(?:길|경로)|까지\s*(?:길|경로))\s*(?:좀\s*)?(?:알려|안내|찾아|보여)/))) return `take me to ${koPlace(m[1])}`;
  if ((m = s.match(/^(.+?)\s*(?:가자|갈래|가고\s*싶어)$/))) return `take me to ${koPlace(m[1])}`;
  // ---- show me X on the map ----
  if ((m = s.match(/^(?:지도(?:에서)?\s*)?(.+?)\s*(?:을|를|이|가)?\s*(?:보여|찾아\s*줘|찾아|로\s*이동|어디\s*있|어딨|위치)/)) && !/(?:대피|산소|경사|위험|해|태양)|^(?:내|현재|지금|여기|이곳|목적지|출발지)$/.test(m[1])) return `show me ${koPlace(m[1])}`;
  // ---- questions ----
  if (/산소|숨\s*(?:쉴|쉬는)|호흡|공기|o2|O2|오투|생명\s*유지|plss|PLSS|잔량/.test(s)) return "how much oxygen";
  if (/돌아가(?:는\s*데|려면)|귀환\s*(?:시간|가능)|돌아갈\s*수\s*있|복귀\s*시간/.test(s)) return "how long to walk back";
  if (/대피|피난|숨을\s*(?:데|곳)|피할\s*(?:데|곳)|방사선|태양\s*(?:풍|폭풍)|플레어|차폐|가릴\s*(?:데|곳)/.test(s)) return /(?:데려|가자|가\s*줘|안내|이동|찾아)/.test(s) ? "take me to the nearest shelter" : "where is the shelter";
  if (/체크\s*포인트|경유지|다음\s*정류|중간\s*지점/.test(s)) return "next checkpoint";
  if (/해\s*(?:가\s*)?지|일몰|일출|해가|태양\s*(?:고도|위치)|그늘|그림자|어두|햇빛|밤이|낮이/.test(s)) return "is the sun up";
  if (/얼마나\s*(?:남|걸|더|가야)|남은\s*(?:거리|시간)|도착\s*(?:시간|예정|시각)|언제\s*도착|몇\s*(?:분|시간)\s*(?:남|걸)|거리가?\s*(?:얼마|몇)/.test(s)) return "how far to go";
  if (/경사|기울기|가파|오르막|내리막|비탈/.test(s)) return "slope ahead";
  if (/위험|바위|조심|장애물|절벽|낭떠러지|안전/.test(s)) return "any danger ahead";
  if (/고도|높이|해발/.test(s)) return "what is my elevation";
  if (/가장\s*높은|가장\s*낮은/.test(s)) return /높은/.test(s) ? "what is the highest point" : "what is the lowest point";
  if (/몇\s*시|현지\s*시각|지금\s*시간|시간이\s*몇|솔\s*몇/.test(s)) return "what time is it";
  if (/어디야|어디에\s*있|내\s*위치|현재\s*위치|여기\s*어디|여긴\s*어디/.test(s)) return "where am i";
  if (/속도|얼마나\s*빨리|빠르기/.test(s)) return "how fast am i going";
  if (/다음|어디로|어느\s*쪽|방향|어떻게\s*가/.test(s)) return "what's next";
  if (/상태|요약|어때|괜찮|보고|브리핑|전체|현황/.test(s)) return "status";
  return s;   // leave it (Claude, if enabled, reads Korean)
}
// Korean utterance -> one or more English commands (several are joined with " ;; ")
export function koToEnglish(raw) {
  const s = normNumbers(String(raw).trim().replace(/[.?!~…]+$/g, "").replace(/^(?:어시스턴트|내비게이터|네비게이터|자비스|헤이|저기|야)[,\s]*/, "")
    .replace(/\s*(?:좀|제발|혹시)\s+/g, " ").replace(/\s+/g, " ").trim());
  const out = one(s);
  return Array.isArray(out) ? out.join(" ;; ") : out;
}

// ---------- what the assistant says ----------
export const dirKo = (w) => DIR_KO[w] || w;
export function distKo(m) {
  if (m >= 1000) return `${(m / 1000).toFixed(1).replace(/\.0$/, "")}킬로미터`;
  if (m >= 100) return `${Math.round(m / 50) * 50}미터`;
  return `${Math.max(10, Math.round(m / 10) * 10)}미터`;
}
export function durKo(sec) {
  const neg = sec < 0, m = Math.round(Math.abs(sec) / 60), h = Math.floor(m / 60), mm = m % 60;
  return `${neg ? "마이너스 " : ""}${h ? `${h}시간${mm ? ` ${mm}분` : ""}` : `${mm}분`}`;
}
export const timeKo = (hhmm) => { const [h, m] = hhmm.split(":").map(Number); return `${h}시${m ? ` ${m}분` : ""}`; };

// maneuver text from nav.js
export function manKo(text = "", sub = "") {
  let t = text, m;
  if ((m = t.match(/^(Bear|Turn|Sharp turn) (left|right)$/))) t = `${m[2] === "left" ? "왼쪽" : "오른쪽"}으로 ${m[1] === "Bear" ? "비스듬히 진행" : m[1] === "Turn" ? "회전" : "급회전"}`;
  else if ((m = t.match(/^Head (.+)$/))) t = `${dirKo(m[1])}쪽으로 출발`;
  else if ((m = t.match(/^Continue (.+)$/))) t = `${dirKo(m[1])}쪽으로 계속 진행`;
  else if ((m = t.match(/^Steep (climb|descent) · (\d+)°$/))) t = `${m[2]}도 급경사 ${m[1] === "climb" ? "오르막" : "내리막"}`;
  else if ((m = t.match(/^Arrive at (.+)$/))) t = `${m[1]} 도착`;
  else if ((m = t.match(/^Checkpoint: (.+)$/))) t = `체크포인트 ${m[1]}`;
  let s = sub || "";
  s = s.replace(/^to avoid steep ground, /, "급경사를 피해 ").replace(/^to avoid a rock ridge, /, "바위 능선을 피해 ")
    .replace(/toward (.+)$/, "$1 방향").replace(/^End of route$/, "경로 끝").replace(/^Stop here for (\d+) min$/, "여기서 $1분 정지")
    .replace(/^for (\d+) m · short steps, lean (forward|back)$/, (_, d, w) => `${d}미터 구간, 보폭을 짧게 하고 몸을 ${w === "forward" ? "앞으로" : "뒤로"} 기울이세요`)
    .replace(/^for (\d+) m · slow down$/, "$1미터 구간, 속도를 줄이세요");
  return { text: t, sub: s };
}

// alerts from app.js live()
export function alertKo(a) {
  let m;
  if (/^Turn back now/.test(a)) return "지금 돌아가세요. 예비 산소를 남기고 돌아갈 산소가 부족합니다";
  if ((m = a.match(/^Walk-back margin (.+): plan to turn back soon$/))) return `귀환 여유 시간 ${m[1].replace(/ h /, "시간 ").replace(/ min/, "분")}, 곧 돌아갈 준비를 하세요`;
  if ((m = a.match(/^Steep ground ahead: (\d+)°$/))) return `전방에 ${m[1]}도 급경사가 있습니다`;
  if (/^Entering terrain shadow/.test(a)) return "지형 그늘로 들어갑니다. 춥고 발밑이 어두우니 조심하세요";
  return a;
}

// safety-check titles from app.js assess()
export function checkKo(t) {
  let m;
  if (t === "All checks passed") return "모든 안전 점검 통과";
  if ((m = t.match(/^Steepest ground (\d+)° \(limit (\d+)°\)$/))) return `최대 경사 ${m[1]}도, 한계 ${m[2]}도`;
  if (t === "Not enough oxygen to walk back") return "돌아올 산소가 부족합니다";
  if (t === "Oxygen is tight for the walk back") return "돌아올 산소가 빠듯합니다";
  if (t === "Enough oxygen to walk back") return "돌아올 산소 충분";
  if (t === "Finishes in daylight") return "낮 시간 안에 끝남";
  if (t === "Finishes close to sunset") return "일몰 직전에 끝남";
  if (t === "Runs outside daylight") return "어두운 시간에 걸쳐 있음";
  if ((m = t.match(/^(\d+)% of the route in terrain shadow$/))) return `경로의 ${m[1]}퍼센트가 지형 그늘`;
  if (t === "Sunlit the whole way") return "전 구간 햇빛";
  if ((m = t.match(/^Radiation shielding: sky (\d+)% open on average$/))) return `방사선 차폐: 하늘 평균 ${m[1]}퍼센트 개방`;
  if ((m = t.match(/^Reconnaissance only: (\d+) m terrain$/))) return `정찰용 전용, ${m[1]}미터 해상도 지형`;
  if (t === "Rock density not assessed") return "바위 밀도 미평가";
  if (t === "Point moved to usable ground") return "지점을 이동 가능한 땅으로 옮김";
  return t;
}
// danger titles/subs from app.js analyse()
export function dangerKo(title, sub) {
  let m, t = title;
  if ((m = t.match(/^Steep (climb|descent) up to (\d+)°$/))) t = `최대 ${m[2]}도 급경사 ${m[1] === "climb" ? "오르막" : "내리막"}`;
  else if (t === "Rocky ground / ridges") t = "바위 지대와 능선";
  else if (t === "Passes close to no-go ground") t = "통행 불가 지역 근처 통과";
  else if (t === "In terrain shadow") t = "지형 그늘 구간";
  const len = (sub.match(/^(\d[\d,.]*\s?(?:km|m))/) || [])[1];
  return len ? `${t}, 길이 ${len.replace(/\s?km/, "킬로미터").replace(/\s?m$/, "미터")}` : t;
}

// ---------- English assistant output -> Korean ----------
// The onboard assistant composes English sentences from a fixed set of templates; this maps each one.
// Anything it doesn't recognise (e.g. a Claude reply already in Korean) passes through unchanged.
const NAME_KO = [
  // "2 km north west of X" first, so X can still be a coordinate with decimal points
  [/(\S+) (km|m) (north east|north west|south east|south west|north|south|east|west) of (.+?)(?=[,:]|$)/g, (_, n, u, d, b) => `${b}에서 ${DIR_KO[d]}쪽 ${n}${u}`],
  [/\bLanding plain\b/g, "착륙 평원"], [/\bUpper boxwork ridges\b/g, "상부 박스워크 능선"],
  [/\bGale crater \(Curiosity\)/g, "게일 크레이터(큐리오시티)"], [/\bJezero crater \(Perseverance\)/g, "예제로 크레이터(퍼서비어런스)"],
  [/\bColumbia Hills \(Spirit\)/g, "컬럼비아 힐스(스피릿)"], [/\bEndeavour crater \(Opportunity\)/g, "인데버 크레이터(오퍼튜니티)"],
  [/\bVictoria crater \(Opportunity\)/g, "빅토리아 크레이터(오퍼튜니티)"], [/\bInSight landing area\b/g, "인사이트 착륙 지역"], [/\bPhoenix landing area\b/g, "피닉스 착륙 지역"],
  [/\bMars Pathfinder \(Sojourner\)/g, "마스 패스파인더(소저너)"], [/\bViking (1|2) landing site\b/g, "바이킹 $1호 착륙지"], [/\bZhurong \(Tianwen-1\)/g, "주룽(톈원 1호)"],
  [/\bOlympus Mons\b/g, "올림푸스 산"], [/\bValles Marineris\b/g, "매리너스 협곡"], [/\bHellas Planitia\b/g, "헬라스 평원"], [/\bElysium Mons\b/g, "엘리시움 산"],
  [/\bArsia Mons\b/g, "아르시아 산"], [/\bPavonis Mons\b/g, "파보니스 산"], [/\bAscraeus Mons\b/g, "아스크라이우스 산"], [/\bUtopia Planitia\b/g, "유토피아 평원"],
  [/\bNearest shelter \((\d+)% sky open\)/g, "가장 가까운 대피처(하늘 $1% 개방)"],
  [/\b(Highest|Lowest) point \((-?\d+) m\)/g, (_, w, e) => `${w === "Highest" ? "최고" : "최저"} 지점(고도 ${e}m)`],
  [/(\d+) m (left|right|ahead|back) of (your position|the start)/g, (_, n, d, b) => `${b === "the start" ? "출발지" : "현재 위치"}에서 ${{ left: "왼쪽", right: "오른쪽", ahead: "앞쪽", back: "뒤쪽" }[d]} ${n}m`],
  [/\bCurrent position\b/g, "현재 위치"], [/\byour position\b/g, "현재 위치"], [/\bthe start\b/g, "출발지"], [/\bthe destination\b/g, "목적지"], [/\bDestination\b(?! set)/g, "목적지"],
  [/(\d+(?:\.\d+)?) South (\d+(?:\.\d+)?) East/g, "남위 $1 동경 $2"], [/(\d+(?:\.\d+)?) North (\d+(?:\.\d+)?) East/g, "북위 $1 동경 $2"],
];
const UNITS = [
  [/(\d+(?:\.\d+)?) kilometres? per hour/g, "시속 $1킬로미터"],
  [/(\d+(?:\.\d+)?) kilometres?/g, "$1킬로미터"], [/(\d+) metres/g, "$1미터"],
  [/minus (\d+) hours?(?: (\d+) minutes?)?/g, (_, h, m) => `마이너스 ${h}시간${m ? ` ${m}분` : ""}`],
  [/(\d+) hours?(?: (\d+) minutes?)?/g, (_, h, m) => `${h}시간${m ? ` ${m}분` : ""}`], [/(\d+) minutes?/g, "$1분"],
  [/(\d+) degrees/g, "$1도"], [/(\d+) percent/g, "$1퍼센트"],
  [/(\d\d?):(\d\d) local (?:mean solar )?time/g, (_, h, m) => `현지 시각 ${+h}시${+m ? ` ${+m}분` : ""}`],
];
const subAll = (s, list) => list.reduce((t, [re, to]) => t.replace(re, to), s);
// a maneuver clause such as "bear right, toward X" or "steep climb · 18°, for 95 m · short steps, lean forward"
function mClause(s) {
  const parts = s.split(/,\s+(?=to avoid|toward|for \d|End of route|Stop here)/);
  const head = parts[0].trim(), rest = parts.slice(1).join(", ");
  const k = manKo(head.charAt(0).toUpperCase() + head.slice(1), rest);
  return [k.text, k.sub].filter(Boolean).join(", ");
}
const yesNo = (w, a, b) => (w ? a : b);
const RULES = [
  [/^Guidance started$/, "안내를 시작합니다"],
  // a bare maneuver sentence: "Bear right, toward X", "Steep climb · 20°, for 30 m · …", "Arrive at X, End of route"
  [/^((?:Bear|Turn|Sharp turn) (?:left|right)|Head [a-z-]+(?: [a-z]+)?|Steep (?:climb|descent) · \d+°|Arrive at .+?|Checkpoint: .+?)(?:, (.+))?$/, (_, m, r) => mClause(r ? `${m}, ${r}` : m)],
  [/^(.+) to go, about (.+)$/, "남은 거리 $1, 약 $2"],
  [/^([\d.]+ (?:kilometres?|metres)), about (.+)$/, "$1, 약 $2"],
  [/^Arrival around (.+)$/, "도착 예정은 $1"],
  [/^In (\S+ \S+), (.+)$/, (_, d, m) => `${d} 앞에서 ${mClause(m)}`],
  [/^You have arrived at (.+)$/, "$1에 도착했습니다"], [/^End of route$/, "경로가 끝났습니다"],
  [/^Steep (climb|descent) starts now$/, (_, m) => `급경사 ${m === "climb" ? "오르막" : "내리막"}이 시작됩니다`],
  [/^short steps, lean (forward|back)$/, (_, w) => `보폭을 짧게 하고 몸을 ${yesNo(w === "forward", "앞으로", "뒤로")} 기울이세요`], [/^slow down$/, "속도를 줄이세요"],
  [/^Checkpoint: (.+)$/, "체크포인트 $1"], [/^Stop here for (\d+) min$/, "여기서 $1분 정지하세요"],
  [/^((?:Bear|Turn|Sharp turn) (?:left|right)|Head \S+(?: \S+)?) now(?:, (.+))?$/, (_, m, r) => `지금 ${mClause(r ? `${m}, ${r}` : m)}`],
  [/^Caution$/, "주의하세요"], [/^Caution: (.+)$/, (_, a) => `주의: ${alertKo(a)}`],
  [/^(Turn back now.+|Walk-back margin .+: plan to turn back soon|Steep ground ahead: .+|Entering terrain shadow.*)$/, (_, a) => alertKo(a)],
  [/^Route planned from (.+?) to (.+?)(?: via (.+?))?: (.+), about (.+), arriving around (.+)$/, (_, a, b, v, d, t, at) => `${a}에서 ${b}까지 경로를 찾았습니다${v ? `(경유: ${v})` : ""}. ${d}, 약 ${t}, 도착 예정은 ${at}`],
  [/^Guiding you to (.+?): (.+), about (.+)$/, "$1까지 안내합니다. $2, 약 $3"],
  [/^All safety checks passed$/, "모든 안전 점검을 통과했습니다"],
  [/^Watch out: (.+)$/, (_, c) => `주의: ${checkKo(c.replace(/ degrees/g, "°").replace(/(\d+) metres terrain/, "$1 m terrain"))}`],
  [/^Say start navigation to begin$/, "'안내 시작'이라고 말하면 출발합니다"],
  [/^Destination set(?: to (.+))?$/, (_, p) => `목적지 설정${p ? `: ${p}` : " 완료"}`], [/^Start set(?: at (.+))?$/, (_, p) => `출발지 설정${p ? `: ${p}` : " 완료"}`],
  [/^Where do you start$/, "어디에서 출발하나요"], [/^Where are you going$/, "어디로 가나요"],
  [/^Say "start from" a place, or tap the map$/, "'어디에서 출발'이라고 말하거나 지도를 누르세요"],
  [/^Switched to (rover|on-foot) mode$/, (_, m) => `${yesNo(m === "rover", "로버", "도보")} 모드로 바꿨습니다`],
  [/^Already in (rover|on-foot) mode$/, (_, m) => `이미 ${yesNo(m === "rover", "로버", "도보")} 모드입니다`],
  [/^You're already there$/, "이미 그곳에 있습니다"],
  [/^I don't know "(.+)"$/, "모르는 장소입니다: $1"], [/^Known places: (.+)$/, "아는 장소: $1"], [/^Sites: (.+)$/, "사이트: $1"], [/^Places: (.+)$/, "장소: $1"],
  [/^You can also say nearest shelter, highest point, a distance and direction like 500 metres north, or coordinates$/, "'가장 가까운 대피소', '가장 높은 곳', '북쪽으로 500미터' 같은 거리와 방향, '남위 4.55 동경 137.55' 같은 좌표로도 말할 수 있습니다"],
  [/^I can also find the nearest shelter.+$/, "가장 가까운 대피소, 가장 높은 곳과 낮은 곳, 거리와 방향, 좌표로도 화성 어디든 찾을 수 있습니다"],
  [/^The sharpest terrain is in the outlined regions$/, "가장 정밀한 지형은 지도에 테두리로 표시된 지역입니다"],
  [/^(.+) is far from your start, so I moved the map there instead of planning across Mars$/, "$1: 출발지에서 너무 멀어서, 화성을 가로지르는 경로 대신 지도를 그곳으로 옮겼습니다"],
  [/^Say start from a place there, or tap the map(?:, to plan a route)?$/, "그곳에서 출발할 장소를 말하거나 지도를 누르세요"],
  [/^Showing (?!the 3D)(.+)$/, "지도에서 보여 줍니다: $1"],
  [/^Route cleared$/, "경로를 지웠습니다"], [/^Loading the example route$/, "예시 경로를 불러옵니다"],
  [/^Saved (.+)$/, "저장했습니다: $1"], [/^You can now say: take me to (.+)$/, "이제 '$1까지 데려가 줘'라고 말할 수 있습니다"],
  [/^Showing the 3D terrain$/, "3D 지형을 보여 줍니다"], [/^Back to the 2D map$/, "2D 지도로 돌아갑니다"],
  [/^Re-analysing the terrain along this route on a finer grid$/, "이 경로 주변 지형을 더 촘촘한 격자로 다시 분석합니다"], [/^There's no route to refine yet$/, "아직 정밀 분석할 경로가 없습니다"],
  [/^Left or right of what\? Before guidance starts, use compass directions, like 200 metres north$/, "안내 전에는 왼쪽·오른쪽 기준이 없습니다. '북쪽으로 200미터'처럼 방위로 말해 주세요"],
  [/^There's no real shelter near here: the sky is (.+) open where you are, and no reachable spot within 1\.5 kilometres is more enclosed$/, "근처에 쓸 만한 대피처가 없습니다. 지금 위치는 하늘이 $1 열려 있고, 1.5킬로미터 안에 이보다 더 가려진 곳이 없습니다"],
  [/^Terrain only shields you where cliffs or crater walls block the sky$/, "지형 차폐는 절벽이나 크레이터 벽이 하늘을 가리는 곳에서만 효과가 있습니다"],
  [/^Sky is (.+) open here and (.+) there$/, "여기는 하늘이 $1, 대피처는 $2 열려 있습니다"],
  [/^(.+) is (.+) kilometres away: too far for a surface traverse \(this planner goes up to 1,500 km\)$/, "$1까지 $2킬로미터: 지표 이동으로는 너무 멉니다(최대 1,500킬로미터)"],
  [/^I moved the map there$/, "지도를 그곳으로 옮겼습니다"], [/^Pick a start near it, or tap the map$/, "근처에서 출발지를 고르거나 지도를 누르세요"],
  [/^Paused$/, "일시정지했습니다"], [/^Resuming guidance$/, "안내를 계속합니다"], [/^Simulation speed (\d+) times$/, "시뮬레이션 속도 $1배"],
  [/^Already at the (fastest|slowest) simulation speed, (\d+) times$/, (_, f, n) => `이미 가장 ${yesNo(f === "fastest", "빠른", "느린")} 속도입니다. ${n}배`],
  [/^Opening the helmet display$/, "헬멧 화면을 엽니다"], [/^Back to the map$/, "지도로 돌아갑니다"], [/^Ending navigation$/, "안내를 종료합니다"],
  [/^Spoken guidance is on$/, "음성 안내를 켰습니다"], [/^Muting spoken guidance$/, "음성 안내를 끕니다"], [/^I'll still answer your questions out loud$/, "질문에는 계속 소리로 답합니다"],
  [/^Guidance hasn't started$/, "아직 안내가 시작되지 않았습니다"], [/^Plan a route, then say start navigation$/, "경로를 정한 뒤 '안내 시작'이라고 말하세요"],
  [/^Nothing to repeat yet$/, "아직 다시 말할 내용이 없습니다"],
  [/^Ask me about oxygen.+$/, "산소, 다음 방향, 도착 시간, 경사, 위험, 햇빛, 대피소, 다음 체크포인트를 물어보세요"],
  [/^Say pause, resume, faster.+$/, "'일시정지', '계속', '빠르게', '느리게', '다시 말해', '음소거', '헬멧 화면 열어', '기지로 돌아가', '가장 가까운 대피소로 데려가 줘', '안내 종료'라고 말할 수 있습니다"],
  [/^Say a route, like: .+$/, "'착륙 평원에서 박스워크 능선까지 안내해 줘'처럼 경로를 말하세요"],
  [/^Places can be names .+$/, "장소 이름, '가장 가까운 대피소', '가장 높은 곳', '북쪽으로 500미터', '남위 4.55 동경 137.55' 같은 좌표를 쓸 수 있습니다"],
  [/^Then say start navigation$/, "그다음 '안내 시작'이라고 말하세요"],
  [/^(.+) of oxygen left$/, "산소가 $1 남았습니다"],
  [/^Walk-back margin is (.+?)(: turn back now|: plan to turn back soon|, that's fine)$/, (_, t, w) => `귀환 여유 시간은 ${t}${w.includes("now") ? "입니다. 지금 돌아가세요" : w.includes("soon") ? "입니다. 곧 돌아갈 준비를 하세요" : "입니다. 충분합니다"}`],
  [/^You're in the pressurized rover, so suit oxygen isn't being drawn$/, "여압 로버 안이라 우주복 산소는 쓰지 않습니다"], [/^Cabin life support isn't modelled here$/, "선실 생명 유지 장치는 계산하지 않습니다"],
  [/^(?:Walking|Driving) back (?:to the start )?from here takes about (.+)$/, "여기서 출발지까지 돌아가는 데 약 $1 걸립니다"],
  [/^Say take me back to base to re-route$/, "'기지로 돌아가 줘'라고 말하면 경로를 다시 잡습니다"],
  [/^(?:The sky|Sky) is (.+) open here$/, "여기는 하늘이 $1 열려 있습니다"],
  [/^The most sheltered spot near the route is (.+?) to the (.+?), with (.+) of the sky open$/, (_, d, w, p) => `경로 근처에서 가장 잘 가려진 곳은 ${dirKo(w)}쪽 ${d} 지점이고, 하늘이 ${p} 열려 있습니다`],
  [/^Say take me to the nearest shelter to go there$/, "'가장 가까운 대피소로 데려가 줘'라고 말하면 그곳으로 안내합니다"],
  [/^Go there if a solar particle event is called$/, "태양 입자 폭풍 경보가 나오면 그곳으로 가세요"],
  [/^Shielding is relative to terrain only, not a dose$/, "차폐는 지형 기준 상대값이며 피폭량이 아닙니다"],
  [/^No better shelter was found near the route$/, "경로 근처에서 더 나은 대피처를 찾지 못했습니다"],
  [/^(?:There are no more checkpoints|No checkpoints left)$/, "남은 체크포인트가 없습니다"], [/^The destination is (.+) ahead$/, "목적지는 $1 앞입니다"],
  [/^(.+) is (\S+ \S+) ahead(?:, with a (\d+) minute stop)?$/, (_, n, d, s) => `${n}: ${d} 앞${s ? `, ${s}분 정지` : ""}`],
  [/^You'll arrive around (.+)$/, "도착 예정은 $1"], [/^You've arrived$/, "도착했습니다"], [/^There are no more turns$/, "더 이상 회전이 없습니다"],
  [/^Slope here is (.+)$/, "여기 경사는 $1입니다"],
  [/^The steepest in the next 50 metres is (.+), against a limit of (\d+)$/, "앞으로 50미터 안의 최대 경사는 $1이고 한계는 $2도입니다"],
  [/^No more marked dangers on the rest of the route$/, "남은 경로에 표시된 위험 구간이 없습니다"],
  [/^Next: (.+?), in (\S+ \S+)$/, (_, t, d) => `다음 위험: ${dangerKo(t.replace(/ degrees/, "°"), "")}, ${d} 앞`],
  [/^You're in it now: (.+)$/, (_, t) => `지금 그 구간입니다: ${dangerKo(t.replace(/ degrees/, "°"), "")}`],
  [/^(\S+ \S+) long, risk of slipping; short steps$/, "길이 $1, 미끄러질 위험이 있으니 보폭을 짧게 하세요"],
  [/^(\S+ \S+) long, slow down, watch rover tilt$/, "길이 $1, 속도를 줄이고 로버 기울기를 확인하세요"],
  [/^The sun is below the horizon$/, "해가 지평선 아래에 있습니다"], [/^Sun is (.+) up in the (.+)$/, (_, e, w) => `해는 ${dirKo(w)}쪽 하늘 ${e} 높이에 있습니다`],
  [/^You're in terrain shadow$/, "지형 그늘 속에 있습니다"], [/^Sunset is at (.+)$/, "일몰은 $1입니다"],
  [/^Elevation is (.+)$/, "고도는 $1입니다"], [/^The route ranges from (.+) to (.+)$/, "경로 고도는 $1에서 $2 사이입니다"],
  [/^Planned walking pace on flat ground is (.+)$/, "평지 보행 속도는 $1로 계획되어 있습니다"], [/^Rover speed is (.+)$/, "로버 속도는 $1입니다"],
  [/^You're (.+?) along the route to (.+), heading (.+?), at (.+)$/, (_, d, to, h, e) => `${to}까지 가는 경로의 ${d} 지점에서 ${dirKo(h)}쪽으로 이동 중이고, 고도는 ${e}입니다`],
  [/^It's (.+)$/, "지금은 $1입니다"],
  [/^Continue (\S+(?: \S+)?) for (.+), then (.+)$/, (_, w, d, m) => `${dirKo(w)}쪽으로 ${d} 계속 간 뒤 ${mClause(m)}`],
  [/^Continue (\S+(?: \S+)?)$/, (_, w) => `${dirKo(w)}쪽으로 계속 가세요`],
  [/^You're stopped at (.+) for another (.+)$/, "$1에서 $2 더 머뭅니다"],
  [/^I didn't catch that$/, "잘 알아듣지 못했습니다"], [/^Ask about oxygen.+$/, "산소, 다음 방향, 도착 시간, 경사, 위험, 햇빛, 대피소를 물어보세요"],
  [/^Or say pause, resume, repeat, or take me to a place$/, "또는 '일시정지', '계속', '다시 말해', '어디로 데려가 줘'라고 말하세요"],
  [/^There's no route yet$/, "아직 경로가 없습니다"], [/^Say something like: .+$/, "'착륙 평원에서 박스워크 능선까지 안내해 줘'처럼 말해 보세요"],
  [/^Route from (.+?) to (.+?): (.+), about (.+)$/, "$1에서 $2까지: $3, 약 $4"],
  [/^The (highest|lowest) point in the analysed area is at (.+)$/, (_, w, e) => `분석한 지역에서 가장 ${yesNo(w === "highest", "높은", "낮은")} 곳은 고도 ${e}입니다`],
  [/^Say take me to the (highest|lowest) point to plan a route there$/, (_, w) => `'가장 ${yesNo(w === "highest", "높은", "낮은")} 곳으로 데려가 줘'라고 말하면 경로를 잡습니다`],
  [/^Before guidance starts I don't know where you are$/, "안내를 시작하기 전에는 현재 위치를 알 수 없습니다"], [/^Name a place, or tap the map$/, "장소를 말하거나 지도를 누르세요"],
  [/^There's no (start|destination) yet$/, (_, w) => `아직 ${yesNo(w === "start", "출발지", "목적지")}가 없습니다`],
  [/^Working on it…$/, "처리 중…"], [/^Thinking…$/, "생각 중…"], [/^Planning the route…$/, "경로 계획 중…"], [/^Done$/, "완료"],
  [/^Voice guidance is working$/, "음성 안내가 작동합니다"], [/^Try: .+$/, "'착륙 평원에서 박스워크 능선까지 안내해 줘'라고 말해 보세요"],
];
export function enToKo(text) {
  if (!text) return text;
  const sentences = String(text).split(/(?<=[.!?])\s+(?=[A-Z0-9"'])/);
  return sentences.map((s0) => {
    const ell = /…$/.test(s0), end = !ell && /[.!?]$/.test(s0) ? s0.slice(-1) : "";
    let s = end ? s0.slice(0, -1) : s0;
    s = subAll(s, NAME_KO);
    for (const [re, to] of RULES) if (re.test(s)) { s = s.replace(re, to); break; }
    s = subAll(s, UNITS);
    if (!hasHangul(s)) s = checkKo(s.replace(/ degrees/g, "°"));   // plan answers list check titles one per sentence
    return s + (end === "?" ? "?" : end ? "." : "");
  }).join(" ");
}

// ---------- Hangul -> Latin, tuned for foreign place names said in Korean ----------
// ("올림푸스" -> "ollimpus", "아라비아 테라" -> "arabia tera") so they can be matched against IAU names.
const INI = ["g", "kk", "n", "d", "tt", "r", "m", "b", "pp", "s", "ss", "", "j", "jj", "ch", "k", "t", "p", "h"];
const MED = ["a", "e", "ia", "ie", "o", "e", "io", "ie", "o", "ua", "ue", "oe", "io", "u", "uo", "ue", "ui", "iu", "eu", "ui", "i"];
const FIN = ["", "k", "k", "ks", "n", "nj", "n", "t", "l", "lk", "lm", "lb", "ls", "lt", "lp", "l", "m", "p", "ps", "s", "s", "ng", "t", "t", "k", "t", "p", "t"];
const GENERIC_KO = /크레이터|분화구|산맥|산|협곡|계곡|평원|평지|고원|분지|지역|화산/g;
const NAME_WORDS_KO = [[/능선|산등성이/g, " ridge "], [/사구/g, " dunes "], [/언덕|구릉/g, " hills "], [/착륙\s*지점|착륙지|랜딩/g, " landing "], [/노두/g, " outcrop "], [/뷰트|뷰츠/g, " buttes "], [/꼭대기|정상/g, " top "]];
export function romanize(s) {
  const t = NAME_WORDS_KO.reduce((x, [re, en]) => x.replace(re, en), String(s)).replace(GENERIC_KO, " ");
  let out = "";
  for (const word of t.split(/\s+/)) {
    const syl = [...word];
    syl.forEach((ch, idx) => {
      const c = ch.charCodeAt(0) - 0xac00;
      if (c < 0 || c > 11171) { out += /[a-z0-9]/i.test(ch) ? ch.toLowerCase() : ""; return; }
      const L = Math.floor(c / 588), V = Math.floor((c % 588) / 28), T = c % 28;
      let v = MED[V];
      // the "으" vowel Korean adds after a lone consonant (스, 크, 트, 프) isn't in the original name
      if (v === "eu" && !T && INI[L] !== "") v = "";
      out += INI[L] + v + FIN[T];
    });
    out += " ";
  }
  return out.trim();
}

// known place names in Korean, for on-screen text
export const namesKo = (s) => subAll(String(s), NAME_KO);
