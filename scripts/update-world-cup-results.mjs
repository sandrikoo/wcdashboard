import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INDEX_FILE = path.join(ROOT, "index.html");
const MAP_FILE = path.join(ROOT, "scripts", "world-cup-fixture-map.json");
const API_BASE = "https://api.thestatsapi.com/api";
const API_KEY = process.env.THESTATSAPI_KEY || process.env.API_FOOTBALL_KEY || "";
const COMPETITION_ID = process.env.THESTATSAPI_COMPETITION_ID || "comp_6107";
const SEASON_ID = process.env.THESTATSAPI_SEASON_ID || "sn_118868";
const DRY_RUN = process.argv.includes("--dry-run");
const MATCH_DURATION_MS = 125 * 60 * 1000;
const CHECK_BUFFER_MS = Number(process.env.RESULT_CHECK_BUFFER_MINUTES || 10) * 60 * 1000;

const TEAM_EN = {
  MEX: "Mexico", RSA: "South Africa", KOR: "South Korea", CZE: "Czech Republic", CAN: "Canada", BIH: "Bosnia & Herzegovina",
  QAT: "Qatar", SUI: "Switzerland", BRA: "Brazil", MAR: "Morocco", HAI: "Haiti", SCO: "Scotland", USA: "USA", PAR: "Paraguay",
  AUS: "Australia", TUR: "Türkiye", GER: "Germany", CUW: "Curaçao", CIV: "Ivory Coast", ECU: "Ecuador", NED: "Netherlands",
  JPN: "Japan", SWE: "Sweden", TUN: "Tunisia", BEL: "Belgium", EGY: "Egypt", IRN: "Iran", NZL: "New Zealand", ESP: "Spain",
  CPV: "Cape Verde", KSA: "Saudi Arabia", URU: "Uruguay", FRA: "France", SEN: "Senegal", IRQ: "Iraq", NOR: "Norway",
  ARG: "Argentina", ALG: "Algeria", AUT: "Austria", JOR: "Jordan", POR: "Portugal", COD: "DR Congo", UZB: "Uzbekistan",
  COL: "Colombia", ENG: "England", CRO: "Croatia", GHA: "Ghana", PAN: "Panama"
};

const NAME_ALIASES = {
  BIH: ["Bosnia & Herzegovina", "Bosnia and Herzegovina", "Bosnia-Herzegovina"],
  CIV: ["Côte d'Ivoire", "Cote d'Ivoire", "Ivory Coast"],
  COD: ["DR Congo", "Congo DR", "Democratic Republic of the Congo"],
  CPV: ["Cabo Verde", "Cape Verde"],
  CUW: ["Curacao", "Curaçao"],
  TUR: ["Turkey", "Türkiye", "Turkiye"],
  USA: ["USA", "United States", "United States of America"]
};

const REAL_TEAM = /^[A-Z]{3}$/;
const SLOT_TEAM = /^(?:W|L|P)\d+[A-Z]?$/;
const FINISHED = new Set(["finished", "ft", "aet", "pen"]);

function extractConstObject(source, name) {
  const marker = `const ${name} = `;
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`Cannot find ${name} in index.html`);
  const objectStart = start + marker.length;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = objectStart; i < source.length; i += 1) {
    const ch = source[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === "\"") inString = false;
      continue;
    }
    if (ch === "\"") inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return {
        start: objectStart,
        end: i + 1,
        value: JSON.parse(source.slice(objectStart, i + 1))
      };
    }
  }
  throw new Error(`Cannot parse ${name} in index.html`);
}

function normalizeName(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function namesForCode(code) {
  return [TEAM_EN[code], ...(NAME_ALIASES[code] || [])].filter(Boolean).map(normalizeName);
}

function fixtureTeamNames(fixture) {
  return [
    normalizeName(fixture?.teams?.home?.name),
    normalizeName(fixture?.teams?.away?.name)
  ];
}

function isRealMatch(match) {
  return REAL_TEAM.test(match.h) && REAL_TEAM.test(match.a);
}

function tbDate(value) {
  return new Date(`${value}:00+04:00`);
}

function isDue(match, now) {
  return now.getTime() >= tbDate(match.tb).getTime() + MATCH_DURATION_MS + CHECK_BUFFER_MS;
}

function utcDate(value) {
  return value.toISOString().slice(0, 10);
}

function candidateDates(match) {
  const kickoff = tbDate(match.tb);
  const dates = new Set([utcDate(kickoff), match.tb.slice(0, 10)]);
  dates.add(utcDate(new Date(kickoff.getTime() - 24 * 60 * 60 * 1000)));
  dates.add(utcDate(new Date(kickoff.getTime() + 24 * 60 * 60 * 1000)));
  return [...dates];
}

async function fetchApi(pathname, params) {
  if (!API_KEY) throw new Error("Missing THESTATSAPI_KEY GitHub secret.");
  const url = new URL(`${API_BASE}${pathname}`);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, String(value)));
  const res = await fetch(url, { headers: { Authorization: `Bearer ${API_KEY}` } });
  if (!res.ok) throw new Error(`API request failed ${res.status}: ${await res.text()}`);
  const body = await res.json();
  if (Array.isArray(body.errors) && body.errors.length) throw new Error(`API returned errors: ${body.errors.join(", ")}`);
  if (body.errors && Object.keys(body.errors).length) throw new Error(`API returned errors: ${JSON.stringify(body.errors)}`);
  return body.data || body.response || [];
}

