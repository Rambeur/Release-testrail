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

async function createCampaignServer({ base, email, apiKey, projectId, suiteId, tickets }) {
  const grouped = tickets.reduce((acc, t) => {
    const key = t.section || "Sans module";
    if (!acc[key]) acc[key] = [];
    acc[key].push(t);
    return acc;
  }, {});
  const modules = Object.keys(grouped);
  const runName = tickets[0]?.runName || "Release web";

  let resolvedSuiteId = suiteId ? parseInt(suiteId) : null;
  if (!resolvedSuiteId) {
    const suites = await trFetch(base, email, apiKey, "get_suites/" + projectId);
    resolvedSuiteId = suites[0]?.id || null;
  }

  const suiteParam = resolvedSuiteId ? "&suite_id=" + resolvedSuiteId : "";

  // Dossier parent
  const parentSection = await trFetch(base, email, apiKey, "add_section/" + projectId, "POST", {
    name: runName,
    ...(resolvedSuiteId ? { suite_id: resolvedSuiteId } : {}),
  });
  const parentId = parentSection.id;

  // Sous-dossiers et cas
  const newCaseIds = [];
  for (const module of modules) {
    const subSection = await trFetch(base, email, apiKey, "add_section/" + projectId, "POST", {
      name: module,
      parent_id: parentId,
      ...(resolvedSuiteId ? { suite_id: resolvedSuiteId } : {}),
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

  // Sections NON REGRESSION (paginées)
  let sections = [];
  let secOffset = 0;
  while (true) {
    const resp = await trFetch(
      base,
      email,
      apiKey,
      "get_sections/" + projectId + "?suite_id=" + resolvedSuiteId + "&limit=250&offset=" + secOffset
    );
    const batch = resp.sections ?? resp;
    sections = sections.concat(batch);
    if (batch.length < 250) break;
    secOffset += 250;
  }

  const nonRegSection = sections.find((s) => s.name.trim().toUpperCase() === "NON REGRESSION");
  let nonRegCaseIds = [];

  if (nonRegSection) {
    const desktopSection = sections.find(
      (s) => s.name.trim().toLowerCase() === "desktop" && s.parent_id === nonRegSection.id
    );
    if (desktopSection) {
      const getChildIds = (parentId) => {
        const children = sections.filter((s) => s.parent_id === parentId);
        return [parentId, ...children.flatMap((c) => getChildIds(c.id))];
      };
      for (const sectionId of getChildIds(desktopSection.id)) {
        let offset = 0;
        while (true) {
          const resp = await trFetch(
            base,
            email,
            apiKey,
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
    ...(resolvedSuiteId ? { suite_id: resolvedSuiteId } : {}),
    description:
      "Campagne générée automatiquement depuis Slack\n" +
      "• " + newCaseIds.length + " cas créés depuis Slack\n" +
      "• " + nonRegCaseIds.length + " cas NON REGRESSION",
  });

  return { run, newCaseIds, nonRegCaseIds, nonRegFound: !!nonRegSection };
}

export { createCampaignServer };
