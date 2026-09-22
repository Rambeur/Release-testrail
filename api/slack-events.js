import crypto from "node:crypto";
import { waitUntil } from "@vercel/functions";
import { parseSlackMessage } from "./_lib/parse-slack.js";
import { createCampaignServer, openWebReleaseWindow, getOpenWebWindowRunName } from "./_lib/testrail-api.js";

// Désactive le body parser Vercel pour pouvoir vérifier la signature HMAC
export const config = {
  api: { bodyParser: false },
};

// ─── Routage par channel ──────────────────────────────────────────────────────
// Chaque channel surveillé est mappé à sa "famille" : le bot ignore silencieusement
// tout message provenant d'un channel absent de cette liste.

const CHANNEL_FAMILY = Object.fromEntries(
  [
    [process.env.SLACK_CHANNEL_WEB, "web"],
    [process.env.SLACK_CHANNEL_ANDROID, "android"],
    [process.env.SLACK_CHANNEL_IOS, "ios"],
  ].filter(([id]) => Boolean(id))
);

// Ouverture de la fenêtre "Release Web" : détectée depuis le message d'annonce du
// release manager, qui contient toujours un token du type "web-2026.09.28".
const WEB_RELEASE_OPEN_RE = /\bweb-(\d{4})\.(\d{2})\.(\d{2})\b/;
const WEB_WINDOW_HOURS = 72; // "les 3 prochains jours"

