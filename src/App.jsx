import { useState, useEffect } from "react";

// ─── Constants ────────────────────────────────────────────────────────────────
const ADMIN_PIN = "1234";
const HOLES = Array.from({ length: 18 }, (_, i) => i + 1);
const FORMAT_LABELS = {
  singles: "Singles",
  foursomes: "Foursomes",
  fourball: "Four-Ball",
};

// ─── Storage ──────────────────────────────────────────────────────────────────
async function load(key) {
  try { const r = await window.storage.get(key, true); return r ? JSON.parse(r.value) : null; }
  catch { return null; }
}
async function save(key, val) {
  try { await window.storage.set(key, JSON.stringify(val), true); } catch {}
}

// ─── Match Logic ──────────────────────────────────────────────────────────────
function computeMatchStatus(holeResults = []) {
  let aUp = 0, holesPlayed = 0;
  for (let i = 0; i < 18; i++) {
    const r = holeResults[i];
    if (r === null || r === undefined) break;
    holesPlayed++;
    if (r === "A") aUp++;
    else if (r === "B") aUp--;
  }
  const holesRemaining = 18 - holesPlayed;
  if (holesPlayed > 0 && Math.abs(aUp) > holesRemaining) {
    return { winner: aUp > 0 ? "A" : "B", label: `${Math.abs(aUp)}&${holesRemaining}`, complete: true, aUp, holesPlayed };
  }
  if (holesPlayed === 18) {
    if (aUp === 0) return { winner: "half", label: "Halved", complete: true, aUp, holesPlayed };
    return { winner: aUp > 0 ? "A" : "B", label: "1 UP", complete: true, aUp, holesPlayed };
  }
  if (holesPlayed === 0) return { winner: null, label: "Not Started", complete: false, aUp: 0, holesPlayed: 0 };
  if (aUp === 0) return { winner: null, label: "AS", complete: false, aUp: 0, holesPlayed };
  return { winner: null, label: `${Math.abs(aUp)} UP`, complete: false, aUp, holesPlayed };
}

function computePoints(matches) {
  let aPoints = 0, bPoints = 0;
  for (const m of matches) {
    const s = computeMatchStatus(m.holeResults || []);
    if (s.complete) {
      if (s.winner === "A") aPoints += 1;
      else if (s.winner === "B") bPoints += 1;
      else { aPoints += 0.5; bPoints += 0.5; }
    }
  }
  return { aPoints, bPoints };
}

// ─── Design Tokens ────────────────────────────────────────────────────────────
const G = {
  glass: "rgba(255,255,255,0.055)",
  glassBorder: "rgba(255,255,255,0.11)",
  aColor: "#a8d5b5",
  aBg: "rgba(168,213,181,0.11)",
  aBorder: "rgba(168,213,181,0.22)",
  bColor: "#a8b4d5",
  bBg: "rgba(168,180,213,0.11)",
  bBorder: "rgba(168,180,213,0.22)",
  text: "#f0f0f0",
  muted: "#777",
  dim: "#3a3a3a",
  gold: "#c9a84c",
  bg: "#0c0c0e",
};

const glassStyle = (extra = {}) => ({
  background: G.glass,
  border: `1px solid ${G.glassBorder}`,
  backdropFilter: "blur(24px)",
  WebkitBackdropFilter: "blur(24px)",
  ...extra,
});

const mono = { fontFamily: "'DM Mono', monospace" };
const serif = { fontFamily: "'Cormorant Garamond', serif" };

// ─── Shared UI ────────────────────────────────────────────────────────────────
function GlassCard({ children, style = {}, onClick }) {
  return (
    <div onClick={onClick} style={{
      ...glassStyle(), borderRadius: "16px", padding: "18px",
      cursor: onClick ? "pointer" : "default", ...style
    }}>{children}</div>
  );
}

function Btn({ children, onClick, color = G.gold, style = {}, disabled = false }) {
  return (
    <button onClick={onClick} disabled={disabled} style={{
      background: `${color}18`, border: `1px solid ${color}35`,
      color, borderRadius: "10px", padding: "10px 16px",
      ...mono, fontSize: "11px", cursor: disabled ? "default" : "pointer",
      letterSpacing: "0.07em", opacity: disabled ? 0.35 : 1,
      transition: "all 0.2s", textTransform: "uppercase", ...style
    }}>{children}</button>
  );
}

function Pill({ children, color = G.gold }) {
  return (
    <span style={{
      background: `${color}12`, border: `1px solid ${color}28`,
      color, borderRadius: "20px", padding: "3px 9px",
      fontSize: "9px", ...mono, letterSpacing: "0.09em", whiteSpace: "nowrap"
    }}>{children}</span>
  );
}

function TextInput({ value, onChange, placeholder, type = "text" }) {
  return (
    <input value={value} onChange={onChange} placeholder={placeholder} type={type} style={{
      ...glassStyle(), borderRadius: "10px", padding: "10px 13px",
      color: G.text, ...mono, fontSize: "13px",
      width: "100%", boxSizing: "border-box", outline: "none",
    }} />
  );
}

// ─── Background ───────────────────────────────────────────────────────────────
function Background() {
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 0, pointerEvents: "none", background: G.bg, overflow: "hidden" }}>
      <div style={{ position: "absolute", width: "600px", height: "600px", borderRadius: "50%", background: "radial-gradient(circle, rgba(168,213,181,0.035) 0%, transparent 65%)", top: "-150px", left: "-150px" }} />
      <div style={{ position: "absolute", width: "500px", height: "500px", borderRadius: "50%", background: "radial-gradient(circle, rgba(168,180,213,0.035) 0%, transparent 65%)", bottom: "50px", right: "-100px" }} />
      <svg width="100%" height="100%" style={{ opacity: 0.02, position: "absolute", inset: 0 }}>
        <defs>
          <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
            <path d="M 40 0 L 0 0 0 40" fill="none" stroke="white" strokeWidth="0.5" />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#grid)" />
      </svg>
    </div>
  );
}

// ─── Nav ──────────────────────────────────────────────────────────────────────
function Nav({ page, setPage, adminUnlocked }) {
  const tabs = [
    { id: "leaderboard", icon: "⬡", label: "Live" },
    { id: "sessions", icon: "◫", label: "Sessions" },
    { id: "score", icon: "✦", label: "Score" },
    { id: "admin", icon: adminUnlocked ? "◈" : "◉", label: "Admin" },
  ];
  return (
    <nav style={{
      position: "fixed", bottom: 0, left: 0, right: 0, zIndex: 100,
      background: "rgba(10,10,12,0.88)", backdropFilter: "blur(30px)",
      WebkitBackdropFilter: "blur(30px)",
      borderTop: "1px solid rgba(255,255,255,0.07)",
      display: "flex",
    }}>
      {tabs.map(t => (
        <button key={t.id} onClick={() => setPage(t.id)} style={{
          flex: 1, padding: "12px 4px 16px", background: "transparent", border: "none",
          color: page === t.id ? G.text : "#444",
          cursor: "pointer", transition: "all 0.2s",
          borderTop: page === t.id ? "1px solid rgba(255,255,255,0.15)" : "1px solid transparent",
          display: "flex", flexDirection: "column", alignItems: "center", gap: "3px"
        }}>
          <span style={{ fontSize: "15px", opacity: page === t.id ? 1 : 0.4 }}>{t.icon}</span>
          <span style={{ fontSize: "8px", ...mono, letterSpacing: "0.12em", textTransform: "uppercase" }}>{t.label}</span>
        </button>
      ))}
    </nav>
  );
}

