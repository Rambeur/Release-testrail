import { Buffer } from "node:buffer";

async function trFetch(base, email, apiKey, path, method = "GET", body = null) {
  let targetUrl;
  if (path.includes("?")) {
    const [apiPath, queryString] = path.split("?");
    targetUrl = base + "/index.php?/api/v2/" + apiPath + "&" + queryString;
  } else {
    targetUrl = base + "/index.php?/api/v2/" + path;
  }

  const opts = {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: "Basic " + Buffer.from(email + ":" + apiKey).toString("base64"),
    },
  };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(targetUrl, opts);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || "Erreur HTTP " + res.status + " sur " + path);
  }
  return res.json();
}

// ─── Recherche d'un run existant par nom ──────────────────────────────────────

async function findExistingRun(base, email, apiKey, projectId, suiteId, runName) {
  let offset = 0;
  while (true) {
    const resp = await trFetch(
      base, email, apiKey,
      "get_runs/" + projectId + "?suite_id=" + suiteId + "&is_completed=0&limit=50&offset=" + offset
    );
    const runs = resp.runs ?? resp;
    const found = runs.find((r) => r.name === runName);
    if (found) return found;
    if (runs.length < 50) break;
    offset += 50;
  }
  return null;
}

// ─── Récupérer toutes les sections (paginées) ─────────────────────────────────

async function getAllSections(base, email, apiKey, projectId, suiteId) {
  let sections = [];
  let offset = 0;
  while (true) {
    const resp = await trFetch(
      base, email, apiKey,
      "get_sections/" + projectId + "?suite_id=" + suiteId + "&limit=250&offset=" + offset
    );
    const batch = resp.sections ?? resp;
    sections = sections.concat(batch);
    if (batch.length < 250) break;
    offset += 250;
  }
  return sections;
}

// ─── Récupérer les case_ids actuels d'un run ──────────────────────────────────

async function getRunCaseIds(base, email, apiKey, runId) {
  let caseIds = [];
  let offset = 0;
  while (true) {
    const resp = await trFetch(
      base, email, apiKey,
      "get_tests/" + runId + "?limit=250&offset=" + offset
    );
    const tests = resp.tests ?? resp;
    caseIds = caseIds.concat(tests.map((t) => t.case_id));
    if (tests.length < 250) break;
    offset += 250;
  }
  return caseIds;
}

// ─── Ajouter modules + cas à un run existant ──────────────────────────────────

async function addToExistingCampaign({ base, email, apiKey, projectId, suiteId, tickets, existingRun }) {
  const resolvedSuiteId = parseInt(suiteId);
  const grouped = tickets.reduce((acc, t) => {
    const key = t.section || "Sans module";
    if (!acc[key]) acc[key] = [];
    acc[key].push(t);
    return acc;
  }, {});
  const runName = tickets[0]?.runName;

  // Trouver la section parente existante (même nom que le run, sans parent)
  const sections = await getAllSections(base, email, apiKey, projectId, resolvedSuiteId);
  let parentSection = sections.find((s) => s.name === runName && s.parent_id === null);

  if (!parentSection) {
    parentSection = await trFetch(base, email, apiKey, "add_section/" + projectId, "POST", {
      name: runName,
      suite_id: resolvedSuiteId,
    });
  }

  // Ajouter les nouveaux sous-dossiers et cas
  const newCaseIds = [];
  for (const module of Object.keys(grouped)) {
    const subSection = await trFetch(base, email, apiKey, "add_section/" + projectId, "POST", {
      name: module,
      parent_id: parentSection.id,
      suite_id: resolvedSuiteId,
    });
    for (const ticket of grouped[module]) {
      const created = await trFetch(base, email, apiKey, "add_case/" + subSection.id, "POST", {
        title: ticket.title,
        custom_expected: ticket.expectedResult || "",
        refs: ticket.references || "",
      });
      newCaseIds.push(created.id);
    }
  }

  // Fusionner avec les case_ids existants du run
  const existingCaseIds = await getRunCaseIds(base, email, apiKey, existingRun.id);
  const allCaseIds = [...new Set([...existingCaseIds, ...newCaseIds])];

  await trFetch(base, email, apiKey, "update_run/" + existingRun.id, "POST", {
    case_ids: allCaseIds,
  });

  return { run: existingRun, newCaseIds, isUpdate: true };
}

