const JIRA_BASE = "https://lequipe.atlassian.net/browse/";

function getNextMonday(from = new Date()) {
  const d = new Date(from);
  const day = d.getDay();
  const daysUntilMonday = day === 1 ? 7 : (8 - day) % 7;
  d.setDate(d.getDate() + daysUntilMonday);
  return (
    String(d.getDate()).padStart(2, "0") +
    "/" +
    String(d.getMonth() + 1).padStart(2, "0") +
    "/" +
    d.getFullYear()
  );
}

function getRunName(module, nextMonday) {
  if (!module) return "Release web du " + nextMonday;
  if (/^and-/i.test(module)) return "Release " + module;
  if (/^ios-/i.test(module)) return "Release " + module;
  return "Release web du " + nextMonday;
}

function parseSlackMessage(text) {
  const nextMonday = getNextMonday();

  text = text
    // Supprimer les liens Slack formatés entre parenthèses : (<https://...|MR>)
    .replace(/\(<https?:\/\/[^>]+>\)/g, "")
    // Extraire le texte d'affichage des liens Slack : <https://...|TC-15376> → TC-15376
    .replace(/<https?:\/\/[^|>]*\|([^>]+)>/g, "$1")
    // Supprimer les liens Slack sans texte : <https://...>
    .replace(/<https?:\/\/[^>]+>/g, "")
    // Supprimer le barré Slack
    .replace(/~~[^~]*~~/g, "")
    // Supprimer les (MR) restants en texte brut
    .replace(/\(MR\)/g, "")
    // Normaliser [NO -TICKET] / [NO- TICKET] → [NO-TICKET]
    .replace(/\[NO\s*-\s*TICKET\]/gi, "[NO-TICKET]")
    // Entourer les refs sans crochets
    .replace(/(?<!\[)\b([A-Z]+-\d+)\b(?!\])/g, "[$1]");

  const goprodMatches = [];
  const gre = /goprod\s+([^\s\[\n@(]+)/gi;
  let match;
  while ((match = gre.exec(text)) !== null) {
    goprodMatches.push({
      index: match.index,
      module: match[1].replace(/\?+$/, "").trim(),
    });
  }

  const blocks =
    goprodMatches.length === 0
      ? [{ module: "", content: text }]
      : goprodMatches.map((gm, i) => ({
          module: gm.module,
          content: text.slice(gm.index, goprodMatches[i + 1]?.index ?? text.length),
        }));

  const EXCLUDED_NAMES = ["Jean-Christophe Delanneau", "Jean-Christophe", "Delanneau"];
  const allTickets = [];

  for (const { module, content } of blocks) {
    const runName = getRunName(module, nextMonday);
    const sectionHierarchy = module ? runName + " > " + module : runName;
    const tokens = [];

    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      const headRefs = [];
      let remaining = trimmed;

      while (true) {
        const refMatch = /^\[([A-Z]+-\d+|NO-TICKET)\]/.exec(remaining);
        if (refMatch) {
          headRefs.push(refMatch[1]);
          remaining = remaining.slice(refMatch[0].length);
        } else if (/^\[[^\]]+\]/.test(remaining)) {
          break;
        } else {
          break;
        }
      }

      if (headRefs.length > 0) {
        const bodyRaw = remaining.replace(/^\s*(?:\[[^\]]+\]\s*)*/, "").trim();
        const mentions = [];
        const mentionRe = /@([\w\u00C0-\u00FF\-]+(?:[ ]+[\w\u00C0-\u00FF\-]+)*)/g;
        let mm;
        let titleClean = bodyRaw;
        while ((mm = mentionRe.exec(bodyRaw)) !== null) {
          const names = mm[1]
            .split(/(?<=[a-z\u00E0-\u00FE])(?=[A-Z\u00C0-\u00DE])/)
            .map((n) => n.trim())
            .filter(Boolean);
          for (const name of names) {
            if (!EXCLUDED_NAMES.some((ex) => name.includes(ex))) mentions.push(name);
          }
          titleClean = titleClean.replace(mm[0], "").trim();
        }
        for (const ref of headRefs) {
          if (titleClean) tokens.push({ type: "ticket", ref, title: titleClean });
        }
        for (const name of mentions) tokens.push({ type: "mention", name });
      } else {
        const mentionRe = /@([\w\u00C0-\u00FF\-]+(?:[ ]+[\w\u00C0-\u00FF\-]+)*)/g;
        let mm;
        while ((mm = mentionRe.exec(trimmed)) !== null) {
          const names = mm[1]
            .split(/(?<=[a-z\u00E0-\u00FE])(?=[A-Z\u00C0-\u00DE])/)
            .map((n) => n.trim())
            .filter(Boolean);
          for (const name of names) {
            if (!EXCLUDED_NAMES.some((ex) => name.includes(ex)))
              tokens.push({ type: "mention", name });
          }
        }
      }
    }

    let i = 0;
    while (i < tokens.length) {
      if (tokens[i].type === "ticket") {
        const groupTickets = [];
        while (i < tokens.length && tokens[i].type === "ticket") {
          groupTickets.push(tokens[i]);
          i++;
        }
        const groupMentions = [];
        while (i < tokens.length && tokens[i].type === "mention") {
          groupMentions.push(tokens[i].name);
          i++;
        }
        for (const ticket of groupTickets) {
          allTickets.push({
            ref: ticket.ref,
            title: "[" + ticket.ref + "] " + ticket.title,
            expectedResult: ticket.ref !== "NO-TICKET" ? JIRA_BASE + ticket.ref : "",
            section: module,
            sectionHierarchy,
            runName,
            references: groupMentions.join(", "),
          });
        }
      } else {
        i++;
      }
    }
  }

  return allTickets;
}

export { parseSlackMessage, getNextMonday };
