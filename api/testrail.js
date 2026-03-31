export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.status(200).end();

  const { testrailUrl, path } = req.query;
  if (!testrailUrl || !path) return res.status(400).json({ error: "Paramètres manquants" });

  const authorization = req.headers["authorization"];
  if (!authorization) return res.status(401).json({ error: "Authorization manquant" });

  const base = testrailUrl.replace(/\/$/, "");
  let targetUrl;
  if (path.includes("?")) {
    const [apiPath, queryString] = path.split("?");
    targetUrl = base + "/index.php?/api/v2/" + apiPath + "&" + queryString;
  } else {
    targetUrl = base + "/index.php?/api/v2/" + path;
  }

  try {
    const fetchOptions = {
      method: req.method,
      headers: { "Content-Type": "application/json", "Authorization": authorization },
    };
    if (req.method === "POST" && req.body) fetchOptions.body = JSON.stringify(req.body);

    const response = await fetch(targetUrl, fetchOptions);
    const data = await response.json();
    return res.status(response.status).json(data);
  } catch (err) {
    return res.status(500).json({ error: "Erreur proxy: " + err.message, url: targetUrl });
  }
}