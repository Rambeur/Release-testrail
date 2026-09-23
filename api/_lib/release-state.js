import { get } from "@vercel/global-config";

const KEY_PREFIX = "current_version_";

function keyFor(platform) {
  return KEY_PREFIX + platform;
}

// Lit la version actuellement en prod pour la plateforme (SDK, lecture optimisée).
async function getCurrentVersion(platform) {
  return (await get(keyFor(platform))) ?? null;
}

// Écrase la version enregistrée (API REST Vercel : le SDK Global Config est en lecture seule).
async function setCurrentVersion(platform, version) {
  const configId = process.env.GLOBAL_CONFIG_ID;
  const token = process.env.VERCEL_API_TOKEN;
  if (!configId || !token) {
    throw new Error("GLOBAL_CONFIG_ID ou VERCEL_API_TOKEN manquant");
  }

  const teamId = process.env.VERCEL_TEAM_ID;
  const url =
    `https://api.vercel.com/v1/global-config/${configId}/items` +
    (teamId ? `?teamId=${teamId}` : "");

  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      items: [{ operation: "upsert", key: keyFor(platform), value: version }],
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || "Erreur mise à jour Global Config (" + res.status + ")");
  }
}

export { getCurrentVersion, setCurrentVersion };
