import { useState, useCallback, useEffect } from "react";

const JIRA_BASE = "https://lequipe.atlassian.net/browse/";

const MODULE_COLORS = [
  { bg: "rgba(200,240,100,0.08)", border: "rgba(200,240,100,0.22)", text: "#c8f064" },
  { bg: "rgba(99,179,237,0.08)",  border: "rgba(99,179,237,0.22)",  text: "#63b3ed" },
  { bg: "rgba(252,129,74,0.08)",  border: "rgba(252,129,74,0.22)",  text: "#fc814a" },
  { bg: "rgba(154,117,234,0.08)", border: "rgba(154,117,234,0.22)", text: "#9a75ea" },
  { bg: "rgba(72,199,142,0.08)",  border: "rgba(72,199,142,0.22)",  text: "#48c78e" },
  { bg: "rgba(255,183,77,0.08)",  border: "rgba(255,183,77,0.22)",  text: "#ffb74d" },
  { bg: "rgba(240,98,146,0.08)",  border: "rgba(240,98,146,0.22)",  text: "#f06292" },
  { bg: "rgba(77,208,225,0.08)",  border: "rgba(77,208,225,0.22)",  text: "#4dd0e1" },
];

function getModuleColor(index) {
  return MODULE_COLORS[index % MODULE_COLORS.length];
}

function getNextMonday(from = new Date()) {
  const d = new Date(from);
  const day = d.getDay();
  const daysUntilMonday = day === 1 ? 7 : (8 - day) % 7;
  d.setDate(d.getDate() + daysUntilMonday);
  return String(d.getDate()).padStart(2,"0") + "/" + String(d.getMonth()+1).padStart(2,"0") + "/" + d.getFullYear();
}