function fixtureMatchesTeams(fixture, match) {
  const fixtureNames = fixtureTeamNames(fixture);
  const homeNames = namesForCode(match.h);
  const awayNames = namesForCode(match.a);
  const direct = homeNames.includes(fixtureNames[0]) && awayNames.includes(fixtureNames[1]);
  const reversed = homeNames.includes(fixtureNames[1]) && awayNames.includes(fixtureNames[0]);
  return direct || reversed;
}

async function fetchWorldCupFixtures() {
  const all = [];
  for (let page = 1; page <= 3; page += 1) {
    const rows = await fetchApi("/football/matches", {
      competition_id: COMPETITION_ID,
      season_id: SEASON_ID,
      per_page: 100,
      page
    });
    all.push(...rows);
    if (rows.length < 100) break;
  }
  return all;
}

async function findFixture(match, fixtureMap, fixtures) {
  const mappedId = fixtureMap[String(match.id)];
  if (mappedId) return fixtures.find(fixture => fixture.match_id === mappedId) || null;
  return fixtures.find(fixture => Number(fixture.match_number) === Number(match.id))
    || fixtures.find(fixture => fixtureMatchesTeams(fixture, match))
    || null;
}

function finishedWinnerCodes(match, fixture) {
  const status = String(fixture?.status || fixture?.fixture?.status?.short || "").toLowerCase();
  if (!FINISHED.has(status)) return null;
  const homeWinner = fixture?.home?.winner ?? fixture?.teams?.home?.winner;
  const awayWinner = fixture?.away?.winner ?? fixture?.teams?.away?.winner;
  if (homeWinner === true) return { winner: match.h, loser: match.a, status };
  if (awayWinner === true) return { winner: match.a, loser: match.h, status };

  const homePenalty = Number(fixture?.home?.penalty_score ?? fixture?.home?.penalties ?? fixture?.score?.penalty?.home);
  const awayPenalty = Number(fixture?.away?.penalty_score ?? fixture?.away?.penalties ?? fixture?.score?.penalty?.away);
  if (Number.isFinite(homePenalty) && Number.isFinite(awayPenalty) && homePenalty !== awayPenalty) {
    return homePenalty > awayPenalty
      ? { winner: match.h, loser: match.a, status }
      : { winner: match.a, loser: match.h, status };
  }

  const homeGoals = Number(fixture?.home?.score ?? fixture?.goals?.home);
  const awayGoals = Number(fixture?.away?.score ?? fixture?.goals?.away);
  if (Number.isFinite(homeGoals) && Number.isFinite(awayGoals) && homeGoals !== awayGoals) {
    return homeGoals > awayGoals
      ? { winner: match.h, loser: match.a, status }
      : { winner: match.a, loser: match.h, status };
  }
  return null;
}

function replaceSlots(data, matchId, winner, loser) {
  let changes = 0;
  const winnerSlot = `W${matchId}`;
  const loserSlot = `L${matchId}`;
  data.matches.forEach(match => {
    if (match.h === winnerSlot) { match.h = winner; changes += 1; }
    if (match.a === winnerSlot) { match.a = winner; changes += 1; }
    if (match.h === loserSlot) { match.h = loser; changes += 1; }
    if (match.a === loserSlot) { match.a = loser; changes += 1; }
  });
  return changes;
}

function unresolvedSlots(data) {
  return new Set(data.matches.flatMap(match => [match.h, match.a]).filter(code => SLOT_TEAM.test(code)));
}

async function main() {
  const html = fs.readFileSync(INDEX_FILE, "utf8");
  const dataBlock = extractConstObject(html, "DATA");
  const data = dataBlock.value;
  const fixtureMap = fs.existsSync(MAP_FILE) ? JSON.parse(fs.readFileSync(MAP_FILE, "utf8")) : {};
  const now = process.env.RESULT_CHECK_NOW ? new Date(process.env.RESULT_CHECK_NOW) : new Date();
  const beforeSlots = unresolvedSlots(data);
  let resolved = 0;
  let checked = 0;
  let fixtures = null;

  for (const match of data.matches) {
    if (!isRealMatch(match) || !isDue(match, now)) continue;
    const hasDownstreamSlot = beforeSlots.has(`W${match.id}`) || beforeSlots.has(`L${match.id}`);
    if (!hasDownstreamSlot) continue;
    checked += 1;
    if (DRY_RUN) continue;
    fixtures ||= await fetchWorldCupFixtures();
    const fixture = await findFixture(match, fixtureMap, fixtures);
    if (!fixture) {
      console.log(`No API fixture found for match ${match.id} ${match.h}-${match.a}`);
      continue;
    }
    const result = finishedWinnerCodes(match, fixture);
    if (!result) {
      console.log(`Match ${match.id} is not finished in API yet (${fixture.fixture?.status?.short || "unknown"}).`);
      continue;
    }
    const changes = replaceSlots(data, match.id, result.winner, result.loser);
    if (changes) {
      resolved += changes;
      console.log(`Resolved W${match.id}: ${result.winner} advanced (${result.status}).`);
    }
  }

  if (DRY_RUN) {
    console.log(`Dry run ok. Due downstream matches: ${checked}.`);
    return;
  }

  if (!resolved) {
    console.log(`No bracket updates. Checked ${checked} due downstream matches.`);
    return;
  }

  const updated = `${html.slice(0, dataBlock.start)}${JSON.stringify(data)}${html.slice(dataBlock.end)}`;
  fs.writeFileSync(INDEX_FILE, updated);
  console.log(`Updated ${resolved} bracket slot(s) in index.html.`);
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
