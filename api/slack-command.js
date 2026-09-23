import crypto from "node:crypto";
import { getCurrentVersion, setCurrentVersion } from "./_lib/release-state.js";

export const config = {
  api: { bodyParser: false },
};

async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => { data += chunk; });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function verifySlackSignature(signingSecret, rawBody, timestamp, signature) {
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

// Accounts par plateforme
const ACCOUNTS = {
  android: ["Compte abonné L'Equipe", "Compte NON abonné", "Compte Google"],
  ios: ["Compte abonné L'Equipe", "Compte NON abonné", "Compte Google", "Compte Apple"],
};

const PLATFORM_LABEL = { android: "Android", ios: "iOS" };
const PLATFORM_EMOJI = { android: "🤖", ios: "🍎" };

function buildMigrationPlanBlocks(platform, targetVersion, prodVersion) {
  const accounts = ACCOUNTS[platform];
  const label = PLATFORM_LABEL[platform];
  const emoji = PLATFORM_EMOJI[platform];

  return [
    {
      type: "header",
      text: { type: "plain_text", text: `${emoji} Plan de migration ${label} — ${targetVersion}`, emoji: true },
    },
    { type: "divider" },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*👤 Comptes à tester*\n${accounts.map(a => `• ${a}`).join("\n")}`,
      },
    },
    { type: "divider" },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*🔄 Parcours de migration*\n• \`${prodVersion}\` (store)  →  MAJ \`${targetVersion}\`\n• Fresh install \`${targetVersion}\``,
      },
    },
  ];
}

const VERSION_RE = /^\d+\.\d+\.\d+$/;

function parseArgs(text) {
  const parts = text.trim().split(/\s+/);

  // "set android 10.66.1" : force manuellement la version courante (garde-fou si un
  // changement de thème a été raté ou mal formulé).
  if (parts[0]?.toLowerCase() === "set") {
    const platform = parts[1]?.toLowerCase();
    const version = parts[2];
    if (!platform || !["android", "ios"].includes(platform)) {
      return { error: "Plateforme invalide. Usage : `/migration-plan set android|ios <version>`" };
    }
    if (!version || !VERSION_RE.test(version)) {
      return { error: "Version invalide. Exemple : `10.66.1`" };
    }
    return { mode: "set", platform, version };
  }

  // "android 10.68.0" : version cible dont on veut le plan de migration
  const platform = parts[0]?.toLowerCase();
  const targetVersion = parts[1];

  if (!platform || !["android", "ios"].includes(platform)) {
    return { error: "Plateforme invalide. Usage : `/migration-plan android|ios <version>`" };
  }
  if (!targetVersion || !VERSION_RE.test(targetVersion)) {
    return { error: "Version invalide. Exemple : `10.62.0`" };
  }

  return { mode: "plan", platform, targetVersion };
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const rawBody = await getRawBody(req);

  const timestamp = req.headers["x-slack-request-timestamp"];
  const signature = req.headers["x-slack-signature"];
  const signingSecret = process.env.SLACK_SIGNING_SECRET;

  if (!signingSecret || !timestamp || !signature) {
    return res.status(401).json({ error: "Paramètres de sécurité manquants" });
  }
  if (!verifySlackSignature(signingSecret, rawBody, timestamp, signature)) {
    return res.status(401).json({ error: "Signature invalide" });
  }

  const params = new URLSearchParams(rawBody);
  const text = params.get("text") ?? "";

  const parsed = parseArgs(text);
  if (parsed.error) {
    return res.status(200).json({ response_type: "ephemeral", text: `❌ ${parsed.error}` });
  }

  if (parsed.mode === "set") {
    try {
      await setCurrentVersion(parsed.platform, parsed.version);
    } catch (err) {
      return res.status(200).json({ response_type: "ephemeral", text: `❌ Erreur : ${err.message}` });
    }
    return res.status(200).json({
      response_type: "in_channel",
      text: `✅ Version courante ${PLATFORM_LABEL[parsed.platform]} forcée à \`${parsed.version}\``,
    });
  }

  const { platform, targetVersion } = parsed;

  let prodVersion;
  try {
    prodVersion = await getCurrentVersion(platform);
  } catch (err) {
    return res.status(200).json({ response_type: "ephemeral", text: `❌ Erreur lecture version : ${err.message}` });
  }

  if (!prodVersion) {
    return res.status(200).json({
      response_type: "ephemeral",
      text: `❌ Aucune version connue pour ${PLATFORM_LABEL[platform]}. Utilise \`/migration-plan set ${platform} <version>\` pour l'initialiser.`,
    });
  }

  const blocks = buildMigrationPlanBlocks(platform, targetVersion, prodVersion);

  return res.status(200).json({
    response_type: "in_channel",
    blocks,
  });
}
