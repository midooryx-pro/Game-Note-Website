// Runs on Vercel's server. It adds the secret RAWG key so visitors never see it.
// The site calls it like this: /api/rawg?path=games/3498&page=1

// Only allow the RAWG requests Game Note actually uses.
const ALLOWED_ENDPOINTS =
  /^(games|games\/\d+|games\/\d+\/screenshots|games\/\d+\/game-series|genres)$/;

module.exports = async (req, res) => {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed." });
  }

  const key = process.env.RAWG_API_KEY;

  if (!key) {
    return res.status(500).json({
      error: "The server is missing RAWG_API_KEY. Add it in your Vercel project settings."
    });
  }

  const incoming = new URL(req.url, "http://localhost");

  // The RAWG page we want, e.g. "games/123/screenshots"
  const endpoint = (incoming.searchParams.get("path") || "")
    .replace(/^\/+|\/+$/g, "");

  if (!ALLOWED_ENDPOINTS.test(endpoint)) {
    return res.status(400).json({ error: `Endpoint not allowed: "${endpoint}"` });
  }

  const url = new URL(`https://api.rawg.io/api/${endpoint}`);

  // Pass along every other setting (page, ordering, search...),
  // but never the "key" or "path" from the visitor.
  incoming.searchParams.forEach((value, name) => {
    if (name !== "key" && name !== "path") {
      url.searchParams.set(name, value);
    }
  });

  url.searchParams.set("key", key);

  try {
    const response = await fetch(url);
    const data = await response.json().catch(() => ({}));

    // Cache successful answers for 5 minutes so you use fewer RAWG requests.
    if (response.ok) {
      res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");
    }

    return res.status(response.status).json(data);
  } catch {
    return res.status(502).json({ error: "Couldn't reach RAWG." });
  }
};