import { useState, useEffect, useRef } from "react";

const ADMIN_PIN = "1234";
const HOLES = Array.from({ length: 18 }, (_, i) => i + 1);
const FORMAT_LABELS = { singles: "Singles", foursomes: "Alternate Shot", fourball: "Best Ball", scramble: "Scramble" };
const shortName = name => { const p = (name || "").trim().split(" "); return p.length > 1 ? p[0] + " " + p[p.length-1][0] + "." : p[0]; };

// ── Storage ───────────────────────────────────────────────────────────────────
// ── Supabase client ───────────────────────────────────────────────────────────
const SUPABASE_URL = "https://kmsxprzzubjibxksuohg.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imttc3hwcnp6dWJqaWJ4a3N1b2hnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgwMzA2OTgsImV4cCI6MjA5MzYwNjY5OH0.CSWns2w3EYT_UFPbPtUn5l_lW1LHR3Wc5cZ59xODSYM";

async function sbFetch(path, method = "GET", body = null) {
  const opts = {
    method,
    headers: {
      "apikey": SUPABASE_KEY,
      "Authorization": "Bearer " + SUPABASE_KEY,
      "Content-Type": "application/json",
      "Prefer": method === "POST" ? "resolution=merge-duplicates" : "",
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(SUPABASE_URL + path, opts);
  if (!res.ok) return null;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function load(key) {
  try {
    // Try Supabase first
    const rows = await sbFetch(`/rest/v1/app_data?key=eq.${encodeURIComponent(key)}&select=value`);
    if (rows && rows.length > 0) return rows[0].value;
    // Fallback to localStorage
    const v = localStorage.getItem(key);
    return v ? JSON.parse(v) : null;
  } catch { 
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : null; } catch { return null; }
  }
}

async function save(key, val) {
  try {
    // Save to both Supabase and localStorage for offline resilience
    await sbFetch("/rest/v1/app_data", "POST", { key, value: val, updated_at: new Date().toISOString() });
    localStorage.setItem(key, JSON.stringify(val));
  } catch {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch {}
  }
}

// Subscribe to real-time changes from Supabase
function subscribeToChanges(key, callback) {
  try {
    const ws = new WebSocket(
      SUPABASE_URL.replace("https://", "wss://") + "/realtime/v1/websocket?apikey=" + SUPABASE_KEY + "&vsn=1.0.0"
    );
    ws.onopen = () => {
      ws.send(JSON.stringify({ topic: "realtime:public:app_data:key=eq." + key, event: "phx_join", payload: {}, ref: "1" }));
    };
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.event === "postgres_changes" && msg.payload?.new?.value) {
        callback(msg.payload.new.value);
      }
    };
    return () => ws.close();
  } catch { return () => {}; }
}

// ── Match Logic ───────────────────────────────────────────────────────────────
// playerScores: { [playerId]: [s1,s2,...,s18] }  (null = not entered)
// playerAIds, playerBIds: string[]
// format: "fourball" | "foursomes" | "singles"

function getHoleWinner(holeIdx, playerAIds, playerBIds, playerScores) {
  const scores = (ids) => ids
    .map(id => (playerScores[id] || [])[holeIdx])
    .filter(s => s !== null && s !== undefined && s > 0);
  const aScores = scores(playerAIds);
  const bScores = scores(playerBIds);
  if (!aScores.length || !bScores.length) return null; // not all entered
  const aBest = Math.min(...aScores);
  const bBest = Math.min(...bScores);
  if (aBest < bBest) return "A";
  if (bBest < aBest) return "B";
  return "half";
}

function isTeamScoreFormat(format) { return format === "scramble" || format === "foursomes"; }

function computeMatchFromScores(m) {
  const { playerAIds = [], playerBIds = [], playerScores = {}, format, id } = m;
  // For team formats, scores are stored under team keys, not player IDs
  const aIds = isTeamScoreFormat(format) ? [id + "_A"] : playerAIds;
  const bIds = isTeamScoreFormat(format) ? [id + "_B"] : playerBIds;
  const { playerAIds: _a, playerBIds: _b, ...rest } = m;
  let aUp = 0, holesPlayed = 0;
  const holeResults = [];

  for (let i = 0; i < 18; i++) {
    const w = getHoleWinner(i, aIds, bIds, playerScores);
    holeResults.push(w);
    if (w !== null) {
      holesPlayed++;
      if (w === "A") aUp++;
      else if (w === "B") aUp--;
    } else {
      break; // stop at first unplayed hole
    }
  }

  const holesRemaining = 18 - holesPlayed;
  if (holesPlayed > 0 && Math.abs(aUp) > holesRemaining) {
    const winner = aUp > 0 ? "A" : "B";
    return { winner, label: `${Math.abs(aUp)}&${holesRemaining}`, complete: true, aUp, holesPlayed, holeResults };
  }
  if (holesPlayed === 18) {
    if (aUp === 0) return { winner: "half", label: "Halved", complete: true, aUp, holesPlayed, holeResults };
    return { winner: aUp > 0 ? "A" : "B", label: "1 UP", complete: true, aUp, holesPlayed, holeResults };
  }
  if (holesPlayed === 0) return { winner: null, label: "Not Started", complete: false, aUp: 0, holesPlayed: 0, holeResults };
  if (aUp === 0) return { winner: null, label: "AS", complete: false, aUp: 0, holesPlayed, holeResults };
  return { winner: null, label: `${Math.abs(aUp)} UP`, complete: false, aUp, holesPlayed, holeResults };
}

function computePoints(matches) {
  let aPoints = 0, bPoints = 0;
  for (const m of matches) {
    const s = computeMatchFromScores(m);
    if (s.complete) {
      if (s.winner === "A") aPoints += 1;
      else if (s.winner === "B") bPoints += 1;
      else { aPoints += 0.5; bPoints += 0.5; }
    }
  }
  return { aPoints, bPoints };
}

function playerGrossTotal(playerId, playerScores, holes = HOLES) {
  return holes.reduce((sum, h) => {
    const s = (playerScores[playerId] || [])[h - 1];
    return sum + (s > 0 ? s : 0);
  }, 0);
}

function playerVsPar(playerId, playerScores, pars, holes = HOLES) {
  return holes.reduce((sum, h) => {
    const s = (playerScores[playerId] || [])[h - 1];
    const p = (pars || [])[h - 1] || 4;
    return sum + (s > 0 ? s - p : 0);
  }, 0);
}

// Projected points = confirmed points + current match leaders treated as wins/halves
function computeProjected(matches) {
  let aProj = 0, bProj = 0;
  for (const m of matches) {
    const s = computeMatchFromScores(m);
    if (s.complete) {
      // Already decided — same as confirmed
      if (s.winner === "A") { aProj += 1; }
      else if (s.winner === "B") { bProj += 1; }
      else { aProj += 0.5; bProj += 0.5; }
    } else if (s.holesPlayed > 0) {
      // In progress — project current leader as winner
      if (s.aUp > 0) { aProj += 1; }
      else if (s.aUp < 0) { bProj += 1; }
      else { aProj += 0.5; bProj += 0.5; } // all square = projected half
    }
    // Not started — contributes nothing to projection
  }
  return { aProj, bProj };
}

// ── Brand tokens ──────────────────────────────────────────────────────────────
const C = {
  bg: "#0a0a0a",
  surface: "rgba(255,255,255,0.08)",
  surfaceHigh: "rgba(255,255,255,0.13)",
  surfaceDark: "rgba(0,0,0,0.45)",
  border: "rgba(255,255,255,0.14)",
  borderStrong: "rgba(255,255,255,0.28)",
  white: "#FFFFFF",
  grey1: "#C8C8C8",
  grey2: "#909090",
  grey3: "#3A3A3A",
  gold: "#D4AF6A",
  danger: "#C0392B",
  eagle: "#5BA3E8",
  birdie: "#E8A838",
  par: "#FFFFFF",
  bogey: "#999999",
  double: "#C0392B",
};

const BC = { fontFamily: "'Barlow Condensed', 'Arial Narrow', Arial, sans-serif" };
const BM = { fontFamily: "'Barlow', Arial, sans-serif" };
const surf = (e = {}) => ({ background: C.surface, border: `1px solid ${C.border}`, ...e });
const surfHigh = (e = {}) => ({ background: C.surfaceHigh, border: `1px solid ${C.borderStrong}`, ...e });

// ── Shared UI ─────────────────────────────────────────────────────────────────
function Card({ children, style = {}, onClick }) {
  return <div onClick={onClick} style={{ ...surf(), borderRadius: 14, padding: 16, cursor: onClick ? "pointer" : "default", ...style }}>{children}</div>;
}
function Btn({ children, onClick, color = C.gold, disabled = false, style = {} }) {
  return (
    <button onClick={onClick} disabled={disabled} style={{
      border: `1px solid ${color}44`, background: `${color}14`, color,
      borderRadius: 8, padding: "9px 14px", ...BC, fontSize: 11, fontWeight: 700,
      letterSpacing: "0.1em", textTransform: "uppercase",
      cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.3 : 1,
      transition: "all 0.15s", ...style,
    }}>{children}</button>
  );
}
function Tag({ children, color = C.grey2 }) {
  return <span style={{ border: `1px solid ${color}33`, background: `${color}10`, color, borderRadius: 20, padding: "2px 8px", fontSize: 9, ...BC, fontWeight: 600, letterSpacing: "0.1em", whiteSpace: "nowrap" }}>{children}</span>;
}
function SectionLabel({ children }) {
  return <div style={{ color: C.grey2, ...BC, fontSize: 9, fontWeight: 700, letterSpacing: "0.2em", marginBottom: 10 }}>{children}</div>;
}
function Background() {
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 0, pointerEvents: "none", background: C.bg }}>
      <div style={{ position: "absolute", inset: 0, background: "radial-gradient(ellipse 80% 50% at 50% -10%, rgba(255,255,255,0.025) 0%, transparent 70%)" }} />
    </div>
  );
}

// ── Score dot (birdie/par/bogey color coding) ─────────────────────────────────
function ScoreDot({ score, par, size = 20 }) {
  if (!score || score <= 0) return <div style={{ width: size, height: size }} />;
  const d = score - par;
  const fs = size * 0.5;
  const num = <span style={{ ...BC, fontSize: fs, fontWeight: 800, lineHeight: 1 }}>{score}</span>;

  if (d <= -2) { // Eagle — double circle
    return (
      <div style={{ width: size, height: size, borderRadius: "50%", border: `1.5px solid ${C.eagle}`, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ width: size * 0.72, height: size * 0.72, borderRadius: "50%", border: `1.5px solid ${C.eagle}`, background: `${C.eagle}20`, display: "flex", alignItems: "center", justifyContent: "center", color: C.eagle }}>{num}</div>
      </div>
    );
  }
  if (d === -1) { // Birdie — single circle
    return <div style={{ width: size, height: size, borderRadius: "50%", border: `1.5px solid ${C.birdie}`, background: `${C.birdie}18`, display: "flex", alignItems: "center", justifyContent: "center", color: C.birdie }}>{num}</div>;
  }
  if (d === 0) { // Par — just number
    return <div style={{ width: size, height: size, display: "flex", alignItems: "center", justifyContent: "center", color: C.white }}>{num}</div>;
  }
  if (d === 1) { // Bogey — single square
    return <div style={{ width: size, height: size, borderRadius: 2, border: `1.5px solid ${C.bogey}`, background: "transparent", display: "flex", alignItems: "center", justifyContent: "center", color: C.bogey }}>{num}</div>;
  }
  // Double+ — double square
  return (
    <div style={{ width: size, height: size, borderRadius: 2, border: `1.5px solid ${C.double}`, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ width: size * 0.72, height: size * 0.72, borderRadius: 1, border: `1.5px solid ${C.double}`, background: `${C.double}18`, display: "flex", alignItems: "center", justifyContent: "center", color: C.double }}>{num}</div>
    </div>
  );
}

// ── Nav ───────────────────────────────────────────────────────────────────────
function Nav({ page, setPage, adminUnlocked }) {
  const tabs = [
    { id: "leaderboard", label: "LIVE" },
    { id: "score", label: "SCORE" },
    { id: "records", label: "HISTORY" },
    { id: "admin", label: "ADMIN" },
  ];
  return (
    <nav style={{ position: "fixed", bottom: 0, left: 0, right: 0, zIndex: 100, background: "rgba(8,8,8,0.97)", borderTop: `1px solid ${C.border}`, display: "flex" }}>
      {tabs.map(t => (
        <button key={t.id} onClick={() => setPage(t.id)} style={{
          flex: 1, padding: "13px 4px 17px", background: "transparent", border: "none",
          color: page === t.id ? C.white : C.grey2,
          borderTop: `2px solid ${page === t.id ? C.white : "transparent"}`,
          ...BC, fontSize: 9, fontWeight: 700, letterSpacing: "0.1em", cursor: "pointer", transition: "color 0.15s",
        }}>{t.label}{t.id === "admin" && adminUnlocked ? " ✦" : ""}</button>
      ))}
    </nav>
  );
}

// ── Score Banner ──────────────────────────────────────────────────────────────
function ScoreBanner({ teamA, teamB, aPoints, bPoints, aProj, bProj, totalMatches }) {
  const fmt = v => v % 1 === 0 ? String(v) : v.toFixed(1);
  const toWin = totalMatches > 0 ? Math.floor(totalMatches / 2) + 0.5 : "—";
  const aLeads = aPoints > bPoints, bLeads = bPoints > aPoints;
  const aProjLeads = aProj > bProj, bProjLeads = bProj > aProj;
  const hasProjection = aProj !== aPoints || bProj !== bPoints;
  return (
    <div style={{ borderBottom: `1px solid ${C.border}`, marginBottom: 2 }}>
      <div style={{ borderBottom: `1px solid ${C.border}`, padding: "12px 0", textAlign: "center", background: "rgba(255,255,255,0.03)" }}>
        <div style={{ color: C.grey2, ...BC, fontSize: 9, fontWeight: 700, letterSpacing: "0.24em" }}>
          THE BEEHIVE CUP &nbsp;·&nbsp; {totalMatches} MATCHES &nbsp;·&nbsp; {toWin} TO WIN
        </div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 48px 1fr", padding: "18px 20px 10px" }}>
        <div>
          <div style={{ color: aLeads ? C.white : C.grey2, ...BC, fontSize: 10, fontWeight: 700, letterSpacing: "0.2em", marginBottom: 4, textTransform: "uppercase" }}>{teamA?.name || "Team A"}</div>
          <div style={{ color: aLeads ? C.white : C.grey2, ...BC, fontSize: 88, fontWeight: 800, lineHeight: 1 }}>{fmt(aPoints)}</div>
        </div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", paddingTop: 24 }}>
          <div style={{ color: C.grey3, ...BC, fontSize: 11, fontWeight: 700, letterSpacing: "0.1em" }}>VS</div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ color: bLeads ? C.white : C.grey2, ...BC, fontSize: 10, fontWeight: 700, letterSpacing: "0.2em", marginBottom: 4, textTransform: "uppercase" }}>{teamB?.name || "Team B"}</div>
          <div style={{ color: bLeads ? C.white : C.grey2, ...BC, fontSize: 88, fontWeight: 800, lineHeight: 1 }}>{fmt(bPoints)}</div>
        </div>
      </div>

      {/* Projected row */}
      {hasProjection && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 48px 1fr", padding: "0 20px 16px", alignItems: "center" }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <div style={{ color: C.gold, ...BC, fontSize: 20, fontWeight: 800 }}>{fmt(aProj)}</div>
              <div style={{ color: C.grey2, ...BC, fontSize: 8, fontWeight: 700, letterSpacing: "0.14em" }}>PROJ</div>
            </div>
          </div>
          <div />
          <div style={{ textAlign: "right" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, justifyContent: "flex-end" }}>
              <div style={{ color: C.grey2, ...BC, fontSize: 8, fontWeight: 700, letterSpacing: "0.14em" }}>PROJ</div>
              <div style={{ color: C.gold, ...BC, fontSize: 20, fontWeight: 800 }}>{fmt(bProj)}</div>
            </div>
          </div>
        </div>
      )}

      {totalMatches > 0 && (
        <div style={{ height: 2, background: C.grey3, display: "flex" }}>
          <div style={{ width: `${(aPoints / totalMatches) * 100}%`, background: C.white, transition: "width 1s ease" }} />
          <div style={{ flex: 1 }} />
          <div style={{ width: `${(bPoints / totalMatches) * 100}%`, background: C.grey1, transition: "width 1s ease" }} />
        </div>
      )}
    </div>
  );
}