// Android/iOS : une seule release = un seul message avec l'en-tête "goprod and-X.Y.Z"
// ou "goprod ios-X.Y.Z" ; pas de fenêtre temporelle nécessaire.
const PLATFORM_PREFIX = { android: /^and-/i, ios: /^ios-/i };

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => { data += chunk; });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function verifySlackSignature(signingSecret, rawBody, timestamp, signature) {
  // Protection replay attack (fenêtre 5 min)
  const age = Math.abs(Date.now() / 1000 - parseInt(timestamp, 10));
  if (age > 300) return false;

  const baseString = `v0:${timestamp}:${rawBody}`;
  const expected = "v0=" + crypto.createHmac("sha256", signingSecret).update(baseString).digest("hex");

  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

// Résout les mentions Slack <@U12345> → @Prénom Nom via users.info
async function resolveUserMentions(text, token) {
  const ids = [...new Set([...text.matchAll(/<@(U[A-Z0-9]+)>/g)].map((m) => m[1]))];
  if (ids.length === 0) return text;

  const names = {};
  await Promise.all(
    ids.map(async (id) => {
      try {
        const res = await fetch(`https://slack.com/api/users.info?user=${id}`, {
          headers: { Authorization: "Bearer " + token },
        });
        const data = await res.json();
        names[id] = data.ok ? (data.user.real_name || data.user.profile?.display_name || id) : id;
      } catch {
        names[id] = id;
      }
    })
  );

  return text.replace(/<@(U[A-Z0-9]+)>/g, (_, id) => "@" + (names[id] || id));
}

async function postToSlack(token, channel, text, threadTs) {
  const body = { channel, text, ...(threadTs ? { thread_ts: threadTs } : {}) };
  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return res.json();
}

function formatExpiry(iso) {
  const d = new Date(iso);
  return (
    String(d.getDate()).padStart(2, "0") + "/" +
    String(d.getMonth() + 1).padStart(2, "0") + "/" +
    d.getFullYear() + " " +
    String(d.getHours()).padStart(2, "0") + "h" +
    String(d.getMinutes()).padStart(2, "0")
  );
}

async function debugLog(token, targetChannel, family, resolvedText, tickets) {
  if (process.env.DEBUG_SLACK !== "1") return;
  await postToSlack(
    token, targetChannel,
    `🔍 *DEBUG* (${family})\n\`\`\`${resolvedText.slice(0, 500)}\`\`\`\nrunName: \`${tickets[0]?.runName ?? "—"}\` | tickets: ${tickets.map((t) => t.ref).join(", ") || "aucun"}`
  );
}

// ─── Traitement principal (s'exécute en arrière-plan après la réponse 200) ───

async function postCampaignResult(token, targetChannel, event, TR, tickets) {
  await postToSlack(
    token,
    targetChannel,
    `⏳ *<#${event.channel}>* — ${tickets.length} ticket${tickets.length > 1 ? "s" : ""} détecté${tickets.length > 1 ? "s" : ""}, vérification de la campagne en cours...`
  );

  const result = await createCampaignServer({ ...TR, tickets });
  const runUrl = `${TR.base}/index.php?/runs/view/${result.run.id}`;

  const lines = result.isUpdate
    ? [
        `✅ *${tickets[0]?.runName} — mis à jour* (depuis <#${event.channel}>)`,
        `• ${result.newCaseIds.length} nouveau${result.newCaseIds.length > 1 ? "x" : ""} cas ajouté${result.newCaseIds.length > 1 ? "s" : ""}`,
        `<${runUrl}|Ouvrir dans TestRail>`,
      ]
    : [
        `✅ *Campagne créée !* (depuis <#${event.channel}>)`,
        `• ${result.newCaseIds.length} cas depuis Slack`,
        `• ${result.nonRegCaseIds?.length ?? 0} cas NON REGRESSION`,
        `• *${result.newCaseIds.length + (result.nonRegCaseIds?.length ?? 0)}* cas au total`,
        ...(result.nonRegFound === false ? [`⚠️ Dossier "NON REGRESSION" introuvable.`] : []),
        `<${runUrl}|Ouvrir dans TestRail>`,
      ];

  await postToSlack(token, targetChannel, lines.join("\n"));
}

async function handleWebChannel(event, token, TR, targetChannel, resolvedText) {
  const openMatch = WEB_RELEASE_OPEN_RE.exec(resolvedText);
  if (openMatch) {
    const [, year, month, day] = openMatch;
    const runName = `Release web du ${day}/${month}/${year}`;
    const { expiresAt } = await openWebReleaseWindow({ ...TR, runName, hoursValid: WEB_WINDOW_HOURS });
    await postToSlack(
      token,
      targetChannel,
      `🟢 *Fenêtre Release Web ouverte* (depuis <#${event.channel}>)\nLes messages "goprod" seront pris en compte jusqu'au ${formatExpiry(expiresAt)}.`
    );
    return;
  }

  const tickets = parseSlackMessage(resolvedText);
  await debugLog(token, targetChannel, "web", resolvedText, tickets);
  if (tickets.length === 0) return; // pas une entrée de release, on ignore silencieusement

  const openRunName = await getOpenWebWindowRunName(TR);
  if (!openRunName) return; // hors fenêtre de release, on ignore silencieusement

  const adjustedTickets = tickets.map((t) => ({
    ...t,
    runName: openRunName,
    sectionHierarchy: t.section ? openRunName + " > " + t.section : openRunName,
  }));

  await postCampaignResult(token, targetChannel, event, TR, adjustedTickets);
}

async function handleAppChannel(event, token, TR, targetChannel, resolvedText, family) {
  const tickets = parseSlackMessage(resolvedText);
  await debugLog(token, targetChannel, family, resolvedText, tickets);
  if (tickets.length === 0) return;

  const expectedPrefix = PLATFORM_PREFIX[family];
  if (!expectedPrefix.test(tickets[0].section || "")) return; // mauvais format pour ce channel

  await postCampaignResult(token, targetChannel, event, TR, tickets);
}

async function processSlackEvent(event, token, family) {
  const TR = {
    base: "https://lequipe.testrail.io",
    email: "iyahia-ext@lequipe.fr",
    apiKey: process.env.TESTRAIL_API_KEY,
    projectId: "1",
    suiteId: "1",
  };

  const targetChannel = process.env.SLACK_TARGET_CHANNEL || event.channel;

  try {
    const resolvedText = await resolveUserMentions(event.text, token);

    if (family === "web") {
      await handleWebChannel(event, token, TR, targetChannel, resolvedText);
    } else {
      await handleAppChannel(event, token, TR, targetChannel, resolvedText, family);
    }
  } catch (err) {
    await postToSlack(
      token,
      targetChannel,
      `❌ Erreur (depuis <#${event.channel}>) : ${err.message}`
    );
  }
}

// ─── Handler Vercel ──────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const rawBody = await getRawBody(req);
  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return res.status(400).json({ error: "JSON invalide" });
  }

  // Étape 1 : vérification de l'URL Slack (first-time setup)
  if (body.type === "url_verification") {
    return res.status(200).json({ challenge: body.challenge });
  }

  // Étape 2 : vérification de la signature
  const timestamp = req.headers["x-slack-request-timestamp"];
  const signature = req.headers["x-slack-signature"];
  const signingSecret = process.env.SLACK_SIGNING_SECRET;

  if (!signingSecret || !timestamp || !signature) {
    return res.status(401).json({ error: "Paramètres de sécurité manquants" });
  }
  if (!verifySlackSignature(signingSecret, rawBody, timestamp, signature)) {
    return res.status(401).json({ error: "Signature invalide" });
  }

  // Étape 3 : filtrage des events
  const event = body.event;
  if (
    !event ||
    event.type !== "message" ||
    event.bot_id ||        // ignorer les messages du bot lui-même
    event.subtype           // ignorer edits, deletions, etc.
  ) {
    return res.status(200).end();
  }

  // Étape 4 : seuls les 3 channels de release configurés sont traités
  const family = CHANNEL_FAMILY[event.channel];
  if (!family) return res.status(200).end();

  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) {
    console.error("SLACK_BOT_TOKEN manquant");
    return res.status(500).json({ error: "Configuration manquante" });
  }

  // Étape 5 : planifier le traitement en arrière-plan, répondre 200 à Slack immédiatement
  waitUntil(processSlackEvent(event, token, family));
  return res.status(200).end();
}
