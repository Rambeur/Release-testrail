import { useState, useCallback } from "react";

const JIRA_BASE = "https://lequipe.atlassian.net/browse/";

const MODULE_COLORS = [
  { bg: "rgba(200,240,100,0.08)", border: "rgba(200,240,100,0.22)", text: "#c8f064" },   // lime
  { bg: "rgba(99,179,237,0.08)",  border: "rgba(99,179,237,0.22)",  text: "#63b3ed" },   // blue
  { bg: "rgba(252,129,74,0.08)",  border: "rgba(252,129,74,0.22)",  text: "#fc814a" },   // orange
  { bg: "rgba(154,117,234,0.08)", border: "rgba(154,117,234,0.22)", text: "#9a75ea" },   // purple
  { bg: "rgba(72,199,142,0.08)",  border: "rgba(72,199,142,0.22)",  text: "#48c78e" },   // green
  { bg: "rgba(255,183,77,0.08)",  border: "rgba(255,183,77,0.22)",  text: "#ffb74d" },   // yellow
  { bg: "rgba(240,98,146,0.08)",  border: "rgba(240,98,146,0.22)",  text: "#f06292" },   // pink
  { bg: "rgba(77,208,225,0.08)",  border: "rgba(77,208,225,0.22)",  text: "#4dd0e1" },   // cyan
];

function getModuleColor(index) {
  return MODULE_COLORS[index % MODULE_COLORS.length];
}

function getNextMonday(from = new Date()) {
  const d = new Date(from);
  const day = d.getDay();
  const daysUntilMonday = day === 1 ? 7 : (8 - day) % 7;
  d.setDate(d.getDate() + daysUntilMonday);
  return `${String(d.getDate()).padStart(2,"0")}/${String(d.getMonth()+1).padStart(2,"0")}/${d.getFullYear()}`;
}