// ── Match Row (leaderboard) ───────────────────────────────────────────────────
function MatchRow({ m, teamA, teamB, players, expanded, onToggle }) {
  const status = computeMatchFromScores(m);
  const { holeResults = [] } = status;
  const aNames = (m.playerAIds || []).map(id => players.find(p => p.id === id)?.name || id);
  const bNames = (m.playerBIds || []).map(id => players.find(p => p.id === id)?.name || id);
  const aWin = status.winner === "A" || (!status.complete && status.aUp > 0);
  const bWin = status.winner === "B" || (!status.complete && status.aUp < 0);
  let centerMain = "—", centerSub = "NOT STARTED";
  if (status.holesPlayed > 0) { centerMain = status.label; centerSub = status.complete ? "FINAL" : `THRU ${status.holesPlayed}`; }
  const centerColor = status.winner === "half" ? C.gold : aWin ? C.white : bWin ? C.grey1 : C.grey2;
  const aColor = aWin ? C.white : (bWin || status.complete) ? C.grey3 : C.grey2;
  const bColor = bWin ? C.grey1 : (aWin || status.complete) ? C.grey3 : C.grey2;

  return (
    <div style={{ borderBottom: `1px solid ${C.border}`, overflow: "hidden" }}>
      <div onClick={onToggle} style={{ display: "grid", gridTemplateColumns: "1fr 76px 1fr", minHeight: 64, cursor: "pointer", background: aWin ? "rgba(255,255,255,0.07)" : "rgba(255,255,255,0.02)" }}>
        <div style={{ borderLeft: `3px solid ${aWin ? C.white : "transparent"}`, padding: "10px 8px 10px 14px", display: "flex", flexDirection: "column", justifyContent: "center" }}>
          {aNames.map((n, i) => <div key={i} style={{ color: aColor, ...BC, fontSize: aNames.length > 1 ? 13 : 16, fontWeight: 800, lineHeight: 1.2, textTransform: "uppercase", letterSpacing: "0.04em" }}>{n}</div>)}
        </div>
        <div style={{ borderLeft: `1px solid ${C.grey3}`, borderRight: `1px solid ${C.grey3}`, background: "rgba(0,0,0,0.35)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "6px 2px" }}>
          <div style={{ color: centerColor, ...BC, fontSize: 18, fontWeight: 800, lineHeight: 1 }}>{centerMain}</div>
          <div style={{ color: C.grey2, ...BC, fontSize: 8, fontWeight: 700, marginTop: 4, letterSpacing: "0.1em" }}>{centerSub}</div>
        </div>
        <div style={{ borderRight: `3px solid ${bWin ? C.grey1 : "transparent"}`, padding: "10px 14px 10px 8px", display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "flex-end" }}>
          {bNames.map((n, i) => <div key={i} style={{ color: bColor, ...BC, fontSize: bNames.length > 1 ? 13 : 16, fontWeight: 800, lineHeight: 1.2, textTransform: "uppercase", letterSpacing: "0.04em", textAlign: "right" }}>{n}</div>)}
        </div>
      </div>
      {/* Hole strip */}
      <div onClick={onToggle} style={{ display: "flex", gap: 2, padding: "5px 10px", background: "rgba(0,0,0,0.3)", cursor: "pointer", alignItems: "center" }}>
        {HOLES.map(h => {
          const r = holeResults[h - 1];
          return <div key={h} style={{ flex: 1, height: 3, background: r === "A" ? C.white : r === "B" ? C.grey1 : r === "half" ? C.gold : C.grey3 }} />;
        })}
        <div style={{ color: C.grey3, ...BC, fontSize: 7, fontWeight: 700, marginLeft: 6, flexShrink: 0 }}>{expanded ? "▲" : "▼"}</div>
      </div>
      {/* Expanded: hole grid */}
      {expanded && (
        <div style={{ background: "rgba(0,0,0,0.45)", padding: "10px 12px 12px" }}>
          {[HOLES.slice(0, 9), HOLES.slice(9)].map((half, hi) => (
            <div key={hi} style={{ display: "grid", gridTemplateColumns: "repeat(9,1fr)", gap: 3, marginBottom: hi === 0 ? 4 : 0 }}>
              {half.map(h => {
                const r = holeResults[h - 1];
                return (
                  <div key={h} style={{ textAlign: "center" }}>
                    <div style={{ color: C.grey3, ...BC, fontSize: 7, fontWeight: 600, marginBottom: 2 }}>{h}</div>
                    <div style={{
                      height: 22, borderRadius: 3, display: "flex", alignItems: "center", justifyContent: "center",
                      ...BC, fontSize: 9, fontWeight: 800,
                      background: r === "A" ? "rgba(255,255,255,0.12)" : r === "B" ? "rgba(170,170,170,0.10)" : r === "half" ? `${C.gold}18` : "rgba(255,255,255,0.03)",
                      color: r === "A" ? C.white : r === "B" ? C.grey1 : r === "half" ? C.gold : C.grey3,
                      border: `1px solid ${r === "A" ? "rgba(255,255,255,0.22)" : r === "B" ? "rgba(170,170,170,0.18)" : r === "half" ? `${C.gold}35` : C.grey3}`,
                    }}>
                      {r === "A" ? (teamA?.name?.[0] || "A").toUpperCase() : r === "B" ? (teamB?.name?.[0] || "B").toUpperCase() : r === "half" ? "½" : h}
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Leaderboard ───────────────────────────────────────────────────────────────
function LeaderboardPage({ data, onNavigate }) {
  const [expandedMatch, setExpandedMatch] = useState(null);
  const { players } = data;
  const courses = data.courses || [];
  const cy = data.currentYear;
  const sessions = cy?.sessions || [];
  const matches = cy?.matches || [];
  const cyTeams = cy?.teams || [];
  const teamA = cyTeams.find(t => t.id === "A") || { id: "A", name: "Team A" };
  const teamB = cyTeams.find(t => t.id === "B") || { id: "B", name: "Team B" };
  const allActiveMatches = matches;
  const { aPoints, bPoints } = computePoints(allActiveMatches);
  const { aProj, bProj } = computeProjected(allActiveMatches);
  const activeSession = sessions.find(s => s.status === "active");
  const activeSessionMatches = activeSession ? matches.filter(m => m.sessionId === activeSession.id) : [];

  return (
    <div style={{ paddingBottom: 100 }}>
      <div style={{ textAlign: "center", padding: "28px 0 20px", borderBottom: `1px solid ${C.border}` }}>
        <img src="data:image/png;base64,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" style={{ width: 52, height: 52, objectFit: "contain", marginBottom: 4 }} alt="Beehive Cup" />
        <div style={{ color: C.white, ...BC, fontSize: 28, fontWeight: 800, letterSpacing: "0.08em", textTransform: "uppercase" }}>Beehive Cup</div>
        <div style={{ color: C.grey2, ...BC, fontSize: 9, fontWeight: 700, letterSpacing: "0.28em", marginTop: 4 }}>THE GREATEST RIVALRY IN GOLF</div>
      </div>
      <ScoreBanner teamA={teamA} teamB={teamB} aPoints={aPoints} bPoints={bPoints} aProj={aProj} bProj={bProj} totalMatches={allActiveMatches.length} />
      {!activeSession && (
        <div style={{ textAlign: "center", padding: "56px 20px" }}>
          <div style={{ fontSize: 32, marginBottom: 12 }}>🏌️</div>
          <div style={{ color: C.grey2, ...BC, fontSize: 12, fontWeight: 600, letterSpacing: "0.1em" }}>NO ACTIVE SESSION</div>
          <div style={{ color: C.grey3, ...BC, fontSize: 10, fontWeight: 600, letterSpacing: "0.08em", marginTop: 6 }}>SET ONE IN ADMIN → CUP SETUP → SESSIONS</div>
        </div>
      )}
      {activeSession && [activeSession].map(session => {
        const sessionMatches = activeSessionMatches;
        const course = courses.find(c => c.id === session.courseId);
        return (
          <div key={session.id} style={{ marginBottom: 32 }}>
            <div style={{ padding: "14px 16px 12px", borderBottom: `1px solid ${C.border}`, display: "flex", alignItems: "center", gap: 10, background: "rgba(255,255,255,0.03)" }}>
              <div style={{ color: C.white, ...BC, fontSize: 16, fontWeight: 800, letterSpacing: "0.06em", textTransform: "uppercase", flex: 1 }}>{session.name}</div>
              <Tag color={C.grey2}>{FORMAT_LABELS[session.format] || session.format}</Tag>
              {course && <Tag color={C.grey3}>{course.name}</Tag>}
            </div>
            {sessionMatches.length === 0 && <div style={{ padding: "16px", color: C.grey3, ...BC, fontSize: 11, fontWeight: 600, letterSpacing: "0.08em" }}>NO MATCHES SET UP</div>}
            {sessionMatches.map(m => (
              <MatchRow key={m.id} m={m} teamA={teamA} teamB={teamB} players={players}
                expanded={expandedMatch === m.id}
                onToggle={() => setExpandedMatch(expandedMatch === m.id ? null : m.id)} />
            ))}
          </div>
        );
      })}
      <div style={{ textAlign:"center", padding:"20px 16px 0" }}>
        <button onClick={() => onNavigate && onNavigate("allsessions")} style={{ background:"none", border:`1px solid ${C.border}`, borderRadius:10, padding:"10px 24px", color:C.grey2, cursor:"pointer", fontFamily:"'Barlow Condensed','Arial Narrow',Arial,sans-serif", fontSize:11, fontWeight:700, letterSpacing:"0.14em" }}>ALL SESSIONS →</button>
      </div>
    </div>
  );
}

// ── Player Scorecard ──────────────────────────────────────────────────────────
function PlayerScorecard({ player, match, course, onBack, players = [] }) {
  const pars = course?.pars || Array(18).fill(4);
  const scores = (match.playerScores || {})[player.id] || [];
  const front = HOLES.slice(0, 9);
  const back = HOLES.slice(9);
  const frontTotal = playerGrossTotal(player.id, match.playerScores || {}, front);
  const backTotal = playerGrossTotal(player.id, match.playerScores || {}, back);
  const total = frontTotal + backTotal;
  const frontPar = front.reduce((s, h) => s + (pars[h - 1] || 4), 0);
  const backPar = back.reduce((s, h) => s + (pars[h - 1] || 4), 0);
  const totalPar = frontPar + backPar;
  const totalDiff = total > 0 ? total - totalPar : null;
  const fmtVsPar = v => v === 0 ? "E" : v > 0 ? `+${v}` : `${v}`;

  // Returns rendering config for each score relative to par
  function cellStyle(score, par) {
    if (!score || score <= 0) return { type: "empty" };
    const d = score - par;
    if (d <= -2) return { type: "eagle",  color: C.eagle };
    if (d === -1) return { type: "birdie", color: C.birdie };
    if (d === 0)  return { type: "par",    color: C.white };
    if (d === 1)  return { type: "bogey",  color: C.bogey };
    if (d === 2)  return { type: "double", color: C.double };
    // Triple+ — double square, escalating red shade
    return { type: "double", color: C.double };
  }

  function ScoreCell({ score, par }) {
    const cs = cellStyle(score, par);
    if (cs.type === "empty") return <div style={{ width: 28, height: 28, display: "flex", alignItems: "center", justifyContent: "center", color: C.grey3, ...BC, fontSize: 10 }}>—</div>;

    const num = <span style={{ color: cs.color, ...BC, fontSize: 12, fontWeight: 800, lineHeight: 1 }}>{score}</span>;

    if (cs.type === "par") {
      // Just the number, no shape
      return <div style={{ width: 28, height: 28, display: "flex", alignItems: "center", justifyContent: "center" }}>{num}</div>;
    }
    if (cs.type === "birdie") {
      return (
        <div style={{ width: 28, height: 28, borderRadius: "50%", border: `1.5px solid ${cs.color}`, background: `${cs.color}18`, display: "flex", alignItems: "center", justifyContent: "center" }}>
          {num}
        </div>
      );
    }
    if (cs.type === "eagle") {
      // Double circle — outer ring + inner circle
      return (
        <div style={{ width: 28, height: 28, borderRadius: "50%", border: `1.5px solid ${cs.color}`, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ width: 20, height: 20, borderRadius: "50%", border: `1.5px solid ${cs.color}`, background: `${cs.color}22`, display: "flex", alignItems: "center", justifyContent: "center" }}>
            {num}
          </div>
        </div>
      );
    }
    if (cs.type === "bogey") {
      return (
        <div style={{ width: 26, height: 26, borderRadius: 3, border: `1.5px solid ${cs.color}`, background: "transparent", display: "flex", alignItems: "center", justifyContent: "center" }}>
          {num}
        </div>
      );
    }
    if (cs.type === "double") {
      // Double square — outer + inner
      return (
        <div style={{ width: 28, height: 28, borderRadius: 3, border: `1.5px solid ${cs.color}`, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ width: 20, height: 20, borderRadius: 2, border: `1.5px solid ${cs.color}`, background: `${cs.color}18`, display: "flex", alignItems: "center", justifyContent: "center" }}>
            {num}
          </div>
        </div>
      );
    }
    return <div style={{ width: 28, height: 28, display: "flex", alignItems: "center", justifyContent: "center" }}>{num}</div>;
  }

  const labelCell = { color: C.grey2, ...BC, fontSize: 9, fontWeight: 700, letterSpacing: "0.1em", textAlign: "center", padding: "7px 2px" };
  const totalCell = (val, diff) => {
    const c = diff === null ? C.grey2 : diff < 0 ? C.birdie : diff === 0 ? C.white : C.bogey;
    return { color: c, ...BC, fontSize: 13, fontWeight: 800, textAlign: "center", padding: "7px 2px" };
  };

  return (
    <div style={{ padding: "16px 0 100px" }}>
      {/* Header */}
      <div style={{ padding: "0 16px 16px" }}>
        <button onClick={onBack} style={{ background: "none", border: "none", color: C.grey2, ...BC, fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", cursor: "pointer", marginBottom: 14, padding: 0 }}>← BACK</button>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            {players && (() => {
              const pl = players.find(p => p.id === player.id);
              return pl ? <PlayerAvatar player={pl} size={44} fontSize={15} /> : null;
            })()}
            <div>
              <div style={{ color: C.white, ...BC, fontSize: 26, fontWeight: 800, letterSpacing: "0.06em", textTransform: "uppercase" }}>{player.name}</div>
              <div style={{ color: C.grey2, ...BC, fontSize: 9, fontWeight: 700, letterSpacing: "0.2em", marginTop: 2 }}>
                {course?.name?.toUpperCase() || "SCORECARD"}{course ? " · PAR " + totalPar : ""}
              </div>
            </div>
          </div>
          {total > 0 && (
            <div style={{ textAlign: "right" }}>
              <div style={{ color: totalDiff < 0 ? C.birdie : totalDiff === 0 ? C.white : C.bogey, ...BC, fontSize: 36, fontWeight: 800, lineHeight: 1 }}>{fmtVsPar(totalDiff)}</div>
            </div>
          )}
        </div>
      </div>

      {/* Horizontal scorecard — front 9 then back 9 */}
      {[front, back].map((half, hi) => {
        const halfPar = hi === 0 ? frontPar : backPar;
        const halfTotal = hi === 0 ? frontTotal : backTotal;
        const halfDiff = halfTotal > 0 ? halfTotal - halfPar : null;

        return (
          <div key={hi} style={{ marginBottom: 2, overflowX: "auto", WebkitOverflowScrolling: "touch" }}>
            <div style={{ minWidth: 340 }}>
              {/* Row: HOLE numbers */}
              <div style={{ display: "grid", gridTemplateColumns: "36px repeat(9, 1fr) 36px", background: "rgba(255,255,255,0.06)", borderTop: hi === 0 ? `1px solid ${C.border}` : "none" }}>
                <div style={{ ...labelCell, color: C.grey2, fontSize: 8, borderRight: `1px solid ${C.grey3}` }}>HOLE</div>
                {half.map(h => (
                  <div key={h} style={{ ...labelCell, borderRight: `1px solid ${C.grey3}` }}>{h}</div>
                ))}
                <div style={{ ...labelCell, color: C.grey2, fontSize: 9 }}>{hi === 0 ? "OUT" : "IN"}</div>
              </div>

              {/* Row: PAR */}
              <div style={{ display: "grid", gridTemplateColumns: "36px repeat(9, 1fr) 36px", background: "rgba(255,255,255,0.03)", borderTop: `1px solid ${C.grey3}` }}>
                <div style={{ ...labelCell, color: C.grey2, fontSize: 8, borderRight: `1px solid ${C.grey3}` }}>PAR</div>
                {half.map(h => (
                  <div key={h} style={{ color: C.grey2, ...BC, fontSize: 12, fontWeight: 600, textAlign: "center", padding: "6px 2px", borderRight: `1px solid ${C.grey3}` }}>
                    {pars[h - 1] || 4}
                  </div>
                ))}
                <div style={{ color: C.grey2, ...BC, fontSize: 12, fontWeight: 700, textAlign: "center", padding: "6px 2px" }}>{halfPar}</div>
              </div>

              {/* Row: SCORE */}
              <div style={{ display: "grid", gridTemplateColumns: "36px repeat(9, 1fr) 36px", background: "rgba(0,0,0,0.25)", borderTop: `1px solid ${C.grey3}`, borderBottom: `1px solid ${C.border}` }}>
                <div style={{ ...labelCell, color: C.grey2, fontSize: 8, borderRight: `1px solid ${C.grey3}`, display: "flex", alignItems: "center", justifyContent: "center" }}>SCR</div>
                {half.map(h => {
                  const par = pars[h - 1] || 4;
                  const score = scores[h - 1];
                  return (
                    <div key={h} style={{ padding: "5px 2px", display: "flex", alignItems: "center", justifyContent: "center", borderRight: `1px solid ${C.grey3}` }}>
                      <ScoreCell score={score} par={par} />
                    </div>
                  );
                })}
                {/* Half total */}
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "4px 2px" }}>
                  {halfTotal > 0 ? (
                    <div style={{ color: C.white, ...BC, fontSize: 14, fontWeight: 800, lineHeight: 1 }}>{halfTotal}</div>
                  ) : <div style={{ color: C.grey3, ...BC, fontSize: 11 }}>—</div>}
                </div>
              </div>
            </div>
          </div>
        );
      })}

      {/* Total row */}
      {total > 0 && (
        <div style={{ margin: "12px 16px 0", ...surf(), borderRadius: 10, padding: "12px 16px", display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, textAlign: "center" }}>
          {[
            { label: "FRONT", val: frontTotal, diff: frontTotal > 0 ? frontTotal - frontPar : null },
            { label: "BACK",  val: backTotal,  diff: backTotal > 0  ? backTotal  - backPar  : null },
            { label: "TOTAL", val: total,      diff: totalDiff },
          ].map(({ label, val, diff }) => (
            <div key={label}>
              <div style={{ color: C.grey2, ...BC, fontSize: 8, fontWeight: 700, letterSpacing: "0.16em", marginBottom: 4 }}>{label}</div>
              <div style={{ color: C.white, ...BC, fontSize: 22, fontWeight: 800, lineHeight: 1 }}>{val || "—"}</div>
              {val > 0 && diff !== null && <div style={{ color: diff < 0 ? C.birdie : diff === 0 ? C.white : C.bogey, ...BC, fontSize: 10, fontWeight: 700, marginTop: 2 }}>{fmtVsPar(diff)}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── All Sessions Page ───────────────────────────────────────────────────────
function AllSessionsPage({ data, onBack }) {
  const { players } = data;
  const courses = data.courses || [];
  const cy = data.currentYear;
  const sessions = (cy?.sessions || []).slice().sort((a,b) => (a.name||"").localeCompare(b.name||""));
  const matches = cy?.matches || [];
  const cyTeams = cy?.teams || [];
  const teamA = cyTeams.find(t=>t.id==="A")||{id:"A",name:"Team A"};
  const teamB = cyTeams.find(t=>t.id==="B")||{id:"B",name:"Team B"};
  const [expanded, setExpanded] = useState(null);
  const [scorecardView, setScorecardView] = useState(null);
  const getPName = id => players.find(p=>p.id===id)?.name || id;

  if (scorecardView) {
    const course = courses.find(c => c.id === sessions.find(s => s.id === scorecardView.match.sessionId)?.courseId);
    return <PlayerScorecard player={scorecardView.player} match={scorecardView.match} course={course} onBack={() => setScorecardView(null)} players={players} />;
  }

  const statusColor = s => s.status === "active" ? C.white : s.status === "completed" ? "#6FCF8A" : C.grey3;
  const statusLabel = s => s.status === "active" ? "● LIVE" : s.status === "completed" ? "✓ DONE" : "SCHEDULED";

  return (
    <div style={{ padding: "24px 16px 100px" }}>
      <button onClick={onBack} style={{ background:"none", border:"none", color:C.grey2, cursor:"pointer", fontFamily:"'Barlow Condensed','Arial Narrow',Arial,sans-serif", fontSize:10, fontWeight:700, letterSpacing:"0.1em", marginBottom:16, padding:0 }}>← BACK</button>
      <div style={{ marginBottom: 22 }}>
        <div style={{ color: C.white, fontFamily:"'Barlow Condensed','Arial Narrow',Arial,sans-serif", fontSize: 26, fontWeight: 800, letterSpacing: "0.06em", textTransform: "uppercase" }}>Sessions</div>
        <div style={{ color: C.grey2, fontFamily:"'Barlow Condensed','Arial Narrow',Arial,sans-serif", fontSize: 9, fontWeight: 700, letterSpacing: "0.2em", marginTop: 2 }}>ALL ROUNDS & RESULTS</div>
      </div>
      {sessions.length === 0 && <div style={{ color: C.grey2, fontFamily:"'Barlow Condensed','Arial Narrow',Arial,sans-serif", fontSize: 11, fontWeight: 600, letterSpacing: "0.1em" }}>NO SESSIONS YET</div>}
      {sessions.map(s => {
        const sMatches = matches.filter(m => m.sessionId === s.id);
        const { aPoints, bPoints } = computePoints(sMatches);
        const course = courses.find(c => c.id === s.courseId);
        const isExp = expanded === s.id;
        return (
          <Card key={s.id} style={{ marginBottom: 8 }} onClick={() => setExpanded(isExp ? null : s.id)}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
              <div style={{ flex: 1 }}>
                <div style={{ color: C.white, fontFamily:"'Barlow Condensed','Arial Narrow',Arial,sans-serif", fontSize: 18, fontWeight: 800, letterSpacing: "0.04em", textTransform: "uppercase", marginBottom: 6 }}>{s.name}</div>
                <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                  <Tag color={statusColor(s)}>{statusLabel(s)}</Tag>
                  <Tag color={C.grey2}>{FORMAT_LABELS[s.format] || s.format}</Tag>
                  {course && <Tag color={C.grey2}>{course.name}</Tag>}
                  {s.date && <Tag color={C.grey3}>{s.date}</Tag>}
                </div>
              </div>
              <div style={{ textAlign: "right", flexShrink: 0, marginLeft: 12 }}>
                <div style={{ fontFamily:"'Barlow Condensed','Arial Narrow',Arial,sans-serif", fontSize: 24, fontWeight: 800, lineHeight: 1 }}>
                  <span style={{ color: C.white }}>{aPoints % 1 ? aPoints.toFixed(1) : aPoints}</span>
                  <span style={{ color: C.grey3 }}> – </span>
                  <span style={{ color: C.grey1 }}>{bPoints % 1 ? bPoints.toFixed(1) : bPoints}</span>
                </div>
                <div style={{ color: C.grey2, fontFamily:"'Barlow Condensed','Arial Narrow',Arial,sans-serif", fontSize: 8, fontWeight: 600, letterSpacing: "0.1em", marginTop: 2 }}>{sMatches.length} MATCHES</div>
              </div>
            </div>
            {isExp && (
              <div style={{ marginTop: 14, borderTop: `1px solid ${C.grey3}`, paddingTop: 14 }} onClick={e => e.stopPropagation()}>
                {sMatches.length === 0 && <div style={{ color: C.grey3, fontFamily:"'Barlow Condensed','Arial Narrow',Arial,sans-serif", fontSize: 11 }}>NO MATCHES SET UP</div>}
                {sMatches.map(m => {
                  const courseObj = courses.find(c => c.id === s.courseId);
                  const allPlayers = [...(m.playerAIds||[]), ...(m.playerBIds||[])].map(id => players.find(p=>p.id===id)).filter(Boolean);
                  return (
                    <div key={m.id} style={{ marginBottom: 8 }}>
                      <MatchRow m={m} teamA={teamA} teamB={teamB} players={players} expanded={false} onToggle={()=>{}} />
                      <div style={{ display:"flex", gap:6, flexWrap:"wrap", padding:"8px 10px", background:"rgba(0,0,0,0.2)" }}>
                        {s.format === "scramble" ? (
                          [{key:"A",ids:m.playerAIds||[]},{key:"B",ids:m.playerBIds||[]}].map(team => {
                            const scoreKey = m.id + "_" + team.key;
                            const teamScores = (m.playerScores||{})[scoreKey]||[];
                            const gross = teamScores.filter(x=>x>0).reduce((a,b)=>a+b,0);
                            const pars = courseObj?.pars||Array(18).fill(4);
                            const holesPlayed = teamScores.filter(x=>x>0).length;
                            const vp = gross - pars.slice(0,holesPlayed).reduce((a,b)=>a+b,0);
                            const vpStr = vp===0?"E":vp>0?`+${vp}`:`${vp}`;
                            const vpColor = vp<=0?C.birdie:C.bogey;
                            const label = team.ids.map(id=>(players.find(p=>p.id===id)?.name||"").split(" ")[0]).join(" / ");
                            const fakePlayer = {id:scoreKey, name:label};
                            return (
                              <button key={team.key} onClick={()=>setScorecardView({match:m,player:fakePlayer})} style={{ background:C.surface, border:`1px solid ${C.border}`, borderRadius:8, padding:"6px 10px", cursor:"pointer", textAlign:"left" }}>
                                <div style={{ color:C.white, fontFamily:"'Barlow Condensed','Arial Narrow',Arial,sans-serif", fontSize:10, fontWeight:700, textTransform:"uppercase", letterSpacing:"0.04em" }}>{label}</div>
                                {gross>0 && <div style={{ fontFamily:"'Barlow Condensed','Arial Narrow',Arial,sans-serif", fontSize:11, fontWeight:800, marginTop:2, color:vpColor }}>{vpStr}</div>}
                              </button>
                            );
                          })
                        ) : (
                          allPlayers.map(pl => {
                            const pars = courseObj?.pars||Array(18).fill(4);
                            const vp = playerVsPar(pl.id, m.playerScores||{}, pars);
                            const scores = (m.playerScores||{})[pl.id]||[];
                            const gross = scores.filter(x=>x>0).reduce((a,b)=>a+b,0);
                            const vpStr = vp===0?"E":vp>0?`+${vp}`:`${vp}`;
                            const vpColor = vp<=0?C.birdie:C.bogey;
                            return (
                              <button key={pl.id} onClick={()=>setScorecardView({match:m,player:pl})} style={{ background:C.surface, border:`1px solid ${C.border}`, borderRadius:8, padding:"6px 10px", cursor:"pointer", textAlign:"left" }}>
                                <div style={{ color:C.white, fontFamily:"'Barlow Condensed','Arial Narrow',Arial,sans-serif", fontSize:10, fontWeight:700, textTransform:"uppercase", letterSpacing:"0.04em" }}>{pl.name.split(" ")[0]}</div>
                                {gross>0 && <div style={{ fontFamily:"'Barlow Condensed','Arial Narrow',Arial,sans-serif", fontSize:11, fontWeight:800, marginTop:2, color:vpColor }}>{vpStr}</div>}
                              </button>
                            );
                          })
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </Card>
        );
      })}
    </div>
  );
}

// ── Sessions Page ─────────────────────────────────────────────────────────────
function SessionsPage({ data }) {
  const { players } = data;
  const courses = data.courses || [];
  const cy = data.currentYear;
  const sessions = cy?.sessions || [];
  const matches = cy?.matches || [];
  const cyTeams = cy?.teams || [];
  const teams = [
    cyTeams.find(t => t.id === "A") || { id: "A", name: "Team A" },
    cyTeams.find(t => t.id === "B") || { id: "B", name: "Team B" },
  ];
  const [expanded, setExpanded] = useState(null);
  const [scorecardView, setScorecardView] = useState(null); // { match, player }
  const getPName = id => players.find(p => p.id === id)?.name || id;
  const sorted = [...sessions].sort((a, b) => new Date(b.date) - new Date(a.date));

  if (scorecardView) {
    const course = courses.find(c => c.id === sessions.find(s => s.id === scorecardView.match.sessionId)?.courseId);
    return <PlayerScorecard player={scorecardView.player} match={scorecardView.match} course={course} onBack={() => setScorecardView(null)} players={players} />;
  }

  return (
    <div style={{ padding: "24px 16px 100px" }}>
      <div style={{ marginBottom: 22 }}>
        <div style={{ color: C.white, ...BC, fontSize: 26, fontWeight: 800, letterSpacing: "0.06em", textTransform: "uppercase" }}>Sessions</div>
        <div style={{ color: C.grey2, ...BC, fontSize: 9, fontWeight: 700, letterSpacing: "0.2em", marginTop: 2 }}>ALL ROUNDS & RESULTS</div>
      </div>
      {sorted.length === 0 && <div style={{ color: C.grey2, ...BC, fontSize: 11, fontWeight: 600, letterSpacing: "0.1em" }}>NO SESSIONS YET</div>}
      {sorted.map(s => {
        const sMatches = matches.filter(m => m.sessionId === s.id);
        const { aPoints, bPoints } = computePoints(sMatches);
        const teamA = teams.find(t => t.id === "A"), teamB = teams.find(t => t.id === "B");
        const course = courses.find(c => c.id === s.courseId);
        const isExp = expanded === s.id;
        return (
          <Card key={s.id} style={{ marginBottom: 8 }} onClick={() => setExpanded(isExp ? null : s.id)}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
              <div style={{ flex: 1 }}>
                <div style={{ color: C.white, ...BC, fontSize: 18, fontWeight: 800, letterSpacing: "0.04em", textTransform: "uppercase", marginBottom: 6 }}>{s.name}</div>
                <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                  {s.active && <Tag color={C.white}>● LIVE</Tag>}
                  <Tag color={C.grey2}>{FORMAT_LABELS[s.format] || s.format}</Tag>
                  {course && <Tag color={C.grey2}>{course.name}</Tag>}
                  {s.date && <Tag color={C.grey3}>{s.date}</Tag>}
                </div>
              </div>
              <div style={{ textAlign: "right", flexShrink: 0, marginLeft: 12 }}>
                <div style={{ ...BC, fontSize: 24, fontWeight: 800, lineHeight: 1 }}>
                  <span style={{ color: C.white }}>{aPoints % 1 ? aPoints.toFixed(1) : aPoints}</span>
                  <span style={{ color: C.grey3 }}> – </span>
                  <span style={{ color: C.grey1 }}>{bPoints % 1 ? bPoints.toFixed(1) : bPoints}</span>
                </div>
                <div style={{ color: C.grey2, ...BC, fontSize: 8, fontWeight: 600, letterSpacing: "0.1em", marginTop: 2 }}>{sMatches.length} MATCHES</div>
              </div>
            </div>
            {isExp && (
              <div style={{ marginTop: 14, borderTop: `1px solid ${C.grey3}`, paddingTop: 14 }} onClick={e => e.stopPropagation()}>
                {sMatches.map(m => {
                  const st = computeMatchFromScores(m);
                  const allPlayers = [...(m.playerAIds || []), ...(m.playerBIds || [])].map(id => players.find(p => p.id === id)).filter(Boolean);
                  return (
                    <div key={m.id} style={{ marginBottom: 14, paddingBottom: 14, borderBottom: `1px solid ${C.grey3}` }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                        <div>
                          <div style={{ color: C.white, ...BC, fontSize: 11, fontWeight: 700 }}>{(m.playerAIds || []).map(getPName).join(" / ")}</div>
                          <div style={{ color: C.grey1, ...BC, fontSize: 11, fontWeight: 700 }}>{(m.playerBIds || []).map(getPName).join(" / ")}</div>
                        </div>
                        <div style={{ color: st.complete ? (st.winner === "half" ? C.gold : st.winner === "A" ? C.white : C.grey1) : C.grey2, ...BC, fontSize: 11, fontWeight: 800, letterSpacing: "0.06em" }}>
                          {st.label}{!st.complete && st.holesPlayed > 0 ? ` · ${st.holesPlayed}` : ""}
                        </div>
                      </div>
                      {/* Player scorecard buttons */}
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                        {allPlayers.map(pl => {
                          const scores = (m.playerScores || {})[pl.id] || [];
                          const gross = scores.filter(s => s > 0).reduce((a, b) => a + b, 0);
                          const pars = course?.pars || Array(18).fill(4);
                          const vp = playerVsPar(pl.id, m.playerScores || {}, pars);
                          const hasScores = gross > 0;
                          return (
                            <button key={pl.id} onClick={() => setScorecardView({ match: m, player: pl })} style={{
                              background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8,
                              padding: "6px 10px", cursor: "pointer", textAlign: "left",
                            }}>
                              <div style={{ color: C.white, ...BC, fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em" }}>{pl.name}</div>
                              {hasScores && (
                                <div style={{ color: C.grey2, ...BC, fontSize: 9, fontWeight: 600, marginTop: 2 }}>
                                  {gross} &nbsp;<span style={{ color: vp <= 0 ? C.birdie : C.bogey }}>{vp === 0 ? "E" : vp > 0 ? `+${vp}` : vp}</span>
                                </div>
                              )}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </Card>
        );
      })}
    </div>
  );
}



// ── Satellite Tiles ───────────────────────────────────────────────────────────
// Renders a 3x3 grid of ESRI World Imagery tiles centered on a lat/lng.
// No API key needed. Tile URLs: server.arcgisonline.com/World_Imagery
function latLngToTile(lat, lng, zoom) {
  const n = Math.pow(2, zoom);
  const x = Math.floor((lng + 180) / 360 * n);
  const latRad = lat * Math.PI / 180;
  const y = Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n);
  return { x, y };
}

function SatelliteTiles({ center, zoom }) {
  const { x: cx, y: cy } = latLngToTile(center.lat, center.lng, zoom);
  const offsets = [-1, 0, 1];
  return (
    <div style={{ position: "absolute", inset: 0, display: "grid", gridTemplateColumns: "repeat(3, 256px)", gridTemplateRows: "repeat(3, 256px)", justifyContent: "center", alignContent: "center" }}>
      {offsets.map(dy => offsets.map(dx => {
        const tx = cx + dx, ty = cy + dy;
        const url = `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${zoom}/${ty}/${tx}`;
        return (
          <img key={`${dx},${dy}`} src={url} width={256} height={256}
            style={{ display: "block", imageRendering: "pixelated" }}
            alt="" draggable={false}
          />
        );
      }))}
    </div>
  );
}



// ── Hole Map (Static Maps API + pixel-to-latlng math) ────────────────────────
const GMAPS_KEY = "AIzaSyCQ_1b2SsxhTOX0KOpgM4uRZWs87pDMPUw";
const STATIC_ZOOM = 18;
const STATIC_W = 640;
const STATIC_H = 480;

// Haversine distance in yards between two lat/lng points
function haversineYards(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const rad = d => d * Math.PI / 180;
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat/2)*Math.sin(dLat/2) +
            Math.cos(rad(lat1))*Math.cos(rad(lat2))*
            Math.sin(dLng/2)*Math.sin(dLng/2);
  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)) * 1.09361);
}

// Convert a pixel tap on a Static Maps image to real lat/lng
// Uses Mercator projection math matching Google's tile system
function pixelToLatLng(px, py, centerLat, centerLng, zoom, imgW, imgH) {
  const TILE = 256;
  const scale = Math.pow(2, zoom);
  const rad = d => d * Math.PI / 180;
  // World pixel coords of the map center
  const sinLat = Math.sin(rad(centerLat));
  const cx = (centerLng + 180) / 360 * TILE * scale;
  const cy = (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * TILE * scale;
  // Offset tap from center
  const wx = cx + (px - imgW / 2);
  const wy = cy + (py - imgH / 2);
  // Back to lat/lng
  const lng = wx / (TILE * scale) * 360 - 180;
  const n = Math.PI - 2 * Math.PI * wy / (TILE * scale);
  const lat = 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  return { lat, lng };
}

function HoleMap({ hole, par, course, onClose }) {
  const [pinA, setPinA] = useState(null);
  const [pinB, setPinB] = useState(null);
  const [mapLoading, setMapLoading] = useState(true);
  const [mapError, setMapError] = useState(false);
  const [mapImgSrc, setMapImgSrc] = useState(null);
  const imgRef = useRef(null);

  const centerLat = course?.lat || 40.3052;
  const centerLng = course?.lng || -111.6949;

  const mapUrl = "https://maps.googleapis.com/maps/api/staticmap" +
    "?center=" + centerLat + "," + centerLng +
    "&zoom=" + STATIC_ZOOM +
    "&size=" + STATIC_W + "x" + STATIC_H +
    "&scale=2" +
    "&maptype=satellite" +
    "&key=" + GMAPS_KEY;

  useEffect(() => {
    setPinA(null); setPinB(null);
    setMapLoading(false); setMapError(true); setMapImgSrc(null);
  }, [hole, centerLat, centerLng]);

  function onImgLoad() {}
  function onImgError() { setMapError(true); }

  function handleTap(e) {
    if (!imgRef.current) return;
    const rect = imgRef.current.getBoundingClientRect();
    // Tap position relative to image
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    // Scale to static image logical pixels (image rendered at display size, logical at STATIC_W x STATIC_H)
    const scaledPx = (px / rect.width) * STATIC_W;
    const scaledPy = (py / rect.height) * STATIC_H;
    const { lat, lng } = pixelToLatLng(scaledPx, scaledPy, centerLat, centerLng, STATIC_ZOOM, STATIC_W, STATIC_H);
    const pin = { lat, lng, px, py };
    if (!pinA) { setPinA(pin); }
    else if (!pinB) { setPinB(pin); }
    else { setPinA(pin); setPinB(null); } // reset on third tap
  }

  function reset() { setPinA(null); setPinB(null); }

  const distance = pinA && pinB ? haversineYards(pinA.lat, pinA.lng, pinB.lat, pinB.lng) : null;
  const mode = !pinA ? "first" : !pinB ? "second" : "done";

  const BC2 = { fontFamily: "'Barlow Condensed', 'Arial Narrow', Arial, sans-serif" };

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 200, background: "#000", display: "flex", flexDirection: "column" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 16px 10px", borderBottom: "1px solid rgba(255,255,255,0.12)", flexShrink: 0 }}>
        <div>
          <div style={{ color: "#fff", ...BC2, fontSize: 20, fontWeight: 800, letterSpacing: "0.06em" }}>
            {"HOLE " + hole + "  \u00B7  PAR " + par}
          </div>
          {course && <div style={{ color: "#555", ...BC2, fontSize: 9, fontWeight: 700, letterSpacing: "0.16em", marginTop: 2 }}>{course.name.toUpperCase() + " \u00B7 SATELLITE"}</div>}
        </div>
        <button onClick={onClose} style={{ background: "rgba(255,255,255,0.1)", border: "1px solid rgba(255,255,255,0.2)", color: "#fff", borderRadius: 8, padding: "6px 12px", ...BC2, fontSize: 11, fontWeight: 700, letterSpacing: "0.1em", cursor: "pointer" }}>CLOSE</button>
      </div>

      {/* Status bar */}
      <div style={{ padding: "8px 0", textAlign: "center", borderBottom: "1px solid rgba(255,255,255,0.08)", flexShrink: 0 }}>
        {mode !== "done" && <div style={{ color: "#888", ...BC2, fontSize: 11, fontWeight: 700, letterSpacing: "0.14em" }}>
          {mode === "first" ? "TAP TO SET POINT A" : "TAP TO SET POINT B"}
        </div>}
        {mode === "done" && (
          <div>
            <div style={{ color: "#D4AF6A", ...BC2, fontSize: 28, fontWeight: 800, letterSpacing: "0.06em", lineHeight: 1 }}>{distance} YDS</div>
            <div style={{ color: "#444", ...BC2, fontSize: 8, fontWeight: 700, letterSpacing: "0.16em", marginTop: 2 }}>TAP AGAIN TO RESET</div>
          </div>
        )}
      </div>

      {/* Map image */}
      <div style={{ flex: 1, position: "relative", overflow: "hidden", cursor: "crosshair", background: "#0a0a0a" }} onClick={handleTap}>
        {/* Loading spinner */}
        {mapLoading && !mapError && (
          <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12, zIndex: 2 }}>
            <div style={{ width: 36, height: 36, border: "3px solid #222", borderTop: "3px solid #666", borderRadius: "50%", animation: "spin 1s linear infinite" }} />
            <div style={{ color: "#444", fontFamily: "'Barlow Condensed', 'Arial Narrow', Arial, sans-serif", fontSize: 10, fontWeight: 700, letterSpacing: "0.2em" }}>LOADING MAP</div>
            <style>{"@keyframes spin{to{transform:rotate(360deg)}}"}</style>
          </div>
        )}
        {/* Error state — still allow pin tapping on dark background */}
        {mapError && (
          <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, zIndex: 2, padding: 24, textAlign: "center" }}>
            <div style={{ color: "#555", fontFamily: "'Barlow Condensed', 'Arial Narrow', Arial, sans-serif", fontSize: 11, fontWeight: 700, letterSpacing: "0.1em" }}>SATELLITE IMAGE UNAVAILABLE</div>
            <div style={{ color: "#333", fontFamily: "'Barlow Condensed', 'Arial Narrow', Arial, sans-serif", fontSize: 9, letterSpacing: "0.08em", maxWidth: 220 }}>Distance measurement still works — tap two points to measure</div>
          </div>
        )}
        {mapImgSrc && mapImgSrc !== "embed" && (
          <img
            ref={imgRef}
            src={mapImgSrc}
            onLoad={onImgLoad}
            onError={onImgError}
            alt="Hole satellite view"
            style={{ width: "100%", height: "100%", objectFit: "cover", display: "block", userSelect: "none", WebkitUserSelect: "none" }}
            draggable={false}
          />
        )}
        {mapImgSrc === "embed" && (
          <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, padding: 24, textAlign: "center" }}>
            <div style={{ color: "#555", fontFamily: "'Barlow Condensed', 'Arial Narrow', Arial, sans-serif", fontSize: 13, fontWeight: 700, letterSpacing: "0.1em" }}>SATELLITE UNAVAILABLE</div>
            <div style={{ color: "#333", fontFamily: "'Barlow Condensed', 'Arial Narrow', Arial, sans-serif", fontSize: 9, letterSpacing: "0.08em", maxWidth: 220 }}>Map will load after deployment. Distance measurement still works — tap two points.</div>
          </div>
        )}

        {/* Pin A */}
        {pinA && (
          <div style={{ position: "absolute", left: pinA.px, top: pinA.py, transform: "translate(-50%, -100%)", pointerEvents: "none" }}>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
              <div style={{ width: 30, height: 30, borderRadius: "50% 50% 50% 0", background: "#fff", border: "2px solid #000", transform: "rotate(-45deg)", boxShadow: "0 2px 8px rgba(0,0,0,0.8)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                <span style={{ transform: "rotate(45deg)", ...BC2, fontSize: 11, fontWeight: 900, color: "#000" }}>A</span>
              </div>
            </div>
          </div>
        )}

        {/* Pin B */}
        {pinB && (
          <div style={{ position: "absolute", left: pinB.px, top: pinB.py, transform: "translate(-50%, -100%)", pointerEvents: "none" }}>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
              <div style={{ width: 30, height: 30, borderRadius: "50% 50% 50% 0", background: "#D4AF6A", border: "2px solid #000", transform: "rotate(-45deg)", boxShadow: "0 2px 8px rgba(0,0,0,0.8)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                <span style={{ transform: "rotate(45deg)", ...BC2, fontSize: 11, fontWeight: 900, color: "#000" }}>B</span>
              </div>
            </div>
          </div>
        )}

        {/* Line between pins */}
        {pinA && pinB && (() => {
          const dx = pinB.px - pinA.px;
          const dy = pinB.py - pinA.py;
          const len = Math.sqrt(dx*dx + dy*dy);
          const angle = Math.atan2(dy, dx) * 180 / Math.PI;
          return (
            <div style={{ position: "absolute", left: pinA.px, top: pinA.py, width: len, height: 2, background: "linear-gradient(90deg,rgba(255,255,255,0.9),rgba(212,175,106,0.9))", transformOrigin: "0 50%", transform: "rotate(" + angle + "deg)", pointerEvents: "none", boxShadow: "0 0 6px rgba(0,0,0,0.9)" }} />
          );
        })()}
      </div>

      {/* Footer */}
      <div style={{ display: "flex", gap: 10, padding: "10px 16px 28px", borderTop: "1px solid rgba(255,255,255,0.08)", flexShrink: 0 }}>
        <button onClick={reset} style={{ flex: 1, padding: 12, borderRadius: 10, background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.14)", color: "#ccc", ...BC2, fontSize: 11, fontWeight: 700, letterSpacing: "0.1em", cursor: "pointer" }}>RESET</button>
        <button onClick={onClose} style={{ flex: 1, padding: 12, borderRadius: 10, background: "#fff", border: "none", color: "#000", ...BC2, fontSize: 11, fontWeight: 800, letterSpacing: "0.1em", cursor: "pointer" }}>DONE</button>
      </div>
    </div>
  );
}

// ── Score Entry ───────────────────────────────────────────────────────────────
function ScoreEntryPage({ data, onUpdate }) {
  const { players } = data;
  const courses = data.courses || [];
  const cy = data.currentYear;
  const sessions = cy?.sessions || [];
  const matches = cy?.matches || [];
  const cyTeams = cy?.teams || [];
  const [selectedMatch, setSelectedMatch] = useState(null);
  const [playerScores, setPlayerScores] = useState({});
  const [currentHole, setCurrentHole] = useState(1);
  const [showHoleMap, setShowHoleMap] = useState(false);
  const teamA = cyTeams.find(t => t.id === "A") || { id: "A", name: "Team A" };
  const teamB = cyTeams.find(t => t.id === "B") || { id: "B", name: "Team B" };
  const activeMatches = cy?.status === "active" ? matches : [];
  const getPName = id => players.find(p => p.id === id)?.name || id;

  // For scramble/foursomes: one score per team, stored under "teamA_ID" and "teamB_ID" keys
  function isTeamFormat(format) { return format === "scramble" || format === "foursomes"; }
  function teamScoreId(matchId, side) { return matchId + "_" + side; }

  function selectMatch(m) {
    setSelectedMatch(m);
    const existing = {};
    if (isTeamFormat(m.format)) {
      // One score entry per team pairing
      const idA = teamScoreId(m.id, "A");
      const idB = teamScoreId(m.id, "B");
      existing[idA] = [...((m.playerScores || {})[idA] || Array(18).fill(null))];
      existing[idB] = [...((m.playerScores || {})[idB] || Array(18).fill(null))];
    } else {
      [...(m.playerAIds || []), ...(m.playerBIds || [])].forEach(id => {
        existing[id] = [...((m.playerScores || {})[id] || Array(18).fill(null))];
      });
    }
    setPlayerScores(existing);
    // Jump to first unentered hole
    const scoreIds = Object.keys(existing);
    let firstEmpty = 1;
    for (let h = 1; h <= 18; h++) {
      const allEntered = scoreIds.every(id => {
        const s = (existing[id] || [])[h - 1];
        return s !== null && s !== undefined && s > 0;
      });
      if (!allEntered) { firstEmpty = h; break; }
      if (h === 18) firstEmpty = 18;
    }
    setCurrentHole(firstEmpty);
  }

  function setScore(playerId, holeIdx, value) {
    const num = parseInt(value);
    const updated = { ...playerScores, [playerId]: [...(playerScores[playerId] || Array(18).fill(null))] };
    updated[playerId][holeIdx] = isNaN(num) || num <= 0 ? null : num;
    setPlayerScores(updated);
  }

  async function saveScores(scores) {
    const s = scores || playerScores;
    const updated = { ...selectedMatch, playerScores: s };
    const newMatches = matches.map(m => m.id === selectedMatch.id ? updated : m);
    await onUpdate({ ...data, currentYear: { ...cy, matches: newMatches } });
    setSelectedMatch(updated);
  }

  if (selectedMatch) {
    const session = sessions.find(s => s.id === selectedMatch.sessionId);
    const course = courses.find(c => c.id === session?.courseId);
    const pars = course?.pars || Array(18).fill(4);
    const status = computeMatchFromScores({ ...selectedMatch, playerScores });
    const allPlayerIds = isTeamFormat(selectedMatch.format)
      ? [teamScoreId(selectedMatch.id, "A"), teamScoreId(selectedMatch.id, "B")]
      : [...(selectedMatch.playerAIds || []), ...(selectedMatch.playerBIds || [])];
    const h = currentHole;
    const par = pars[h - 1] || 4;
    const holeWinner = getHoleWinner(
      h - 1,
      isTeamFormat(selectedMatch.format) ? [teamScoreId(selectedMatch.id, "A")] : (selectedMatch.playerAIds || []),
      isTeamFormat(selectedMatch.format) ? [teamScoreId(selectedMatch.id, "B")] : (selectedMatch.playerBIds || []),
      playerScores
    );

    const leadColor = status.winner === "half" ? C.gold : (status.winner === "A" || status.aUp > 0) ? C.white : (status.winner === "B" || status.aUp < 0) ? C.grey1 : C.grey2;
    let statusText = "NOT STARTED";
    if (status.holesPlayed > 0) {
      if (status.complete) statusText = `${status.label} — FINAL`;
      else if (status.aUp === 0) statusText = `ALL SQUARE · THRU ${status.holesPlayed}`;
      else statusText = `${status.aUp > 0 ? (teamA?.name || "A") : (teamB?.name || "B")} ${Math.abs(status.aUp)} UP · THRU ${status.holesPlayed}`;
    }

    return (
      <>
        {showHoleMap && (
          <HoleMap hole={currentHole} par={pars[currentHole - 1] || 4} course={course} onClose={() => setShowHoleMap(false)} />
        )}
        <div style={{ padding: "16px 16px 120px" }}>
        <button onClick={() => setSelectedMatch(null)} style={{ background: "none", border: "none", color: C.grey2, ...BC, fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", cursor: "pointer", marginBottom: 14, padding: 0 }}>← BACK</button>

        {/* Match status */}
        <div style={{ textAlign: "center", padding: "14px 0 12px", borderBottom: `1px solid ${C.border}`, marginBottom: 16 }}>
          <div style={{ color: leadColor, ...BC, fontSize: 22, fontWeight: 800, letterSpacing: "0.06em" }}>{statusText}</div>
          <div style={{ color: C.grey2, ...BC, fontSize: 9, fontWeight: 700, letterSpacing: "0.14em", marginTop: 3 }}>{session?.name?.toUpperCase()} · {FORMAT_LABELS[session?.format]?.toUpperCase()}</div>
        </div>

        {/* Hole strip nav */}
        <div style={{ display: "flex", gap: 2, marginBottom: 16, alignItems: "center" }}>
          {HOLES.map(n => {
            const hw = getHoleWinner(
              n - 1,
              isTeamFormat(selectedMatch.format) ? [teamScoreId(selectedMatch.id, "A")] : (selectedMatch.playerAIds || []),
              isTeamFormat(selectedMatch.format) ? [teamScoreId(selectedMatch.id, "B")] : (selectedMatch.playerBIds || []),
              playerScores
            );
            const allIn = allPlayerIds.every(id => { const s = (playerScores[id] || [])[n - 1]; return s !== null && s !== undefined && s > 0; });
            return (
              <div key={n} onClick={() => { saveScores(); setCurrentHole(n); }} style={{
                flex: 1, height: n === currentHole ? 22 : 16, borderRadius: 2, cursor: "pointer", transition: "all 0.15s",
                background: n === currentHole ? C.white : hw === "A" ? "rgba(255,255,255,0.5)" : hw === "B" ? "rgba(200,200,200,0.45)" : hw === "half" ? `${C.gold}80` : allIn ? "rgba(255,255,255,0.18)" : "rgba(255,255,255,0.1)",
                border: n === currentHole ? `none` : "none",
                position: "relative",
              }}>
                {n === currentHole && <div style={{ position: "absolute", top: "50%", left: "50%", transform: "translate(-50%,-50%)", color: C.bg, ...BC, fontSize: 8, fontWeight: 900 }}>{n}</div>}
              </div>
            );
          })}
        </div>

        {/* Current hole entry */}
        <div style={{ ...surfHigh(), borderRadius: 14, overflow: "hidden", marginBottom: 14 }}>
          {/* Hole header */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 56px", padding: "12px 16px", background: "rgba(0,0,0,0.3)", borderBottom: `1px solid ${C.grey3}`, textAlign: "center", alignItems: "center" }}>
            <div>
              <div style={{ color: C.grey1, ...BC, fontSize: 9, fontWeight: 700, letterSpacing: "0.16em" }}>HOLE</div>
              <div style={{ color: C.white, ...BC, fontSize: 36, fontWeight: 800, lineHeight: 1 }}>{h}</div>
            </div>
            <div>
              <div style={{ color: C.grey1, ...BC, fontSize: 9, fontWeight: 700, letterSpacing: "0.16em" }}>PAR</div>
              <div style={{ color: C.white, ...BC, fontSize: 36, fontWeight: 800, lineHeight: 1 }}>{par}</div>
            </div>
            <div>
              <div style={{ color: C.grey1, ...BC, fontSize: 9, fontWeight: 700, letterSpacing: "0.16em" }}>RESULT</div>
              <div style={{
                color: holeWinner === "A" ? C.white : holeWinner === "B" ? C.grey1 : holeWinner === "half" ? C.gold : C.grey3,
                ...BC, fontSize: 14, fontWeight: 800, marginTop: 6
              }}>
                {holeWinner === "A" ? (teamA?.name || "A").toUpperCase() : holeWinner === "B" ? (teamB?.name || "B").toUpperCase() : holeWinner === "half" ? "HALVED" : "—"}
              </div>
            </div>
            <button onClick={() => setShowHoleMap(true)} style={{ background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.18)", borderRadius: 8, padding: "8px 4px", color: C.white, ...BC, fontSize: 8, fontWeight: 700, letterSpacing: "0.08em", cursor: "pointer", lineHeight: 1.4 }}>
              VIEW<br/>MAP
            </button>
          </div>

          {/* Score rows — per-player for Best Ball/Singles, per-team for Scramble/Alt Shot */}
          {isTeamFormat(selectedMatch.format) ? (
            <>
              <div style={{ borderBottom: `1px solid ${C.grey3}` }}>
                <div style={{ padding: "8px 16px 6px", background: "rgba(255,255,255,0.06)", borderBottom: `1px solid ${C.border}` }}>
                  <div style={{ color: C.white, ...BC, fontSize: 9, fontWeight: 800, letterSpacing: "0.2em" }}>
                    {(selectedMatch.playerAIds || []).map(getPName).join(" & ").toUpperCase()}
                  </div>
                </div>
                {(() => {
                  const idA = teamScoreId(selectedMatch.id, "A");
                  const sc = (playerScores[idA] || [])[h - 1];
                  const diff = sc > 0 ? sc - par : null;
                  return <PlayerScoreRow key={idA} playerId={idA} name={(selectedMatch.playerAIds || []).map(getPName).join(" & ")} score={sc} diff={diff} par={par} onChange={val => setScore(idA, h - 1, val)} />;
                })()}
              </div>
              <div>
                <div style={{ padding: "8px 16px 6px", background: "rgba(255,255,255,0.04)", borderBottom: `1px solid ${C.border}` }}>
                  <div style={{ color: C.grey1, ...BC, fontSize: 9, fontWeight: 800, letterSpacing: "0.2em" }}>
                    {(selectedMatch.playerBIds || []).map(getPName).join(" & ").toUpperCase()}
                  </div>
                </div>
                {(() => {
                  const idB = teamScoreId(selectedMatch.id, "B");
                  const sc = (playerScores[idB] || [])[h - 1];
                  const diff = sc > 0 ? sc - par : null;
                  return <PlayerScoreRow key={idB} playerId={idB} name={(selectedMatch.playerBIds || []).map(getPName).join(" & ")} score={sc} diff={diff} par={par} onChange={val => setScore(idB, h - 1, val)} />;
                })()}
              </div>
            </>
          ) : (
            <>
              {/* Team A players */}
              <div style={{ borderBottom: `1px solid ${C.grey3}` }}>
                <div style={{ padding: "8px 16px 6px", background: "rgba(255,255,255,0.06)", borderBottom: `1px solid ${C.border}` }}>
                  <div style={{ color: C.white, ...BC, fontSize: 9, fontWeight: 800, letterSpacing: "0.2em" }}>{(teamA?.name || "TEAM A").toUpperCase()}</div>
                </div>
                {(selectedMatch.playerAIds || []).map(pid => {
                  const sc = (playerScores[pid] || [])[h - 1];
                  const diff = sc > 0 ? sc - par : null;
                  return <PlayerScoreRow key={pid} playerId={pid} name={getPName(pid)} score={sc} diff={diff} par={par} onChange={val => setScore(pid, h - 1, val)} />;
                })}
              </div>
              {/* Team B players */}
              <div>
                <div style={{ padding: "8px 16px 6px", background: "rgba(255,255,255,0.04)", borderBottom: `1px solid ${C.border}` }}>
                  <div style={{ color: C.grey1, ...BC, fontSize: 9, fontWeight: 800, letterSpacing: "0.2em" }}>{(teamB?.name || "TEAM B").toUpperCase()}</div>
                </div>
                {(selectedMatch.playerBIds || []).map(pid => {
                  const sc = (playerScores[pid] || [])[h - 1];
                  const diff = sc > 0 ? sc - par : null;
                  return <PlayerScoreRow key={pid} playerId={pid} name={getPName(pid)} score={sc} diff={diff} par={par} onChange={val => setScore(pid, h - 1, val)} />;
                })}
              </div>
            </>
          )}
        </div>

        {/* Prev / Next */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 12 }}>
          <button onClick={() => { saveScores(); setCurrentHole(Math.max(1, currentHole - 1)); }} disabled={currentHole === 1} style={{
            padding: 12, borderRadius: 10, background: C.surfaceHigh, border: `1px solid ${C.border}`,
            color: currentHole === 1 ? "rgba(255,255,255,0.2)" : C.white, ...BC, fontSize: 12, fontWeight: 700, letterSpacing: "0.1em", cursor: currentHole === 1 ? "default" : "pointer",
          }}>← PREV</button>
          <button onClick={async () => { await saveScores(); if (currentHole < 18) setCurrentHole(currentHole + 1); else setSelectedMatch(null); }} style={{
            padding: 12, borderRadius: 10,
            background: currentHole === 18 ? C.white : C.surfaceHigh,
            border: `1px solid ${currentHole === 18 ? C.white : C.border}`,
            color: currentHole === 18 ? C.bg : C.white,
            ...BC, fontSize: 12, fontWeight: 700, letterSpacing: "0.1em", cursor: "pointer",
          }}>{currentHole === 18 ? "✓ DONE" : "NEXT →"}</button>
        </div>


      </div>
      </>
    );
  }

  return (
    <div style={{ padding: "24px 16px 100px" }}>
      <div style={{ marginBottom: 22 }}>
        <div style={{ color: C.white, ...BC, fontSize: 26, fontWeight: 800, letterSpacing: "0.06em", textTransform: "uppercase" }}>Score Entry</div>
        <div style={{ color: C.grey2, ...BC, fontSize: 9, fontWeight: 700, letterSpacing: "0.2em", marginTop: 2 }}>SELECT YOUR MATCH</div>
      </div>
      {activeMatches.length === 0 && (
        <div style={{ textAlign: "center", padding: "48px 20px", color: C.grey2, ...BC, fontSize: 11, fontWeight: 700, letterSpacing: "0.1em" }}>
          NO ACTIVE MATCHES<br /><span style={{ color: C.grey3, fontSize: 9, marginTop: 6, display: "block" }}>ACTIVATE A SESSION IN ADMIN</span>
        </div>
      )}
      {activeMatches.map(m => {
        const status = computeMatchFromScores(m);
        const session = sessions.find(s => s.id === m.sessionId);
        return (
          <button key={m.id} onClick={() => selectMatch(m)} style={{
            display: "block", width: "100%", marginBottom: 6,
            background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12,
            padding: "14px 16px", textAlign: "left", cursor: "pointer",
          }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <div style={{ color: C.grey2, ...BC, fontSize: 8, fontWeight: 700, letterSpacing: "0.14em", marginBottom: 6, textTransform: "uppercase" }}>{session?.name} · {FORMAT_LABELS[session?.format]}</div>
                <div style={{ color: C.white, ...BC, fontSize: 13, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 2 }}>{(m.playerAIds || []).map(getPName).join(" / ")}</div>
                <div style={{ color: C.grey1, ...BC, fontSize: 13, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.04em" }}>{(m.playerBIds || []).map(getPName).join(" / ")}</div>
              </div>
              <div style={{ textAlign: "right", marginLeft: 12, flexShrink: 0 }}>
                <div style={{ color: status.complete ? C.gold : C.grey2, ...BC, fontSize: 11, fontWeight: 700 }}>{status.label}{!status.complete && status.holesPlayed > 0 ? ` · ${status.holesPlayed}` : ""}</div>
                <div style={{ color: C.grey3, fontSize: 16, marginTop: 4 }}>→</div>
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}

// ── Player Score Row (used in score entry) ────────────────────────────────────
function PlayerScoreRow({ playerId, name, score, diff, par, onChange }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState("");
  const inputRef = useRef(null);

  function startEdit() { setVal(score > 0 ? String(score) : ""); setEditing(true); setTimeout(() => inputRef.current?.focus(), 50); }
  function commit(v) {
    const n = parseInt(v);
    onChange(isNaN(n) || n <= 0 ? null : n);
    setEditing(false);
  }

  const diffColor = diff === null ? C.grey3 : diff <= -2 ? C.eagle : diff === -1 ? C.birdie : diff === 0 ? C.white : diff === 1 ? C.bogey : C.double;
  const diffLabel = diff === null ? "" : diff <= -2 ? "EAGLE" : diff === -1 ? "BIRDIE" : diff === 0 ? "PAR" : diff === 1 ? "BOGEY" : diff === 2 ? "DOUBLE" : `+${diff}`;

  // Quick-tap score buttons: par-2 through par+4
  const quickScores = [];
  for (let s = Math.max(1, par - 2); s <= par + 4; s++) quickScores.push(s);

  return (
    <div style={{ borderTop: `1px solid ${C.border}` }}>
      <div style={{ display: "flex", alignItems: "center", padding: "12px 16px", gap: 10 }}>
        <div style={{ flex: 1, color: C.white, ...BC, fontSize: 15, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.04em" }}>{name}</div>
        {diff !== null && <div style={{ color: diffColor, ...BC, fontSize: 10, fontWeight: 800, letterSpacing: "0.06em" }}>{diffLabel}</div>}
        <button onClick={startEdit} style={{
          width: 48, height: 48, borderRadius: 10, border: `1.5px solid ${score > 0 ? C.borderStrong : C.grey3}`,
          background: score > 0 ? C.surfaceHigh : "rgba(255,255,255,0.04)",
          color: score > 0 ? C.white : C.grey3, ...BC, fontSize: 22, fontWeight: 800, cursor: "pointer",
        }}>{score > 0 ? score : "—"}</button>
      </div>

      {/* Quick score pad */}
      <div style={{ display: "flex", gap: 5, padding: "4px 16px 14px" }}>
        {quickScores.map(s => {
          const d = s - par;
          const isActive = score === s;
          let borderCol = C.grey3, bgCol = "transparent", col = C.grey2;
          if (d <= -2) { borderCol = C.eagle; col = C.eagle; }
          else if (d === -1) { borderCol = C.birdie; col = C.birdie; }
          else if (d === 0) { borderCol = "rgba(255,255,255,0.3)"; col = C.white; }
          else if (d === 1) { borderCol = C.bogey; col = C.bogey; }
          else { borderCol = `${C.double}66`; col = C.double; }
          if (isActive) bgCol = `${borderCol}25`;
          return (
            <button key={s} onClick={() => onChange(s)} style={{
              flex: 1, height: 40, borderRadius: 7, border: `1.5px solid ${isActive ? borderCol : "rgba(255,255,255,0.12)"}`,
              background: isActive ? bgCol : "rgba(255,255,255,0.04)",
              color: isActive ? col : C.grey2, ...BC, fontSize: 14, fontWeight: 800, cursor: "pointer", transition: "all 0.1s",
            }}>{s}</button>
          );
        })}
        {/* Manual input */}
        {editing ? (
          <input ref={inputRef} type="number" value={val} onChange={e => setVal(e.target.value)}
            onBlur={() => commit(val)} onKeyDown={e => { if (e.key === "Enter") commit(val); if (e.key === "Escape") setEditing(false); }}
            style={{ width: 44, height: 36, borderRadius: 6, border: `1.5px solid ${C.white}`, background: "rgba(255,255,255,0.1)", color: C.white, ...BC, fontSize: 13, fontWeight: 800, textAlign: "center", outline: "none" }}
          />
        ) : (
          <button onClick={startEdit} style={{ width: 36, height: 36, borderRadius: 6, border: `1px solid ${C.grey3}`, background: "transparent", color: C.grey3, ...BC, fontSize: 11, fontWeight: 700, cursor: "pointer" }}>✎</button>
        )}
      </div>
    </div>
  );
}

// ── Admin ─────────────────────────────────────────────────────────────────────

// ── Admin sub-components ──────────────────────────────────────────────────────

function PlayerAvatar({ player, size = 40, fontSize = 15 }) {
  const initials = player.name.split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase();
  if (player.photo) {
    return (
      <div style={{ width: size, height: size, borderRadius: "50%", overflow: "hidden", flexShrink: 0, border: "2px solid rgba(255,255,255,0.15)" }}>
        <img src={player.photo} alt={player.name} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
      </div>
    );
  }
  return (
    <div style={{ width: size, height: size, borderRadius: "50%", background: "rgba(255,255,255,0.08)", border: "2px solid rgba(255,255,255,0.14)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
      <span style={{ color: "rgba(255,255,255,0.5)", fontFamily: "'Barlow Condensed', 'Arial Narrow', Arial, sans-serif", fontSize, fontWeight: 700 }}>{initials}</span>
    </div>
  );
}

function AdminPlayersTab({ data, onUpdate }) {
  const { players } = data;
  const [newName, setNewName] = useState("");
  const inp = (e = {}) => ({ background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.14)", borderRadius: 8, padding: "10px 12px", color: "#fff", fontFamily: "'Barlow', Arial, sans-serif", fontSize: 13, width: "100%", boxSizing: "border-box", outline: "none", ...e });

  async function addPlayer() {
    if (!newName.trim()) return;
    await onUpdate({ ...data, players: [...players, { id: Date.now().toString(), name: newName.trim() }] });
    setNewName("");
  }
  async function removePlayer(id) { await onUpdate({ ...data, players: players.filter(p => p.id !== id) }); }

  async function cleanDuplicates() {
    const CANONICAL_IDS = new Set([
      "p_logan","p_will","p_cale","p_josh","p_jake","p_harrison","p_tommy",
      "p_zach","p_blake","p_parker_m","p_marshall","p_jason","p_joe",
      "p_colton","p_dalton","p_shane","p_london","p_parker_l","p_mckay","p_cj"
    ]);
    const isTimestamp = id => /^\d{10,}$/.test(id);

    // Build name->canonical ID map for remapping
    const nameToCanonical = {};
    players.forEach(p => {
      if (CANONICAL_IDS.has(p.id)) nameToCanonical[p.name.toLowerCase().trim()] = p.id;
    });
    // Also build timestamp ID -> canonical ID map via name matching
    const tsToCanonical = {};
    players.forEach(p => {
      if (isTimestamp(p.id)) {
        const canonical = nameToCanonical[p.name.toLowerCase().trim()];
        if (canonical) tsToCanonical[p.id] = canonical;
      }
    });

    // Remap any timestamp IDs in currentYear matches
    function remapIds(ids) {
      return (ids || []).map(id => tsToCanonical[id] || id);
    }
    const cy = data.currentYear;
    const fixedCY = cy ? {
      ...cy,
      teams: (cy.teams || []).map(t => ({ ...t, playerIds: remapIds(t.playerIds) })),
      matches: (cy.matches || []).map(m => ({
        ...m,
        playerAIds: remapIds(m.playerAIds),
        playerBIds: remapIds(m.playerBIds),
        playerScores: Object.fromEntries(
          Object.entries(m.playerScores || {}).map(([id, scores]) => [tsToCanonical[id] || id, scores])
        ),
      })),
    } : cy;

    // Clean player list
    const cleaned = players.filter(p => CANONICAL_IDS.has(p.id) || !isTimestamp(p.id));

    await onUpdate({ ...data, players: cleaned, currentYear: fixedCY });
  }

  async function uploadPhoto(playerId, file) {
    // Read and compress image to max 300x300 to keep storage size small
    const b64 = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = reject;
      reader.onload = e => {
        const img = new Image();
        img.onerror = reject;
        img.onload = () => {
          const MAX = 300;
          const scale = Math.min(1, MAX / Math.max(img.width, img.height));
          const w = Math.round(img.width * scale);
          const h = Math.round(img.height * scale);
          const canvas = document.createElement("canvas");
          canvas.width = w; canvas.height = h;
          const ctx = canvas.getContext("2d");
          ctx.drawImage(img, 0, 0, w, h);
          resolve(canvas.toDataURL("image/jpeg", 0.82));
        };
        img.src = e.target.result;
      };
      reader.readAsDataURL(file);
    });
    const updatedPlayers = players.map(p => p.id === playerId ? { ...p, photo: b64 } : p);
    await onUpdate({ ...data, players: updatedPlayers });
  }

  async function removePhoto(playerId) {
    await onUpdate({ ...data, players: players.map(p => p.id === playerId ? { ...p, photo: null } : p) });
  }

  return (
    <div>
      <Card style={{ marginBottom: 10 }}>
        <SectionLabel>ADD PLAYER</SectionLabel>
        <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
          <input value={newName} onChange={e => setNewName(e.target.value)} onKeyDown={e => e.key === "Enter" && addPlayer()} placeholder="Player name" style={inp({ flex: 1 })} />
        </div>
        <Btn onClick={addPlayer} style={{ width: "100%", textAlign: "center" }}>+ Add Player</Btn>
      </Card>
      <Card>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <SectionLabel style={{ marginBottom: 0 }}>ALL PLAYERS ({players.length})</SectionLabel>
          {players.length > 20 && (
            <button onClick={cleanDuplicates} style={{ background: "rgba(255,80,80,0.12)", border: "1px solid rgba(255,80,80,0.3)", borderRadius: 6, padding: "4px 10px", color: "#ff6b6b", fontFamily: "'Barlow Condensed', 'Arial Narrow', Arial, sans-serif", fontSize: 9, fontWeight: 700, letterSpacing: "0.1em", cursor: "pointer" }}>
              CLEAN DUPLICATES ({players.length - 20} extra)
            </button>
          )}
        </div>
        {players.length === 0 && <div style={{ color: "#2a2a2a", fontFamily: "'Barlow Condensed', 'Arial Narrow', Arial, sans-serif", fontSize: 11 }}>No players yet</div>}
        {players.map(p => (
          <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 0", borderBottom: "1px solid #2a2a2a" }}>
            <PlayerAvatar player={p} size={38} fontSize={13} />
            <span style={{ color: "#fff", fontFamily: "'Barlow', Arial, sans-serif", fontSize: 13, flex: 1 }}>{p.name}</span>
            <label style={{ cursor: "pointer", flexShrink: 0 }}>
              <input type="file" accept="image/*" style={{ display: "none" }} onChange={e => e.target.files[0] && uploadPhoto(p.id, e.target.files[0])} />
              <div style={{ background: "rgba(255,255,255,0.07)", border: "1px solid rgba(255,255,255,0.14)", borderRadius: 6, padding: "4px 8px", color: "rgba(255,255,255,0.5)", fontFamily: "'Barlow Condensed', 'Arial Narrow', Arial, sans-serif", fontSize: 9, fontWeight: 700, letterSpacing: "0.08em", whiteSpace: "nowrap" }}>
                {p.photo ? "CHANGE" : "ADD PHOTO"}
              </div>
            </label>
            {p.photo && (
              <button onClick={() => removePhoto(p.id)} style={{ background: "none", border: "none", color: "#444", cursor: "pointer", fontSize: 14, padding: "0 2px", flexShrink: 0 }}>x</button>
            )}
            <button onClick={() => removePlayer(p.id)} style={{ background: "none", border: "none", color: "#333", cursor: "pointer", fontSize: 16, padding: "0 2px", flexShrink: 0 }}>x</button>
          </div>
        ))}
      </Card>
    </div>
  );
}

function AdminCoursesTab({ data, onUpdate }) {
  const courses = data.courses || [];
  const [newCourseName, setNewCourseName] = useState("");
  const [newCoursePars, setNewCoursePars] = useState(Array(18).fill(4));
  const [expandedCourse, setExpandedCourse] = useState(null);
  const [courseSearch, setCourseSearch] = useState("");
  const [courseSearchResults, setCourseSearchResults] = useState([]);
  const [courseSearching, setCourseSearching] = useState(false);
  const [selectedCourseLocation, setSelectedCourseLocation] = useState(null);

  const inp = (e = {}) => ({ background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.14)", borderRadius: 8, padding: "10px 12px", color: "#fff", fontFamily: "'Barlow', Arial, sans-serif", fontSize: 13, width: "100%", boxSizing: "border-box", outline: "none", ...e });

  async function searchCourse() {
    if (!courseSearch.trim()) return;
    setCourseSearching(true); setCourseSearchResults([]);
    try {
      const prompt = "Find the GPS coordinates of this golf course: \"" + courseSearch + "\". Return ONLY a JSON array of up to 3 results, no markdown. Format: [{\"name\":\"Full Name\",\"address\":\"City, State\",\"lat\":0.0,\"lng\":0.0}]. If not found return [].";
      const res = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 300, messages: [{ role: "user", content: prompt }] }) });
      const json = await res.json();
      const text = (json.content || []).map(b => b.text || "").join("").trim();
      const results = JSON.parse(text.replace(/```json|```/g, "").trim());
      setCourseSearchResults(Array.isArray(results) ? results : []);
    } catch(e) { setCourseSearchResults([]); }
    setCourseSearching(false);
  }

  async function addCourse() {
    if (!newCourseName.trim()) return;
    const c = { id: Date.now().toString(), name: newCourseName.trim(), pars: [...newCoursePars], lat: selectedCourseLocation?.lat || null, lng: selectedCourseLocation?.lng || null, address: selectedCourseLocation?.address || null };
    await onUpdate({ ...data, courses: [...courses, c] });
    setNewCourseName(""); setNewCoursePars(Array(18).fill(4)); setCourseSearch(""); setCourseSearchResults([]); setSelectedCourseLocation(null);
  }
  async function deleteCourse(id) { await onUpdate({ ...data, courses: courses.filter(c => c.id !== id) }); }

  return (
    <div>
      <Card style={{ marginBottom: 10 }}>
        <SectionLabel>CREATE COURSE</SectionLabel>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ color: "#555", fontFamily: "'Barlow Condensed', 'Arial Narrow', Arial, sans-serif", fontSize: 8, fontWeight: 700, letterSpacing: "0.16em", marginBottom: 4 }}>SEARCH BY NAME</div>
          <div style={{ display: "flex", gap: 6 }}>
            <input value={courseSearch} onChange={e => setCourseSearch(e.target.value)} onKeyDown={e => e.key === "Enter" && searchCourse()} placeholder="e.g. Sleepy Ridge Golf Club" style={inp({ flex: 1 })} />
            <button onClick={searchCourse} style={{ background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.14)", color: "#fff", borderRadius: 8, padding: "0 12px", fontFamily: "'Barlow Condensed', 'Arial Narrow', Arial, sans-serif", fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", cursor: "pointer", flexShrink: 0, whiteSpace: "nowrap" }}>{courseSearching ? "..." : "SEARCH"}</button>
          </div>
          {courseSearchResults.length > 0 && (
            <div style={{ background: "rgba(0,0,0,0.4)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 10, overflow: "hidden" }}>
              {courseSearchResults.map((r, i) => (
                <button key={i} onClick={() => { setSelectedCourseLocation(r); if (!newCourseName) setNewCourseName(r.name.split(",")[0]); setCourseSearchResults([]); }} style={{ display: "block", width: "100%", padding: "10px 12px", textAlign: "left", background: selectedCourseLocation?.lat === r.lat ? "rgba(255,255,255,0.08)" : "transparent", border: "none", borderBottom: i < courseSearchResults.length - 1 ? "1px solid #2a2a2a" : "none", cursor: "pointer" }}>
                  <div style={{ color: "#fff", fontFamily: "'Barlow Condensed', 'Arial Narrow', Arial, sans-serif", fontSize: 12, fontWeight: 700 }}>{r.name.split(",")[0]}</div>
                  <div style={{ color: "#555", fontFamily: "'Barlow Condensed', 'Arial Narrow', Arial, sans-serif", fontSize: 9, fontWeight: 600, marginTop: 1 }}>{r.address}</div>
                </button>
              ))}
            </div>
          )}
          {selectedCourseLocation && (
            <div style={{ background: "rgba(212,175,106,0.08)", border: "1px solid rgba(212,175,106,0.3)", borderRadius: 8, padding: "8px 12px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <div style={{ color: "#D4AF6A", fontFamily: "'Barlow Condensed', 'Arial Narrow', Arial, sans-serif", fontSize: 10, fontWeight: 700, letterSpacing: "0.1em" }}>LOCATION CONFIRMED</div>
                <div style={{ color: "#aaa", fontFamily: "'Barlow Condensed', 'Arial Narrow', Arial, sans-serif", fontSize: 9, marginTop: 2 }}>{selectedCourseLocation.lat.toFixed(4)}, {selectedCourseLocation.lng.toFixed(4)}</div>
              </div>
              <button onClick={() => setSelectedCourseLocation(null)} style={{ background: "none", border: "none", color: "#555", cursor: "pointer", fontSize: 14 }}>x</button>
            </div>
          )}
          <div style={{ color: "#555", fontFamily: "'Barlow Condensed', 'Arial Narrow', Arial, sans-serif", fontSize: 8, fontWeight: 700, letterSpacing: "0.16em" }}>COURSE NAME</div>
          <input value={newCourseName} onChange={e => setNewCourseName(e.target.value)} placeholder="Course name" style={inp()} />
          <SectionLabel>PAR PER HOLE</SectionLabel>
          {[HOLES.slice(0, 9), HOLES.slice(9)].map((half, hi) => (
            <div key={hi} style={{ display: "grid", gridTemplateColumns: "repeat(9,1fr)", gap: 4 }}>
              {half.map(h => (
                <div key={h} style={{ textAlign: "center" }}>
                  <div style={{ color: "#2a2a2a", fontFamily: "'Barlow Condensed', 'Arial Narrow', Arial, sans-serif", fontSize: 7, fontWeight: 700, marginBottom: 3 }}>{h}</div>
                  <select value={newCoursePars[h - 1]} onChange={e => { const p = [...newCoursePars]; p[h - 1] = Number(e.target.value); setNewCoursePars(p); }} style={{ background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.14)", borderRadius: 5, padding: "5px 0", color: "#fff", fontFamily: "'Barlow Condensed', 'Arial Narrow', Arial, sans-serif", fontSize: 12, fontWeight: 700, width: "100%", outline: "none", appearance: "none", textAlign: "center", cursor: "pointer" }}>
                    <option value={3}>3</option><option value={4}>4</option><option value={5}>5</option>
                  </select>
                </div>
              ))}
            </div>
          ))}
          <div style={{ color: "#555", fontFamily: "'Barlow Condensed', 'Arial Narrow', Arial, sans-serif", fontSize: 9, fontWeight: 700, letterSpacing: "0.1em" }}>TOTAL PAR: <span style={{ color: "#fff" }}>{newCoursePars.reduce((a, b) => a + b, 0)}</span></div>
          <Btn onClick={addCourse} style={{ width: "100%", textAlign: "center", padding: 11 }}>+ Save Course</Btn>
        </div>
      </Card>
      {courses.length === 0 && <div style={{ color: "#2a2a2a", fontFamily: "'Barlow Condensed', 'Arial Narrow', Arial, sans-serif", fontSize: 11, fontWeight: 600, letterSpacing: "0.1em", padding: "12px 0" }}>NO COURSES YET</div>}
      {courses.map(c => (
        <Card key={c.id} style={{ marginBottom: 6 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: expandedCourse === c.id ? 10 : 0 }}>
            <div style={{ color: "#fff", fontFamily: "'Barlow Condensed', 'Arial Narrow', Arial, sans-serif", fontSize: 14, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.04em" }}>{c.name}</div>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <span style={{ color: "#555", fontFamily: "'Barlow Condensed', 'Arial Narrow', Arial, sans-serif", fontSize: 9, fontWeight: 700, letterSpacing: "0.1em" }}>PAR {(c.pars || []).reduce((a, b) => a + b, 0)}</span>
              <button onClick={() => setExpandedCourse(expandedCourse === c.id ? null : c.id)} style={{ background: "none", border: "none", color: "#555", cursor: "pointer", fontFamily: "'Barlow Condensed', 'Arial Narrow', Arial, sans-serif", fontSize: 9, fontWeight: 700 }}>{expandedCourse === c.id ? "UP" : "DN"}</button>
              <Btn onClick={() => deleteCourse(c.id)} color={C.danger} style={{ padding: "4px 8px", fontSize: 10 }}>x</Btn>
            </div>
          </div>
          {expandedCourse === c.id && (
            <div>
              {[HOLES.slice(0, 9), HOLES.slice(9)].map((half, hi) => (
                <div key={hi} style={{ display: "grid", gridTemplateColumns: "repeat(9,1fr)", gap: 3, marginBottom: hi === 0 ? 4 : 0 }}>
                  {half.map(h => (
                    <div key={h} style={{ textAlign: "center" }}>
                      <div style={{ color: "#2a2a2a", fontFamily: "'Barlow Condensed', 'Arial Narrow', Arial, sans-serif", fontSize: 7, fontWeight: 700, marginBottom: 2 }}>{h}</div>
                      <div style={{ height: 22, borderRadius: 3, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "'Barlow Condensed', 'Arial Narrow', Arial, sans-serif", fontSize: 12, fontWeight: 700, background: "rgba(255,255,255,0.08)", color: "#555", border: "1px solid rgba(255,255,255,0.14)" }}>{(c.pars || [])[h - 1] || 4}</div>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
        </Card>
      ))}
    </div>
  );
}

function AdminCupSetupTab({ data, onUpdate }) {
  const { players, courses } = data;
  const cy = data.currentYear;
  const [innerTab, setInnerTab] = useState("year");

  // Year / teams form state
  const [yearNum, setYearNum] = useState(cy?.year || new Date().getFullYear());
  const [teamAName, setTeamAName] = useState(cy?.teams?.find(t => t.id === "A")?.name || "Team A");
  const [teamBName, setTeamBName] = useState(cy?.teams?.find(t => t.id === "B")?.name || "Team B");
  const [teamAPlayers, setTeamAPlayers] = useState(cy?.teams?.find(t => t.id === "A")?.playerIds || []);
  const [teamBPlayers, setTeamBPlayers] = useState(cy?.teams?.find(t => t.id === "B")?.playerIds || []);

  // Session form
  const [newSession, setNewSession] = useState({ name: "", date: "", courseId: "", format: "fourball" });

  // Match form
  const [matchSetup, setMatchSetup] = useState({ sessionId: "", playerAIds: [], playerBIds: [] });

  const sessions = cy?.sessions || [];
  const matches = cy?.matches || [];
  const cyTeams = cy?.teams || [];
  const teamA = cyTeams.find(t => t.id === "A") || { id: "A", name: "Team A", playerIds: [] };
  const teamB = cyTeams.find(t => t.id === "B") || { id: "B", name: "Team B", playerIds: [] };
  const playersA = players.filter(p => teamA.playerIds?.includes(p.id));
  const playersB = players.filter(p => teamB.playerIds?.includes(p.id));

  const inp = (e = {}) => ({ background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.14)", borderRadius: 8, padding: "10px 12px", color: "#fff", fontFamily: "'Barlow', Arial, sans-serif", fontSize: 13, width: "100%", boxSizing: "border-box", outline: "none", ...e });
  const sel = (e = {}) => ({ ...inp(), appearance: "none", cursor: "pointer", ...e });
  const getPName = id => players.find(p => p.id === id)?.name || id;

  async function saveYearSetup() {
    const updated = {
      ...cy,
      year: yearNum,
      teams: [
        { id: "A", name: teamAName, playerIds: teamAPlayers },
        { id: "B", name: teamBName, playerIds: teamBPlayers },
      ],
    };
    await onUpdate({ ...data, currentYear: updated });
  }

  async function addSession() {
    if (!newSession.name.trim()) return;
    const s = { ...newSession, id: "s_" + Date.now() };
    await onUpdate({ ...data, currentYear: { ...cy, sessions: [...sessions, s] } });
    setNewSession({ name: "", date: "", courseId: "", format: "fourball" });
  }

  async function deleteSession(id) {
    await onUpdate({ ...data, currentYear: { ...cy, sessions: sessions.filter(s => s.id !== id), matches: matches.filter(m => m.sessionId !== id) } });
  }

  async function addMatch() {
    if (!matchSetup.sessionId || !matchSetup.playerAIds.length || !matchSetup.playerBIds.length) return;
    const session = sessions.find(s => s.id === matchSetup.sessionId);
    const initScores = {};
    [...matchSetup.playerAIds, ...matchSetup.playerBIds].forEach(id => { initScores[id] = Array(18).fill(null); });
    const m = { ...matchSetup, id: "m_" + Date.now(), format: session?.format || "fourball", playerScores: initScores };
    await onUpdate({ ...data, currentYear: { ...cy, matches: [...matches, m] } });
    setMatchSetup({ sessionId: matchSetup.sessionId, playerAIds: [], playerBIds: [] });
  }

  async function deleteMatch(id) {
    await onUpdate({ ...data, currentYear: { ...cy, matches: matches.filter(m => m.id !== id) } });
  }



  const [confirmComplete, setConfirmComplete] = useState(false);

  async function completeYear() {
    if (!cy) return;
    if (!confirmComplete) { setConfirmComplete(true); return; }
    setConfirmComplete(false);
    const historyEntry = { ...cy, status: "complete", id: "y_" + cy.year + "_" + Date.now() };
    const newHistory = [...(data.history || []), historyEntry];
    const nextYear = (cy.year || new Date().getFullYear()) + 1;
    const newCY = {
      id: "cy_" + nextYear, year: nextYear, status: "active",
      teams: [{ id: "A", name: "Team A", playerIds: [] }, { id: "B", name: "Team B", playerIds: [] }],
      winnerId: null, mvp: null, sessions: [], matches: [],
    };
    await onUpdate({ ...data, history: newHistory, currentYear: newCY });
  }

  const innerTabs = ["year", "sessions", "matches"];

  if (!cy) {
    return (
      <div style={{ textAlign: "center", padding: "40px 20px", color: "#555", fontFamily: "'Barlow Condensed', 'Arial Narrow', Arial, sans-serif", fontSize: 12, fontWeight: 700, letterSpacing: "0.1em" }}>
        NO ACTIVE YEAR<br />
        <Btn onClick={() => onUpdate({ ...data, currentYear: { id: "cy_" + new Date().getFullYear(), year: new Date().getFullYear(), status: "active", teams: [{ id: "A", name: "Team A", playerIds: [] }, { id: "B", name: "Team B", playerIds: [] }], winnerId: null, mvp: null, sessions: [], matches: [] } })} style={{ marginTop: 16 }}>Start New Year</Btn>
      </div>
    );
  }

  return (
    <div>
      {/* Year header + complete button */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, padding: "12px 14px", background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 12 }}>
        <div>
          <div style={{ color: "#fff", fontFamily: "'Barlow Condensed', 'Arial Narrow', Arial, sans-serif", fontSize: 22, fontWeight: 800 }}>{cy.year} CUP</div>
          <div style={{ color: "#4ade80", fontFamily: "'Barlow Condensed', 'Arial Narrow', Arial, sans-serif", fontSize: 9, fontWeight: 700, letterSpacing: "0.14em", marginTop: 2 }}>ACTIVE</div>
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <div style={{ display: "flex", gap: 6 }}>
            {confirmComplete && (
              <button onClick={() => setConfirmComplete(false)} style={{ background: "none", border: "1px solid rgba(255,255,255,0.15)", borderRadius: 8, padding: "7px 10px", color: C.grey2, fontFamily: "'Barlow Condensed', 'Arial Narrow', Arial, sans-serif", fontSize: 9, fontWeight: 700, cursor: "pointer" }}>CANCEL</button>
            )}
            <Btn onClick={completeYear} color={confirmComplete ? C.danger : C.gold} style={{ padding: "8px 12px", fontSize: 10 }}>
              {confirmComplete ? "CONFIRM →" : "COMPLETE YEAR →"}
            </Btn>
          </div>
        </div>
      </div>

      {/* Inner tabs */}
      <div style={{ display: "flex", gap: 2, marginBottom: 14, background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 10, padding: 3 }}>
        {innerTabs.map(t => (
          <button key={t} onClick={() => setInnerTab(t)} style={{ flex: 1, padding: "7px 2px", borderRadius: 7, border: "none", background: innerTab === t ? "rgba(255,255,255,0.1)" : "transparent", color: innerTab === t ? "#fff" : "#555", fontFamily: "'Barlow Condensed', 'Arial Narrow', Arial, sans-serif", fontSize: 9, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", cursor: "pointer", transition: "all 0.15s" }}>{t}</button>
        ))}
      </div>

      {/* YEAR sub-tab: team setup */}
      {innerTab === "year" && (
        <div>
          <Card style={{ marginBottom: 10 }}>
            <SectionLabel>YEAR</SectionLabel>
            <input type="number" value={yearNum} onChange={e => setYearNum(Number(e.target.value))} style={inp({ marginBottom: 10 })} />
            <SectionLabel>TEAM A</SectionLabel>
            <input value={teamAName} onChange={e => setTeamAName(e.target.value)} placeholder="Team A name" style={inp({ marginBottom: 8 })} />
            <div style={{ color: "#fff", fontFamily: "'Barlow Condensed', 'Arial Narrow', Arial, sans-serif", fontSize: 9, fontWeight: 700, letterSpacing: "0.14em", marginBottom: 6 }}>TEAM A PLAYERS</div>
            {players.map(p => (
              <label key={p.id} style={{ display: "flex", alignItems: "center", gap: 10, color: "#fff", fontFamily: "'Barlow', Arial, sans-serif", fontSize: 12, cursor: "pointer", padding: "5px 0", borderBottom: "1px solid #2a2a2a" }}>
                <input type="checkbox" checked={teamAPlayers.includes(p.id)} onChange={e => setTeamAPlayers(prev => e.target.checked ? [...prev, p.id] : prev.filter(id => id !== p.id))} />
                {p.name}
              </label>
            ))}
            <div style={{ marginTop: 14 }}>
              <SectionLabel>TEAM B</SectionLabel>
              <input value={teamBName} onChange={e => setTeamBName(e.target.value)} placeholder="Team B name" style={inp({ marginBottom: 8 })} />
              <div style={{ color: "#aaa", fontFamily: "'Barlow Condensed', 'Arial Narrow', Arial, sans-serif", fontSize: 9, fontWeight: 700, letterSpacing: "0.14em", marginBottom: 6 }}>TEAM B PLAYERS</div>
              {players.map(p => (
                <label key={p.id} style={{ display: "flex", alignItems: "center", gap: 10, color: "#fff", fontFamily: "'Barlow', Arial, sans-serif", fontSize: 12, cursor: "pointer", padding: "5px 0", borderBottom: "1px solid #2a2a2a" }}>
                  <input type="checkbox" checked={teamBPlayers.includes(p.id)} onChange={e => setTeamBPlayers(prev => e.target.checked ? [...prev, p.id] : prev.filter(id => id !== p.id))} />
                  {p.name}
                </label>
              ))}
            </div>
            <Btn onClick={saveYearSetup} style={{ width: "100%", textAlign: "center", padding: 11, marginTop: 12 }}>Save Year Setup</Btn>
          </Card>

          {/* Emergency: manually set current year number */}
          <div style={{ marginTop: 8, padding: "12px 14px", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 10, background: "rgba(255,255,255,0.02)" }}>
            <div style={{ color: C.grey3, fontFamily: "'Barlow Condensed', 'Arial Narrow', Arial, sans-serif", fontSize: 8, fontWeight: 700, letterSpacing: "0.14em", marginBottom: 6 }}>OVERRIDE YEAR NUMBER</div>
            <div style={{ display: "flex", gap: 8 }}>
              <input type="number" value={yearNum} onChange={e => setYearNum(Number(e.target.value))}
                style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 7, padding: "8px 12px", color: "#fff", fontFamily: "'Barlow', Arial, sans-serif", fontSize: 13, width: 100, outline: "none" }} />
              <button onClick={async () => { await onUpdate({ ...data, currentYear: { ...cy, year: yearNum } }); }}
                style={{ background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.14)", borderRadius: 7, padding: "8px 14px", color: C.white, fontFamily: "'Barlow Condensed', 'Arial Narrow', Arial, sans-serif", fontSize: 10, fontWeight: 700, cursor: "pointer" }}>
                SET YEAR
              </button>
            </div>
          </div>
        </div>
      )}

      {/* SESSIONS sub-tab */}
      {innerTab === "sessions" && (
        <div>
          <Card style={{ marginBottom: 10 }}>
            <SectionLabel>ADD SESSION</SectionLabel>
            <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
              <input value={newSession.name} onChange={e => setNewSession(s => ({ ...s, name: e.target.value }))} placeholder="Session name" style={inp()} />
              <input value={newSession.date} onChange={e => setNewSession(s => ({ ...s, date: e.target.value }))} type="date" style={inp()} />
              <select value={newSession.courseId} onChange={e => setNewSession(s => ({ ...s, courseId: e.target.value }))} style={sel()}>
                <option value="">Select course (optional)...</option>
                {courses.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              <select value={newSession.format} onChange={e => setNewSession(s => ({ ...s, format: e.target.value }))} style={sel()}>
                <option value="fourball">Best Ball</option>
                <option value="foursomes">Alternate Shot</option>
                <option value="scramble">Scramble</option>
                <option value="singles">Singles</option>
              </select>
              <Btn onClick={addSession} style={{ width: "100%", textAlign: "center", padding: 11 }}>+ Add Session</Btn>
            </div>
          </Card>
          {sessions.map(s => {
            const course = courses.find(c => c.id === s.courseId);
            return (
              <Card key={s.id} style={{ marginBottom: 6 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ color: "#fff", fontFamily: "'Barlow Condensed', 'Arial Narrow', Arial, sans-serif", fontSize: 13, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 4 }}>{s.name}</div>
                    <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginBottom: 8 }}>
                      <Tag>{FORMAT_LABELS[s.format]}</Tag>
                      {course && <Tag color={C.grey2}>{course.name}</Tag>}
                      {s.date && <Tag color={C.grey3}>{s.date}</Tag>}
                    </div>
                    <div style={{ display: "flex", gap: 5 }}>
                      {["scheduled","active","completed"].map(status => {
                        const isCur = (s.status||"scheduled") === status;
                        const col = status==="active"?C.white:status==="completed"?"#6FCF8A":C.grey2;
                        return (
                          <button key={status} onClick={async e => {
                            e.stopPropagation();
                            const updated = sessions.map(sess => ({
                              ...sess,
                              status: sess.id===s.id ? status : (status==="active"&&(sess.status||"scheduled")==="active" ? "completed" : sess.status||"scheduled")
                            }));
                            await onUpdate({...data, currentYear:{...cy, sessions:updated}});
                          }} style={{
                            background: isCur?"rgba(255,255,255,0.12)":"rgba(255,255,255,0.04)",
                            border:`1px solid ${isCur?"rgba(255,255,255,0.3)":"rgba(255,255,255,0.1)"}`,
                            borderRadius:6, padding:"4px 8px", cursor:"pointer", color:isCur?col:C.grey3,
                            fontFamily:"'Barlow Condensed','Arial Narrow',Arial,sans-serif",
                            fontSize:9, fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase",
                          }}>
                            {status==="active"?"● LIVE":status==="completed"?"✓ DONE":"SCHEDULED"}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                  <Btn onClick={() => deleteSession(s.id)} color={C.danger} style={{ padding: "6px 9px", fontSize: 11, marginLeft: 8 }}>x</Btn>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {/* MATCHES sub-tab */}
      {innerTab === "matches" && (
        <div>
          <Card style={{ marginBottom: 10 }}>
            <SectionLabel>ADD MATCH</SectionLabel>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <select value={matchSetup.sessionId} onChange={e => setMatchSetup(m => ({ ...m, sessionId: e.target.value, playerAIds: [], playerBIds: [] }))} style={sel()}>
                <option value="">Select session...</option>
                {sessions.map(s => <option key={s.id} value={s.id}>{s.name} — {FORMAT_LABELS[s.format]}</option>)}
              </select>
              {matchSetup.sessionId && (() => {
                const session = sessions.find(s => s.id === matchSetup.sessionId);
                return (
                  <>
                    <div style={{ color: "#2a2a2a", fontFamily: "'Barlow Condensed', 'Arial Narrow', Arial, sans-serif", fontSize: 9, fontWeight: 700, letterSpacing: "0.12em" }}>FORMAT: {FORMAT_LABELS[session?.format]} (from session)</div>
                    <div>
                      <div style={{ color: "#fff", fontFamily: "'Barlow Condensed', 'Arial Narrow', Arial, sans-serif", fontSize: 9, fontWeight: 700, letterSpacing: "0.14em", marginBottom: 6, textTransform: "uppercase" }}>{teamA?.name || "Team A"}</div>
                      {playersA.map(p => (
                        <label key={p.id} style={{ display: "flex", alignItems: "center", gap: 10, color: "#fff", fontFamily: "'Barlow', Arial, sans-serif", fontSize: 12, cursor: "pointer", padding: "5px 0", borderBottom: "1px solid #2a2a2a" }}>
                          <input type="checkbox" checked={matchSetup.playerAIds.includes(p.id)} onChange={e => setMatchSetup(m => ({ ...m, playerAIds: e.target.checked ? [...m.playerAIds, p.id] : m.playerAIds.filter(id => id !== p.id) }))} />
                          {p.name}
                        </label>
                      ))}
                    </div>
                    <div>
                      <div style={{ color: "#aaa", fontFamily: "'Barlow Condensed', 'Arial Narrow', Arial, sans-serif", fontSize: 9, fontWeight: 700, letterSpacing: "0.14em", marginBottom: 6, textTransform: "uppercase", marginTop: 4 }}>{teamB?.name || "Team B"}</div>
                      {playersB.map(p => (
                        <label key={p.id} style={{ display: "flex", alignItems: "center", gap: 10, color: "#fff", fontFamily: "'Barlow', Arial, sans-serif", fontSize: 12, cursor: "pointer", padding: "5px 0", borderBottom: "1px solid #2a2a2a" }}>
                          <input type="checkbox" checked={matchSetup.playerBIds.includes(p.id)} onChange={e => setMatchSetup(m => ({ ...m, playerBIds: e.target.checked ? [...m.playerBIds, p.id] : m.playerBIds.filter(id => id !== p.id) }))} />
                          {p.name}
                        </label>
                      ))}
                    </div>
                  </>
                );
              })()}
              <Btn onClick={addMatch} disabled={!matchSetup.sessionId || !matchSetup.playerAIds.length || !matchSetup.playerBIds.length} style={{ width: "100%", textAlign: "center", padding: 11 }}>+ Add Match</Btn>
            </div>
          </Card>
          {sessions.map(s => {
            const sMatches = matches.filter(m => m.sessionId === s.id);
            if (!sMatches.length) return null;
            return (
              <div key={s.id} style={{ marginBottom: 14 }}>
                <div style={{ color: "#2a2a2a", fontFamily: "'Barlow Condensed', 'Arial Narrow', Arial, sans-serif", fontSize: 8, fontWeight: 700, letterSpacing: "0.16em", marginBottom: 6, textTransform: "uppercase" }}>{s.name}</div>
                {sMatches.map(m => (
                  <Card key={m.id} style={{ marginBottom: 5, padding: "11px 14px" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <div>
                        <div style={{ color: "#fff", fontFamily: "'Barlow Condensed', 'Arial Narrow', Arial, sans-serif", fontSize: 11, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.04em" }}>{(m.playerAIds || []).map(getPName).join(" / ")}</div>
                        <div style={{ color: "#aaa", fontFamily: "'Barlow Condensed', 'Arial Narrow', Arial, sans-serif", fontSize: 11, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.04em" }}>{(m.playerBIds || []).map(getPName).join(" / ")}</div>
                      </div>
                      <Btn onClick={() => deleteMatch(m.id)} color={C.danger} style={{ padding: "5px 9px", fontSize: 10 }}>x</Btn>
                    </div>
                  </Card>
                ))}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}


function AdminPage({ data, onUpdate, adminUnlocked, setAdminUnlocked, onExport, onImport }) {
  const [pin, setPin] = useState("");
  const [pinError, setPinError] = useState(false);
  const [tab, setTab] = useState("setup");

  const { players, courses } = data;
  const cy = data.currentYear;
  const history = data.history || [];
  const getPName = id => players.find(p => p.id === id)?.name || id;

  function tryPin() { if (pin === ADMIN_PIN) { setAdminUnlocked(true); setPinError(false); } else { setPinError(true); setPin(""); } }

  const inp = (e = {}) => ({ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, padding: "10px 12px", color: C.white, ...BM, fontSize: 13, width: "100%", boxSizing: "border-box", outline: "none", ...e });

  if (!adminUnlocked) {
    return (
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", padding: "80px 16px" }}>
        <div style={{ color: C.white, ...BC, fontSize: 28, fontWeight: 800, letterSpacing: "0.08em", marginBottom: 6, textTransform: "uppercase" }}>Admin</div>
        <div style={{ color: C.grey2, ...BC, fontSize: 9, fontWeight: 700, letterSpacing: "0.2em", marginBottom: 32 }}>ENTER PIN TO CONTINUE</div>
        <input type="password" inputMode="numeric" maxLength={4} value={pin} onChange={e => setPin(e.target.value)} onKeyDown={e => e.key === "Enter" && tryPin()} placeholder="••••"
          style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: 14, color: C.white, textAlign: "center", fontSize: 28, letterSpacing: "0.5em", width: 160, outline: "none", marginBottom: 10, boxSizing: "border-box" }} />
        {pinError && <div style={{ color: C.danger, ...BC, fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", marginBottom: 8 }}>INCORRECT PIN</div>}
        <Btn onClick={tryPin} style={{ width: 160, textAlign: "center", padding: "11px 0" }}>UNLOCK</Btn>
        <div style={{ color: C.grey3, ...BC, fontSize: 9, fontWeight: 600, letterSpacing: "0.1em", marginTop: 20 }}>DEFAULT PIN: 1234</div>
      </div>
    );
  }

  const TABS = ["players", "courses", "setup", "history", "teams"];
  return (
    <div style={{ padding: "24px 16px 120px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}>
        <div style={{ color: C.white, ...BC, fontSize: 26, fontWeight: 800, letterSpacing: "0.06em", textTransform: "uppercase" }}>Admin</div>
        <div style={{ display: "flex", gap: 6 }}>
          <button onClick={onExport} style={{ background: "rgba(255,255,255,0.07)", border: "1px solid rgba(255,255,255,0.14)", borderRadius: 7, padding: "6px 10px", color: C.grey1, fontFamily: "'Barlow Condensed', 'Arial Narrow', Arial, sans-serif", fontSize: 9, fontWeight: 700, letterSpacing: "0.08em", cursor: "pointer" }}>
            EXPORT
          </button>
          <label style={{ cursor: "pointer" }}>
            <input type="file" accept=".json" style={{ display: "none" }} onChange={e => e.target.files[0] && onImport(e.target.files[0])} />
            <div style={{ background: "rgba(255,255,255,0.07)", border: "1px solid rgba(255,255,255,0.14)", borderRadius: 7, padding: "6px 10px", color: C.grey1, fontFamily: "'Barlow Condensed', 'Arial Narrow', Arial, sans-serif", fontSize: 9, fontWeight: 700, letterSpacing: "0.08em", cursor: "pointer" }}>
              IMPORT
            </div>
          </label>
        </div>
      </div>
      <div style={{ display: "flex", gap: 2, marginBottom: 18, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: 3 }}>
        {TABS.map(t => (
          <button key={t} onClick={() => setTab(t)} style={{
            flex: 1, padding: "8px 2px", borderRadius: 7, border: "none",
            background: tab === t ? "rgba(255,255,255,0.1)" : "transparent",
            color: tab === t ? C.white : C.grey2,
            ...BC, fontSize: 9, fontWeight: 700, letterSpacing: "0.09em", textTransform: "uppercase", cursor: "pointer", transition: "all 0.15s",
          }}>{t === "setup" ? "CUP SETUP" : t}</button>
        ))}
      </div>

      {tab === "players" && <AdminPlayersTab data={data} onUpdate={onUpdate} />}
      {tab === "courses" && <AdminCoursesTab data={data} onUpdate={onUpdate} />}
      {tab === "setup"   && <AdminCupSetupTab data={data} onUpdate={onUpdate} />}
      {tab === "history" && <AdminHistoryTab data={data} onUpdate={onUpdate} />}
      {tab === "teams" && <TeamBuilderTab data={data} />}
    </div>
  );
}

// ── Root ──────────────────────────────────────────────────────────────────────

// ── Records: stat helpers ─────────────────────────────────────────────────────

function computeHistoryStats(data) {
  const history = data.history || [];
  const players = data.players || [];
  // Build per-player stats across all history
  const stats = {};
  players.forEach(p => {
    stats[p.id] = { id: p.id, name: p.name, W: 0, L: 0, D: 0, PF: 0, PA: 0, cups: 0, years: [] };
  });

  history.forEach(year => {
    // Track who won the cup this year
    const winnerId = year.winnerId; // team id within year
    const yearPlayers = new Set();

    (year.sessions || []).forEach(session => {
      (session.matches || []).forEach(match => {
        const aIds = match.playerAIds || [];
        const bIds = match.playerBIds || [];
        aIds.forEach(id => yearPlayers.add(id));
        bIds.forEach(id => yearPlayers.add(id));

        // Determine match result
        const res = match.result; // "A" | "B" | "half"
        const pts = res === "A" ? 1 : res === "B" ? 1 : 0.5;

        aIds.forEach(id => {
          if (!stats[id]) return;
          if (res === "A")      { stats[id].W++; stats[id].PF += 1; stats[id].PA += 0; }
          else if (res === "B") { stats[id].L++; stats[id].PF += 0; stats[id].PA += 1; }
          else                  { stats[id].D++; stats[id].PF += 0.5; stats[id].PA += 0.5; }
        });
        bIds.forEach(id => {
          if (!stats[id]) return;
          if (res === "B")      { stats[id].W++; stats[id].PF += 1; stats[id].PA += 0; }
          else if (res === "A") { stats[id].L++; stats[id].PF += 0; stats[id].PA += 1; }
          else                  { stats[id].D++; stats[id].PF += 0.5; stats[id].PA += 0.5; }
        });
      });
    });

    // Cup titles — players on the winning team
    if (winnerId) {
      const winningTeam = (year.teams || []).find(t => t.id === winnerId);
      if (winningTeam) {
        (winningTeam.playerIds || []).forEach(id => {
          if (stats[id]) stats[id].cups++;
        });
      }
    }

    // Track year participation
    yearPlayers.forEach(id => {
      if (stats[id] && !stats[id].years.includes(year.year)) stats[id].years.push(year.year);
    });
  });

  return Object.values(stats).filter(s => s.W + s.L + s.D > 0 || s.cups > 0);
}

function plusMinus(s) { return s.W - s.L; }
function winPct(s) {
  const total = s.W + s.L + s.D;
  return total > 0 ? Math.round((s.W / total) * 100) : 0;
}

// ── Records Page ──────────────────────────────────────────────────────────────

// ── Head to Head ──────────────────────────────────────────────────────────────
function HeadToHead({ players, data }) {
  const [playerA, setPlayerA] = useState("");
  const [playerB, setPlayerB] = useState("");
  const [expandedMatch, setExpandedMatch] = useState(null);
  const history = data.history || [];

  function computeH2H(idA, idB) {
    let W = 0, L = 0, D = 0;
    const matchups = [];
    history.forEach(year => {
      (year.sessions || []).forEach(session => {
        (session.matches || []).forEach(match => {
          const aOnA = (match.playerAIds || []).includes(idA);
          const aOnB = (match.playerBIds || []).includes(idA);
          const bOnA = (match.playerAIds || []).includes(idB);
          const bOnB = (match.playerBIds || []).includes(idB);
          const opposed = (aOnA && bOnB) || (aOnB && bOnA);
          if (!opposed) return;
          const aWins = (aOnA && match.result === "A") || (aOnB && match.result === "B");
          const bWins = (aOnA && match.result === "B") || (aOnB && match.result === "A");
          if (aWins) W++;
          else if (bWins) L++;
          else D++;
          // Collect partners — everyone else on each side
          const aPartners = (aOnA ? match.playerAIds : match.playerBIds).filter(id => id !== idA);
          const bPartners = (bOnA ? match.playerAIds : match.playerBIds).filter(id => id !== idB);
          matchups.push({
            year: year.year,
            session: session.name,
            course: session.course || "",
            result: aWins ? "W" : bWins ? "L" : "D",
            resultLabel: match.resultLabel || "",
            format: match.format,
            aPartners,
            bPartners,
          });
        });
      });
    });
    return { W, L, D, matchups };
  }

  const nameA = players.find(p => p.id === playerA)?.name || "";
  const nameB = players.find(p => p.id === playerB)?.name || "";
  const h2h = playerA && playerB && playerA !== playerB ? computeH2H(playerA, playerB) : null;
  const total = h2h ? h2h.W + h2h.L + h2h.D : 0;
  const pmColor = h2h ? (h2h.W > h2h.L ? "#6FCF8A" : h2h.L > h2h.W ? C.double : C.grey2) : C.grey2;

  const sel = (e = {}) => ({ background: C.surface, border: "1px solid " + C.border, borderRadius: 8, padding: "10px 12px", color: C.white, fontFamily: "'Barlow', Arial, sans-serif", fontSize: 13, width: "100%", boxSizing: "border-box", outline: "none", appearance: "none", ...e });

  return (
    <div style={{ padding: "20px 16px 80px" }}>
      <div style={{ color: C.grey2, ...BC, fontSize: 9, fontWeight: 700, letterSpacing: "0.2em", marginBottom: 14 }}>SELECT TWO PLAYERS</div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 20 }}>
        <div>
          <div style={{ color: C.white, ...BC, fontSize: 8, fontWeight: 700, letterSpacing: "0.14em", marginBottom: 6 }}>PLAYER A</div>
          <select value={playerA} onChange={e => setPlayerA(e.target.value)} style={sel()}>
            <option value="">Select...</option>
            {players.filter(p => p.id !== playerB).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
        <div>
          <div style={{ color: C.grey1, ...BC, fontSize: 8, fontWeight: 700, letterSpacing: "0.14em", marginBottom: 6 }}>PLAYER B</div>
          <select value={playerB} onChange={e => setPlayerB(e.target.value)} style={sel()}>
            <option value="">Select...</option>
            {players.filter(p => p.id !== playerA).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
      </div>

      {h2h && total === 0 && (
        <div style={{ textAlign: "center", padding: "40px 20px", color: C.grey3, ...BC, fontSize: 11, fontWeight: 700, letterSpacing: "0.1em" }}>
          NO HEAD-TO-HEAD MATCHES FOUND
        </div>
      )}

      {h2h && total > 0 && (
        <div>
          {/* Summary banner */}
          <div style={{ ...surf(), borderRadius: 14, padding: "18px 16px", marginBottom: 16, textAlign: "center" }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr auto 1fr", alignItems: "center", gap: 8, marginBottom: 14 }}>
              <div>
                <div style={{ color: C.white, ...BC, fontSize: 13, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 6 }}>{nameA.split(" ")[0]}</div>
                <div style={{ color: pmColor, ...BC, fontSize: 48, fontWeight: 800, lineHeight: 1 }}>{h2h.W}</div>
                <div style={{ color: C.grey2, ...BC, fontSize: 8, fontWeight: 700, letterSpacing: "0.14em", marginTop: 4 }}>WINS</div>
              </div>
              <div style={{ color: C.grey3, ...BC, fontSize: 14, fontWeight: 700 }}>VS</div>
              <div>
                <div style={{ color: C.grey1, ...BC, fontSize: 13, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 6 }}>{nameB.split(" ")[0]}</div>
                <div style={{ color: h2h.L > h2h.W ? "#6FCF8A" : h2h.W > h2h.L ? C.double : C.grey2, ...BC, fontSize: 48, fontWeight: 800, lineHeight: 1 }}>{h2h.L}</div>
                <div style={{ color: C.grey2, ...BC, fontSize: 8, fontWeight: 700, letterSpacing: "0.14em", marginTop: 4 }}>WINS</div>
              </div>
            </div>
            <div style={{ display: "flex", justifyContent: "center", gap: 16 }}>
              <div style={{ textAlign: "center" }}>
                <div style={{ color: C.grey2, ...BC, fontSize: 20, fontWeight: 800 }}>{h2h.D}</div>
                <div style={{ color: C.grey3, ...BC, fontSize: 8, fontWeight: 700, letterSpacing: "0.12em" }}>HALVED</div>
              </div>
              <div style={{ textAlign: "center" }}>
                <div style={{ color: C.grey2, ...BC, fontSize: 20, fontWeight: 800 }}>{total}</div>
                <div style={{ color: C.grey3, ...BC, fontSize: 8, fontWeight: 700, letterSpacing: "0.12em" }}>TOTAL</div>
              </div>
            </div>
          </div>

          {/* Match log */}
          <div style={{ color: C.grey2, ...BC, fontSize: 9, fontWeight: 700, letterSpacing: "0.2em", marginBottom: 10 }}>MATCH LOG</div>
          <div style={{ ...surf(), borderRadius: 12, overflow: "hidden" }}>
            {h2h.matchups.map((m, i) => {
              const resColor = m.result === "W" ? "#6FCF8A" : m.result === "L" ? C.double : C.gold;
              const resLabel = m.result === "W" ? nameA.split(" ")[0] + " wins" : m.result === "L" ? nameB.split(" ")[0] + " wins" : "Halved";
              const aPartnerNames = m.aPartners.map(id => shortName(players.find(p => p.id === id)?.name || id));
              const bPartnerNames = m.bPartners.map(id => shortName(players.find(p => p.id === id)?.name || id));
              const hasPartners = aPartnerNames.length > 0 || bPartnerNames.length > 0;
              return (
                <div key={i} style={{ borderBottom: i < h2h.matchups.length - 1 ? "1px solid " + C.grey3 : "none", background: i % 2 === 0 ? "transparent" : "rgba(255,255,255,0.02)" }}>
                  <button onClick={() => setExpandedMatch(expandedMatch === i ? null : i)} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 14px", width: "100%", background: "none", border: "none", cursor: "pointer", textAlign: "left" }}>
                    <div>
                      <div style={{ color: C.white, ...BC, fontSize: 13, fontWeight: 700 }}>{m.year} · {FORMAT_LABELS[m.format] || m.format}</div>
                      <div style={{ color: C.grey2, ...BC, fontSize: 9, fontWeight: 600, marginTop: 1 }}>
                        {m.session}{m.course ? " · " + m.course : ""}
                      </div>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      {m.resultLabel && <div style={{ color: C.grey2, ...BC, fontSize: 10, fontWeight: 700 }}>{m.resultLabel}</div>}
                      <div style={{ color: resColor, ...BC, fontSize: 11, fontWeight: 800, letterSpacing: "0.06em" }}>{resLabel}</div>
                      {hasPartners && <div style={{ color: C.grey3, fontSize: 10 }}>{expandedMatch === i ? "▲" : "▼"}</div>}
                    </div>
                  </button>
                  {expandedMatch === i && hasPartners && (
                    <div style={{ padding: "0 14px 10px", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                      <div style={{ background: "rgba(255,255,255,0.04)", borderRadius: 8, padding: "8px 10px" }}>
                        <div style={{ color: C.grey2, ...BC, fontSize: 7, fontWeight: 700, letterSpacing: "0.14em", marginBottom: 4 }}>{nameA.split(" ")[0].toUpperCase()}'S SIDE</div>
                        <div style={{ color: C.white, fontFamily: "'Barlow', Arial, sans-serif", fontSize: 11 }}>{nameA.split(" ")[0]}</div>
                        {aPartnerNames.map((n, j) => <div key={j} style={{ color: C.grey1, fontFamily: "'Barlow', Arial, sans-serif", fontSize: 11 }}>{n}</div>)}
                      </div>
                      <div style={{ background: "rgba(255,255,255,0.04)", borderRadius: 8, padding: "8px 10px" }}>
                        <div style={{ color: C.grey2, ...BC, fontSize: 7, fontWeight: 700, letterSpacing: "0.14em", marginBottom: 4 }}>{nameB.split(" ")[0].toUpperCase()}'S SIDE</div>
                        <div style={{ color: C.white, fontFamily: "'Barlow', Arial, sans-serif", fontSize: 11 }}>{nameB.split(" ")[0]}</div>
                        {bPartnerNames.map((n, j) => <div key={j} style={{ color: C.grey1, fontFamily: "'Barlow', Arial, sans-serif", fontSize: 11 }}>{n}</div>)}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function RecordsPage({ data }) {
  const [tab, setTab] = useState("players");
  const [selectedPlayer, setSelectedPlayer] = useState(null);
  const history = data.history || [];
  const players = data.players || [];
  const stats = computeHistoryStats(data);
  stats.sort((a, b) => plusMinus(b) - plusMinus(a));

  if (selectedPlayer) {
    return <PlayerProfile player={selectedPlayer} data={data} stats={stats.find(s => s.id === selectedPlayer.id)} onBack={() => setSelectedPlayer(null)} />;
  }

  return (
    <div style={{ paddingBottom: 100 }}>
      {/* Header */}
      <div style={{ textAlign: "center", padding: "28px 0 20px", borderBottom: "1px solid " + C.border }}>
        <div style={{ color: C.white, ...BC, fontSize: 28, fontWeight: 800, letterSpacing: "0.08em" }}>RECORDS</div>
        <div style={{ color: C.grey2, ...BC, fontSize: 9, fontWeight: 700, letterSpacing: "0.28em", marginTop: 4 }}>BEEHIVE CUP HISTORY</div>
      </div>

      {/* Sub tabs */}
      <div style={{ display: "flex", borderBottom: "1px solid " + C.border }}>
        {[["players","PLAYERS"],["h2h","H2H"],["history","HISTORY"]].map(([id,label]) => (
          <button key={id} onClick={() => setTab(id)} style={{
            flex: 1, padding: "12px 0", background: "transparent", border: "none",
            borderBottom: tab === id ? "2px solid " + C.white : "2px solid transparent",
            color: tab === id ? C.white : C.grey2,
            ...BC, fontSize: 10, fontWeight: 700, letterSpacing: "0.14em", textTransform: "uppercase", cursor: "pointer",
          }}>{label}</button>
        ))}
      </div>

      {tab === "players" && <PlayersTab stats={stats} players={players} onSelect={p => setSelectedPlayer(p)} data={data} />}
      {tab === "history" && <HistoryTab history={history} data={data} />}
      {tab === "h2h" && <HeadToHead players={players} data={data} />}
    </div>
  );
}

// ── Players Tab ───────────────────────────────────────────────────────────────
function PlayersTab({ stats, players, onSelect, data }) {
  if (stats.length === 0) {
    return (
      <div style={{ textAlign: "center", padding: "48px 20px", color: C.grey2, ...BC, fontSize: 11, fontWeight: 700, letterSpacing: "0.1em" }}>
        NO HISTORICAL DATA YET<br />
        <span style={{ color: C.grey3, fontSize: 9, display: "block", marginTop: 6 }}>ADD PAST YEARS IN ADMIN TO SEE STATS</span>
      </div>
    );
  }

  const col = { color: C.grey2, ...BC, fontSize: 8, fontWeight: 700, letterSpacing: "0.1em", textAlign: "center", padding: "6px 4px" };
  const cell = (val, color) => ({ color: color || C.white, ...BC, fontSize: 12, fontWeight: 700, textAlign: "center", padding: "8px 4px" });

  return (
    <div style={{ padding: "0 0 16px" }}>
      {/* Table header */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 28px 28px 28px 40px 32px 32px", padding: "0 12px", background: "rgba(255,255,255,0.03)", borderBottom: "1px solid " + C.grey3, gap: 2 }}>
        <div style={{ ...col, textAlign: "left" }}>PLAYER</div>
        <div style={col}>W</div>
        <div style={col}>L</div>
        <div style={col}>D</div>
        <div style={col}>+/-</div>
        <div style={col}>PF</div>
        <div style={col}>PA</div>
      </div>
      {stats.map((s, i) => {
        const pm = plusMinus(s);
        const pmColor = pm > 0 ? "#6FCF8A" : pm < 0 ? C.double : C.grey2;
        const player = data.players.find(p => p.id === s.id);
        return (
          <button key={s.id} onClick={() => player && onSelect(player)} style={{
            display: "grid", gridTemplateColumns: "1fr 28px 28px 28px 40px 32px 32px",
            width: "100%", padding: "0 12px", background: i % 2 === 0 ? "transparent" : "rgba(255,255,255,0.02)",
            border: "none", borderBottom: "1px solid " + C.grey3, cursor: "pointer", gap: 2, alignItems: "center",
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 0" }}>
              <PlayerAvatar player={data.players.find(p => p.id === s.id) || { name: s.name }} size={32} fontSize={11} />
              <div style={{ textAlign: "left" }}>
                <div style={{ color: C.white, ...BC, fontSize: 13, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.03em" }}>{s.name}</div>
                {s.cups > 0 && <div style={{ color: C.gold, ...BC, fontSize: 8, fontWeight: 700, letterSpacing: "0.1em", marginTop: 1 }}>{"CUP x" + s.cups}</div>}
              </div>
            </div>
            <div style={cell(s.W, C.white)}>{s.W}</div>
            <div style={cell(s.L, C.grey2)}>{s.L}</div>
            <div style={cell(s.D, C.grey2)}>{s.D}</div>
            <div style={cell(pm > 0 ? "+" + pm : pm, pmColor)}>{pm > 0 ? "+" + pm : pm}</div>
            <div style={cell(s.PF % 1 ? s.PF.toFixed(1) : s.PF, C.grey1)}>{s.PF % 1 ? s.PF.toFixed(1) : s.PF}</div>
            <div style={cell(s.PA % 1 ? s.PA.toFixed(1) : s.PA, C.grey2)}>{s.PA % 1 ? s.PA.toFixed(1) : s.PA}</div>
          </button>
        );
      })}
    </div>
  );
}

// ── Player Profile ────────────────────────────────────────────────────────────
function PlayerProfile({ player, data, stats, onBack }) {
  const history = data.history || [];
  const s = stats;
  if (!s) return <div style={{ padding: 16 }}><button onClick={onBack} style={{ background: "none", border: "none", color: C.grey2, ...BC, fontSize: 10, fontWeight: 700, cursor: "pointer" }}>← BACK</button></div>;

  const pm = plusMinus(s);
  const total = s.W + s.L + s.D;
  const pmColor = pm > 0 ? "#6FCF8A" : pm < 0 ? C.double : C.grey2;

  // Year-by-year breakdown
  const yearStats = history.map(year => {
    let W = 0, L = 0, D = 0, PF = 0, PA = 0;
    let played = false;
    (year.sessions || []).forEach(session => {
      (session.matches || []).forEach(match => {
        const onA = (match.playerAIds || []).includes(player.id);
        const onB = (match.playerBIds || []).includes(player.id);
        if (!onA && !onB) return;
        played = true;
        const res = match.result;
        const isWin = (onA && res === "A") || (onB && res === "B");
        const isLoss = (onA && res === "B") || (onB && res === "A");
        if (isWin) { W++; PF++; }
        else if (isLoss) { L++; PA++; }
        else { D++; PF += 0.5; PA += 0.5; }
      });
    });
    if (!played) return null;
    // Did they win the cup?
    const winningTeam = (year.teams || []).find(t => t.id === year.winnerId);
    const wonCup = winningTeam && (winningTeam.playerIds || []).includes(player.id);
    return { year: year.year, W, L, D, PF, PA, wonCup };
  }).filter(Boolean);

  return (
    <div style={{ padding: "16px 16px 100px" }}>
      <button onClick={onBack} style={{ background: "none", border: "none", color: C.grey2, ...BC, fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", cursor: "pointer", marginBottom: 16, padding: 0 }}>← BACK</button>

      {/* Player header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 20 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <PlayerAvatar player={player} size={64} fontSize={22} />
          <div>
            <div style={{ color: C.white, ...BC, fontSize: 26, fontWeight: 800, letterSpacing: "0.06em", textTransform: "uppercase" }}>{player.name}</div>
            <div style={{ color: C.grey2, ...BC, fontSize: 9, fontWeight: 700, letterSpacing: "0.2em", marginTop: 2 }}>
              APPEARANCES: {s.years.length}
            </div>
          </div>
        </div>
        <div style={{ textAlign: "right", display: "flex", flexDirection: "column", gap: 6, alignItems: "flex-end" }}>
          {s.cups > 0 && (
            <div style={{ background: "rgba(212,175,106,0.12)", border: "1px solid rgba(212,175,106,0.4)", borderRadius: 8, padding: "6px 10px", textAlign: "center" }}>
              <div style={{ color: C.gold, ...BC, fontSize: 8, fontWeight: 700, letterSpacing: "0.14em" }}>CUP WINNER</div>
              <div style={{ color: C.gold, ...BC, fontSize: 20, fontWeight: 800, lineHeight: 1.2 }}>{s.cups}x</div>
            </div>
          )}
          {(() => {
            const mvpYears = (data.history || []).filter(y => y.mvp === player.id).map(y => y.year);
            if (!mvpYears.length) return null;
            return (
              <div style={{ background: "linear-gradient(135deg, rgba(212,175,106,0.18), rgba(212,175,106,0.06))", border: "1px solid rgba(212,175,106,0.45)", borderRadius: 10, padding: "8px 12px", textAlign: "center", minWidth: 72 }}>
                {/* Trophy SVG */}
                <svg width="28" height="28" viewBox="0 0 28 28" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ display: "block", margin: "0 auto 4px" }}>
                  {/* Cup body */}
                  <path d="M8 4h12v9a6 6 0 01-12 0V4z" fill="rgba(212,175,106,0.25)" stroke="#D4AF6A" strokeWidth="1.5" strokeLinejoin="round"/>
                  {/* Left handle */}
                  <path d="M8 6.5H5.5a2.5 2.5 0 000 5H8" stroke="#D4AF6A" strokeWidth="1.5" strokeLinecap="round"/>
                  {/* Right handle */}
                  <path d="M20 6.5h2.5a2.5 2.5 0 010 5H20" stroke="#D4AF6A" strokeWidth="1.5" strokeLinecap="round"/>
                  {/* Stem */}
                  <path d="M14 19v4" stroke="#D4AF6A" strokeWidth="1.5" strokeLinecap="round"/>
                  {/* Base */}
                  <path d="M10 23h8" stroke="#D4AF6A" strokeWidth="1.5" strokeLinecap="round"/>
                  {/* Star inside cup */}
                  <path d="M14 8l.7 2h2.1l-1.7 1.2.6 2L14 12l-1.7 1.2.6-2L11.2 10h2.1z" fill="#D4AF6A"/>
                </svg>
                <div style={{ color: C.gold, ...BC, fontSize: 8, fontWeight: 800, letterSpacing: "0.18em" }}>MVP</div>
                <div style={{ color: C.gold, ...BC, fontSize: 10, fontWeight: 700, marginTop: 2, letterSpacing: "0.04em" }}>{mvpYears.join(", ")}</div>
              </div>
            );
          })()}
        </div>
      </div>

      {/* All-time stat boxes */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 6, marginBottom: 20 }}>
        {[
          { label: "W", val: s.W, color: C.white },
          { label: "L", val: s.L, color: C.grey2 },
          { label: "D", val: s.D, color: C.grey2 },
          { label: "+/-", val: pm > 0 ? "+" + pm : pm, color: pmColor },
        ].map(({ label, val, color }) => (
          <div key={label} style={{ ...surf(), borderRadius: 10, padding: "12px 6px", textAlign: "center" }}>
            <div style={{ color: C.grey2, ...BC, fontSize: 8, fontWeight: 700, letterSpacing: "0.16em", marginBottom: 4 }}>{label}</div>
            <div style={{ color, ...BC, fontSize: 24, fontWeight: 800, lineHeight: 1 }}>{val}</div>
          </div>
        ))}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6, marginBottom: 24 }}>
        {[
          { label: "WIN %", val: winPct(s) + "%" },
          { label: "PF", val: s.PF % 1 ? s.PF.toFixed(1) : s.PF },
          { label: "PA", val: s.PA % 1 ? s.PA.toFixed(1) : s.PA },
        ].map(({ label, val }) => (
          <div key={label} style={{ ...surf(), borderRadius: 10, padding: "12px 6px", textAlign: "center" }}>
            <div style={{ color: C.grey2, ...BC, fontSize: 8, fontWeight: 700, letterSpacing: "0.16em", marginBottom: 4 }}>{label}</div>
            <div style={{ color: C.white, ...BC, fontSize: 20, fontWeight: 800, lineHeight: 1 }}>{val}</div>
          </div>
        ))}
      </div>

      {/* Year by year */}
      {yearStats.length > 0 && (
        <div>
          <div style={{ color: C.grey2, ...BC, fontSize: 9, fontWeight: 700, letterSpacing: "0.2em", marginBottom: 10 }}>YEAR BY YEAR</div>
          <div style={{ ...surf(), borderRadius: 12, overflow: "hidden" }}>
            {/* Header */}
            <div style={{ display: "grid", gridTemplateColumns: "56px 1fr 1fr 1fr 48px 36px 36px", background: "rgba(0,0,0,0.3)", padding: "6px 12px", gap: 4 }}>
              {["YEAR","W","L","D","+/-","PF","PA"].map(h => (
                <div key={h} style={{ color: C.grey2, ...BC, fontSize: 8, fontWeight: 700, letterSpacing: "0.1em", textAlign: "center" }}>{h}</div>
              ))}
            </div>
            {yearStats.map((y, i) => {
              const ypm = y.W - y.L;
              const ypmColor = ypm > 0 ? "#6FCF8A" : ypm < 0 ? C.double : C.grey2;
              return (
                <div key={y.year} style={{ display: "grid", gridTemplateColumns: "56px 1fr 1fr 1fr 48px 36px 36px", padding: "9px 12px", gap: 4, borderTop: "1px solid " + C.grey3, background: i % 2 === 0 ? "transparent" : "rgba(255,255,255,0.02)", alignItems: "center" }}>
                  <div style={{ color: y.wonCup ? C.gold : C.grey1, ...BC, fontSize: 12, fontWeight: 800, textAlign: "center" }}>
                    {y.year}{y.wonCup ? " ★" : ""}
                  </div>
                  <div style={{ color: C.white, ...BC, fontSize: 12, fontWeight: 700, textAlign: "center" }}>{y.W}</div>
                  <div style={{ color: C.grey2, ...BC, fontSize: 12, fontWeight: 700, textAlign: "center" }}>{y.L}</div>
                  <div style={{ color: C.grey2, ...BC, fontSize: 12, fontWeight: 700, textAlign: "center" }}>{y.D}</div>
                  <div style={{ color: ypmColor, ...BC, fontSize: 12, fontWeight: 800, textAlign: "center" }}>{ypm > 0 ? "+" + ypm : ypm}</div>
                  <div style={{ color: C.grey1, ...BC, fontSize: 11, fontWeight: 600, textAlign: "center" }}>{y.PF % 1 ? y.PF.toFixed(1) : y.PF}</div>
                  <div style={{ color: C.grey2, ...BC, fontSize: 11, fontWeight: 600, textAlign: "center" }}>{y.PA % 1 ? y.PA.toFixed(1) : y.PA}</div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ── History Tab ───────────────────────────────────────────────────────────────
function HistoryTab({ history, data }) {
  const [expanded, setExpanded] = useState(null);
  const [expandedSession, setExpandedSession] = useState(null);
  const sorted = [...history].sort((a, b) => b.year - a.year);

  function getPlayerName(id) { const p = (data.players || []).find(p => p.id === id); return p?.name || "?"; }

  if (sorted.length === 0) {
    return (
      <div style={{ textAlign: "center", padding: "48px 20px", color: C.grey2, ...BC, fontSize: 11, fontWeight: 700, letterSpacing: "0.1em" }}>
        NO HISTORY YET<br />
        <span style={{ color: C.grey3, fontSize: 9, display: "block", marginTop: 6 }}>ADD PAST YEARS IN ADMIN</span>
      </div>
    );
  }

  return (
    <div style={{ padding: "12px 14px 16px" }}>
      {sorted.map(year => {
        const isExp = expanded === year.id;
        const winTeam = (year.teams || []).find(t => t.id === year.winnerId);
        const loseTeam = (year.teams || []).find(t => t.id !== year.winnerId);
        // Compute year score
        let aScore = 0, bScore = 0;
        (year.sessions || []).forEach(s => {
          (s.matches || []).forEach(m => {
            if (m.result === "A") aScore++;
            else if (m.result === "B") bScore++;
            else { aScore += 0.5; bScore += 0.5; }
          });
        });
        const [teamA, teamB] = year.teams || [];
        return (
          <div key={year.id} style={{ marginBottom: 8 }}>
            <button onClick={() => setExpanded(isExp ? null : year.id)} style={{
              width: "100%", ...surf(), borderRadius: 12, padding: "14px 16px",
              border: "1px solid " + C.border, cursor: "pointer", textAlign: "left",
            }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                <div>
                  <div style={{ color: C.white, ...BC, fontSize: 20, fontWeight: 800, letterSpacing: "0.04em", marginBottom: 4 }}>{year.year}</div>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    {winTeam && <Tag color={C.gold}>★ {winTeam.name}</Tag>}
                    {year.mvp && <Tag color={C.gold}>MVP: {getPlayerName(year.mvp)}</Tag>}
                    <Tag color={C.grey2}>{(year.sessions || []).length} SESSIONS</Tag>
                  </div>
                </div>
                {teamA && teamB && (
                  <div style={{ textAlign: "right" }}>
                    <div style={{ ...BC, fontSize: 20, fontWeight: 800, lineHeight: 1 }}>
                      <span style={{ color: year.winnerId === teamA.id ? C.white : C.grey2 }}>{aScore % 1 ? aScore.toFixed(1) : aScore}</span>
                      <span style={{ color: C.grey3 }}> - </span>
                      <span style={{ color: year.winnerId === teamB.id ? C.white : C.grey2 }}>{bScore % 1 ? bScore.toFixed(1) : bScore}</span>
                    </div>
                    <div style={{ color: C.grey2, ...BC, fontSize: 8, fontWeight: 600, letterSpacing: "0.1em", marginTop: 2 }}>
                      {teamA.name} vs {teamB.name}
                    </div>
                  </div>
                )}
              </div>
            </button>

            {isExp && (
              <div style={{ marginTop: 2, paddingLeft: 8 }}>
                {/* Teams */}
                {year.teams && year.teams.length > 0 && (
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginBottom: 8 }}>
                    {year.teams.map(team => (
                      <div key={team.id} style={{ ...surf(), borderRadius: 10, padding: "10px 12px", borderColor: team.id === year.winnerId ? C.gold + "44" : C.border }}>
                        <div style={{ color: team.id === year.winnerId ? C.gold : C.grey1, ...BC, fontSize: 10, fontWeight: 800, letterSpacing: "0.12em", marginBottom: 6 }}>
                          {team.name}{team.id === year.winnerId ? " ★" : ""}
                        </div>
                        {(team.playerIds || []).map(id => (
                          <div key={id} style={{ color: C.white, ...BC, fontSize: 11, fontWeight: 600, padding: "2px 0" }}>{getPlayerName(id)}</div>
                        ))}
                      </div>
                    ))}
                  </div>
                )}

                {/* Sessions */}
                {(year.sessions || []).map(session => {
                  const sessKey = year.id + session.id;
                  const sessExp = expandedSession === sessKey;
                  let sA = 0, sB = 0;
                  (session.matches || []).forEach(m => {
                    if (m.result === "A") sA++;
                    else if (m.result === "B") sB++;
                    else { sA += 0.5; sB += 0.5; }
                  });
                  return (
                    <div key={session.id} style={{ marginBottom: 4 }}>
                      <button onClick={() => setExpandedSession(sessExp ? null : sessKey)} style={{
                        width: "100%", background: "rgba(255,255,255,0.04)", border: "1px solid " + C.grey3,
                        borderRadius: 8, padding: "10px 12px", cursor: "pointer", textAlign: "left",
                      }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                          <div>
                            <div style={{ color: C.white, ...BC, fontSize: 13, fontWeight: 700 }}>{session.name}</div>
                            <div style={{ color: C.grey2, ...BC, fontSize: 9, fontWeight: 600, letterSpacing: "0.08em", marginTop: 2 }}>
                              {FORMAT_LABELS[session.format] || session.format}
                              {session.course ? " · " + session.course : ""}
                            </div>
                          </div>
                          <div style={{ ...BC, fontSize: 16, fontWeight: 800 }}>
                            <span style={{ color: C.white }}>{sA % 1 ? sA.toFixed(1) : sA}</span>
                            <span style={{ color: C.grey3 }}>-</span>
                            <span style={{ color: C.grey1 }}>{sB % 1 ? sB.toFixed(1) : sB}</span>
                          </div>
                        </div>
                      </button>

                      {sessExp && (
                        <div style={{ padding: "6px 4px 2px" }}>
                          {(session.matches || []).map((m, mi) => {
                            const aNames = (m.playerAIds || []).map(getPlayerName).join(" / ");
                            const bNames = (m.playerBIds || []).map(getPlayerName).join(" / ");
                            const resColor = m.result === "A" ? C.white : m.result === "B" ? C.grey1 : C.gold;
                            const resLabel = m.result === "A" ? aNames.split(" / ")[0] + " wins" : m.result === "B" ? bNames.split(" / ")[0] + " wins" : "Halved";
                            return (
                              <div key={mi} style={{ display: "grid", gridTemplateColumns: "1fr auto 1fr", gap: 8, padding: "8px 8px", borderBottom: "1px solid " + C.grey3, alignItems: "center" }}>
                                <div style={{ color: m.result === "A" ? C.white : C.grey3, ...BC, fontSize: 11, fontWeight: 700, textTransform: "uppercase" }}>{aNames}</div>
                                <div style={{ textAlign: "center" }}>
                                  <div style={{ color: resColor, ...BC, fontSize: 11, fontWeight: 800 }}>{m.resultLabel || "—"}</div>
                                </div>
                                <div style={{ color: m.result === "B" ? C.grey1 : C.grey3, ...BC, fontSize: 11, fontWeight: 700, textTransform: "uppercase", textAlign: "right" }}>{bNames}</div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Admin History Tab ─────────────────────────────────────────────────────────

// Inline roster assigner used inside history year editing

function YearMetaEditor({ year, players, onSave }) {
  const [teamA, teamB] = year.teams || [];
  const [aName, setAName] = useState(teamA?.name || "");
  const [bName, setBName] = useState(teamB?.name || "");
  const [winnerId, setWinnerId] = useState(year.winnerId || "");
  const [mvp, setMvp] = useState(year.mvp || "");
  const [saved, setSaved] = useState(false);
  const [open, setOpen] = useState(!year.winnerId);

  const inp = (e = {}) => ({ background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.14)", borderRadius: 8, padding: "9px 12px", color: "#fff", fontFamily: "'Barlow', Arial, sans-serif", fontSize: 13, width: "100%", boxSizing: "border-box", outline: "none", ...e });
  const sel = (e = {}) => ({ ...inp(), appearance: "none", cursor: "pointer", ...e });

  async function save() {
    await onSave({
      winnerId,
      mvp: mvp || null,
      teams: [
        { ...(teamA || { id: "hy_a", playerIds: [] }), name: aName },
        { ...(teamB || { id: "hy_b", playerIds: [] }), name: bName },
      ],
    });
    setSaved(true);
    setTimeout(() => { setSaved(false); setOpen(false); }, 1200);
  }

  const winnerName = year.teams?.find(t => t.id === year.winnerId)?.name;

  return (
    <div style={{ marginBottom: 10, border: "1px solid rgba(255,255,255,0.12)", borderRadius: 12, overflow: "hidden" }}>
      <button onClick={() => setOpen(o => !o)} style={{ width: "100%", display: "flex", justifyContent: "space-between", alignItems: "center", padding: "11px 14px", background: "rgba(255,255,255,0.04)", border: "none", cursor: "pointer" }}>
        <div>
          <div style={{ color: C.white, fontFamily: "'Barlow Condensed', 'Arial Narrow', Arial, sans-serif", fontSize: 10, fontWeight: 800, letterSpacing: "0.12em", textAlign: "left" }}>YEAR DETAILS</div>
          <div style={{ color: C.grey2, fontFamily: "'Barlow Condensed', 'Arial Narrow', Arial, sans-serif", fontSize: 8, fontWeight: 600, letterSpacing: "0.1em", marginTop: 2, textAlign: "left" }}>
            {winnerName ? "★ " + winnerName + " WON" : "Set winner, team names, MVP"}
          </div>
        </div>
        <div style={{ color: C.grey2, fontFamily: "'Barlow Condensed', 'Arial Narrow', Arial, sans-serif", fontSize: 10, fontWeight: 700 }}>{open ? "▲" : "▼"}</div>
      </button>
      {open && (
        <div style={{ padding: "12px 14px", borderTop: "1px solid rgba(255,255,255,0.08)", display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <div>
              <div style={{ color: C.white, fontFamily: "'Barlow Condensed', 'Arial Narrow', Arial, sans-serif", fontSize: 8, fontWeight: 700, letterSpacing: "0.14em", marginBottom: 4 }}>TEAM A NAME</div>
              <input value={aName} onChange={e => setAName(e.target.value)} placeholder="Team A" style={inp()} />
            </div>
            <div>
              <div style={{ color: C.grey1, fontFamily: "'Barlow Condensed', 'Arial Narrow', Arial, sans-serif", fontSize: 8, fontWeight: 700, letterSpacing: "0.14em", marginBottom: 4 }}>TEAM B NAME</div>
              <input value={bName} onChange={e => setBName(e.target.value)} placeholder="Team B" style={inp()} />
            </div>
          </div>
          <div>
            <div style={{ color: C.gold, fontFamily: "'Barlow Condensed', 'Arial Narrow', Arial, sans-serif", fontSize: 8, fontWeight: 700, letterSpacing: "0.14em", marginBottom: 4 }}>CUP WINNER</div>
            <select value={winnerId} onChange={e => setWinnerId(e.target.value)} style={sel()}>
              <option value="">Select winner...</option>
              <option value="hy_a">{aName || "Team A"}</option>
              <option value="hy_b">{bName || "Team B"}</option>
            </select>
          </div>
          <div>
            <div style={{ color: C.grey2, fontFamily: "'Barlow Condensed', 'Arial Narrow', Arial, sans-serif", fontSize: 8, fontWeight: 700, letterSpacing: "0.14em", marginBottom: 4 }}>MVP (OPTIONAL)</div>
            <select value={mvp} onChange={e => setMvp(e.target.value)} style={sel()}>
              <option value="">No MVP</option>
              {players.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          <button onClick={save} style={{ background: saved ? "rgba(255,255,255,0.08)" : C.white, border: "none", borderRadius: 8, padding: "10px 0", color: saved ? C.grey1 : C.bg, fontFamily: "'Barlow Condensed', 'Arial Narrow', Arial, sans-serif", fontSize: 11, fontWeight: 800, letterSpacing: "0.1em", cursor: "pointer", width: "100%" }}>
            {saved ? "✓ SAVED" : "Save Details"}
          </button>
        </div>
      )}
    </div>
  );
}

function RosterAssigner({ year, players, onSave }) {
  const [teamA, teamB] = year.teams || [];
  const [aIds, setAIds] = useState(teamA?.playerIds || []);
  const [bIds, setBIds] = useState(teamB?.playerIds || []);
  const [saved, setSaved] = useState(false);
  const [open, setOpen] = useState(!(teamA?.playerIds?.length > 0));

  async function save() {
    await onSave(aIds, bIds);
    setSaved(true);
    setTimeout(() => { setSaved(false); setOpen(false); }, 1200);
  }

  const rostersSet = (teamA?.playerIds?.length || 0) > 0 && (teamB?.playerIds?.length || 0) > 0;

  return (
    <div style={{ marginBottom: 14, border: "1px solid " + (rostersSet ? "rgba(212,175,106,0.3)" : "rgba(255,80,80,0.3)"), borderRadius: 12, overflow: "hidden" }}>
      <button onClick={() => setOpen(o => !o)} style={{ width: "100%", display: "flex", justifyContent: "space-between", alignItems: "center", padding: "11px 14px", background: rostersSet ? "rgba(212,175,106,0.07)" : "rgba(255,80,80,0.07)", border: "none", cursor: "pointer" }}>
        <div>
          <div style={{ color: rostersSet ? C.gold : "#ff6b6b", ...BC, fontSize: 10, fontWeight: 800, letterSpacing: "0.12em", textAlign: "left" }}>
            {rostersSet ? "★ ROSTERS SET" : "! SET TEAM ROSTERS"} 
          </div>
          <div style={{ color: C.grey2, ...BC, fontSize: 8, fontWeight: 600, letterSpacing: "0.1em", marginTop: 2, textAlign: "left" }}>
            {rostersSet ? (teamA?.name || "A") + ": " + (teamA?.playerIds?.length || 0) + " players  ·  " + (teamB?.name || "B") + ": " + (teamB?.playerIds?.length || 0) + " players" : "Required for cup title tracking"}
          </div>
        </div>
        <div style={{ color: C.grey2, ...BC, fontSize: 10, fontWeight: 700 }}>{open ? "▲" : "▼"}</div>
      </button>

      {open && (
        <div style={{ padding: "12px 14px", borderTop: "1px solid " + C.grey3 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
            {[{ team: teamA, ids: aIds, setIds: setAIds, otherIds: bIds, col: C.white }, { team: teamB, ids: bIds, setIds: setBIds, otherIds: aIds, col: C.grey1 }].map(({ team, ids, setIds, otherIds, col }) => (
              <div key={team?.id || Math.random()}>
                <div style={{ color: col, ...BC, fontSize: 9, fontWeight: 800, letterSpacing: "0.14em", marginBottom: 6 }}>{team?.name || "Team"}</div>
                {players.map(p => (
                  <label key={p.id} style={{ display: "flex", alignItems: "center", gap: 6, color: otherIds.includes(p.id) ? C.grey3 : C.white, fontFamily: "'Barlow', Arial, sans-serif", fontSize: 11, cursor: otherIds.includes(p.id) ? "default" : "pointer", padding: "3px 0", borderBottom: "1px solid " + C.grey3 }}>
                    <input type="checkbox" checked={ids.includes(p.id)} disabled={otherIds.includes(p.id)}
                      onChange={e => setIds(prev => e.target.checked ? [...prev, p.id] : prev.filter(id => id !== p.id))} />
                    {shortName(p.name)}
                  </label>
                ))}
              </div>
            ))}
          </div>
          <Btn onClick={save} style={{ width: "100%", textAlign: "center", padding: 9, fontSize: 11 }}>
            {saved ? "✓ SAVED" : "Save Rosters"}
          </Btn>
        </div>
      )}
    </div>
  );
}

function AdminHistoryTab({ data, onUpdate }) {
  const history = data.history || [];
  const players = data.players || [];
  const [mode, setMode] = useState("list"); // "list" | "year" | "session" | "match"
  const [editYear, setEditYear] = useState(null);
  const [editSession, setEditSession] = useState(null);

  // New year form
  const [newYear, setNewYear] = useState({ year: new Date().getFullYear() - 1, teams: [
    { id: "hy_a", name: "", playerIds: [] },
    { id: "hy_b", name: "", playerIds: [] },
  ], winnerId: "", mvp: "" });

  // New session form
  const [newSess, setNewSess] = useState({ name: "", format: "fourball", courseId: "" });

  // New match form
  const [newMatch, setNewMatch] = useState({ playerAIds: [], playerBIds: [], result: "A", resultLabel: "" });

  function getPName(id) { return players.find(p => p.id === id)?.name || id; }

  async function saveYear() {
    if (!newYear.year) return;
    const y = { ...newYear, id: "y_" + newYear.year + "_" + Date.now(), sessions: [] };
    await onUpdate({ ...data, history: [...history, y] });
    setMode("list");
  }

  async function addSession(yearId) {
    if (!newSess.name.trim()) return;
    const course = (data.courses || []).find(c => c.id === newSess.courseId);
    const s = { ...newSess, id: "hs_" + Date.now(), matches: [], course: course?.name || "" };
    const updated = history.map(y => y.id === yearId ? { ...y, sessions: [...(y.sessions || []), s] } : y);
    await onUpdate({ ...data, history: updated });
    setNewSess({ name: "", format: "fourball", course: "" });
  }

  async function addMatch(yearId, sessId) {
    if (!newMatch.playerAIds.length || !newMatch.playerBIds.length) return;
    const m = { ...newMatch, id: "hm_" + Date.now() };
    const updated = history.map(y => y.id !== yearId ? y : {
      ...y, sessions: (y.sessions || []).map(s => s.id !== sessId ? s : {
        ...s, matches: [...(s.matches || []), m]
      })
    });
    await onUpdate({ ...data, history: updated });
    setNewMatch({ playerAIds: [], playerBIds: [], result: "A", resultLabel: "" });
  }

  async function deleteMatch(yearId, sessId, matchId) {
    const updated = history.map(y => y.id !== yearId ? y : {
      ...y, sessions: (y.sessions || []).map(s => s.id !== sessId ? s : {
        ...s, matches: (s.matches || []).filter(m => m.id !== matchId)
      })
    });
    await onUpdate({ ...data, history: updated });
  }

  async function deleteSession(yearId, sessId) {
    const updated = history.map(y => y.id !== yearId ? y : {
      ...y, sessions: (y.sessions || []).filter(s => s.id !== sessId)
    });
    await onUpdate({ ...data, history: updated });
  }

  async function deleteYear(yearId) {
    await onUpdate({ ...data, history: history.filter(y => y.id !== yearId) });
  }

  const inp = (e = {}) => ({ background: C.surface, border: "1px solid " + C.border, borderRadius: 8, padding: "10px 12px", color: C.white, fontFamily: "'Barlow', Arial, sans-serif", fontSize: 13, width: "100%", boxSizing: "border-box", outline: "none", ...e });
  const sel = (e = {}) => ({ ...inp(), appearance: "none", cursor: "pointer", ...e });

  // ── List mode ──
  if (mode === "list") {
    return (
      <div>
        <Btn onClick={() => setMode("year")} style={{ width: "100%", textAlign: "center", padding: 11, marginBottom: 12 }}>+ Add Year</Btn>
        {[...history].sort((a, b) => b.year - a.year).map(year => {
          const winTeam = (year.teams || []).find(t => t.id === year.winnerId);
          return (
            <div key={year.id} style={{ ...surf(), borderRadius: 12, padding: "12px 14px", marginBottom: 6, border: "1px solid " + C.border }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
                <div>
                  <div style={{ color: C.white, ...BC, fontSize: 18, fontWeight: 800 }}>{year.year}</div>
                  {winTeam && <div style={{ color: C.gold, ...BC, fontSize: 9, fontWeight: 700, letterSpacing: "0.1em", marginTop: 2 }}>★ {winTeam.name}</div>}
                </div>
                <div style={{ display: "flex", gap: 6 }}>
                  <Btn onClick={() => { setEditYear(year); setMode("session"); }} color={C.white} style={{ padding: "5px 10px", fontSize: 10 }}>EDIT</Btn>
                  <Btn onClick={() => deleteYear(year.id)} color={C.danger} style={{ padding: "5px 9px", fontSize: 10 }}>✕</Btn>
                </div>
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <Tag color={C.grey2}>{(year.sessions || []).length} sessions</Tag>
                <Tag color={C.grey2}>{(year.sessions || []).reduce((t, s) => t + (s.matches || []).length, 0)} matches</Tag>
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  // ── New year form ──
  if (mode === "year") {
    return (
      <div>
        <button onClick={() => setMode("list")} style={{ background: "none", border: "none", color: C.grey2, ...BC, fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", cursor: "pointer", marginBottom: 14, padding: 0 }}>← BACK</button>
        <SectionLabel>NEW YEAR</SectionLabel>
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 12 }}>
          <input type="number" value={newYear.year} onChange={e => setNewYear(y => ({ ...y, year: Number(e.target.value) }))} placeholder="Year" style={inp()} />
          {newYear.teams.map((team, ti) => (
            <div key={team.id}>
              <SectionLabel>TEAM {ti + 1} NAME</SectionLabel>
              <input value={team.name} onChange={e => setNewYear(y => ({ ...y, teams: y.teams.map((t, i) => i === ti ? { ...t, name: e.target.value } : t) }))} placeholder={"Team " + (ti + 1) + " name"} style={inp({ marginBottom: 6 })} />
              <SectionLabel>TEAM {ti + 1} PLAYERS</SectionLabel>
              <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                {players.map(p => (
                  <label key={p.id} style={{ display: "flex", alignItems: "center", gap: 8, color: C.white, fontFamily: "'Barlow', Arial, sans-serif", fontSize: 12, cursor: "pointer", padding: "5px 0", borderBottom: "1px solid " + C.grey3 }}>
                    <input type="checkbox" checked={team.playerIds.includes(p.id)}
                      onChange={e => setNewYear(y => ({ ...y, teams: y.teams.map((t, i) => i !== ti ? t : { ...t, playerIds: e.target.checked ? [...t.playerIds, p.id] : t.playerIds.filter(id => id !== p.id) }) }))} />
                    {p.name}
                  </label>
                ))}
              </div>
            </div>
          ))}
          <div>
            <SectionLabel>CUP WINNER</SectionLabel>
            <select value={newYear.winnerId} onChange={e => setNewYear(y => ({ ...y, winnerId: e.target.value }))} style={sel()}>
              <option value="">Select winning team...</option>
              {newYear.teams.map((t, i) => <option key={t.id} value={t.id}>{t.name || "Team " + (i + 1)}</option>)}
            </select>
          </div>
          <div>
            <SectionLabel>MVP (OPTIONAL)</SectionLabel>
            <select value={newYear.mvp} onChange={e => setNewYear(y => ({ ...y, mvp: e.target.value }))} style={sel()}>
              <option value="">No MVP</option>
              {players.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          <Btn onClick={saveYear} style={{ width: "100%", textAlign: "center", padding: 11 }}>Save Year</Btn>
        </div>
      </div>
    );
  }

  // ── Session/match editing mode ──
  if (mode === "session" && editYear) {
    const year = history.find(y => y.id === editYear.id) || editYear;
    const [teamA, teamB] = year.teams || [];
    // If rosters assigned use them, otherwise fall back to full player list
    const playersA = teamA?.playerIds?.length ? players.filter(p => (teamA.playerIds).includes(p.id)) : players;
    const playersB = teamB?.playerIds?.length ? players.filter(p => (teamB.playerIds).includes(p.id)) : players;
    const rostersSet = teamA?.playerIds?.length > 0 && teamB?.playerIds?.length > 0;

    async function saveRosters(aIds, bIds) {
      const updated = history.map(y => y.id !== year.id ? y : {
        ...y, teams: [
          { ...(teamA || { id: "hy_a" }), playerIds: aIds },
          { ...(teamB || { id: "hy_b" }), playerIds: bIds },
        ]
      });
      await onUpdate({ ...data, history: updated });
    }

    return (
      <div>
        <button onClick={() => { setEditYear(null); setMode("list"); }} style={{ background: "none", border: "none", color: C.grey2, ...BC, fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", cursor: "pointer", marginBottom: 14, padding: 0 }}>← BACK</button>
        <div style={{ color: C.white, ...BC, fontSize: 20, fontWeight: 800, marginBottom: 4 }}>{year.year}</div>

        {/* Year meta editor: team names, winner, MVP */}
        <YearMetaEditor year={year} players={players} onSave={async (updates) => {
          const updated = history.map(y => y.id !== year.id ? y : { ...y, ...updates });
          await onUpdate({ ...data, history: updated });
        }} />

        {/* Roster assignment — required for cup titles */}
        <RosterAssigner year={year} players={players} onSave={saveRosters} />

        {/* Add session */}
        <div style={{ ...surf(), borderRadius: 12, padding: 14, marginBottom: 12, border: "1px solid " + C.border }}>
          <SectionLabel>ADD SESSION</SectionLabel>
          <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
            <input value={newSess.name} onChange={e => setNewSess(s => ({ ...s, name: e.target.value }))} placeholder="Session name (e.g. Day 1 - Four-Ball)" style={inp()} />
            <select value={newSess.courseId} onChange={e => setNewSess(s => ({ ...s, courseId: e.target.value }))} style={sel()}>
              <option value="">Select course (optional)...</option>
              {data.courses && data.courses.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <select value={newSess.format} onChange={e => setNewSess(s => ({ ...s, format: e.target.value }))} style={sel()}>
              <option value="fourball">Best Ball</option>
              <option value="foursomes">Alternate Shot</option>
              <option value="scramble">Scramble</option>
              <option value="singles">Singles</option>
            </select>
            <Btn onClick={() => addSession(year.id)} style={{ width: "100%", textAlign: "center", padding: 10 }}>+ Add Session</Btn>
          </div>
        </div>

        {/* Existing sessions */}
        {(year.sessions || []).map(session => (
          <div key={session.id} style={{ ...surf(), borderRadius: 12, padding: 14, marginBottom: 10, border: "1px solid " + C.border }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
              <div>
                <div style={{ color: C.white, ...BC, fontSize: 14, fontWeight: 700 }}>{session.name}</div>
                <div style={{ color: C.grey2, ...BC, fontSize: 9, letterSpacing: "0.08em" }}>{FORMAT_LABELS[session.format]} {session.course ? "· " + session.course : ""}</div>
              </div>
              <Btn onClick={() => deleteSession(year.id, session.id)} color={C.danger} style={{ padding: "5px 9px", fontSize: 10 }}>✕</Btn>
            </div>

            {/* Existing matches */}
            {(session.matches || []).map(m => {
              const aNames = (m.playerAIds || []).map(getPName).join(" / ");
              const bNames = (m.playerBIds || []).map(getPName).join(" / ");
              const resColor = m.result === "A" ? C.white : m.result === "B" ? C.grey1 : C.gold;
              return (
                <div key={m.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "7px 0", borderBottom: "1px solid " + C.grey3 }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ color: m.result === "A" ? C.white : C.grey3, ...BC, fontSize: 10, fontWeight: 700, textTransform: "uppercase" }}>{aNames}</div>
                    <div style={{ color: m.result === "B" ? C.grey1 : C.grey3, ...BC, fontSize: 10, fontWeight: 700, textTransform: "uppercase" }}>{bNames}</div>
                  </div>
                  <div style={{ color: resColor, ...BC, fontSize: 11, fontWeight: 800, marginRight: 10 }}>{m.resultLabel || m.result}</div>
                  <Btn onClick={() => deleteMatch(year.id, session.id, m.id)} color={C.danger} style={{ padding: "4px 8px", fontSize: 9 }}>✕</Btn>
                </div>
              );
            })}

            {/* Add match form */}
            <div style={{ marginTop: 10, padding: "10px 0 0" }}>
              <SectionLabel>ADD MATCH</SectionLabel>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {/* Two-column player picker — filtered by team roster if set */}
                {!rostersSet && (
                  <div style={{ color: "#ff6b6b", fontFamily: "'Barlow Condensed', 'Arial Narrow', Arial, sans-serif", fontSize: 9, fontWeight: 700, letterSpacing: "0.1em", padding: "6px 0" }}>
                    ! Set rosters above to filter players by team
                  </div>
                )}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                  <div>
                    <div style={{ color: C.white, ...BC, fontSize: 9, fontWeight: 700, letterSpacing: "0.14em", marginBottom: 6 }}>
                      {(teamA?.name || "SIDE A").toUpperCase()}
                      {rostersSet && <span style={{ color: C.grey3, fontSize: 8, marginLeft: 4 }}>({playersA.length})</span>}
                    </div>
                    {playersA.map(p => (
                      <label key={p.id} style={{ display: "flex", alignItems: "center", gap: 6, color: newMatch.playerBIds.includes(p.id) ? C.grey3 : C.white, fontFamily: "'Barlow', Arial, sans-serif", fontSize: 12, cursor: "pointer", padding: "4px 0", borderBottom: "1px solid " + C.grey3 }}>
                        <input type="checkbox"
                          checked={newMatch.playerAIds.includes(p.id)}
                          disabled={newMatch.playerBIds.includes(p.id)}
                          onChange={e => setNewMatch(m => ({ ...m, playerAIds: e.target.checked ? [...m.playerAIds, p.id] : m.playerAIds.filter(id => id !== p.id) }))} />
                        {shortName(p.name)}
                      </label>
                    ))}
                  </div>
                  <div>
                    <div style={{ color: C.grey1, ...BC, fontSize: 9, fontWeight: 700, letterSpacing: "0.14em", marginBottom: 6 }}>
                      {(teamB?.name || "SIDE B").toUpperCase()}
                      {rostersSet && <span style={{ color: C.grey3, fontSize: 8, marginLeft: 4 }}>({playersB.length})</span>}
                    </div>
                    {playersB.map(p => (
                      <label key={p.id} style={{ display: "flex", alignItems: "center", gap: 6, color: newMatch.playerAIds.includes(p.id) ? C.grey3 : C.white, fontFamily: "'Barlow', Arial, sans-serif", fontSize: 12, cursor: "pointer", padding: "4px 0", borderBottom: "1px solid " + C.grey3 }}>
                        <input type="checkbox"
                          checked={newMatch.playerBIds.includes(p.id)}
                          disabled={newMatch.playerAIds.includes(p.id)}
                          onChange={e => setNewMatch(m => ({ ...m, playerBIds: e.target.checked ? [...m.playerBIds, p.id] : m.playerBIds.filter(id => id !== p.id) }))} />
                        {shortName(p.name)}
                      </label>
                    ))}
                  </div>
                </div>
                <div>
                  <SectionLabel>RESULT</SectionLabel>
                  <select value={newMatch.result} onChange={e => setNewMatch(m => ({ ...m, result: e.target.value }))} style={sel()}>
                    <option value="A">Side A wins ({newMatch.playerAIds.map(id => shortName(players.find(p => p.id === id)?.name)).filter(Boolean).join(" / ") || "..."})</option>
                    <option value="B">Side B wins ({newMatch.playerBIds.map(id => shortName(players.find(p => p.id === id)?.name)).filter(Boolean).join(" / ") || "..."})</option>
                    <option value="half">Halved</option>
                  </select>
                </div>
                <input value={newMatch.resultLabel} onChange={e => setNewMatch(m => ({ ...m, resultLabel: e.target.value }))} placeholder='Score e.g. "3&2" or "1 UP" (optional)' style={inp()} />
                <Btn onClick={() => addMatch(year.id, session.id)} disabled={!newMatch.playerAIds.length || !newMatch.playerBIds.length} style={{ width: "100%", textAlign: "center", padding: 10 }}>+ Add Match</Btn>
              </div>
            </div>
          </div>
        ))}
      </div>
    );
  }

  return null;
}


// ── Team Builder ──────────────────────────────────────────────────────────────
function TeamBuilderTab({ data }) {
  const { players, history } = data;
  const [teamA, setTeamA] = useState([]);
  const [teamB, setTeamB] = useState([]);
  const [analyzed, setAnalyzed] = useState(false);

  const unassigned = players.filter(p => !teamA.includes(p.id) && !teamB.includes(p.id));
  const getPName = id => players.find(p => p.id === id)?.name || id;
  const sName = name => { const p = (name||"").trim().split(" "); return p.length > 1 ? p[0]+" "+p[p.length-1][0]+"." : p[0]; };

  function toggleTeam(pid, side) {
    setAnalyzed(false);
    if (side === "A") {
      if (teamA.includes(pid)) setTeamA(t => t.filter(id => id !== pid));
      else if (teamA.length < 8) { setTeamA(t => [...t, pid]); setTeamB(t => t.filter(id => id !== pid)); }
    } else {
      if (teamB.includes(pid)) setTeamB(t => t.filter(id => id !== pid));
      else if (teamB.length < 8) { setTeamB(t => [...t, pid]); setTeamA(t => t.filter(id => id !== pid)); }
    }
  }

  function buildH2H() {
    const h2h = {};
    const get = (a,b) => { if(!h2h[a]) h2h[a]={}; if(!h2h[a][b]) h2h[a][b]={w:0,l:0,d:0}; return h2h[a][b]; };
    (history||[]).forEach(yr => (yr.sessions||[]).forEach(s => (s.matches||[]).forEach(m => {
      const aIds=m.playerAIds||[], bIds=m.playerBIds||[], res=m.result;
      aIds.forEach(pa => bIds.forEach(pb => {
        const ab=get(pa,pb), ba=get(pb,pa);
        if(res==="A"){ab.w++;ba.l++;}else if(res==="B"){ab.l++;ba.w++;}else{ab.d++;ba.d++;}
      }));
    })));
    return h2h;
  }

  function buildPM() {
    const pm = {};
    players.forEach(p => { pm[p.id] = 0; });
    (history||[]).forEach(yr => (yr.sessions||[]).forEach(s => (s.matches||[]).forEach(m => {
      const aIds=m.playerAIds||[], bIds=m.playerBIds||[], res=m.result;
      aIds.forEach(id => { pm[id]=(pm[id]||0)+(res==="A"?1:res==="B"?-1:0); });
      bIds.forEach(id => { pm[id]=(pm[id]||0)+(res==="B"?1:res==="A"?-1:0); });
    })));
    return pm;
  }

  function analyzeTeams() {
    const h2h = buildH2H();
    const pm = buildPM();
    const matchups = [];
    let totalProb = 0;
    teamA.forEach(pa => teamB.forEach(pb => {
      const rec = (h2h[pa]||{})[pb] || {w:0,l:0,d:0};
      const tot = rec.w+rec.l+rec.d;
      let probA;
      if (tot >= 2) {
        probA = (rec.w + rec.d*0.5) / tot;
      } else {
        const pmDiff = (pm[pa]||0) - (pm[pb]||0);
        const pmProb = 0.5 + Math.max(-0.35, Math.min(0.35, pmDiff * 0.04));
        probA = tot === 1 ? 0.65*((rec.w+rec.d*0.5)/tot) + 0.35*pmProb : pmProb;
      }
      matchups.push({pa, pb, probA, rec, tot});
      totalProb += probA;
    }));
    matchups.sort((a,b) => b.tot - a.tot || Math.abs(b.probA-0.5)-Math.abs(a.probA-0.5));
    const avgProbA = totalProb / matchups.length;
    const teamAPM = teamA.reduce((s,id)=>s+(pm[id]||0),0);
    const teamBPM = teamB.reduce((s,id)=>s+(pm[id]||0),0);
    return { matchups, avgProbA, teamAPM, teamBPM, pm };
  }

  const teamAName = data.currentYear?.teams?.find(t=>t.id==="A")?.name || "Team A";
  const teamBName = data.currentYear?.teams?.find(t=>t.id==="B")?.name || "Team B";
  const BC2 = { fontFamily: "'Barlow Condensed', 'Arial Narrow', Arial, sans-serif" };

  return (
    <div>
      <div style={{ color: C.grey2, ...BC2, fontSize: 9, fontWeight: 700, letterSpacing: "0.14em", marginBottom: 14 }}>
        ASSIGN 8 PLAYERS TO EACH TEAM, THEN RUN ANALYSIS
      </div>

      {/* Team columns */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 10 }}>
        {["A","B"].map(side => {
          const team = side==="A" ? teamA : teamB;
          const name = side==="A" ? teamAName : teamBName;
          return (
            <div key={side} style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 12, padding: "10px 12px" }}>
              <div style={{ color: side==="A"?C.white:C.grey1, ...BC2, fontSize: 10, fontWeight: 800, letterSpacing: "0.12em", marginBottom: 6 }}>
                {name.toUpperCase()} <span style={{ color: C.grey3 }}>({team.length}/8)</span>
              </div>
              {team.map(pid => (
                <div key={pid} style={{ display: "flex", justifyContent: "space-between", padding: "3px 0", borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
                  <span style={{ color: C.white, fontFamily: "'Barlow', Arial, sans-serif", fontSize: 11 }}>{sName(getPName(pid))}</span>
                  <button onClick={()=>toggleTeam(pid,side)} style={{ background:"none",border:"none",color:"#444",cursor:"pointer",fontSize:13,padding:"0 2px" }}>x</button>
                </div>
              ))}
              {team.length < 8 && <div style={{ color: C.grey3, ...BC2, fontSize: 8, marginTop: 4 }}>{8-team.length} more needed</div>}
            </div>
          );
        })}
      </div>

      {/* Unassigned */}
      {unassigned.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ color: C.grey2, ...BC2, fontSize: 8, fontWeight: 700, letterSpacing: "0.14em", marginBottom: 6 }}>UNASSIGNED — TAP TO ADD</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
            {unassigned.map(p => (
              <div key={p.id} style={{ display: "flex", borderRadius: 7, overflow: "hidden", border: "1px solid rgba(255,255,255,0.14)" }}>
                <button onClick={()=>toggleTeam(p.id,"A")} style={{ background:"rgba(255,255,255,0.08)",border:"none",padding:"5px 9px",color:C.white,...BC2,fontSize:10,fontWeight:700,cursor:"pointer" }}>
                  {sName(p.name)}
                </button>
                <button onClick={()=>toggleTeam(p.id,"B")} style={{ background:"rgba(255,255,255,0.03)",border:"none",borderLeft:"1px solid rgba(255,255,255,0.1)",padding:"5px 8px",color:C.grey2,...BC2,fontSize:9,fontWeight:700,cursor:"pointer" }}>B</button>
              </div>
            ))}
          </div>
          <div style={{ color: C.grey3, ...BC2, fontSize: 8, marginTop: 5 }}>NAME = ADD TO {teamAName.toUpperCase()} &nbsp;|&nbsp; B = ADD TO {teamBName.toUpperCase()}</div>
        </div>
      )}

      {/* Analyze button */}
      {teamA.length===8 && teamB.length===8 && (
        <button onClick={()=>setAnalyzed(true)} style={{ width:"100%",padding:"13px 0",background:analyzed?"rgba(255,255,255,0.06)":C.white,border:"none",borderRadius:10,color:analyzed?C.grey2:C.bg,...BC2,fontSize:13,fontWeight:800,letterSpacing:"0.1em",cursor:"pointer",marginBottom:16 }}>
          {analyzed ? "RE-RUN ANALYSIS" : "RUN ANALYSIS →"}
        </button>
      )}

      {/* Results */}
      {analyzed && teamA.length===8 && teamB.length===8 && (() => {
        const { matchups, avgProbA, teamAPM, teamBPM, pm } = analyzeTeams();
        const projA = (avgProbA*8).toFixed(1);
        const projB = (8-avgProbA*8).toFixed(1);
        const balance = Math.abs(avgProbA-0.5);
        const balLabel = balance<0.04?"VERY BALANCED":balance<0.09?"FAIRLY BALANCED":balance<0.15?"SLIGHT EDGE":"LOPSIDED";
        const balColor = balance<0.04?"#6FCF8A":balance<0.09?C.gold:balance<0.15?C.bogey:C.danger;
        const topH2H = matchups.filter(m=>m.tot>0).slice(0,10);
        const noPrior = matchups.filter(m=>m.tot===0).length;

        return (
          <div>
            {/* Summary card */}
            <div style={{ background:"rgba(255,255,255,0.04)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:12,padding:"14px 16px",marginBottom:12 }}>
              <div style={{ color:balColor,...BC2,fontSize:10,fontWeight:800,letterSpacing:"0.16em",marginBottom:10 }}>{balLabel}</div>
              <div style={{ display:"grid",gridTemplateColumns:"1fr auto 1fr",alignItems:"center",gap:8,marginBottom:12 }}>
                <div>
                  <div style={{ color:C.white,...BC2,fontSize:10,fontWeight:700 }}>{teamAName}</div>
                  <div style={{ color:C.white,...BC2,fontSize:34,fontWeight:800,lineHeight:1 }}>{projA}</div>
                  <div style={{ color:C.grey2,...BC2,fontSize:8,marginTop:2 }}>PROJ PTS &nbsp;|&nbsp; PM {teamAPM>0?"+"+teamAPM:teamAPM}</div>
                </div>
                <div style={{ color:C.grey3,...BC2,fontSize:14 }}>-</div>
                <div style={{ textAlign:"right" }}>
                  <div style={{ color:C.grey1,...BC2,fontSize:10,fontWeight:700 }}>{teamBName}</div>
                  <div style={{ color:C.grey1,...BC2,fontSize:34,fontWeight:800,lineHeight:1 }}>{projB}</div>
                  <div style={{ color:C.grey2,...BC2,fontSize:8,marginTop:2 }}>PROJ PTS &nbsp;|&nbsp; PM {teamBPM>0?"+"+teamBPM:teamBPM}</div>
                </div>
              </div>
              <div style={{ height:5,background:"rgba(255,255,255,0.06)",borderRadius:3,overflow:"hidden",marginBottom:4 }}>
                <div style={{ width:Math.round(avgProbA*100)+"%",height:"100%",background:C.white,borderRadius:3 }} />
              </div>
              <div style={{ display:"flex",justifyContent:"space-between" }}>
                <div style={{ color:C.grey2,...BC2,fontSize:8 }}>{teamAName} {Math.round(avgProbA*100)}%</div>
                <div style={{ color:C.grey2,...BC2,fontSize:8 }}>{Math.round((1-avgProbA)*100)}% {teamBName}</div>
              </div>
            </div>

            {/* +/- breakdown */}
            <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:6,marginBottom:12 }}>
              {["A","B"].map(side => {
                const team=side==="A"?teamA:teamB, name=side==="A"?teamAName:teamBName, tpm=side==="A"?teamAPM:teamBPM;
                const sorted=[...team].sort((a,b)=>(pm[b]||0)-(pm[a]||0));
                return (
                  <div key={side} style={{ background:"rgba(255,255,255,0.03)",border:"1px solid rgba(255,255,255,0.08)",borderRadius:10,padding:"10px 12px" }}>
                    <div style={{ color:side==="A"?C.white:C.grey1,...BC2,fontSize:9,fontWeight:800,letterSpacing:"0.12em",marginBottom:6 }}>{name.toUpperCase()}</div>
                    {sorted.map(pid => {
                      const p=pm[pid]||0, c=p>0?"#6FCF8A":p<0?"#E87070":C.grey2;
                      return (
                        <div key={pid} style={{ display:"flex",justifyContent:"space-between",padding:"3px 0",borderBottom:"1px solid rgba(255,255,255,0.04)" }}>
                          <span style={{ color:C.white,fontFamily:"'Barlow', Arial, sans-serif",fontSize:11 }}>{sName(getPName(pid))}</span>
                          <span style={{ color:c,...BC2,fontSize:11,fontWeight:800 }}>{p>0?"+"+p:p}</span>
                        </div>
                      );
                    })}
                    <div style={{ display:"flex",justifyContent:"space-between",marginTop:5,paddingTop:4,borderTop:"1px solid rgba(255,255,255,0.1)" }}>
                      <span style={{ color:C.grey2,...BC2,fontSize:8,fontWeight:700,letterSpacing:"0.1em" }}>TOTAL</span>
                      <span style={{ color:side==="A"?C.white:C.grey1,...BC2,fontSize:11,fontWeight:800 }}>{tpm>0?"+"+tpm:tpm}</span>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Historical matchups */}
            {topH2H.length > 0 && (
              <div style={{ marginBottom:10 }}>
                <div style={{ color:C.grey2,...BC2,fontSize:8,fontWeight:700,letterSpacing:"0.16em",marginBottom:6 }}>KEY HEAD-TO-HEAD MATCHUPS</div>
                <div style={{ background:"rgba(255,255,255,0.03)",border:"1px solid rgba(255,255,255,0.08)",borderRadius:10,overflow:"hidden" }}>
                  {topH2H.map((m,i) => {
                    const pct=Math.round(m.probA*100);
                    const ec=m.probA>0.62?"#6FCF8A":m.probA<0.38?"#E87070":C.gold;
                    const el=m.probA>0.62?teamAName+" edge":m.probA<0.38?teamBName+" edge":"toss-up";
                    return (
                      <div key={i} style={{ padding:"8px 12px",borderBottom:i<topH2H.length-1?"1px solid rgba(255,255,255,0.05)":"none" }}>
                        <div style={{ display:"grid",gridTemplateColumns:"1fr 24px 1fr",alignItems:"center",gap:4,marginBottom:5 }}>
                          <span style={{ color:C.white,fontFamily:"'Barlow', Arial, sans-serif",fontSize:12,fontWeight:700 }}>{sName(getPName(m.pa))}</span>
                          <span style={{ color:C.grey3,...BC2,fontSize:9,textAlign:"center" }}>vs</span>
                          <span style={{ color:C.grey1,fontFamily:"'Barlow', Arial, sans-serif",fontSize:12,fontWeight:700,textAlign:"right" }}>{sName(getPName(m.pb))}</span>
                        </div>
                        <div style={{ display:"grid",gridTemplateColumns:"1fr auto 80px",alignItems:"center",gap:6 }}>
                          <div style={{ height:4,background:"rgba(255,255,255,0.06)",borderRadius:2,overflow:"hidden" }}>
                            <div style={{ width:pct+"%",height:"100%",background:ec,borderRadius:2 }} />
                          </div>
                          <span style={{ color:ec,...BC2,fontSize:8,fontWeight:700,whiteSpace:"nowrap" }}>{el}</span>
                          <span style={{ color:C.grey3,...BC2,fontSize:8,textAlign:"right" }}>{m.rec.w}W {m.rec.l}L {m.rec.d}D</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
            {noPrior > 0 && (
              <div style={{ color:C.grey3,...BC2,fontSize:8,textAlign:"center",padding:"6px 0" }}>
                {noPrior} cross-team matchups have no prior history — projected from +/- ratings only
              </div>
            )}
          </div>
        );
      })()}
    </div>
  );
}


const SEED_DATA = (() => {
  const loganId = "p_logan", willId = "p_will", caleId = "p_cale", joshId = "p_josh";
  const courseId = "c_sleepy", sessionId = "s_1", matchId = "m_1";
  return {
    players: [
      { id: loganId, name: "Logan Plummer" },
      { id: willId,  name: "Will Dana" },
      { id: caleId,  name: "Cale Hammond" },
      { id: joshId,  name: "Josh Rodgerson" },
    ],
    courses: [
      {
        id: courseId, name: "Sleepy Ridge Golf Club", pars: Array(18).fill(4),
        lat: 40.3052, lng: -111.6949, address: "900 S Sleepy Ridge Dr, Orem, UT 84058",
      },
      {
        id: "c_wasatch_mtn", name: "Wasatch Mountain - Mountain Course",
        pars: [4,3,4,4,3,4,3,5,5, 3,4,5,3,5,4,5,3,4],
        lat: 40.5185, lng: -111.4818, address: "Midway, UT",
      },
      {
        id: "c_wasatch_lake", name: "Wasatch Mountain - Lakes Course",
        pars: [5,4,4,4,4,3,4,3,5, 4,4,4,3,5,4,3,5,4],
        lat: 40.5185, lng: -111.4818, address: "Midway, UT",
      },
      {
        id: "c_soldier_gold", name: "Soldier Hollow - Gold Course",
        pars: [4,5,3,4,4,4,5,3,4, 4,4,5,4,3,4,3,5,4],
        lat: 40.5024, lng: -111.4391, address: "Midway, UT",
      },
      {
        id: "c_soldier_silver", name: "Soldier Hollow - Silver Course",
        pars: [4,5,3,4,3,5,3,4,5, 5,4,4,3,4,3,5,3,5],
        lat: 40.5024, lng: -111.4391, address: "Midway, UT",
      },
      {
        id: "c_mountain_dell", name: "Mountain Dell - Canyon Course",
        pars: [4,3,4,5,5,3,4,4,4, 3,5,4,3,5,4,4,4,4],
        lat: 40.7282, lng: -111.7085, address: "Salt Lake City, UT",
      },
    ],
    history: [],
    currentYear: {
      id: "cy_2026", year: 2026, status: "active",
      teams: [
        { id: "A", name: "Team A", playerIds: [loganId, willId] },
        { id: "B", name: "Team B", playerIds: [caleId, joshId] },
      ],
      winnerId: null, mvp: null,
      sessions: [{ id: sessionId, name: "Session 1", date: "2026-04-11", courseId, format: "fourball" }],
      matches: [{
        id: matchId, sessionId, format: "fourball",
        playerAIds: [loganId, willId], playerBIds: [caleId, joshId],
        playerScores: {
          [loganId]: Array(18).fill(null), [willId]: Array(18).fill(null),
          [caleId]: Array(18).fill(null),  [joshId]: Array(18).fill(null),
        },
      }],
    },
  };
})();

const DEFAULT_DATA = SEED_DATA;

export default function App() {
  const [page, setPage] = useState("leaderboard");
  const [data, setData] = useState(null);
  const [adminUnlocked, setAdminUnlocked] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      let d = await load("beehive-cup-data");
      if (!d) {
        d = DEFAULT_DATA;
        await save("beehive-cup-data", d);
      } else {
        // Merge in any new seed courses not already present
        const existingIds = new Set((d.courses || []).map(c => c.id));
        const newCourses = (DEFAULT_DATA.courses || []).filter(c => !existingIds.has(c.id));
        if (newCourses.length > 0) {
          d = { ...d, courses: [...(d.courses || []), ...newCourses] };
          await save("beehive-cup-data", d);
        }
        // Migrate old data model (sessions/matches at root) to currentYear if needed
        if (!d.currentYear && (d.sessions || d.matches)) {
          d = {
            ...d,
            currentYear: {
              id: "cy_migrated", year: new Date().getFullYear(), status: "active",
              teams: (d.teams || []).map(t => ({ ...t, playerIds: (d.players || []).filter(p => p.teamId === t.id).map(p => p.id) })),
              winnerId: null, mvp: null,
              sessions: (d.sessions || []).map(s => { const {active, ...rest} = s; return rest; }),
              matches: d.matches || [],
            },
          };
          delete d.sessions; delete d.matches; delete d.teams;
          await save("beehive-cup-data", d);
        }
      }
      setData(d);
      setLoading(false);
    })();
    // Real-time subscription via Supabase websocket
    const unsubscribe = subscribeToChanges("beehive-cup-data", (newData) => {
      setData(newData);
    });
    // Fallback poll every 30s for reliability
    const iv = setInterval(async () => { const d = await load("beehive-cup-data"); if (d) setData(d); }, 30000);
    return () => { clearInterval(iv); unsubscribe(); };
  }, []);

  async function resetToSeedData() {
    await save("beehive-cup-data", SEED_DATA);
    setData(SEED_DATA);
  }

  async function handleUpdate(nd) { setData(nd); await save("beehive-cup-data", nd); }

  async function exportData() {
    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "beehive-cup-backup.json";
    a.click(); URL.revokeObjectURL(url);
  }

  async function importData(file) {
    const text = await file.text();
    const parsed = JSON.parse(text);
    await save("beehive-cup-data", parsed);
    setData(parsed);
  }

  if (loading) return (
    <div style={{ minHeight: "100vh", background: C.bg, display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 12 }}>
      <Background />
      <img src="data:image/png;base64,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" style={{ width: 48, height: 48, objectFit: "contain", position: "relative", zIndex: 1 }} alt="Beehive Cup" />
      <div style={{ color: C.grey3, ...BC, fontSize: 9, fontWeight: 700, letterSpacing: "0.3em", position: "relative", zIndex: 1 }}>LOADING</div>
    </div>
  );

  return (
    <>

      <style>{`* { box-sizing: border-box; -webkit-tap-highlight-color: transparent; } input, select, button { font-family: inherit; } input[type=number]::-webkit-inner-spin-button { opacity: 1; }`}</style>
      <div style={{ minHeight: "100vh", background: C.bg, color: C.white, paddingBottom: 80, position: "relative" }}>
        <Background />
        <div style={{ position: "relative", zIndex: 1, maxWidth: 480, margin: "0 auto" }}>
          {page === "leaderboard" && <LeaderboardPage data={data} onNavigate={setPage} />}
          {page === "allsessions" && <AllSessionsPage data={data} onBack={() => setPage("leaderboard")} />}
          {page === "sessions" && <AllSessionsPage data={data} onBack={() => setPage("leaderboard")} />}
          {page === "score" && <ScoreEntryPage data={data} onUpdate={handleUpdate} />}
          {page === "records" && <RecordsPage data={data} />}
          {page === "admin" && <AdminPage data={data} onUpdate={handleUpdate} adminUnlocked={adminUnlocked} setAdminUnlocked={setAdminUnlocked} onExport={exportData} onImport={importData} />}
        </div>
        <Nav page={page} setPage={setPage} adminUnlocked={adminUnlocked} />
      </div>
    </>
  );
}
