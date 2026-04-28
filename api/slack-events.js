import crypto from "node:crypto";
import { waitUntil } from "@vercel/functions";
import { parseSlackMessage } from "./_lib/parse-slack.js";
import { createCampaignServer } from "./_lib/testrail-api.js";

// Désactive le body parser Vercel pour pouvoir vérifier la signature HMAC
export const config = {
  api: { bodyParser: false },
};

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

// ─── Traitement principal (s'exécute en arrière-plan après la réponse 200) ───

async function processSlackEvent(event, token) {
  const TR = {
    base: "https://lequipe.testrail.io",
    email: "iyahia-ext@lequipe.fr",
    apiKey: process.env.TESTRAIL_API_KEY,
    projectId: "1",
    suiteId: "1",
  };

  try {
    const tickets = parseSlackMessage(event.text);

    if (tickets.length === 0) {
      await postToSlack(token, event.channel, "⚠️ Aucun ticket trouvé dans le message.", event.ts);
      return;
    }

    // Accusé de réception immédiat dans le thread
    await postToSlack(
      token,
      event.channel,
      `⏳ Création de la campagne TestRail en cours... (${tickets.length} ticket${tickets.length > 1 ? "s" : ""} détecté${tickets.length > 1 ? "s" : ""})`,
      event.ts
    );

    const result = await createCampaignServer({ ...TR, tickets });
    const runUrl = `${TR.base}/index.php?/runs/view/${result.run.id}`;
    const total = result.newCaseIds.length + result.nonRegCaseIds.length;

    const lines = [
      `✅ *Campagne créée !*`,
      `• ${result.newCaseIds.length} cas depuis Slack`,
      `• ${result.nonRegCaseIds.length} cas NON REGRESSION`,
      `• *${total}* cas au total dans le run`,
    ];
    if (!result.nonRegFound) {
      lines.push(`⚠️ Dossier "NON REGRESSION" introuvable dans TestRail.`);
    }
    lines.push(`<${runUrl}|Ouvrir dans TestRail>`);

    await postToSlack(token, event.channel, lines.join("\n"), event.ts);
  } catch (err) {
    await postToSlack(
      token,
      event.channel,
      `❌ Erreur lors de la création : ${err.message}`,
      event.ts
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
    event.subtype ||       // ignorer edits, deletions, etc.
    !event.text?.toLowerCase().includes("goprod")
  ) {
    return res.status(200).end();
  }

  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) {
    console.error("SLACK_BOT_TOKEN manquant");
    return res.status(500).json({ error: "Configuration manquante" });
  }

  // Étape 4 : planifier le traitement en arrière-plan, répondre 200 à Slack immédiatement
  waitUntil(processSlackEvent(event, token));
  return res.status(200).end();
}