function parseSlackMessage(text) {
  const nextMonday = getNextMonday();
  const goprodMatches = [];
  const gre = /goprod\s+([^\s\[\n@(]+)/gi;
  let match;
  while ((match = gre.exec(text)) !== null) {
    goprodMatches.push({ index: match.index, module: match[1].replace(/\?+$/, "").trim() });
  }

  const blocks = goprodMatches.length === 0
    ? [{ module: "", content: text }]
    : goprodMatches.map((gm, i) => ({
        module: gm.module,
        content: text.slice(gm.index, goprodMatches[i+1]?.index ?? text.length)
      }));

  const EXCLUDED_NAMES = ["Jean-Christophe Delanneau", "Jean-Christophe", "Delanneau"];
  const allTickets = [];

  for (const { module, content } of blocks) {
    const sectionHierarchy = module ? `Release du ${nextMonday} > ${module}` : `Release du ${nextMonday}`;
    const tokens = [];
    const tkRegex = /\[([A-Z]+-\d+|NO-TICKET)\](?:\[[^\]]+\])?\s*([^\[]*?)(?=\[|@|$)|@([\w\u00C0-\u00FF\-]+(?:\s+[\w\u00C0-\u00FF\-]+)*)/g;
    let m;
    while ((m = tkRegex.exec(content)) !== null) {
      if (m[1]) {
        const rawTitle = m[2].replace(/\(MR\)/g, "").trim();
        if (rawTitle) tokens.push({ type: "ticket", ref: m[1], title: rawTitle });
      } else if (m[3]) {
        const splitNames = m[3].trim().split(/(?<=[a-z\u00C0-\u00FF])(?=[A-Z\u00C0-\u00FF])/).map(n => n.trim()).filter(Boolean);
        for (const name of splitNames) {
          if (!EXCLUDED_NAMES.some(ex => name.includes(ex))) tokens.push({ type: "mention", name });
        }
      }
    }

    let i = 0;
    while (i < tokens.length) {
      if (tokens[i].type === "ticket") {
        const groupTickets = [];
        while (i < tokens.length && tokens[i].type === "ticket") { groupTickets.push(tokens[i]); i++; }
        const groupMentions = [];
        while (i < tokens.length && tokens[i].type === "mention") { groupMentions.push(tokens[i].name); i++; }
        for (const ticket of groupTickets) {
          allTickets.push({
            id: crypto.randomUUID(),
            ref: ticket.ref,
            title: `[${ticket.ref}] ${ticket.title}`,
            expectedResult: ticket.ref !== "NO-TICKET" ? `${JIRA_BASE}${ticket.ref}` : "",
            section: module,
            sectionHierarchy,
            references: groupMentions.join(", "),
          });
        }
      } else { i++; }
    }
  }
  return allTickets;
}

const css = `
@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=Cabinet+Grotesk:wght@700;800&display=swap');

:root {
  --bg: #0e0e0e;
  --surface: #161616;
  --surface2: #1c1c1c;
  --border: #262626;
  --border-strong: #333333;
  --text: #f0ece4;
  --text-2: #a8a49c;
  --text-3: #555250;
  --accent: #c8f064;
  --accent-light: rgba(200,240,100,0.08);
  --accent-border: rgba(200,240,100,0.2);
  --green: #c8f064;
  --green-light: rgba(200,240,100,0.07);
  --green-border: rgba(200,240,100,0.18);
  --mono: 'IBM Plex Mono', monospace;
  --display: 'Cabinet Grotesk', sans-serif;
  --radius: 10px;
  --radius-sm: 6px;
  --shadow: 0 1px 4px rgba(0,0,0,0.3), 0 4px 16px rgba(0,0,0,0.2);
  --shadow-lg: 0 4px 24px rgba(0,0,0,0.4), 0 1px 4px rgba(0,0,0,0.3);
}

* { box-sizing: border-box; margin: 0; padding: 0; }

html, body {
  width: 100%;
  min-height: 100vh;
}

body {
  background: var(--bg);
  font-family: var(--mono);
  color: var(--text);
  -webkit-font-smoothing: antialiased;
  display: flex;
  justify-content: center;
}

#root {
  width: 100%;
}

.layout {
  max-width: 780px;
  margin: 0 auto;
  padding: 48px 24px 80px;
}

/* HEADER */
.header {
  margin-bottom: 36px;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 12px;
}

.header-left h1 {
  font-family: var(--display);
  font-weight: 800;
  font-size: 26px;
  color: var(--text);
  letter-spacing: -0.5px;
  line-height: 1.1;
}

.header-left h1 em {
  font-style: normal;
  color: var(--accent);
}

.header-left p {
  font-size: 11px;
  color: var(--text-3);
  margin-top: 5px;
  letter-spacing: 0.2px;
  line-height: 1.5;
}

.release-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: var(--accent-light);
  border: 1px solid var(--accent-border);
  border-radius: 20px;
  padding: 6px 14px;
  font-size: 11px;
  font-weight: 500;
  color: var(--accent);
  white-space: nowrap;
  letter-spacing: 0.2px;
}

.release-badge svg { flex-shrink: 0; }

/* INPUT PANEL */
.input-panel {
  background: var(--surface);
  border: 1.5px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  overflow: hidden;
  margin-bottom: 16px;
}

.input-panel-header {
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  gap: 8px;
  background: var(--surface2);
}

.input-label {
  font-size: 10px;
  font-weight: 500;
  letter-spacing: 1.2px;
  text-transform: uppercase;
  color: var(--text-3);
}

.slack-dot {
  width: 8px; height: 8px;
  background: #4a154b;
  border-radius: 50%;
  margin-left: auto;
}

.paste-input {
  width: 100%;
  background: transparent;
  border: none;
  outline: none;
  color: var(--text-2);
  font-family: var(--mono);
  font-size: 12px;
  resize: none;
  min-height: 120px;
  line-height: 1.7;
  padding: 16px;
}

.paste-input::placeholder { color: var(--text-3); }

/* ACTIONS */
.actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 32px;
}

.btn-primary {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  background: var(--accent);
  color: #0e0e0e;
  border: none;
  border-radius: var(--radius-sm);
  padding: 10px 20px;
  font-family: var(--display);
  font-weight: 700;
  font-size: 13px;
  cursor: pointer;
  transition: opacity 0.15s, transform 0.1s;
  box-shadow: 0 2px 12px rgba(200,240,100,0.2);
}
.btn-primary:hover { opacity: 0.88; transform: translateY(-1px); }
.btn-primary:active { transform: translateY(0); }

.btn-ghost {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: transparent;
  color: var(--text-3);
  border: 1.5px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 9px 16px;
  font-family: var(--mono);
  font-size: 12px;
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s, background 0.15s;
}
.btn-ghost:hover { color: var(--text); border-color: var(--border-strong); background: var(--surface); }

/* RESULTS HEADER */
.results-meta {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 16px;
}

.results-title {
  font-family: var(--display);
  font-weight: 700;
  font-size: 13px;
  color: var(--text);
  letter-spacing: 0.2px;
}

.count-badge {
  font-size: 10px;
  font-weight: 500;
  color: var(--text-3);
  background: var(--surface2);
  border: 1px solid var(--border);
  border-radius: 20px;
  padding: 2px 10px;
}

.divider {
  flex: 1;
  height: 1px;
  background: var(--border);
}

/* MODULE GROUPS */
.module-group { margin-bottom: 28px; }

.module-label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 10px;
  font-weight: 500;
  letter-spacing: 1px;
  text-transform: uppercase;
  color: var(--accent);
  background: var(--accent-light);
  border: 1px solid var(--accent-border);
  border-radius: 4px;
  padding: 3px 10px;
  margin-bottom: 10px;
}

/* TICKET CARD */
.ticket-card {
  background: var(--surface);
  border: 1.5px solid var(--border);
  border-radius: var(--radius);
  margin-bottom: 10px;
  box-shadow: var(--shadow);
  overflow: hidden;
  transition: border-color 0.15s, box-shadow 0.15s;
}
.ticket-card:hover { border-color: var(--border-strong); box-shadow: var(--shadow-lg); }

.ticket-top {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 16px;
  background: var(--surface2);
  border-bottom: 1px solid var(--border);
  flex-wrap: wrap;
}

.ticket-ref-badge {
  font-size: 10px;
  font-weight: 500;
  color: var(--accent);
  background: var(--accent-light);
  border: 1px solid var(--accent-border);
  border-radius: 4px;
  padding: 3px 8px;
  white-space: nowrap;
  flex-shrink: 0;
}

.ticket-title-wrap {
  flex: 1;
  min-width: 0;
}

.field-input-title {
  width: 100%;
  background: transparent;
  border: none;
  outline: none;
  color: var(--text);
  font-family: var(--mono);
  font-size: 12px;
  font-weight: 500;
  padding: 2px 0;
  border-bottom: 1.5px solid transparent;
  transition: border-color 0.15s;
}
.field-input-title:focus { border-bottom-color: var(--accent); }

.assignees {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
  flex-shrink: 0;
}

.assignee-chip {
  font-size: 10px;
  color: var(--text-2);
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 20px;
  padding: 2px 8px;
  white-space: nowrap;
}

/* TICKET FIELDS */
.ticket-fields {
  padding: 14px 16px;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}

@media (max-width: 540px) {
  .ticket-fields { grid-template-columns: 1fr; }
  .field-full { grid-column: 1 !important; }
}

.field-full { grid-column: 1 / -1; }

.field-wrap {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.field-label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 9px;
  font-weight: 500;
  letter-spacing: 1.2px;
  text-transform: uppercase;
  color: var(--text-3);
}

.auto-tag {
  font-size: 8px;
  font-weight: 500;
  letter-spacing: 0.5px;
  color: var(--green);
  background: var(--green-light);
  border: 1px solid var(--green-border);
  border-radius: 3px;
  padding: 1px 5px;
}

.field-input {
  width: 100%;
  background: var(--surface2);
  border: 1.5px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 8px 10px;
  color: var(--text);
  font-family: var(--mono);
  font-size: 11px;
  outline: none;
  transition: border-color 0.15s, background 0.15s;
  line-height: 1.4;
}
.field-input:focus { border-color: var(--accent); background: var(--surface); }
.field-input.has-value {
  color: var(--green);
  background: var(--green-light);
  border-color: var(--green-border);
}

/* EXPORT BAR */
.export-bar {
  position: sticky;
  bottom: 24px;
  margin-top: 24px;
  background: var(--surface);
  border: 1.5px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow-lg);
  padding: 14px 20px;
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
}

.export-info {
  font-size: 11px;
  color: var(--text-3);
  flex: 1;
}

.export-info strong { color: var(--text-2); }

.btn-export {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  background: var(--accent);
  color: #0e0e0e;
  border: none;
  border-radius: var(--radius-sm);
  padding: 10px 22px;
  font-family: var(--display);
  font-weight: 700;
  font-size: 13px;
  cursor: pointer;
  transition: opacity 0.15s, transform 0.1s;
  white-space: nowrap;
  box-shadow: 0 2px 12px rgba(200,240,100,0.2);
}
.btn-export:hover { opacity: 0.88; transform: translateY(-1px); }
.btn-export:active { transform: translateY(0); }

/* EMPTY STATE */
.empty-state {
  text-align: center;
  padding: 64px 20px;
  color: var(--text-3);
}

.empty-icon {
  font-size: 36px;
  margin-bottom: 12px;
  opacity: 0.4;
}

.empty-state h3 {
  font-family: var(--display);
  font-weight: 700;
  font-size: 15px;
  color: var(--text-2);
  margin-bottom: 6px;
}

.empty-state p {
  font-size: 11px;
  line-height: 1.7;
  max-width: 300px;
  margin: 0 auto;
}

/* TOAST */
.toast {
  position: fixed;
  bottom: 28px;
  right: 28px;
  background: var(--text);
  color: var(--bg);
  font-family: var(--display);
  font-weight: 700;
  font-size: 13px;
  padding: 12px 20px;
  border-radius: var(--radius-sm);
  display: flex;
  align-items: center;
  gap: 8px;
  animation: slideUp 0.25s cubic-bezier(0.16,1,0.3,1);
  z-index: 999;
  box-shadow: 0 8px 32px rgba(0,0,0,0.15);
}

@keyframes slideUp {
  from { opacity: 0; transform: translateY(16px) scale(0.96); }
  to   { opacity: 1; transform: translateY(0) scale(1); }
}

/* RESPONSIVE */
@media (max-width: 600px) {
  .layout { padding: 24px 16px 80px; }
  .header { flex-direction: column; gap: 10px; }
  .actions { flex-direction: column; align-items: stretch; }
  .btn-primary, .btn-ghost { justify-content: center; }
  .ticket-top { flex-direction: column; align-items: flex-start; }
  .export-bar { flex-direction: column; bottom: 12px; }
  .btn-export { width: 100%; justify-content: center; }
}
`;

export default function App() {
  const [slackText, setSlackText] = useState("");
  const [tickets, setTickets] = useState([]);
  const [toast, setToast] = useState(false);
  const nextMonday = getNextMonday();

  const handleParse = () => setTickets(parseSlackMessage(slackText));
  const handleClear = () => { setSlackText(""); setTickets([]); };

  const updateTicket = useCallback((id, field, value) => {
    setTickets(prev => prev.map(t => t.id === id ? { ...t, [field]: value } : t));
  }, []);

  const handleExport = () => {
    const headers = ["Title", "Expected Result", "Section", "Section Hierarchy", "References"];
    const rows = tickets.map(t => [
      `"${t.title.replace(/"/g,'""')}"`,
      `"${t.expectedResult.replace(/"/g,'""')}"`,
      `"${t.section.replace(/"/g,'""')}"`,
      `"${t.sectionHierarchy.replace(/"/g,'""')}"`,
      `"${t.references.replace(/"/g,'""')}"`,
    ]);
    const csv = [headers.join(","), ...rows.map(r => r.join(","))].join("\n");
    const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `testrail_${nextMonday.replace(/\//g,"-")}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    setToast(true);
    setTimeout(() => setToast(false), 3000);
  };

  // Group tickets by module for display
  const grouped = tickets.reduce((acc, t) => {
    const key = t.section || "—";
    if (!acc[key]) acc[key] = [];
    acc[key].push(t);
    return acc;
  }, {});

  const modules = Object.keys(grouped);

  return (
    <>
      <style>{css}</style>
      <div className="layout">

        {/* HEADER */}
        <div className="header">
          <div className="header-left">
            <h1>TestRail <em>Release</em> Prep</h1>
            <p>Colle le message Slack · extraction automatique · export CSV</p>
          </div>
          <div className="release-badge">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>
            </svg>
            Release du {nextMonday}
          </div>
        </div>

        {/* INPUT */}
        <div className="input-panel">
          <div className="input-panel-header">
            <span className="input-label">Message Slack</span>
            <span className="slack-dot" title="Slack" />
          </div>
          <textarea
            className="paste-input"
            value={slackText}
            onChange={e => setSlackText(e.target.value)}
            placeholder="Colle ici le message du chef de release (un ou plusieurs blocs goprod)..."
            rows={5}
          />
        </div>

        {/* ACTIONS */}
        <div className="actions">
          <button className="btn-primary" onClick={handleParse}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
            </svg>
            Extraire les tickets
          </button>
          {tickets.length > 0 && (
            <button className="btn-ghost" onClick={handleClear}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-3.51"/>
              </svg>
              Réinitialiser
            </button>
          )}
        </div>

        {/* RESULTS */}
        {tickets.length > 0 ? (
          <>
            <div className="results-meta">
              <span className="results-title">Tickets extraits</span>
              <span className="count-badge">{tickets.length} ticket{tickets.length > 1 ? "s" : ""}</span>
              <div className="divider" />
            </div>

            {modules.map((mod, modIndex) => {
              const color = getModuleColor(modIndex);
              return (
              <div key={mod} className="module-group">
                <div className="module-label" style={{background: color.bg, border: `1px solid ${color.border}`, color: color.text}}>
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>
                  </svg>
                  {mod}
                </div>

                {grouped[mod].map(ticket => (
                  <div key={ticket.id} className="ticket-card">
                    <div className="ticket-top">
                      <span className="ticket-ref-badge" style={{background: color.bg, border: `1px solid ${color.border}`, color: color.text}}>{ticket.ref}</span>
                      <div className="ticket-title-wrap">
                        <input
                          className="field-input-title"
                          value={ticket.title}
                          onChange={e => updateTicket(ticket.id, "title", e.target.value)}
                          placeholder="Titre..."
                        />
                      </div>
                      {ticket.references && (
                        <div className="assignees">
                          {ticket.references.split(", ").map((r, i) => (
                            <span key={i} className="assignee-chip">@{r}</span>
                          ))}
                        </div>
                      )}
                    </div>

                    <div className="ticket-fields">
                      <div className="field-wrap field-full">
                        <span className="field-label">Expected Result <span className="auto-tag">AUTO</span></span>
                        <input
                          className={`field-input${ticket.expectedResult ? " has-value" : ""}`}
                          value={ticket.expectedResult}
                          onChange={e => updateTicket(ticket.id, "expectedResult", e.target.value)}
                          placeholder="Lien Jira..."
                        />
                      </div>
                      <div className="field-wrap">
                        <span className="field-label">Section <span className="auto-tag">AUTO</span></span>
                        <input
                          className={`field-input${ticket.section ? " has-value" : ""}`}
                          value={ticket.section}
                          onChange={e => updateTicket(ticket.id, "section", e.target.value)}
                          placeholder="Module..."
                        />
                      </div>
                      <div className="field-wrap">
                        <span className="field-label">Section Hierarchy <span className="auto-tag">AUTO</span></span>
                        <input
                          className={`field-input${ticket.sectionHierarchy ? " has-value" : ""}`}
                          value={ticket.sectionHierarchy}
                          onChange={e => updateTicket(ticket.id, "sectionHierarchy", e.target.value)}
                          placeholder="Release du ... > Module"
                        />
                      </div>
                      <div className="field-wrap field-full">
                        <span className="field-label">References <span className="auto-tag">AUTO</span></span>
                        <input
                          className={`field-input${ticket.references ? " has-value" : ""}`}
                          value={ticket.references}
                          onChange={e => updateTicket(ticket.id, "references", e.target.value)}
                          placeholder="Assignés..."
                        />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            );})}

            {/* EXPORT BAR */}
            <div className="export-bar">
              <div className="export-info">
                <strong>{tickets.length} ticket{tickets.length > 1 ? "s" : ""}</strong> · {modules.length} module{modules.length > 1 ? "s" : ""} · prêt pour TestRail
              </div>
              <button className="btn-export" onClick={handleExport}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
                </svg>
                Exporter CSV
              </button>
            </div>
          </>
        ) : (
          <div className="empty-state">
            <div className="empty-icon">📋</div>
            <h3>Prêt à extraire</h3>
            <p>Colle un message Slack avec des blocs <code style={{background:"#222",color:"#c8f064",padding:"1px 5px",borderRadius:3}}>goprod</code> puis clique sur Extraire</p>
          </div>
        )}
      </div>

      {toast && (
        <div className="toast">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
          CSV exporté avec succès
        </div>
      )}
    </>
  );
}