// ─── Créer une nouvelle campagne complète ─────────────────────────────────────

async function createNewCampaign({ base, email, apiKey, projectId, suiteId, tickets }) {
  const resolvedSuiteId = parseInt(suiteId);
  const grouped = tickets.reduce((acc, t) => {
    const key = t.section || "Sans module";
    if (!acc[key]) acc[key] = [];
    acc[key].push(t);
    return acc;
  }, {});
  const runName = tickets[0]?.runName || "Release web";
  const suiteParam = "&suite_id=" + resolvedSuiteId;

  // Dossier parent
  const parentSection = await trFetch(base, email, apiKey, "add_section/" + projectId, "POST", {
    name: runName,
    suite_id: resolvedSuiteId,
  });

  // Sous-dossiers et cas
  const newCaseIds = [];
  for (const module of Object.keys(grouped)) {
    const subSection = await trFetch(base, email, apiKey, "add_section/" + projectId, "POST", {
      name: module,
      parent_id: parentSection.id,
      suite_id: resolvedSuiteId,
    });
    for (const ticket of grouped[module]) {
      const created = await trFetch(base, email, apiKey, "add_case/" + subSection.id, "POST", {
        title: ticket.title,
        custom_expected: ticket.expectedResult || "",
        refs: ticket.references || "",
      });
      newCaseIds.push(created.id);
    }
  }

  // Sections NON REGRESSION
  const sections = await getAllSections(base, email, apiKey, projectId, resolvedSuiteId);
  const nonRegSection = sections.find((s) => s.name.trim().toUpperCase() === "NON REGRESSION");
  let nonRegCaseIds = [];

  if (nonRegSection) {
    const desktopSection = sections.find(
      (s) => s.name.trim().toLowerCase() === "desktop" && s.parent_id === nonRegSection.id
    );
    if (desktopSection) {
      const getChildIds = (pid) => {
        const children = sections.filter((s) => s.parent_id === pid);
        return [pid, ...children.flatMap((c) => getChildIds(c.id))];
      };
      for (const sectionId of getChildIds(desktopSection.id)) {
        let offset = 0;
        while (true) {
          const resp = await trFetch(
            base, email, apiKey,
            "get_cases/" + projectId + "?section_id=" + sectionId + suiteParam + "&limit=250&offset=" + offset
          );
          const cases = resp.cases ?? resp;
          nonRegCaseIds = nonRegCaseIds.concat(cases.map((c) => c.id));
          if (cases.length < 250) break;
          offset += 250;
        }
      }
    }
  }

  const allCaseIds = [...new Set([...newCaseIds, ...nonRegCaseIds])];
  const run = await trFetch(base, email, apiKey, "add_run/" + projectId, "POST", {
    name: runName,
    include_all: false,
    case_ids: allCaseIds,
    suite_id: resolvedSuiteId,
    description:
      "Campagne générée automatiquement depuis Slack\n" +
      "• " + newCaseIds.length + " cas créés depuis Slack\n" +
      "• " + nonRegCaseIds.length + " cas NON REGRESSION",
  });

  return { run, newCaseIds, nonRegCaseIds, nonRegFound: !!nonRegSection, isUpdate: false };
}

// ─── Point d'entrée principal ─────────────────────────────────────────────────

async function createCampaignServer({ base, email, apiKey, projectId, suiteId, tickets }) {
  const runName = tickets[0]?.runName;
  const resolvedSuiteId = suiteId ? parseInt(suiteId) : 1;

  const existingRun = await findExistingRun(base, email, apiKey, projectId, resolvedSuiteId, runName);

  if (existingRun) {
    return addToExistingCampaign({ base, email, apiKey, projectId, suiteId: resolvedSuiteId, tickets, existingRun });
  }

  return createNewCampaign({ base, email, apiKey, projectId, suiteId: resolvedSuiteId, tickets });
}

export { createCampaignServer };