// ─── Score Banner ─────────────────────────────────────────────────────────────
function ScoreBanner({ teamA, teamB, aPoints, bPoints, totalMatches }) {
  const toWin = totalMatches > 0 ? (Math.floor(totalMatches / 2) + 0.5) : "—";
  const fmt = v => v % 1 === 0 ? v : v.toFixed(1);
  const aLeading = aPoints > bPoints, bLeading = bPoints > aPoints;

  return (
    <div style={{ ...glassStyle(), borderRadius: "20px", marginBottom: "14px", overflow: "hidden" }}>
      <div style={{ textAlign: "center", padding: "14px 0 0", color: G.muted, fontSize: "9px", ...mono, letterSpacing: "0.22em" }}>
        BEEHIVE CUP · {totalMatches} MATCHES · {toWin} TO WIN
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr auto 1fr", alignItems: "center", padding: "10px 22px 16px" }}>
        <div>
          <div style={{ color: aLeading ? G.aColor : G.muted, fontSize: "10px", ...mono, letterSpacing: "0.1em", marginBottom: "3px", textTransform: "uppercase" }}>
            {teamA?.name || "Team A"}
          </div>
          <div style={{ color: aLeading ? G.text : G.muted, fontSize: "58px", ...serif, lineHeight: 1, fontWeight: 600 }}>
            {fmt(aPoints)}
          </div>
        </div>
        <div style={{ textAlign: "center", padding: "0 18px", color: "#2a2a2a", fontSize: "12px", ...mono }}>vs</div>
        <div style={{ textAlign: "right" }}>
          <div style={{ color: bLeading ? G.bColor : G.muted, fontSize: "10px", ...mono, letterSpacing: "0.1em", marginBottom: "3px", textTransform: "uppercase" }}>
            {teamB?.name || "Team B"}
          </div>
          <div style={{ color: bLeading ? G.text : G.muted, fontSize: "58px", ...serif, lineHeight: 1, fontWeight: 600 }}>
            {fmt(bPoints)}
          </div>
        </div>
      </div>
      {totalMatches > 0 && (
        <div style={{ height: "1px", background: "rgba(255,255,255,0.04)", position: "relative" }}>
          <div style={{ position: "absolute", left: 0, top: 0, height: "100%", width: `${(aPoints / totalMatches) * 100}%`, background: G.aColor, transition: "width 1s ease" }} />
          <div style={{ position: "absolute", right: 0, top: 0, height: "100%", width: `${(bPoints / totalMatches) * 100}%`, background: G.bColor, transition: "width 1s ease" }} />
        </div>
      )}
    </div>
  );
}

