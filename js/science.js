// Science along the way: places on lower Mount Sharp where Curiosity did notable science, tagged by objective,
// so a crew can turn a walk into a science traverse. Coordinates come from NASA Trek's Curiosity waypoints
// (js/places.js); the upper boxwork ridges are the destination of the example route.
import { PLACES_DATA } from "./places.js";
import { EXAMPLE } from "./mission.js";

export const OBJECTIVES = {
  water: { en: "Ancient water & habitability", ko: "고대 물·생명 가능 환경" },
  layers: { en: "Rock layers & ancient lakes", ko: "암석 층·고대 호수" },
  wind: { en: "Wind & active dunes", ko: "바람·움직이는 모래 언덕" },
  minerals: { en: "Minerals (hematite, silica)", ko: "광물(적철석·실리카)" },
  boxwork: { en: "Boxwork & groundwater", ko: "박스워크·지하수" },
};

// name (Trek waypoint spelling), objective, what Curiosity found there, suggested time on site (min)
export const SCIENCE_SITES = [
  { name: "Bradbury Landing", obj: "water", min: 30,
    en: "Landing site. Rounded pebbles in nearby conglomerate showed an ancient stream once flowed here.",
    ko: "착륙 지점. 근처 역암의 둥근 자갈이 이곳에 옛 개울이 흘렀다는 증거였어요." },
  { name: "The Rocknest", obj: "wind", min: 30,
    en: "Wind-blown sand drift where Curiosity scooped and analysed its first Martian soil.",
    ko: "바람에 쌓인 모래 더미. 큐리오시티가 처음으로 화성 흙을 퍼서 분석한 곳이에요." },
  { name: "Glenelg", obj: "water", min: 45,
    en: "Yellowknife Bay mudstone: the first drill sample showed clay minerals from an ancient lake that could have supported microbes.",
    ko: "옐로나이프 만 이암. 첫 시추 시료에서 미생물이 살 수 있었던 옛 호수의 점토 광물이 나왔어요." },
  { name: "The Kimberly", obj: "layers", min: 45,
    en: "Layered sandstone outcrops recording rivers and deltas flowing toward Mount Sharp; drilled at Windjana.",
    ko: "샤프산 쪽으로 흐른 강과 삼각주를 기록한 층상 사암 노두. 윈드자나에서 시추했어요." },
  { name: "Pahrump Hills", obj: "layers", min: 45,
    en: "Base of Mount Sharp: Murray formation mudstone laid down in a long-lived lake.",
    ko: "샤프산 기슭. 오래 이어진 호수에서 쌓인 머레이층 이암이에요." },
  { name: "Marias Pass", obj: "minerals", min: 30,
    en: "Contact between rock units with unusually high silica, including tridymite.",
    ko: "암석 단위가 만나는 곳으로, 트리디마이트를 포함한 실리카가 유난히 많아요." },
  { name: "Bagnold Dunes", obj: "wind", min: 30,
    en: "Dark, active sand dunes: the first close-up study of active dunes on another planet.",
    ko: "검은 활성 모래 언덕. 다른 행성의 움직이는 모래 언덕을 처음 가까이서 조사한 곳이에요." },
  { name: "Murray Buttes", obj: "layers", min: 30,
    en: "Buttes capped by Stimson sandstone, the remains of ancient wind-blown dunes over lake mudstone.",
    ko: "호수 이암 위에 쌓인 옛 사구가 굳은 스팀슨 사암이 꼭대기를 덮은 뷰트들이에요." },
  { name: "Vera Rubin Ridge", obj: "minerals", min: 45,
    en: "Erosion-resistant ridge rich in hematite, an iron oxide that formed with water.",
    ko: "물과 함께 생긴 산화철인 적철석이 풍부한, 침식에 강한 능선이에요." },
  { name: EXAMPLE.end.name, obj: "boxwork", min: 45, lat: EXAMPLE.end.lat, lon: EXAMPLE.end.lon,
    en: "Boxwork ridges: a network of low ridges left where groundwater deposited minerals in fractures.",
    ko: "박스워크 능선. 지하수가 갈라진 틈에 광물을 남겨 생긴 낮은 능선의 그물망이에요." },
];
// attach coordinates from Trek's waypoints
for (const s of SCIENCE_SITES) if (s.lat == null) {
  const w = PLACES_DATA.waypoints.find(([n, m]) => n === s.name && /curiosity/i.test(m));
  if (w) { s.lat = w[2]; s.lon = w[3]; }
}
