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

// Génère le nom du run selon le module
function getRunName(module, nextMonday) {
  if (!module) return "Release web du " + nextMonday;
  if (/^and-/i.test(module)) return "Release " + module;
  if (/^ios-/i.test(module)) return "Release " + module;
  return "Release web du " + nextMonday;
}

function parseSlackMessage(text) {
  const nextMonday = getNextMonday();

  // Normaliser : retirer ~~ (barré Slack), (MR), et ajouter [] autour des refs sans crochets
  text = text
    .replace(/~~[^~]*~~/g, "")
    .replace(/\(MR\)/g, "")
    .replace(/(?<!\[)\b([A-Z]+-\d+)\b(?!\])/g, "[$1]");

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
    const runName = getRunName(module, nextMonday);
    const sectionHierarchy = module ? runName + " > " + module : runName;
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
            title: "[" + ticket.ref + "] " + ticket.title,
            expectedResult: ticket.ref !== "NO-TICKET" ? JIRA_BASE + ticket.ref : "",
            section: module,
            sectionHierarchy,
            runName,
            references: groupMentions.join(", "),
          });
        }
      } else { i++; }
    }
  }
  return allTickets;
}

// ─── TestRail API helper ──────────────────────────────────────────────────────

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

// ─── Config TestRail ──────────────────────────────────────────────────────────

const TR_CONFIG = {
  base: "https://lequipe.testrail.io",
  email: "iyahia-ext@lequipe.fr",
  apiKey: import.meta.env.VITE_TESTRAIL_API_KEY || "",
  projectId: "1",
  suiteId: "1",
};

// ─── Création de campagne ─────────────────────────────────────────────────────