// ─── Match Row ────────────────────────────────────────────────────────────────
function MatchRow({ m, teamA, teamB, players, expanded, onToggle }) {
  const status = computeMatchStatus(m.holeResults || []);
  const aNames = (m.playerAIds || []).map(id => players.find(p => p.id === id)?.name || id);
  const bNames = (m.playerBIds || []).map(id => players.find(p => p.id === id)?.name || id);

  const aWin = status.winner === "A" || (!status.complete && status.aUp > 0);
  const bWin = status.winner === "B" || (!status.complete && status.aUp < 0);
  const halved = status.winner === "half";

  const centerColor = halved ? G.gold : aWin ? G.aColor : bWin ? G.bColor : G.muted;

  let centerMain = "—", centerSub = "not started";
  if (status.holesPlayed > 0) {
    centerMain = status.label;
    centerSub = status.complete ? "F" : `thru ${status.holesPlayed}`;
  }

  return (
    <div style={{ marginBottom: "4px", borderRadius: "12px", overflow: "hidden", border: "1px solid rgba(255,255,255,0.065)" }}>
      {/* Three-column row */}
      <div onClick={onToggle} style={{ display: "grid", gridTemplateColumns: "1fr 78px 1fr", background: "rgba(255,255,255,0.025)", cursor: "pointer", minHeight: "58px" }}>
        {/* A side */}
        <div style={{
          background: aWin ? G.aBg : "transparent",
          borderLeft: `2px solid ${aWin ? G.aColor : "transparent"}`,
          padding: "10px 8px 10px 12px", display: "flex", flexDirection: "column", justifyContent: "center",
        }}>
          {aNames.map((n, i) => (
            <div key={i} style={{ color: aWin ? G.aColor : bWin || status.complete ? "#333" : G.muted, fontSize: aNames.length > 1 ? "9px" : "11px", ...mono, fontWeight: 600, lineHeight: 1.35, textTransform: "uppercase", letterSpacing: "0.02em" }}>{n}</div>
          ))}
        </div>
        {/* Center */}
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", borderLeft: "1px solid rgba(255,255,255,0.04)", borderRight: "1px solid rgba(255,255,255,0.04)", background: "rgba(0,0,0,0.18)", padding: "6px 2px" }}>
          <div style={{ color: centerColor, fontSize: "14px", ...serif, fontWeight: 700, lineHeight: 1 }}>{centerMain}</div>
          <div style={{ color: "#2d2d2d", fontSize: "7px", ...mono, marginTop: "3px", letterSpacing: "0.09em" }}>{centerSub}</div>
        </div>
        {/* B side */}
        <div style={{
          background: bWin ? G.bBg : "transparent",
          borderRight: `2px solid ${bWin ? G.bColor : "transparent"}`,
          padding: "10px 12px 10px 8px", display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "flex-end",
        }}>
          {bNames.map((n, i) => (
            <div key={i} style={{ color: bWin ? G.bColor : aWin || status.complete ? "#333" : G.muted, fontSize: bNames.length > 1 ? "9px" : "11px", ...mono, fontWeight: 600, lineHeight: 1.35, textTransform: "uppercase", letterSpacing: "0.02em", textAlign: "right" }}>{n}</div>
          ))}
        </div>
      </div>

      {/* Hole strip */}
      <div onClick={onToggle} style={{ display: "flex", gap: "2px", padding: "5px 8px", background: "rgba(0,0,0,0.22)", cursor: "pointer", borderTop: "1px solid rgba(255,255,255,0.03)", alignItems: "center" }}>
        {HOLES.map(h => {
          const r = (m.holeResults || [])[h - 1];
          return <div key={h} style={{ flex: 1, height: "4px", borderRadius: "2px", background: r === "A" ? G.aColor : r === "B" ? G.bColor : r === "half" ? G.gold : "rgba(255,255,255,0.06)" }} />;
        })}
        <div style={{ color: "#2a2a2a", fontSize: "7px", ...mono, marginLeft: "5px", flexShrink: 0 }}>{expanded ? "▲" : "▼"}</div>
      </div>

      {/* Expanded hole grid */}
      {expanded && (
        <div style={{ background: "rgba(0,0,0,0.3)", padding: "10px", borderTop: "1px solid rgba(255,255,255,0.03)" }}>
          {[HOLES.slice(0, 9), HOLES.slice(9)].map((half, hi) => (
            <div key={hi} style={{ display: "grid", gridTemplateColumns: "repeat(9, 1fr)", gap: "3px", marginBottom: hi === 0 ? "4px" : 0 }}>
              {half.map(h => {
                const r = (m.holeResults || [])[h - 1];
                return (
                  <div key={h} style={{ textAlign: "center" }}>
                    <div style={{ color: "#2a2a2a", fontSize: "7px", ...mono, marginBottom: "2px" }}>{h}</div>
                    <div style={{ height: "20px", borderRadius: "4px", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "8px", ...mono, fontWeight: 700, background: r === "A" ? `${G.aColor}16` : r === "B" ? `${G.bColor}16` : r === "half" ? `${G.gold}16` : "rgba(255,255,255,0.03)", color: r === "A" ? G.aColor : r === "B" ? G.bColor : r === "half" ? G.gold : "#2a2a2a", border: `1px solid ${r === "A" ? G.aBorder : r === "B" ? G.bBorder : r === "half" ? `${G.gold}28` : "rgba(255,255,255,0.04)"}` }}>
                      {r === "A" ? (teamA?.name?.[0] || "A") : r === "B" ? (teamB?.name?.[0] || "B") : r === "half" ? "½" : "·"}
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

// ─── Leaderboard ──────────────────────────────────────────────────────────────
function LeaderboardPage({ data }) {
  const [expandedMatch, setExpandedMatch] = useState(null);
  const { teams, sessions, matches, players } = data;
  const courses = data.courses || [];
  const teamA = teams.find(t => t.id === "A");
  const teamB = teams.find(t => t.id === "B");
  const activeSessions = sessions.filter(s => s.active);
  const allActiveMatches = matches.filter(m => activeSessions.find(s => s.id === m.sessionId));
  const { aPoints, bPoints } = computePoints(allActiveMatches);

  return (
    <div style={{ padding: "0 14px 100px" }}>
      <div style={{ textAlign: "center", padding: "26px 0 18px" }}>
        <div style={{ fontSize: "30px", ...serif, color: G.text, fontWeight: 600, letterSpacing: "0.01em" }}>🐝 Beehive Cup</div>
        <div style={{ color: "#2e2e2e", fontSize: "8px", ...mono, letterSpacing: "0.28em", marginTop: "4px" }}>LIVE LEADERBOARD</div>
      </div>
      <ScoreBanner teamA={teamA} teamB={teamB} aPoints={aPoints} bPoints={bPoints} totalMatches={allActiveMatches.length} />
      {activeSessions.length === 0 && (
        <GlassCard style={{ textAlign: "center", padding: "48px 20px" }}>
          <div style={{ fontSize: "24px", marginBottom: "10px" }}>⛳</div>
          <div style={{ color: G.muted, ...mono, fontSize: "11px" }}>No active sessions</div>
        </GlassCard>
      )}
      {activeSessions.map(session => {
        const sessionMatches = matches.filter(m => m.sessionId === session.id);
        return (
          <div key={session.id} style={{ marginBottom: "22px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "9px", padding: "0 2px" }}>
              <div style={{ color: G.text, ...serif, fontSize: "17px", fontWeight: 600 }}>{session.name}</div>
              <Pill>{FORMAT_LABELS[session.format] || session.format}</Pill>
              {(() => { const c = courses.find(c => c.id === session.courseId); return c ? <span style={{ color: G.muted, fontSize: "9px", ...mono }}>{c.name}</span> : null; })()}
            </div>
            {sessionMatches.length === 0 && <div style={{ color: "#2a2a2a", ...mono, fontSize: "11px", padding: "10px 4px" }}>No matches set up</div>}
            {sessionMatches.map(m => (
              <MatchRow key={m.id} m={m} teamA={teamA} teamB={teamB} players={players}
                expanded={expandedMatch === m.id}
                onToggle={() => setExpandedMatch(expandedMatch === m.id ? null : m.id)} />
            ))}
          </div>
        );
      })}
    </div>
  );
}

// ─── Sessions Page ────────────────────────────────────────────────────────────
function SessionsPage({ data }) {
  const { sessions, matches, teams, players } = data;
  const courses = data.courses || [];
  const [expanded, setExpanded] = useState(null);
  function getPlayerName(id) { return players.find(p => p.id === id)?.name || id; }
  const sorted = [...sessions].sort((a, b) => new Date(b.date) - new Date(a.date));

  return (
    <div style={{ padding: "24px 14px 100px" }}>
      <div style={{ marginBottom: "22px" }}>
        <div style={{ fontSize: "24px", ...serif, color: G.text, fontWeight: 600 }}>Sessions</div>
        <div style={{ color: G.muted, fontSize: "9px", ...mono, marginTop: "2px", letterSpacing: "0.1em" }}>ALL ROUNDS & RESULTS</div>
      </div>
      {sorted.length === 0 && <GlassCard style={{ textAlign: "center", padding: "48px" }}><div style={{ color: G.muted, ...mono, fontSize: "11px" }}>No sessions yet</div></GlassCard>}
      {sorted.map(s => {
        const sMatches = matches.filter(m => m.sessionId === s.id);
        const { aPoints, bPoints } = computePoints(sMatches);
        const teamA = teams.find(t => t.id === "A"), teamB = teams.find(t => t.id === "B");
        const isExp = expanded === s.id;
        return (
          <GlassCard key={s.id} style={{ marginBottom: "8px" }} onClick={() => setExpanded(isExp ? null : s.id)}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
              <div>
                <div style={{ color: G.text, ...serif, fontSize: "17px", fontWeight: 600, marginBottom: "6px" }}>{s.name}</div>
                <div style={{ display: "flex", gap: "5px", flexWrap: "wrap" }}>
                  {s.active && <Pill color={G.aColor}>● LIVE</Pill>}
                  <Pill>{FORMAT_LABELS[s.format] || s.format}</Pill>
                  {(() => { const c = courses.find(c => c.id === s.courseId); return c ? <Pill color={G.muted}>{c.name}</Pill> : null; })()}
                  {s.date && <Pill color="#333">{s.date}</Pill>}
                </div>
              </div>
              <div style={{ textAlign: "right", flexShrink: 0, marginLeft: "12px" }}>
                <div style={{ ...mono, fontSize: "20px", lineHeight: 1 }}>
                  <span style={{ color: G.aColor }}>{aPoints % 1 ? aPoints.toFixed(1) : aPoints}</span>
                  <span style={{ color: "#2a2a2a" }}> – </span>
                  <span style={{ color: G.bColor }}>{bPoints % 1 ? bPoints.toFixed(1) : bPoints}</span>
                </div>
                <div style={{ color: G.muted, fontSize: "8px", ...mono, marginTop: "3px" }}>{sMatches.length} matches</div>
              </div>
            </div>
            {isExp && (
              <div style={{ marginTop: "14px", borderTop: "1px solid rgba(255,255,255,0.05)", paddingTop: "14px" }}>
                {sMatches.map(m => {
                  const st = computeMatchStatus(m.holeResults || []);
                  return (
                    <div key={m.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "7px 0", borderBottom: "1px solid rgba(255,255,255,0.03)" }}>
                      <div>
                        <div style={{ color: G.aColor, fontSize: "10px", ...mono }}>{(m.playerAIds || []).map(getPlayerName).join(" / ")}</div>
                        <div style={{ color: G.bColor, fontSize: "10px", ...mono }}>{(m.playerBIds || []).map(getPlayerName).join(" / ")}</div>
                      </div>
                      <div style={{ color: st.complete ? (st.winner === "half" ? G.gold : st.winner === "A" ? G.aColor : G.bColor) : G.muted, ...mono, fontSize: "10px", fontWeight: 700 }}>
                        {st.label}{!st.complete && st.holesPlayed > 0 ? ` · ${st.holesPlayed}` : ""}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </GlassCard>
        );
      })}
    </div>
  );
}

// ─── Score Entry ──────────────────────────────────────────────────────────────
function ScoreEntryPage({ data, onUpdate }) {
  const { sessions, matches, players, teams } = data;
  const [selectedMatch, setSelectedMatch] = useState(null);
  const [holeResults, setHoleResults] = useState(Array(18).fill(null));
  const [saved, setSaved] = useState(false);
  const teamA = teams.find(t => t.id === "A");
  const teamB = teams.find(t => t.id === "B");
  const activeMatches = matches.filter(m => sessions.find(s => s.id === m.sessionId && s.active));
  function getPlayerName(id) { return players.find(p => p.id === id)?.name || id; }

  function selectMatch(m) { setSelectedMatch(m); setHoleResults([...(m.holeResults || Array(18).fill(null))]); setSaved(false); }
  function setHole(hole, result) { const u = [...holeResults]; u[hole] = u[hole] === result ? null : result; setHoleResults(u); setSaved(false); }
  async function saveScores() {
    const updated = { ...selectedMatch, holeResults };
    await onUpdate({ ...data, matches: matches.map(m => m.id === selectedMatch.id ? updated : m) });
    setSelectedMatch(updated); setSaved(true); setTimeout(() => setSaved(false), 2500);
  }

  if (selectedMatch) {
    const status = computeMatchStatus(holeResults);
    const session = sessions.find(s => s.id === selectedMatch.sessionId);
    const aNames = (selectedMatch.playerAIds || []).map(getPlayerName).join(" / ");
    const bNames = (selectedMatch.playerBIds || []).map(getPlayerName).join(" / ");
    const centerColor = status.winner === "half" ? G.gold : (status.winner === "A" || status.aUp > 0) ? G.aColor : (status.winner === "B" || status.aUp < 0) ? G.bColor : G.muted;
    let statusLabel = "Not Started";
    if (status.holesPlayed > 0) {
      if (status.complete) statusLabel = `${status.label} — Final`;
      else if (status.aUp === 0) statusLabel = `All Square · thru ${status.holesPlayed}`;
      else statusLabel = `${status.aUp > 0 ? (teamA?.name || "A") : (teamB?.name || "B")} ${Math.abs(status.aUp)} UP · thru ${status.holesPlayed}`;
    }

    return (
      <div style={{ padding: "16px 14px 120px" }}>
        <button onClick={() => setSelectedMatch(null)} style={{ background: "none", border: "none", color: G.muted, ...mono, fontSize: "10px", cursor: "pointer", marginBottom: "16px", padding: 0, letterSpacing: "0.08em" }}>← BACK</button>
        <GlassCard style={{ textAlign: "center", marginBottom: "14px", padding: "18px" }}>
          <div style={{ color: centerColor, fontSize: "21px", ...serif, fontWeight: 700, marginBottom: "4px" }}>{statusLabel}</div>
          <div style={{ color: G.muted, fontSize: "9px", ...mono, letterSpacing: "0.08em" }}>{session?.name} · {FORMAT_LABELS[session?.format]}</div>
        </GlassCard>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px", marginBottom: "18px" }}>
          {[{ names: aNames, color: G.aColor, border: G.aBorder, label: teamA?.name || "Team A" }, { names: bNames, color: G.bColor, border: G.bBorder, label: teamB?.name || "Team B" }].map((t, i) => (
            <div key={i} style={{ ...glassStyle({ borderColor: t.border }), borderRadius: "11px", padding: "11px 12px" }}>
              <div style={{ color: t.color, fontSize: "8px", ...mono, letterSpacing: "0.14em", marginBottom: "4px", textTransform: "uppercase" }}>{t.label}</div>
              <div style={{ color: G.text, fontSize: "11px", ...mono }}>{t.names}</div>
            </div>
          ))}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: "4px", marginBottom: "18px" }}>
          {HOLES.map(h => {
            const r = holeResults[h - 1];
            const isDecided = status.complete && r === null;
            return (
              <div key={h} style={{ display: "grid", gridTemplateColumns: "24px 1fr 1fr 1fr", gap: "4px", alignItems: "center", opacity: isDecided ? 0.2 : 1 }}>
                <div style={{ color: "#2a2a2a", ...mono, fontSize: "9px", textAlign: "center" }}>{h}</div>
                {[
                  { val: "A", label: teamA?.name || "A", color: G.aColor, bg: G.aBg, border: G.aBorder },
                  { val: "half", label: "Half", color: G.gold, bg: `${G.gold}10`, border: `${G.gold}28` },
                  { val: "B", label: teamB?.name || "B", color: G.bColor, bg: G.bBg, border: G.bBorder },
                ].map(({ val, label, color, bg, border }) => (
                  <button key={val} onClick={() => !isDecided && setHole(h - 1, val)} style={{
                    padding: "8px 2px", borderRadius: "7px",
                    border: `1px solid ${r === val ? border : "rgba(255,255,255,0.04)"}`,
                    background: r === val ? bg : "rgba(255,255,255,0.025)",
                    color: r === val ? color : "#2e2e2e",
                    ...mono, fontSize: "10px", fontWeight: 600,
                    cursor: isDecided ? "default" : "pointer", transition: "all 0.12s"
                  }}>{label}</button>
                ))}
              </div>
            );
          })}
        </div>
        <button onClick={saveScores} style={{
          width: "100%", padding: "15px", borderRadius: "13px",
          background: saved ? `${G.aColor}12` : "rgba(255,255,255,0.06)",
          border: `1px solid ${saved ? G.aColor : "rgba(255,255,255,0.12)"}`,
          color: saved ? G.aColor : G.text, fontSize: "12px", fontWeight: 700, ...mono,
          cursor: "pointer", letterSpacing: "0.12em", transition: "all 0.3s", textTransform: "uppercase"
        }}>{saved ? "✓ Saved" : "Save Scores"}</button>
      </div>
    );
  }

  return (
    <div style={{ padding: "24px 14px 100px" }}>
      <div style={{ marginBottom: "22px" }}>
        <div style={{ fontSize: "24px", ...serif, color: G.text, fontWeight: 600 }}>Score Entry</div>
        <div style={{ color: G.muted, fontSize: "9px", ...mono, marginTop: "2px", letterSpacing: "0.1em" }}>SELECT YOUR MATCH</div>
      </div>
      {activeMatches.length === 0 && (
        <GlassCard style={{ textAlign: "center", padding: "48px 20px" }}>
          <div style={{ color: G.muted, ...mono, fontSize: "11px" }}>No active matches</div>
          <div style={{ color: "#2a2a2a", ...mono, fontSize: "10px", marginTop: "6px" }}>Activate a session in Admin</div>
        </GlassCard>
      )}
      {activeMatches.map(m => {
        const status = computeMatchStatus(m.holeResults || []);
        const session = sessions.find(s => s.id === m.sessionId);
        return (
          <button key={m.id} onClick={() => selectMatch(m)} style={{ display: "block", width: "100%", marginBottom: "6px", ...glassStyle(), borderRadius: "13px", padding: "14px 16px", textAlign: "left", cursor: "pointer" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <div style={{ color: G.muted, fontSize: "8px", ...mono, marginBottom: "6px", letterSpacing: "0.1em", textTransform: "uppercase" }}>{session?.name} · {FORMAT_LABELS[session?.format] || ""}</div>
                <div style={{ color: G.aColor, fontSize: "11px", ...mono, fontWeight: 600, marginBottom: "2px" }}>{(m.playerAIds || []).map(getPlayerName).join(" / ")}</div>
                <div style={{ color: G.bColor, fontSize: "11px", ...mono, fontWeight: 600 }}>{(m.playerBIds || []).map(getPlayerName).join(" / ")}</div>
              </div>
              <div style={{ textAlign: "right", marginLeft: "12px", flexShrink: 0 }}>
                <div style={{ color: status.complete ? G.gold : G.muted, ...mono, fontSize: "10px", marginBottom: "4px" }}>{status.label}{!status.complete && status.holesPlayed > 0 ? ` · ${status.holesPlayed}` : ""}</div>
                <div style={{ color: "#2e2e2e", fontSize: "14px" }}>→</div>
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}

// ─── Admin ────────────────────────────────────────────────────────────────────
function AdminPage({ data, onUpdate, adminUnlocked, setAdminUnlocked }) {
  const [pin, setPin] = useState("");
  const [pinError, setPinError] = useState(false);
  const [tab, setTab] = useState("players");
  const [newPlayerName, setNewPlayerName] = useState("");
  const [newPlayerTeam, setNewPlayerTeam] = useState("A");
  const [teamNames, setTeamNames] = useState({ A: data.teams.find(t => t.id === "A")?.name || "Team A", B: data.teams.find(t => t.id === "B")?.name || "Team B" });
  const [newSession, setNewSession] = useState({ name: "", date: "", courseId: "", format: "fourball", active: true });
  const [matchSetup, setMatchSetup] = useState({ sessionId: "", playerAIds: [], playerBIds: [] });

  // Course creation state
  const [newCourseName, setNewCourseName] = useState("");
  const [newCoursePars, setNewCoursePars] = useState(Array(18).fill(4));
  const [expandedCourse, setExpandedCourse] = useState(null);

  const { players, teams, sessions, matches } = data;
  const courses = data.courses || [];
  const teamA = teams.find(t => t.id === "A"), teamB = teams.find(t => t.id === "B");
  const playersA = players.filter(p => p.teamId === "A"), playersB = players.filter(p => p.teamId === "B");
  function getPlayerName(id) { return players.find(p => p.id === id)?.name || id; }

  function tryPin() { if (pin === ADMIN_PIN) { setAdminUnlocked(true); setPinError(false); } else { setPinError(true); setPin(""); } }
  async function saveTeamNames() { await onUpdate({ ...data, teams: teams.map(t => t.id === "A" ? { ...t, name: teamNames.A } : { ...t, name: teamNames.B }) }); }
  async function addPlayer() { if (!newPlayerName.trim()) return; await onUpdate({ ...data, players: [...players, { id: Date.now().toString(), name: newPlayerName.trim(), teamId: newPlayerTeam }] }); setNewPlayerName(""); }
  async function removePlayer(id) { await onUpdate({ ...data, players: players.filter(p => p.id !== id) }); }
  async function addSession() {
    if (!newSession.name.trim()) return;
    await onUpdate({ ...data, sessions: [...sessions, { ...newSession, id: Date.now().toString() }] });
    setNewSession({ name: "", date: "", courseId: "", format: "fourball", active: true });
  }
  async function toggleSession(id) { await onUpdate({ ...data, sessions: sessions.map(s => s.id === id ? { ...s, active: !s.active } : s) }); }
  async function deleteSession(id) { await onUpdate({ ...data, sessions: sessions.filter(s => s.id !== id), matches: matches.filter(m => m.sessionId !== id) }); }
  async function addCourse() {
    if (!newCourseName.trim()) return;
    const course = { id: Date.now().toString(), name: newCourseName.trim(), pars: [...newCoursePars] };
    await onUpdate({ ...data, courses: [...courses, course] });
    setNewCourseName(""); setNewCoursePars(Array(18).fill(4));
  }
  async function deleteCourse(id) { await onUpdate({ ...data, courses: courses.filter(c => c.id !== id) }); }
  async function addMatch() {
    if (!matchSetup.sessionId || !matchSetup.playerAIds.length || !matchSetup.playerBIds.length) return;
    const session = sessions.find(s => s.id === matchSetup.sessionId);
    await onUpdate({ ...data, matches: [...matches, { ...matchSetup, id: Date.now().toString(), format: session?.format || "fourball", holeResults: Array(18).fill(null) }] });
    setMatchSetup({ sessionId: matchSetup.sessionId, playerAIds: [], playerBIds: [] });
  }
  async function deleteMatch(id) { await onUpdate({ ...data, matches: matches.filter(m => m.id !== id) }); }

  const inputCss = { ...glassStyle(), borderRadius: "10px", padding: "10px 13px", color: G.text, ...mono, fontSize: "13px", width: "100%", boxSizing: "border-box", outline: "none" };

  if (!adminUnlocked) {
    return (
      <div style={{ padding: "24px 14px", display: "flex", flexDirection: "column", alignItems: "center", paddingTop: "80px" }}>
        <div style={{ fontSize: "36px", marginBottom: "14px" }}>◉</div>
        <div style={{ ...serif, color: G.text, fontSize: "24px", fontWeight: 600, marginBottom: "6px" }}>Admin</div>
        <div style={{ color: G.muted, ...mono, fontSize: "10px", marginBottom: "30px", letterSpacing: "0.1em" }}>ENTER PIN</div>
        <input type="password" inputMode="numeric" maxLength={4} value={pin} onChange={e => setPin(e.target.value)} onKeyDown={e => e.key === "Enter" && tryPin()} placeholder="••••"
          style={{ ...glassStyle(), borderRadius: "12px", padding: "14px", color: G.text, textAlign: "center", fontSize: "26px", letterSpacing: "0.5em", width: "150px", outline: "none", marginBottom: "10px", boxSizing: "border-box" }} />
        {pinError && <div style={{ color: "#ef4444", ...mono, fontSize: "10px", marginBottom: "8px" }}>Incorrect PIN</div>}
        <Btn onClick={tryPin} style={{ width: "150px", textAlign: "center" }}>Unlock</Btn>
        <div style={{ color: "#222", ...mono, fontSize: "10px", marginTop: "18px" }}>Default: 1234</div>
      </div>
    );
  }

  return (
    <div style={{ padding: "24px 14px 120px" }}>
      <div style={{ marginBottom: "18px" }}>
        <div style={{ fontSize: "24px", ...serif, color: G.text, fontWeight: 600 }}>Admin</div>
      </div>
      {/* Sub-tabs */}
      <div style={{ display: "flex", gap: "3px", marginBottom: "18px", ...glassStyle(), borderRadius: "12px", padding: "4px" }}>
        {["players", "courses", "sessions", "matches"].map(t => (
          <button key={t} onClick={() => setTab(t)} style={{ flex: 1, padding: "8px 2px", borderRadius: "8px", border: "none", background: tab === t ? "rgba(255,255,255,0.09)" : "transparent", color: tab === t ? G.text : G.muted, ...mono, fontSize: "9px", cursor: "pointer", letterSpacing: "0.06em", textTransform: "uppercase", transition: "all 0.2s" }}>{t}</button>
        ))}
      </div>

      {tab === "players" && (
        <div>
          <GlassCard style={{ marginBottom: "10px" }}>
            <div style={{ color: G.muted, ...mono, fontSize: "8px", letterSpacing: "0.18em", marginBottom: "10px" }}>TEAM NAMES</div>
            <div style={{ display: "flex", gap: "8px", marginBottom: "10px" }}>
              <input value={teamNames.A} onChange={e => setTeamNames(n => ({ ...n, A: e.target.value }))} placeholder="Team A" style={{ ...inputCss, flex: 1, color: G.aColor, borderColor: G.aBorder }} />
              <input value={teamNames.B} onChange={e => setTeamNames(n => ({ ...n, B: e.target.value }))} placeholder="Team B" style={{ ...inputCss, flex: 1, color: G.bColor, borderColor: G.bBorder }} />
            </div>
            <Btn onClick={saveTeamNames} style={{ width: "100%", textAlign: "center" }}>Save Names</Btn>
          </GlassCard>
          <GlassCard style={{ marginBottom: "10px" }}>
            <div style={{ color: G.muted, ...mono, fontSize: "8px", letterSpacing: "0.18em", marginBottom: "10px" }}>ADD PLAYER</div>
            <div style={{ display: "flex", gap: "8px", marginBottom: "10px" }}>
              <input value={newPlayerName} onChange={e => setNewPlayerName(e.target.value)} onKeyDown={e => e.key === "Enter" && addPlayer()} placeholder="Player name" style={{ ...inputCss, flex: 1 }} />
              <select value={newPlayerTeam} onChange={e => setNewPlayerTeam(e.target.value)} style={{ ...inputCss, width: "auto", appearance: "none", cursor: "pointer", paddingRight: "10px" }}>
                <option value="A">{teamA?.name || "A"}</option>
                <option value="B">{teamB?.name || "B"}</option>
              </select>
            </div>
            <Btn onClick={addPlayer} style={{ width: "100%", textAlign: "center" }}>+ Add Player</Btn>
          </GlassCard>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px" }}>
            {["A", "B"].map(tid => {
              const color = tid === "A" ? G.aColor : G.bColor;
              const border = tid === "A" ? G.aBorder : G.bBorder;
              const tName = tid === "A" ? (teamA?.name || "Team A") : (teamB?.name || "Team B");
              return (
                <GlassCard key={tid} style={{ borderColor: border }}>
                  <div style={{ color, ...mono, fontSize: "8px", letterSpacing: "0.14em", marginBottom: "10px", textTransform: "uppercase" }}>{tName}</div>
                  {players.filter(p => p.teamId === tid).length === 0 && <div style={{ color: "#2a2a2a", fontSize: "11px", ...mono }}>—</div>}
                  {players.filter(p => p.teamId === tid).map(p => (
                    <div key={p.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "5px 0", borderBottom: "1px solid rgba(255,255,255,0.03)" }}>
                      <span style={{ color: G.text, fontSize: "11px", ...mono }}>{p.name}</span>
                      <button onClick={() => removePlayer(p.id)} style={{ background: "none", border: "none", color: "#333", cursor: "pointer", fontSize: "14px", padding: "0 2px" }}>×</button>
                    </div>
                  ))}
                </GlassCard>
              );
            })}
          </div>
        </div>
      )}

      {tab === "courses" && (
        <div>
          <GlassCard style={{ marginBottom: "10px" }}>
            <div style={{ color: G.muted, ...mono, fontSize: "8px", letterSpacing: "0.18em", marginBottom: "10px" }}>CREATE COURSE</div>
            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              <input value={newCourseName} onChange={e => setNewCourseName(e.target.value)} placeholder="Course name (e.g. Wasatch Mountain)" style={inputCss} />
              {/* Par grid */}
              <div style={{ color: G.muted, ...mono, fontSize: "8px", letterSpacing: "0.14em", marginTop: "4px" }}>PAR PER HOLE</div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(9, 1fr)", gap: "4px" }}>
                {HOLES.slice(0, 9).map(h => (
                  <div key={h} style={{ textAlign: "center" }}>
                    <div style={{ color: "#2a2a2a", fontSize: "7px", ...mono, marginBottom: "3px" }}>{h}</div>
                    <select value={newCoursePars[h - 1]} onChange={e => { const p = [...newCoursePars]; p[h - 1] = Number(e.target.value); setNewCoursePars(p); }} style={{ ...glassStyle(), borderRadius: "6px", padding: "5px 2px", color: G.text, ...mono, fontSize: "11px", width: "100%", outline: "none", appearance: "none", textAlign: "center", cursor: "pointer" }}>
                      <option value={3}>3</option><option value={4}>4</option><option value={5}>5</option>
                    </select>
                  </div>
                ))}
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(9, 1fr)", gap: "4px" }}>
                {HOLES.slice(9).map(h => (
                  <div key={h} style={{ textAlign: "center" }}>
                    <div style={{ color: "#2a2a2a", fontSize: "7px", ...mono, marginBottom: "3px" }}>{h}</div>
                    <select value={newCoursePars[h - 1]} onChange={e => { const p = [...newCoursePars]; p[h - 1] = Number(e.target.value); setNewCoursePars(p); }} style={{ ...glassStyle(), borderRadius: "6px", padding: "5px 2px", color: G.text, ...mono, fontSize: "11px", width: "100%", outline: "none", appearance: "none", textAlign: "center", cursor: "pointer" }}>
                      <option value={3}>3</option><option value={4}>4</option><option value={5}>5</option>
                    </select>
                  </div>
                ))}
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "4px 2px" }}>
                <span style={{ color: G.muted, ...mono, fontSize: "9px" }}>Total par: <span style={{ color: G.text }}>{newCoursePars.reduce((a, b) => a + b, 0)}</span></span>
              </div>
              <Btn onClick={addCourse} style={{ width: "100%", textAlign: "center", padding: "11px" }}>+ Save Course</Btn>
            </div>
          </GlassCard>

          {courses.length === 0 && <div style={{ color: "#2a2a2a", ...mono, fontSize: "11px", padding: "12px 4px" }}>No courses yet</div>}
          {courses.map(c => (
            <GlassCard key={c.id} style={{ marginBottom: "6px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                <div style={{ flex: 1 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "6px" }}>
                    <div style={{ color: G.text, ...mono, fontSize: "13px" }}>{c.name}</div>
                    <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
                      <span style={{ color: G.muted, ...mono, fontSize: "9px" }}>Par {(c.pars || []).reduce((a, b) => a + b, 0)}</span>
                      <button onClick={() => setExpandedCourse(expandedCourse === c.id ? null : c.id)} style={{ background: "none", border: "none", color: G.muted, cursor: "pointer", fontSize: "10px", ...mono }}>
                        {expandedCourse === c.id ? "▲" : "▼"}
                      </button>
                      <Btn onClick={() => deleteCourse(c.id)} color="#ef4444" style={{ padding: "4px 8px", fontSize: "10px" }}>✕</Btn>
                    </div>
                  </div>
                  {expandedCourse === c.id && (
                    <div>
                      {[HOLES.slice(0, 9), HOLES.slice(9)].map((half, hi) => (
                        <div key={hi} style={{ display: "grid", gridTemplateColumns: "repeat(9, 1fr)", gap: "3px", marginBottom: hi === 0 ? "4px" : 0 }}>
                          {half.map(h => (
                            <div key={h} style={{ textAlign: "center" }}>
                              <div style={{ color: "#2a2a2a", fontSize: "7px", ...mono, marginBottom: "2px" }}>{h}</div>
                              <div style={{ height: "22px", borderRadius: "4px", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "11px", ...mono, background: "rgba(255,255,255,0.04)", color: G.muted, border: "1px solid rgba(255,255,255,0.06)" }}>
                                {(c.pars || [])[h - 1] || 4}
                              </div>
                            </div>
                          ))}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </GlassCard>
          ))}
        </div>
      )}

      {tab === "sessions" && (
        <div>
          <GlassCard style={{ marginBottom: "10px" }}>
            <div style={{ color: G.muted, ...mono, fontSize: "8px", letterSpacing: "0.18em", marginBottom: "10px" }}>CREATE SESSION</div>
            <div style={{ display: "flex", flexDirection: "column", gap: "7px" }}>
              <input value={newSession.name} onChange={e => setNewSession(s => ({ ...s, name: e.target.value }))} placeholder="Session name (e.g. Day 1 — Foursomes)" style={inputCss} />
              <input value={newSession.date} onChange={e => setNewSession(s => ({ ...s, date: e.target.value }))} type="date" style={inputCss} />
              <select value={newSession.courseId} onChange={e => setNewSession(s => ({ ...s, courseId: e.target.value }))} style={{ ...inputCss, appearance: "none", cursor: "pointer" }}>
                <option value="">Select course (optional)...</option>
                {courses.map(c => <option key={c.id} value={c.id}>{c.name} (Par {(c.pars || []).reduce((a, b) => a + b, 0)})</option>)}
              </select>
              <select value={newSession.format} onChange={e => setNewSession(s => ({ ...s, format: e.target.value }))} style={{ ...inputCss, appearance: "none", cursor: "pointer" }}>
                <option value="fourball">Four-Ball (Best Ball)</option>
                <option value="foursomes">Foursomes (Alt. Shot)</option>
                <option value="singles">Singles</option>
              </select>
              <label style={{ display: "flex", alignItems: "center", gap: "8px", color: G.muted, ...mono, fontSize: "10px", cursor: "pointer" }}>
                <input type="checkbox" checked={newSession.active} onChange={e => setNewSession(s => ({ ...s, active: e.target.checked }))} />
                Set as Active (shows on leaderboard)
              </label>
              <Btn onClick={addSession} style={{ width: "100%", textAlign: "center", padding: "11px" }}>+ Create Session</Btn>
            </div>
          </GlassCard>
          {sessions.map(s => {
            const course = courses.find(c => c.id === s.courseId);
            return (
              <GlassCard key={s.id} style={{ marginBottom: "6px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                  <div>
                    <div style={{ color: G.text, ...mono, fontSize: "12px", marginBottom: "6px" }}>{s.name}</div>
                    <div style={{ display: "flex", gap: "5px", flexWrap: "wrap" }}>
                      <Pill>{FORMAT_LABELS[s.format]}</Pill>
                      {course && <Pill color={G.muted}>{course.name}</Pill>}
                      {s.date && <Pill color="#333">{s.date}</Pill>}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: "5px", flexShrink: 0, marginLeft: "8px" }}>
                    <Btn onClick={() => toggleSession(s.id)} color={s.active ? G.aColor : G.muted} style={{ padding: "6px 10px", fontSize: "10px" }}>{s.active ? "● Live" : "○ Off"}</Btn>
                    <Btn onClick={() => deleteSession(s.id)} color="#ef4444" style={{ padding: "6px 9px", fontSize: "11px" }}>✕</Btn>
                  </div>
                </div>
              </GlassCard>
            );
          })}
        </div>
      )}

      {tab === "matches" && (
        <div>
          <GlassCard style={{ marginBottom: "10px" }}>
            <div style={{ color: G.muted, ...mono, fontSize: "8px", letterSpacing: "0.18em", marginBottom: "10px" }}>CREATE MATCH</div>
            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              <select value={matchSetup.sessionId} onChange={e => setMatchSetup(m => ({ ...m, sessionId: e.target.value, playerAIds: [], playerBIds: [] }))} style={{ ...inputCss, appearance: "none", cursor: "pointer" }}>
                <option value="">Select session...</option>
                {sessions.map(s => <option key={s.id} value={s.id}>{s.name} — {FORMAT_LABELS[s.format]}</option>)}
              </select>

              {matchSetup.sessionId && (() => {
                const session = sessions.find(s => s.id === matchSetup.sessionId);
                return (
                  <>
                    <div style={{ color: "#2a2a2a", ...mono, fontSize: "9px", letterSpacing: "0.1em", padding: "0 2px" }}>FORMAT: {FORMAT_LABELS[session?.format] || "—"} (from session)</div>
                    <div>
                      <div style={{ color: G.aColor, ...mono, fontSize: "9px", letterSpacing: "0.12em", marginBottom: "8px", textTransform: "uppercase" }}>{teamA?.name || "Team A"} player(s)</div>
                      {playersA.map(p => (
                        <label key={p.id} style={{ display: "flex", alignItems: "center", gap: "10px", color: G.text, ...mono, fontSize: "12px", cursor: "pointer", padding: "6px 0", borderBottom: "1px solid rgba(255,255,255,0.03)" }}>
                          <input type="checkbox" checked={matchSetup.playerAIds.includes(p.id)} onChange={e => setMatchSetup(m => ({ ...m, playerAIds: e.target.checked ? [...m.playerAIds, p.id] : m.playerAIds.filter(id => id !== p.id) }))} />
                          {p.name}
                        </label>
                      ))}
                    </div>
                    <div>
                      <div style={{ color: G.bColor, ...mono, fontSize: "9px", letterSpacing: "0.12em", marginBottom: "8px", textTransform: "uppercase", marginTop: "4px" }}>{teamB?.name || "Team B"} player(s)</div>
                      {playersB.map(p => (
                        <label key={p.id} style={{ display: "flex", alignItems: "center", gap: "10px", color: G.text, ...mono, fontSize: "12px", cursor: "pointer", padding: "6px 0", borderBottom: "1px solid rgba(255,255,255,0.03)" }}>
                          <input type="checkbox" checked={matchSetup.playerBIds.includes(p.id)} onChange={e => setMatchSetup(m => ({ ...m, playerBIds: e.target.checked ? [...m.playerBIds, p.id] : m.playerBIds.filter(id => id !== p.id) }))} />
                          {p.name}
                        </label>
                      ))}
                    </div>
                  </>
                );
              })()}
              <Btn onClick={addMatch} disabled={!matchSetup.sessionId || !matchSetup.playerAIds.length || !matchSetup.playerBIds.length} style={{ width: "100%", textAlign: "center", padding: "11px" }}>+ Create Match</Btn>
            </div>
          </GlassCard>

          {sessions.map(s => {
            const sMatches = matches.filter(m => m.sessionId === s.id);
            if (!sMatches.length) return null;
            return (
              <div key={s.id} style={{ marginBottom: "14px" }}>
                <div style={{ color: "#2a2a2a", ...mono, fontSize: "8px", letterSpacing: "0.16em", marginBottom: "6px", textTransform: "uppercase" }}>{s.name}</div>
                {sMatches.map(m => (
                  <GlassCard key={m.id} style={{ marginBottom: "5px", padding: "11px 14px" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <div>
                        <div style={{ color: G.aColor, fontSize: "10px", ...mono }}>{(m.playerAIds || []).map(getPlayerName).join(" / ")}</div>
                        <div style={{ color: G.bColor, fontSize: "10px", ...mono }}>{(m.playerBIds || []).map(getPlayerName).join(" / ")}</div>
                      </div>
                      <Btn onClick={() => deleteMatch(m.id)} color="#ef4444" style={{ padding: "5px 9px", fontSize: "10px" }}>✕</Btn>
                    </div>
                  </GlassCard>
                ))}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Root ─────────────────────────────────────────────────────────────────────
const DEFAULT_DATA = {
  teams: [{ id: "A", name: "Team A" }, { id: "B", name: "Team B" }],
  players: [], sessions: [], matches: [], courses: [],
};

export default function App() {
  const [page, setPage] = useState("leaderboard");
  const [data, setData] = useState(null);
  const [adminUnlocked, setAdminUnlocked] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => { const stored = await load("beehive-cup-data"); setData(stored || DEFAULT_DATA); setLoading(false); })();
    const iv = setInterval(async () => { const stored = await load("beehive-cup-data"); if (stored) setData(stored); }, 20000);
    return () => clearInterval(iv);
  }, []);

  async function handleUpdate(newData) { setData(newData); await save("beehive-cup-data", newData); }

  if (loading) return (
    <div style={{ minHeight: "100vh", background: G.bg, display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: "14px" }}>
      <Background />
      <div style={{ fontSize: "32px", position: "relative", zIndex: 1 }}>🐝</div>
      <div style={{ color: "#1e1e1e", ...mono, fontSize: "9px", letterSpacing: "0.28em", position: "relative", zIndex: 1 }}>LOADING</div>
    </div>
  );

  return (
    <>
      <link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@400;600;700&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet" />
      <div style={{ minHeight: "100vh", background: G.bg, color: G.text, paddingBottom: "80px", position: "relative" }}>
        <Background />
        <div style={{ position: "relative", zIndex: 1, maxWidth: "500px", margin: "0 auto" }}>
          {page === "leaderboard" && <LeaderboardPage data={data} />}
          {page === "sessions" && <SessionsPage data={data} />}
          {page === "score" && <ScoreEntryPage data={data} onUpdate={handleUpdate} />}
          {page === "admin" && <AdminPage data={data} onUpdate={handleUpdate} adminUnlocked={adminUnlocked} setAdminUnlocked={setAdminUnlocked} />}
        </div>
        <Nav page={page} setPage={setPage} adminUnlocked={adminUnlocked} />
      </div>
    </>
  );
}