function parseSlackMessage(text) {
  const nextMonday = getNextMonday();

  // Nettoyer le texte : retirer les ~~ (barré Slack) et les (MR)
  // Normaliser : retirer ~~ (barré Slack), (MR), et ajouter [] autour des refs sans crochets
  const cleaned = text
    .replace(/~~[^~]*~~/g, "")
    .replace(/\(MR\)/g, "")
    .replace(/(?<!\[)\b([A-Z]+-\d+)\b(?!\])/g, "[$1]");

  // Détecter les blocs goprod (capture tout jusqu'à la fin de ligne)
  const goprodMatches = [];
  const gre = /goprod\s+([^\n]+)/gi;
  let match;
  while ((match = gre.exec(cleaned)) !== null) {
    const module = match[1]
      .replace(/\?+$/, "")
      .replace(/\s*\(.*?\)\s*$/, "") // retirer "(1550)" etc
      .replace(/[\s\d.\-]+$/, "")    // retirer version "10.58.0"
      .trim();
    if (module) goprodMatches.push({ index: match.index, module });
  }

  const blocks = goprodMatches.length === 0
    ? [{ module: "", content: cleaned }]
    : goprodMatches.map((gm, i) => ({
        module: gm.module,
        content: cleaned.slice(gm.index, goprodMatches[i+1]?.index ?? cleaned.length)
      }));

  const EXCLUDED_NAMES = ["Jean-Christophe Delanneau", "Jean-Christophe", "Delanneau"];
  const allTickets = [];

  for (const { module, content: blockContent } of blocks) {
    const sectionHierarchy = module
      ? "Release du " + nextMonday + " > " + module
      : "Release du " + nextMonday;

    const tokens = [];
    // Accepte [TC-123] ou TC-123 (avec ou sans crochets)
    const tkRegex = /(?:\[([A-Z]+-\d+|NO-TICKET)\]|(?<!\[)([A-Z]+-\d+|NO-TICKET)(?!\]))(?:\[[^\]]+\])?\s*([^\[]*?)(?=\[?[A-Z]+-\d+|@|$)|@([\wÀ-ÿ\-]+(?:\s+[\wÀ-ÿ\-]+)*)/g;
    let m;
    while ((m = tkRegex.exec(blockContent)) !== null) {
      const ref = m[1] || m[2];
      if (ref) {
        const rawTitle = (m[3] || "").trim();
        if (rawTitle) tokens.push({ type: "ticket", ref, title: rawTitle });
      } else if (m[4]) {
        const name = m[4].trim();
        if (name && !EXCLUDED_NAMES.some(ex => name.includes(ex))) {
          tokens.push({ type: "mention", name });
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
            title: "[" + ticket.ref + "] " + ticket.title,
            expectedResult: ticket.ref !== "NO-TICKET" ? JIRA_BASE + ticket.ref : "",
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

// ─── TestRail API helper (via proxy Vercel /api/testrail) ────────────────────

async function trFetch(base, email, apiKey, path, method = "GET", body = null) {
  const proxyUrl = "/api/testrail?testrailUrl=" + encodeURIComponent(base) + "&path=" + encodeURIComponent(path);
  const opts = {
    method,
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Basic " + btoa(email + ":" + apiKey),
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(proxyUrl, opts);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || "Erreur HTTP " + res.status + " sur " + path);
  }
  return res.json();
}

// ─── Logique principale de création de campagne ───────────────────────────────

const TR_CONFIG = {
  base: "https://lequipe.testrail.io",
  email: "iyahia-ext@lequipe.fr",
  apiKey: import.meta.env.VITE_TESTRAIL_API_KEY || "",
  projectId: "1",
  suiteId: "1",
};

async function createCampaign({ base, email, apiKey, projectId, suiteId, tickets, nextMonday, onStep }) {
  const grouped = tickets.reduce((acc, t) => {
    const key = t.section || "Sans module";
    if (!acc[key]) acc[key] = [];
    acc[key].push(t);
    return acc;
  }, {});
  const modules = Object.keys(grouped);

  // Résoudre la suite
  let resolvedSuiteId = suiteId ? parseInt(suiteId) : null;
  if (!resolvedSuiteId) {
    onStep("Récupération des suites...");
    const suites = await trFetch(base, email, apiKey, "get_suites/" + projectId);
    if (suites.length === 1) {
      resolvedSuiteId = suites[0].id;
    } else if (suites.length > 1) {
      resolvedSuiteId = suites[0].id; // prend la première par défaut
    }
  }

  const suiteParam = resolvedSuiteId ? "&suite_id=" + resolvedSuiteId : "";

  // Étape 1 : créer le dossier parent "Release du {lundi}"
  onStep("Création du dossier release...");
  const parentSection = await trFetch(base, email, apiKey, "add_section/" + projectId, "POST", {
    name: "Release du " + nextMonday,
    ...(resolvedSuiteId ? { suite_id: resolvedSuiteId } : {}),
  });
  const parentId = parentSection.id;

  // Étape 2 : créer les sous-dossiers et cas de test par module
  const newCaseIds = [];
  for (const [modIndex, module] of modules.entries()) {
    onStep("Création module " + (modIndex + 1) + "/" + modules.length + " : " + module + "...");
    const subSection = await trFetch(base, email, apiKey, "add_section/" + projectId, "POST", {
      name: module,
      parent_id: parentId,
      ...(resolvedSuiteId ? { suite_id: resolvedSuiteId } : {}),
    });
    const sectionId = subSection.id;

    for (const ticket of grouped[module]) {
      const created = await trFetch(base, email, apiKey, "add_case/" + sectionId, "POST", {
        title: ticket.title,
        custom_expected: ticket.expectedResult || "",
        refs: ticket.ref !== "NO-TICKET" ? ticket.ref : "",
      });
      newCaseIds.push(created.id);
    }
  }

  // Étape 3 : récupérer les cas du dossier NON REGRESSION
  onStep("Récupération des sections...");
  // Récupérer TOUTES les sections en paginant (250 par page)
  let sections = [];
  let secOffset = 0;
  while (true) {
    const resp = await trFetch(base, email, apiKey,
      "get_sections/" + projectId + "?suite_id=" + resolvedSuiteId + "&limit=250&offset=" + secOffset
    );
    const batch = resp.sections ?? resp;
    sections = sections.concat(batch);
    if (batch.length < 250) break;
    secOffset += 250;
  }
  // Cherche NON REGRESSION par nom, fallback sur ID 42 (connu)
  const nonRegSection = sections.find(s => s.name.trim().toUpperCase() === "NON REGRESSION")
    || { id: 42, name: "NON REGRESSION" };
  
  let nonRegCaseIds = [];
  if (nonRegSection) {
    // Trouver le sous-dossier "Desktop" enfant direct de NON REGRESSION
    const desktopSection = sections.find(s =>
      s.name.trim().toLowerCase() === "desktop" && s.parent_id === nonRegSection.id
    );
    if (desktopSection) {
      onStep("Récupération des cas Desktop (NON REGRESSION)...");
      // Collecter Desktop + tous ses enfants récursivement
      const getChildIds = (parentId) => {
        const children = sections.filter(s => s.parent_id === parentId);
        return [parentId, ...children.flatMap(c => getChildIds(c.id))];
      };
      const sectionIds = getChildIds(desktopSection.id);
      for (const sectionId of sectionIds) {
        let offset = 0;
        while (true) {
          const resp = await trFetch(base, email, apiKey,
            "get_cases/" + projectId + "?section_id=" + sectionId + suiteParam + "&limit=250&offset=" + offset
          );
          const cases = resp.cases ?? resp;
          nonRegCaseIds = nonRegCaseIds.concat(cases.map(c => c.id));
          if (cases.length < 250) break;
          offset += 250;
        }
      }
    }
  }

  // Étape 4 : créer le Test Run
  onStep("Création du Test Run...");
  const allCaseIds = [...new Set([...newCaseIds, ...nonRegCaseIds])];
  const run = await trFetch(base, email, apiKey, "add_run/" + projectId, "POST", {
    name: "Release du " + nextMonday,
    include_all: false,
    case_ids: allCaseIds,
    ...(resolvedSuiteId ? { suite_id: resolvedSuiteId } : {}),
    description:
      "Campagne générée automatiquement\n" +
      "• " + newCaseIds.length + " cas créés depuis Slack\n" +
      "• " + nonRegCaseIds.length + " cas NON REGRESSION" +
      (!nonRegSection ? "\n⚠️ Dossier NON REGRESSION introuvable" : ""),
  });

  return { run, newCaseIds, nonRegCaseIds, nonRegFound: !!nonRegSection };
}

// ─── Modal ────────────────────────────────────────────────────────────────────

function TestRailModal({ tickets, nextMonday, onClose }) {
  const [status, setStatus] = useState("loading");
  const [steps, setSteps] = useState([]);
  const [result, setResult] = useState(null);
  const [errorMsg, setErrorMsg] = useState("");

  const runUrl = result ? TR_CONFIG.base + "/index.php?/runs/view/" + result.run.id : null;

  useEffect(() => {
    // Lancer immédiatement à l'ouverture
    createCampaign({
      ...TR_CONFIG,
      projectId: TR_CONFIG.projectId,
      suiteId: TR_CONFIG.suiteId,
      tickets,
      nextMonday,
      onStep: (msg) => setSteps(prev => [...prev, msg]),
    }).then(res => {
      setResult(res);
      setStatus("success");
    }).catch(err => {
      setErrorMsg(err.message || "Erreur inconnue.");
      setStatus("error");
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && status !== "loading" && onClose()}>
      <div className="modal">
        <div className="modal-header">
          <div className="modal-title-wrap">
            <span className="modal-icon">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>
              </svg>
            </span>
            <div>
              <h2 className="modal-title">Créer une campagne TestRail</h2>
              <p className="modal-subtitle">{tickets.length} ticket{tickets.length > 1 ? "s" : ""} · Release du {nextMonday}</p>
            </div>
          </div>
          {status !== "loading" && (
            <button className="modal-close" onClick={onClose}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          )}
        </div>

        {status === "success" ? (
          <div className="modal-success">
            <div className="success-icon">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <polyline points="20 6 9 17 4 12"/>
              </svg>
            </div>
            <h3>Campagne créée !</h3>
            <div className="success-stats">
              <div className="stat-chip">
                <span className="stat-num">{result.newCaseIds.length}</span>
                <span className="stat-label">cas créés depuis Slack</span>
              </div>
              <div className="stat-chip">
                <span className="stat-num">{result.nonRegCaseIds.length}</span>
                <span className="stat-label">cas NON REGRESSION</span>
              </div>
              <div className="stat-chip stat-total">
                <span className="stat-num">{result.newCaseIds.length + result.nonRegCaseIds.length}</span>
                <span className="stat-label">cas au total dans le run</span>
              </div>
            </div>
            {!result.nonRegFound && (
              <div className="warn-banner">
                ⚠️ Dossier "NON REGRESSION" introuvable dans TestRail.
              </div>
            )}
            <a href={runUrl} target="_blank" rel="noopener noreferrer" className="btn-testrail-link">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
              </svg>
              Ouvrir le Test Run
            </a>
            <button className="btn-ghost" onClick={onClose} style={{marginTop: 8}}>Fermer</button>
          </div>

        ) : status === "error" ? (
          <div className="modal-body">
            <div className="error-banner" style={{marginBottom: 0}}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
              </svg>
              {errorMsg}
            </div>
            <div className="modal-footer" style={{paddingTop: 16}}>
              <button className="btn-ghost" onClick={onClose}>Fermer</button>
            </div>
          </div>

        ) : (
          <div className="modal-body">
            <div className="loading-header">
              <span className="spinner-lg" />
              <span className="loading-title">Création en cours...</span>
            </div>
            <div className="steps-log">
              {steps.map((s, i) => (
                <div key={i} className={"step-line" + (i === steps.length - 1 ? " step-active" : " step-done")}>
                  {i === steps.length - 1
                    ? <span className="spinner-sm" />
                    : <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>
                  }
                  {s}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── CSS ──────────────────────────────────────────────────────────────────────

const css = `
@import url('https://fonts.googleapis.com/css2?family=Syne:wght@700;800&family=DM+Mono:wght@400;500&display=swap');

:root {
  --bg: #080808;
  --surface: #101010;
  --surface2: #161616;
  --surface3: #1d1d1d;
  --border: rgba(255,255,255,0.06);
  --border-strong: rgba(255,255,255,0.12);
  --text: #f5f2ec;
  --text-2: #8a8680;
  --text-3: #3d3b38;
  --lime: #c8f064;
  --lime-dim: rgba(200,240,100,0.12);
  --lime-border: rgba(200,240,100,0.25);
  --lime-glow: rgba(200,240,100,0.06);
  --mono: 'DM Mono', monospace;
  --display: 'Syne', sans-serif;
  --r: 12px;
  --r-sm: 7px;
}

*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
html, body { width: 100%; min-height: 100vh; }
body {
  background: var(--bg);
  font-family: var(--mono);
  color: var(--text);
  -webkit-font-smoothing: antialiased;
  display: flex;
  justify-content: center;
  background-image: radial-gradient(ellipse 80% 50% at 50% -10%, rgba(200,240,100,0.04) 0%, transparent 60%);
}
#root { width: 100%; }

.layout {
  max-width: 800px;
  margin: 0 auto;
  padding: 56px 28px 100px;
}

/* ── HEADER ── */
.header {
  margin-bottom: 52px;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 16px;
}

.header-eyebrow {
  font-size: 10px;
  letter-spacing: 2.5px;
  text-transform: uppercase;
  color: var(--lime);
  font-weight: 500;
  margin-bottom: 8px;
  opacity: 0.8;
}

.header-left h1 {
  font-family: var(--display);
  font-weight: 800;
  font-size: 32px;
  color: var(--text);
  letter-spacing: -0.5px;
  line-height: 1;
}

.header-left h1 em {
  font-style: normal;
  color: var(--lime);
  position: relative;
}

.header-left p {
  font-size: 11.5px;
  color: var(--text-3);
  margin-top: 10px;
  letter-spacing: 0.3px;
  line-height: 1.6;
}

.release-badge {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  background: var(--lime-dim);
  border: 1px solid var(--lime-border);
  border-radius: 40px;
  padding: 8px 16px;
  font-size: 11px;
  font-weight: 500;
  color: var(--lime);
  white-space: nowrap;
  letter-spacing: 0.5px;
  margin-top: 4px;
}

.release-badge-dot {
  width: 6px; height: 6px;
  background: var(--lime);
  border-radius: 50%;
  animation: pulse 2s ease-in-out infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.5; transform: scale(0.8); }
}

/* ── INPUT PANEL ── */
.input-panel {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--r);
  overflow: hidden;
  margin-bottom: 12px;
  transition: border-color 0.2s;
}
.input-panel:focus-within {
  border-color: var(--border-strong);
}

.input-panel-header {
  padding: 11px 16px;
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  gap: 8px;
  background: var(--surface2);
}

.input-label {
  font-size: 9.5px;
  font-weight: 500;
  letter-spacing: 1.8px;
  text-transform: uppercase;
  color: var(--text-3);
}

.slack-indicator {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 9px;
  letter-spacing: 1px;
  text-transform: uppercase;
  color: var(--text-3);
}

.slack-dot {
  width: 6px; height: 6px;
  background: #611f69;
  border-radius: 50%;
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
  min-height: 110px;
  line-height: 1.8;
  padding: 16px 18px;
}
.paste-input::placeholder { color: var(--text-3); }

/* ── ACTIONS ── */
.actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 40px;
}

.btn-primary {
  display: inline-flex;
  align-items: center;
  gap: 9px;
  background: var(--lime);
  color: #080808;
  border: none;
  border-radius: var(--r-sm);
  padding: 11px 22px;
  font-family: var(--display);
  font-weight: 700;
  font-size: 13px;
  cursor: pointer;
  transition: opacity 0.15s, transform 0.12s;
  letter-spacing: 0.2px;
}
.btn-primary:hover { opacity: 0.85; transform: translateY(-1px); }
.btn-primary:active { transform: translateY(0) scale(0.99); }

.btn-ghost {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: transparent;
  color: var(--text-3);
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  padding: 10px 16px;
  font-family: var(--mono);
  font-size: 11.5px;
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s, background 0.15s;
}
.btn-ghost:hover { color: var(--text-2); border-color: var(--border-strong); background: var(--surface); }

/* ── RESULTS HEADER ── */
.results-meta {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 20px;
}

.results-title {
  font-family: var(--display);
  font-weight: 700;
  font-size: 13px;
  color: var(--text);
  letter-spacing: 0.3px;
}

.count-badge {
  font-size: 10px;
  font-weight: 500;
  color: var(--lime);
  background: var(--lime-dim);
  border: 1px solid var(--lime-border);
  border-radius: 40px;
  padding: 2px 10px;
  letter-spacing: 0.3px;
}

.divider {
  flex: 1;
  height: 1px;
  background: var(--border);
}

/* ── MODULE GROUPS ── */
.module-group { margin-bottom: 32px; }

.module-label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 9.5px;
  font-weight: 500;
  letter-spacing: 1.5px;
  text-transform: uppercase;
  border-radius: 5px;
  padding: 4px 10px;
  margin-bottom: 10px;
}

/* ── TICKET CARD ── */
.ticket-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--r);
  margin-bottom: 8px;
  overflow: hidden;
  transition: border-color 0.15s, transform 0.12s;
}
.ticket-card:hover {
  border-color: var(--border-strong);
  transform: translateY(-1px);
}

.ticket-top {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 11px 15px;
  background: var(--surface2);
  border-bottom: 1px solid var(--border);
  flex-wrap: wrap;
}

.ticket-ref-badge {
  font-size: 9.5px;
  font-weight: 500;
  border-radius: 5px;
  padding: 3px 9px;
  white-space: nowrap;
  flex-shrink: 0;
  letter-spacing: 0.3px;
}

.ticket-title-wrap { flex: 1; min-width: 0; }

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
.field-input-title:focus { border-bottom-color: var(--lime); }

.assignees { display: flex; gap: 4px; flex-wrap: wrap; flex-shrink: 0; }

.assignee-chip {
  font-size: 9.5px;
  color: var(--text-2);
  background: var(--surface3);
  border: 1px solid var(--border);
  border-radius: 40px;
  padding: 2px 9px;
  white-space: nowrap;
}

/* ── TICKET FIELDS ── */
.ticket-fields {
  padding: 14px 15px;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}

.field-full { grid-column: 1 / -1; }

.field-wrap { display: flex; flex-direction: column; gap: 4px; }

.field-label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 9px;
  font-weight: 500;
  letter-spacing: 1.5px;
  text-transform: uppercase;
  color: var(--text-3);
}

.auto-tag {
  font-size: 8px;
  font-weight: 500;
  letter-spacing: 0.5px;
  color: var(--lime);
  background: var(--lime-dim);
  border: 1px solid var(--lime-border);
  border-radius: 3px;
  padding: 1px 5px;
}

.field-input {
  width: 100%;
  background: var(--surface2);
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  padding: 8px 10px;
  color: var(--text);
  font-family: var(--mono);
  font-size: 11px;
  outline: none;
  transition: border-color 0.15s, background 0.15s;
  line-height: 1.4;
}
.field-input:focus { border-color: var(--lime); background: var(--surface); }
.field-input.has-value {
  color: var(--lime);
  background: var(--lime-glow);
  border-color: rgba(200,240,100,0.15);
}

/* ── EXPORT BAR ── */
.export-bar {
  position: sticky;
  bottom: 24px;
  margin-top: 28px;
  background: var(--surface2);
  border: 1px solid var(--border-strong);
  border-radius: var(--r);
  padding: 14px 20px;
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
  backdrop-filter: blur(12px);
}

.export-info {
  font-size: 11px;
  color: var(--text-3);
  flex: 1;
  line-height: 1.5;
}
.export-info strong { color: var(--text-2); font-weight: 500; }

.export-actions { display: flex; gap: 10px; align-items: center; }

.btn-export {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  background: transparent;
  color: var(--text-2);
  border: 1px solid var(--border-strong);
  border-radius: var(--r-sm);
  padding: 9px 17px;
  font-family: var(--mono);
  font-size: 11.5px;
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s, background 0.15s, transform 0.12s;
  white-space: nowrap;
}
.btn-export:hover { color: var(--text); border-color: rgba(255,255,255,0.2); background: var(--surface3); transform: translateY(-1px); }

.btn-testrail-main {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  background: var(--lime);
  color: #080808;
  border: none;
  border-radius: var(--r-sm);
  padding: 10px 20px;
  font-family: var(--display);
  font-weight: 700;
  font-size: 13px;
  cursor: pointer;
  transition: opacity 0.15s, transform 0.12s;
  white-space: nowrap;
  letter-spacing: 0.2px;
}
.btn-testrail-main:hover { opacity: 0.85; transform: translateY(-1px); }

/* ── EMPTY STATE ── */
.empty-state {
  text-align: center;
  padding: 80px 20px;
  color: var(--text-3);
}

.empty-icon {
  width: 56px; height: 56px;
  margin: 0 auto 20px;
  background: var(--surface2);
  border: 1px solid var(--border);
  border-radius: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.empty-state h3 {
  font-family: var(--display);
  font-weight: 700;
  font-size: 16px;
  color: var(--text-2);
  margin-bottom: 8px;
}

.empty-state p {
  font-size: 11.5px;
  line-height: 1.7;
  max-width: 280px;
  margin: 0 auto;
}

/* ── TOAST ── */
.toast {
  position: fixed;
  bottom: 28px;
  right: 28px;
  background: var(--lime);
  color: #080808;
  font-family: var(--display);
  font-weight: 700;
  font-size: 13px;
  padding: 12px 20px;
  border-radius: var(--r-sm);
  display: flex;
  align-items: center;
  gap: 9px;
  animation: toastIn 0.3s cubic-bezier(0.16,1,0.3,1);
  z-index: 999;
}

@keyframes toastIn {
  from { opacity: 0; transform: translateY(12px) scale(0.95); }
  to   { opacity: 1; transform: translateY(0) scale(1); }
}

/* ── MODAL ── */
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.8);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  padding: 20px;
  backdrop-filter: blur(6px);
  animation: fadeIn 0.18s ease;
}

@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }

.modal {
  background: var(--surface);
  border: 1px solid var(--border-strong);
  border-radius: 16px;
  width: 100%;
  max-width: 480px;
  animation: modalIn 0.25s cubic-bezier(0.16,1,0.3,1);
  overflow: hidden;
  max-height: 90vh;
  overflow-y: auto;
}

@keyframes modalIn {
  from { opacity: 0; transform: translateY(24px) scale(0.96); }
  to   { opacity: 1; transform: translateY(0) scale(1); }
}

.modal-header {
  padding: 20px 22px 18px;
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 14px;
  background: var(--surface2);
}

.modal-title-wrap { display: flex; align-items: flex-start; gap: 13px; }

.modal-icon {
  width: 36px; height: 36px;
  background: var(--lime-dim);
  border: 1px solid var(--lime-border);
  border-radius: 10px;
  display: flex; align-items: center; justify-content: center;
  color: var(--lime);
  flex-shrink: 0;
  margin-top: 1px;
}

.modal-title {
  font-family: var(--display);
  font-weight: 800;
  font-size: 16px;
  color: var(--text);
  line-height: 1.2;
}
.modal-subtitle { font-size: 11px; color: var(--text-3); margin-top: 4px; }

.modal-close {
  background: transparent;
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  width: 28px; height: 28px;
  display: flex; align-items: center; justify-content: center;
  color: var(--text-3);
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s;
  flex-shrink: 0;
}
.modal-close:hover { color: var(--text); border-color: var(--border-strong); }

.modal-body { padding: 22px; }

/* Loading */
.loading-header {
  display: flex; align-items: center; gap: 13px;
  margin-bottom: 22px;
  padding-bottom: 18px;
  border-bottom: 1px solid var(--border);
}
.loading-title {
  font-family: var(--display);
  font-weight: 700;
  font-size: 15px;
  color: var(--text);
}

.steps-log { display: flex; flex-direction: column; gap: 6px; }

.step-line {
  display: flex; align-items: center; gap: 10px;
  font-size: 11.5px;
  padding: 8px 12px;
  border-radius: var(--r-sm);
  transition: all 0.2s;
}
.step-done { color: var(--text-3); }
.step-done svg { color: var(--lime); flex-shrink: 0; }
.step-active {
  color: var(--text);
  background: var(--lime-glow);
  border: 1px solid var(--lime-border);
}

/* Error */
.error-banner {
  display: flex; align-items: flex-start; gap: 9px;
  background: rgba(240,98,146,0.07);
  border: 1px solid rgba(240,98,146,0.2);
  border-radius: var(--r-sm);
  padding: 12px 14px;
  font-size: 11.5px;
  color: #f06292;
  margin-bottom: 16px;
  line-height: 1.5;
}

.warn-banner {
  display: flex; align-items: flex-start; gap: 9px;
  background: rgba(255,183,77,0.07);
  border: 1px solid rgba(255,183,77,0.2);
  border-radius: var(--r-sm);
  padding: 10px 14px;
  font-size: 11px;
  color: #ffb74d;
  margin-bottom: 12px;
  line-height: 1.5;
}

.modal-footer {
  display: flex; justify-content: flex-end; gap: 10px;
  padding-top: 4px;
}

/* Success */
.modal-success {
  padding: 36px 22px;
  text-align: center;
  display: flex; flex-direction: column; align-items: center; gap: 14px;
}

.success-icon {
  width: 60px; height: 60px;
  background: var(--lime-dim);
  border: 1.5px solid var(--lime-border);
  border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  color: var(--lime);
}

.modal-success h3 {
  font-family: var(--display);
  font-weight: 800;
  font-size: 20px;
  color: var(--text);
}

.success-stats {
  display: flex; gap: 10px; flex-wrap: wrap; justify-content: center;
  margin: 2px 0;
}

.stat-chip {
  display: flex; flex-direction: column; align-items: center;
  background: var(--surface2);
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  padding: 12px 18px;
  min-width: 100px;
}
.stat-total {
  background: var(--lime-dim);
  border-color: var(--lime-border);
}
.stat-num {
  font-family: var(--display);
  font-weight: 800;
  font-size: 26px;
  color: var(--text);
  line-height: 1;
}
.stat-total .stat-num { color: var(--lime); }
.stat-label { font-size: 10px; color: var(--text-3); margin-top: 5px; text-align: center; }

.btn-testrail-link {
  display: inline-flex; align-items: center; gap: 8px;
  background: var(--lime);
  color: #080808;
  border: none;
  border-radius: var(--r-sm);
  padding: 11px 22px;
  font-family: var(--display);
  font-weight: 700;
  font-size: 13px;
  text-decoration: none;
  margin-top: 4px;
  transition: opacity 0.15s, transform 0.12s;
  letter-spacing: 0.2px;
}
.btn-testrail-link:hover { opacity: 0.85; transform: translateY(-1px); }

/* Spinners */
.spinner-lg {
  width: 20px; height: 20px;
  border: 2px solid var(--border-strong);
  border-top-color: var(--lime);
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
  display: inline-block;
  flex-shrink: 0;
}
.spinner-sm {
  width: 12px; height: 12px;
  border: 1.5px solid var(--border-strong);
  border-top-color: var(--lime);
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
  display: inline-block;
  flex-shrink: 0;
}
@keyframes spin { to { transform: rotate(360deg); } }

/* Responsive */
@media (max-width: 600px) {
  .layout { padding: 28px 16px 90px; }
  .header { flex-direction: column; }
  .actions { flex-direction: column; align-items: stretch; }
  .btn-primary, .btn-ghost { justify-content: center; }
  .ticket-top { flex-direction: column; align-items: flex-start; }
  .ticket-fields { grid-template-columns: 1fr; }
  .field-full { grid-column: 1; }
  .export-bar { flex-direction: column; bottom: 12px; }
  .export-actions { width: 100%; flex-direction: column; }
  .btn-export, .btn-testrail-main { width: 100%; justify-content: center; }
  .success-stats { flex-direction: column; align-items: stretch; }
}
`

// ─── App ──────────────────────────────────────────────────────────────────────

export default function App() {
  const [slackText, setSlackText] = useState("");
  const [tickets, setTickets] = useState([]);
  const [toast, setToast] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const nextMonday = getNextMonday();

  const handleParse = () => setTickets(parseSlackMessage(slackText));
  const handleClear = () => { setSlackText(""); setTickets([]); };

  const updateTicket = useCallback((id, field, value) => {
    setTickets(prev => prev.map(t => t.id === id ? { ...t, [field]: value } : t));
  }, []);

  const handleExport = () => {
    const headers = ["Title", "Expected Result", "Section", "Section Hierarchy", "References"];
    const rows = tickets.map(t => [
      '"' + t.title.replace(/"/g,'""') + '"',
      '"' + t.expectedResult.replace(/"/g,'""') + '"',
      '"' + t.section.replace(/"/g,'""') + '"',
      '"' + t.sectionHierarchy.replace(/"/g,'""') + '"',
      '"' + t.references.replace(/"/g,'""') + '"',
    ]);
    const csv = [headers.join(","), ...rows.map(r => r.join(","))].join("\n");
    const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "testrail_" + nextMonday.replace(/\//g,"-") + ".csv";
    a.click();
    URL.revokeObjectURL(url);
    setToast(true);
    setTimeout(() => setToast(false), 3000);
  };

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

        <div className="header">
          <div className="header-left">
            <div className="header-eyebrow">TestRail Prep Tool</div>
            <h1>Release <em>Builder</em></h1>
            <p>Slack → tickets extraits → campagne TestRail en 1 clic</p>
          </div>
          <div className="release-badge">
            <span className="release-badge-dot" />
            Release du {nextMonday}
          </div>
        </div>

        <div className="input-panel">
          <div className="input-panel-header">
            <span className="input-label">Message Slack</span>
            <span className="slack-indicator">
              <span className="slack-dot" />
              Slack
            </span>
          </div>
          <textarea className="paste-input" value={slackText} onChange={e => setSlackText(e.target.value)}
            placeholder="Colle ici le message du chef de release (un ou plusieurs blocs goprod)..." rows={5} />
        </div>

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
                  <div className="module-label" style={{background: color.bg, border: "1px solid " + color.border, color: color.text}}>
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>
                    </svg>
                    {mod}
                  </div>
                  {grouped[mod].map(ticket => (
                    <div key={ticket.id} className="ticket-card">
                      <div className="ticket-top">
                        <span className="ticket-ref-badge" style={{background: color.bg, border: "1px solid " + color.border, color: color.text}}>{ticket.ref}</span>
                        <div className="ticket-title-wrap">
                          <input className="field-input-title" value={ticket.title} onChange={e => updateTicket(ticket.id, "title", e.target.value)} placeholder="Titre..." />
                        </div>
                        {ticket.references && (
                          <div className="assignees">
                            {ticket.references.split(", ").map((r, i) => <span key={i} className="assignee-chip">@{r}</span>)}
                          </div>
                        )}
                      </div>
                      <div className="ticket-fields">
                        <div className="field-wrap field-full">
                          <span className="field-label">Expected Result <span className="auto-tag">AUTO</span></span>
                          <input className={"field-input" + (ticket.expectedResult ? " has-value" : "")} value={ticket.expectedResult} onChange={e => updateTicket(ticket.id, "expectedResult", e.target.value)} placeholder="Lien Jira..." />
                        </div>
                        <div className="field-wrap">
                          <span className="field-label">Section <span className="auto-tag">AUTO</span></span>
                          <input className={"field-input" + (ticket.section ? " has-value" : "")} value={ticket.section} onChange={e => updateTicket(ticket.id, "section", e.target.value)} placeholder="Module..." />
                        </div>
                        <div className="field-wrap">
                          <span className="field-label">Section Hierarchy <span className="auto-tag">AUTO</span></span>
                          <input className={"field-input" + (ticket.sectionHierarchy ? " has-value" : "")} value={ticket.sectionHierarchy} onChange={e => updateTicket(ticket.id, "sectionHierarchy", e.target.value)} placeholder="Release du ... > Module" />
                        </div>
                        <div className="field-wrap field-full">
                          <span className="field-label">References <span className="auto-tag">AUTO</span></span>
                          <input className={"field-input" + (ticket.references ? " has-value" : "")} value={ticket.references} onChange={e => updateTicket(ticket.id, "references", e.target.value)} placeholder="Assignés..." />
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              );
            })}

            <div className="export-bar">
              <div className="export-info">
                <strong>{tickets.length} ticket{tickets.length > 1 ? "s" : ""}</strong> · {modules.length} module{modules.length > 1 ? "s" : ""} · prêt pour TestRail
              </div>
              <div className="export-actions">
                <button className="btn-export" onClick={handleExport}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
                  </svg>
                  Exporter CSV
                </button>
                <button className="btn-testrail-main" onClick={() => setShowModal(true)}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>
                  </svg>
                  Créer campagne
                </button>
              </div>
            </div>
          </>
        ) : (
          <div className="empty-state">
            <div className="empty-icon">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{color: "var(--text-3)"}}>
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/>
              </svg>
            </div>
            <h3>Prêt à extraire</h3>
            <p>Colle un message Slack avec des blocs <code style={{background:"var(--surface2)",color:"var(--lime)",padding:"2px 6px",borderRadius:4,fontSize:11}}>goprod</code> puis clique sur Extraire</p>
          </div>
        )}
      </div>

      {showModal && <TestRailModal tickets={tickets} nextMonday={nextMonday} onClose={() => setShowModal(false)} />}

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