async function createCampaign({ base, email, apiKey, projectId, suiteId, tickets, nextMonday, onStep }) {
  const grouped = tickets.reduce((acc, t) => {
    const key = t.section || "Sans module";
    if (!acc[key]) acc[key] = [];
    acc[key].push(t);
    return acc;
  }, {});
  const modules = Object.keys(grouped);

  // Déterminer le nom du run depuis le premier ticket
  const runName = tickets[0]?.runName || ("Release web du " + nextMonday);

  let resolvedSuiteId = suiteId ? parseInt(suiteId) : null;
  if (!resolvedSuiteId) {
    onStep("Récupération des suites...");
    const suites = await trFetch(base, email, apiKey, "get_suites/" + projectId);
    resolvedSuiteId = suites[0]?.id || null;
  }

  const suiteParam = resolvedSuiteId ? "&suite_id=" + resolvedSuiteId : "";

  // Étape 1 : dossier parent
  onStep("Création du dossier release...");
  const parentSection = await trFetch(base, email, apiKey, "add_section/" + projectId, "POST", {
    name: runName,
    ...(resolvedSuiteId ? { suite_id: resolvedSuiteId } : {}),
  });
  const parentId = parentSection.id;

  // Étape 2 : sous-dossiers et cas
  const newCaseIds = [];
  for (const [modIndex, module] of modules.entries()) {
    onStep("Création module " + (modIndex + 1) + "/" + modules.length + " : " + module + "...");
    const subSection = await trFetch(base, email, apiKey, "add_section/" + projectId, "POST", {
      name: module,
      parent_id: parentId,
      ...(resolvedSuiteId ? { suite_id: resolvedSuiteId } : {}),
    });
    for (const ticket of grouped[module]) {
      const created = await trFetch(base, email, apiKey, "add_case/" + subSection.id, "POST", {
        title: ticket.title,
        custom_expected: ticket.expectedResult || "",
        refs: ticket.ref !== "NO-TICKET" ? ticket.ref : "",
      });
      newCaseIds.push(created.id);
    }
  }

  // Étape 3 : sections NON REGRESSION (paginées)
  onStep("Récupération des sections...");
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

  const nonRegSection = sections.find(s => s.name.trim().toUpperCase() === "NON REGRESSION")
    || { id: 42, name: "NON REGRESSION" };

  let nonRegCaseIds = [];
  if (nonRegSection) {
    const desktopSection = sections.find(s =>
      s.name.trim().toLowerCase() === "desktop" && s.parent_id === nonRegSection.id
    );
    if (desktopSection) {
      onStep("Récupération des cas Desktop (NON REGRESSION)...");
      const getChildIds = (parentId) => {
        const children = sections.filter(s => s.parent_id === parentId);
        return [parentId, ...children.flatMap(c => getChildIds(c.id))];
      };
      for (const sectionId of getChildIds(desktopSection.id)) {
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

  // Étape 4 : créer le run
  onStep("Création du Test Run...");
  const allCaseIds = [...new Set([...newCaseIds, ...nonRegCaseIds])];
  const run = await trFetch(base, email, apiKey, "add_run/" + projectId, "POST", {
    name: runName,
    include_all: false,
    case_ids: allCaseIds,
    ...(resolvedSuiteId ? { suite_id: resolvedSuiteId } : {}),
    description:
      "Campagne générée automatiquement\n" +
      "• " + newCaseIds.length + " cas créés depuis Slack\n" +
      "• " + nonRegCaseIds.length + " cas NON REGRESSION",
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
    createCampaign({
      ...TR_CONFIG,
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
              <p className="modal-subtitle">{tickets.length} ticket{tickets.length > 1 ? "s" : ""} · {tickets[0]?.runName || "Release web du " + nextMonday}</p>
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
@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=Cabinet+Grotesk:wght@700;800&display=swap');

:root {
  --bg: #0e0e0e; --surface: #161616; --surface2: #1c1c1c;
  --border: #262626; --border-strong: #333333;
  --text: #f0ece4; --text-2: #a8a49c; --text-3: #555250;
  --accent: #c8f064; --accent-light: rgba(200,240,100,0.08); --accent-border: rgba(200,240,100,0.2);
  --green: #c8f064; --green-light: rgba(200,240,100,0.07); --green-border: rgba(200,240,100,0.18);
  --blue: #63b3ed; --blue-light: rgba(99,179,237,0.08); --blue-border: rgba(99,179,237,0.22);
  --red: #f06292; --red-light: rgba(240,98,146,0.08); --red-border: rgba(240,98,146,0.22);
  --orange: #ffb74d; --orange-light: rgba(255,183,77,0.08); --orange-border: rgba(255,183,77,0.22);
  --mono: 'IBM Plex Mono', monospace; --display: 'Cabinet Grotesk', sans-serif;
  --radius: 10px; --radius-sm: 6px;
  --shadow: 0 1px 4px rgba(0,0,0,0.3), 0 4px 16px rgba(0,0,0,0.2);
  --shadow-lg: 0 4px 24px rgba(0,0,0,0.4), 0 1px 4px rgba(0,0,0,0.3);
}

* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { width: 100%; min-height: 100vh; }
body { background: var(--bg); font-family: var(--mono); color: var(--text); -webkit-font-smoothing: antialiased; display: flex; justify-content: center; }
#root { width: 100%; }
.layout { max-width: 780px; margin: 0 auto; padding: 48px 24px 80px; }

.header { margin-bottom: 36px; display: flex; align-items: flex-start; justify-content: space-between; flex-wrap: wrap; gap: 12px; }
.header-left h1 { font-family: var(--display); font-weight: 800; font-size: 26px; color: var(--text); letter-spacing: -0.5px; line-height: 1.1; }
.header-left h1 em { font-style: normal; color: var(--accent); }
.header-left p { font-size: 11px; color: var(--text-3); margin-top: 5px; line-height: 1.5; }
.release-badge { display: inline-flex; align-items: center; gap: 6px; background: var(--accent-light); border: 1px solid var(--accent-border); border-radius: 20px; padding: 6px 14px; font-size: 11px; font-weight: 500; color: var(--accent); white-space: nowrap; }

.input-panel { background: var(--surface); border: 1.5px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow); overflow: hidden; margin-bottom: 16px; }
.input-panel-header { padding: 12px 16px; border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 8px; background: var(--surface2); }
.input-label { font-size: 10px; font-weight: 500; letter-spacing: 1.2px; text-transform: uppercase; color: var(--text-3); }
.slack-dot { width: 8px; height: 8px; background: #4a154b; border-radius: 50%; margin-left: auto; }
.paste-input { width: 100%; background: transparent; border: none; outline: none; color: var(--text-2); font-family: var(--mono); font-size: 12px; resize: none; min-height: 120px; line-height: 1.7; padding: 16px; }
.paste-input::placeholder { color: var(--text-3); }

.actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 32px; }
.btn-primary { display: inline-flex; align-items: center; gap: 8px; background: var(--accent); color: #0e0e0e; border: none; border-radius: var(--radius-sm); padding: 10px 20px; font-family: var(--display); font-weight: 700; font-size: 13px; cursor: pointer; transition: opacity 0.15s, transform 0.1s; box-shadow: 0 2px 12px rgba(200,240,100,0.2); }
.btn-primary:hover { opacity: 0.88; transform: translateY(-1px); }
.btn-ghost { display: inline-flex; align-items: center; gap: 6px; background: transparent; color: var(--text-3); border: 1.5px solid var(--border); border-radius: var(--radius-sm); padding: 9px 16px; font-family: var(--mono); font-size: 12px; cursor: pointer; transition: color 0.15s, border-color 0.15s, background 0.15s; }
.btn-ghost:hover { color: var(--text); border-color: var(--border-strong); background: var(--surface); }

.results-meta { display: flex; align-items: center; gap: 10px; margin-bottom: 16px; }
.results-title { font-family: var(--display); font-weight: 700; font-size: 13px; color: var(--text); }
.count-badge { font-size: 10px; color: var(--text-3); background: var(--surface2); border: 1px solid var(--border); border-radius: 20px; padding: 2px 10px; }
.divider { flex: 1; height: 1px; background: var(--border); }

.module-group { margin-bottom: 28px; }
.module-label { display: inline-flex; align-items: center; gap: 6px; font-size: 10px; font-weight: 500; letter-spacing: 1px; text-transform: uppercase; border-radius: 4px; padding: 3px 10px; margin-bottom: 10px; }

.ticket-card { background: var(--surface); border: 1.5px solid var(--border); border-radius: var(--radius); margin-bottom: 10px; box-shadow: var(--shadow); overflow: hidden; transition: border-color 0.15s, box-shadow 0.15s; }
.ticket-card:hover { border-color: var(--border-strong); box-shadow: var(--shadow-lg); }
.ticket-top { display: flex; align-items: center; gap: 10px; padding: 12px 16px; background: var(--surface2); border-bottom: 1px solid var(--border); flex-wrap: wrap; }
.ticket-ref-badge { font-size: 10px; font-weight: 500; border-radius: 4px; padding: 3px 8px; white-space: nowrap; flex-shrink: 0; }
.ticket-title-wrap { flex: 1; min-width: 0; }
.field-input-title { width: 100%; background: transparent; border: none; outline: none; color: var(--text); font-family: var(--mono); font-size: 12px; font-weight: 500; padding: 2px 0; border-bottom: 1.5px solid transparent; transition: border-color 0.15s; }
.field-input-title:focus { border-bottom-color: var(--accent); }
.assignees { display: flex; gap: 4px; flex-wrap: wrap; flex-shrink: 0; }
.assignee-chip { font-size: 10px; color: var(--text-2); background: var(--bg); border: 1px solid var(--border); border-radius: 20px; padding: 2px 8px; white-space: nowrap; }

.ticket-fields { padding: 14px 16px; display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.field-full { grid-column: 1 / -1; }
.field-wrap { display: flex; flex-direction: column; gap: 4px; }
.field-label { display: flex; align-items: center; gap: 6px; font-size: 9px; font-weight: 500; letter-spacing: 1.2px; text-transform: uppercase; color: var(--text-3); }
.auto-tag { font-size: 8px; font-weight: 500; color: var(--green); background: var(--green-light); border: 1px solid var(--green-border); border-radius: 3px; padding: 1px 5px; }
.field-input { width: 100%; background: var(--surface2); border: 1.5px solid var(--border); border-radius: var(--radius-sm); padding: 8px 10px; color: var(--text); font-family: var(--mono); font-size: 11px; outline: none; transition: border-color 0.15s, background 0.15s; line-height: 1.4; }
.field-input:focus { border-color: var(--accent); background: var(--surface); }
.field-input.has-value { color: var(--green); background: var(--green-light); border-color: var(--green-border); }

.export-bar { position: sticky; bottom: 24px; margin-top: 24px; background: var(--surface); border: 1.5px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow-lg); padding: 14px 20px; display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
.export-info { font-size: 11px; color: var(--text-3); flex: 1; }
.export-info strong { color: var(--text-2); }
.export-actions { display: flex; gap: 10px; align-items: center; }
.btn-export { display: inline-flex; align-items: center; gap: 8px; background: transparent; color: var(--text-2); border: 1.5px solid var(--border-strong); border-radius: var(--radius-sm); padding: 10px 18px; font-family: var(--display); font-weight: 700; font-size: 13px; cursor: pointer; transition: color 0.15s, border-color 0.15s, background 0.15s, transform 0.1s; white-space: nowrap; }
.btn-export:hover { color: var(--text); border-color: var(--text-3); background: var(--surface2); transform: translateY(-1px); }
.btn-testrail-main { display: inline-flex; align-items: center; gap: 8px; background: var(--accent); color: #0e0e0e; border: none; border-radius: var(--radius-sm); padding: 10px 22px; font-family: var(--display); font-weight: 700; font-size: 13px; cursor: pointer; transition: opacity 0.15s, transform 0.1s; white-space: nowrap; box-shadow: 0 2px 12px rgba(200,240,100,0.2); }
.btn-testrail-main:hover { opacity: 0.88; transform: translateY(-1px); }

.empty-state { text-align: center; padding: 64px 20px; color: var(--text-3); }
.empty-icon { font-size: 36px; margin-bottom: 12px; opacity: 0.4; }
.empty-state h3 { font-family: var(--display); font-weight: 700; font-size: 15px; color: var(--text-2); margin-bottom: 6px; }
.empty-state p { font-size: 11px; line-height: 1.7; max-width: 300px; margin: 0 auto; }

.toast { position: fixed; bottom: 28px; right: 28px; background: var(--text); color: var(--bg); font-family: var(--display); font-weight: 700; font-size: 13px; padding: 12px 20px; border-radius: var(--radius-sm); display: flex; align-items: center; gap: 8px; animation: slideUp 0.25s cubic-bezier(0.16,1,0.3,1); z-index: 999; box-shadow: 0 8px 32px rgba(0,0,0,0.15); }
@keyframes slideUp { from { opacity: 0; transform: translateY(16px) scale(0.96); } to { opacity: 1; transform: translateY(0) scale(1); } }

.modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.72); display: flex; align-items: center; justify-content: center; z-index: 1000; padding: 20px; backdrop-filter: blur(4px); animation: fadeIn 0.15s ease; }
@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
.modal { background: var(--surface); border: 1.5px solid var(--border-strong); border-radius: 14px; width: 100%; max-width: 540px; box-shadow: 0 24px 64px rgba(0,0,0,0.6); animation: modalUp 0.2s cubic-bezier(0.16,1,0.3,1); overflow: hidden; max-height: 90vh; overflow-y: auto; }
@keyframes modalUp { from { opacity: 0; transform: translateY(20px) scale(0.97); } to { opacity: 1; transform: translateY(0) scale(1); } }
.modal-header { padding: 20px 20px 16px; border-bottom: 1px solid var(--border); display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; background: var(--surface2); position: sticky; top: 0; z-index: 1; }
.modal-title-wrap { display: flex; align-items: flex-start; gap: 12px; }
.modal-icon { width: 34px; height: 34px; background: var(--accent-light); border: 1px solid var(--accent-border); border-radius: 8px; display: flex; align-items: center; justify-content: center; color: var(--accent); flex-shrink: 0; margin-top: 2px; }
.modal-title { font-family: var(--display); font-weight: 800; font-size: 16px; color: var(--text); line-height: 1.2; }
.modal-subtitle { font-size: 11px; color: var(--text-3); margin-top: 3px; }
.modal-close { background: transparent; border: 1px solid var(--border); border-radius: var(--radius-sm); width: 28px; height: 28px; display: flex; align-items: center; justify-content: center; color: var(--text-3); cursor: pointer; transition: color 0.15s, border-color 0.15s; flex-shrink: 0; }
.modal-close:hover { color: var(--text); border-color: var(--border-strong); }
.modal-body { padding: 20px; }
.loading-header { display: flex; align-items: center; gap: 12px; margin-bottom: 20px; padding-bottom: 16px; border-bottom: 1px solid var(--border); }
.loading-title { font-family: var(--display); font-weight: 700; font-size: 15px; color: var(--text); }
.steps-log { display: flex; flex-direction: column; gap: 8px; }
.step-line { display: flex; align-items: center; gap: 10px; font-size: 12px; padding: 8px 12px; border-radius: var(--radius-sm); transition: all 0.2s; }
.step-done { color: var(--text-3); background: transparent; }
.step-done svg { color: var(--green); flex-shrink: 0; }
.step-active { color: var(--text); background: var(--surface2); border: 1px solid var(--border); }
.error-banner { display: flex; align-items: center; gap: 8px; background: var(--red-light); border: 1px solid var(--red-border); border-radius: var(--radius-sm); padding: 10px 14px; font-size: 11px; color: var(--red); margin-bottom: 16px; }
.warn-banner { display: flex; align-items: center; gap: 8px; background: var(--orange-light); border: 1px solid var(--orange-border); border-radius: var(--radius-sm); padding: 10px 14px; font-size: 11px; color: var(--orange); margin-bottom: 12px; }
.modal-footer { display: flex; justify-content: flex-end; gap: 10px; padding-top: 4px; }
.modal-success { padding: 32px 20px; text-align: center; display: flex; flex-direction: column; align-items: center; gap: 12px; }
.success-icon { width: 56px; height: 56px; background: var(--green-light); border: 1.5px solid var(--green-border); border-radius: 50%; display: flex; align-items: center; justify-content: center; color: var(--green); }
.modal-success h3 { font-family: var(--display); font-weight: 800; font-size: 18px; color: var(--text); }
.success-stats { display: flex; gap: 10px; flex-wrap: wrap; justify-content: center; margin: 4px 0; }
.stat-chip { display: flex; flex-direction: column; align-items: center; background: var(--surface2); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 10px 16px; min-width: 100px; }
.stat-total { background: var(--accent-light); border-color: var(--accent-border); }
.stat-num { font-family: var(--display); font-weight: 800; font-size: 22px; color: var(--text); line-height: 1; }
.stat-total .stat-num { color: var(--accent); }
.stat-label { font-size: 10px; color: var(--text-3); margin-top: 4px; text-align: center; }
.btn-testrail-link { display: inline-flex; align-items: center; gap: 7px; background: var(--accent); color: #0e0e0e; border: none; border-radius: var(--radius-sm); padding: 10px 20px; font-family: var(--display); font-weight: 700; font-size: 13px; text-decoration: none; margin-top: 4px; transition: opacity 0.15s; }
.btn-testrail-link:hover { opacity: 0.88; }
.spinner-lg { width: 20px; height: 20px; border: 2px solid var(--border-strong); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.7s linear infinite; display: inline-block; flex-shrink: 0; }
.spinner-sm { width: 12px; height: 12px; border: 1.5px solid var(--border-strong); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.7s linear infinite; display: inline-block; flex-shrink: 0; }
@keyframes spin { to { transform: rotate(360deg); } }

@media (max-width: 600px) {
  .layout { padding: 24px 16px 80px; }
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
`;

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

  // Nom du run affiché dans le badge
  const displayRunName = tickets[0]?.runName || ("Release web du " + nextMonday);

  return (
    <>
      <style>{css}</style>
      <div className="layout">

        <div className="header">
          <div className="header-left">
            <h1>TestRail <em>Release</em> Prep</h1>
            <p>Colle le message Slack · extraction automatique · export CSV ou campagne directe</p>
          </div>
          <div className="release-badge">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>
            </svg>
            {displayRunName}
          </div>
        </div>

        <div className="input-panel">
          <div className="input-panel-header">
            <span className="input-label">Message Slack</span>
            <span className="slack-dot" title="Slack" />
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
            <div className="empty-icon">📋</div>
            <h3>Prêt à extraire</h3>
            <p>Colle un message Slack avec des blocs <code style={{background:"#222",color:"#c8f064",padding:"1px 5px",borderRadius:3}}>goprod</code> puis clique sur Extraire</p>
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