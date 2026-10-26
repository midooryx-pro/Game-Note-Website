// Runs on Vercel's server. It adds the secret RAWG key so visitors never see it.
module.exports = async (req, res) => {
  const key = process.env.RAWG_API_KEY;

  if (!key) {
    return res.status(500).json({
      error: "The server is missing RAWG_API_KEY. Add it in your Vercel project settings."
    });
  }

  // Read the requested page straight from the address,
  // e.g. /api/rawg/games/123/screenshots -> "games/123/screenshots"
  const incoming = new URL(req.url, "http://localhost");
  const endpoint = incoming.pathname
    .replace(/^\/api\/rawg\/?/, "")
    .replace(/\/+$/, "");

  // Only allow the RAWG requests Game Note actually uses.
  const allowed = /^(games|games\/\d+|games\/\d+\/screenshots|genres)$/;

  if (!allowed.test(endpoint)) {
    return res.status(400).json({ error: `Endpoint not allowed: "${endpoint}"` });
  }

  const url = new URL(`https://api.rawg.io/api/${endpoint}`);

  incoming.searchParams.forEach((value, name) => {
    if (name !== "key") {
      url.searchParams.set(name, value);
    }
  });

  url.searchParams.set("key", key);

  try {
    const response = await fetch(url);
    const data = await response.json().catch(() => ({}));

    // Cache answers for 5 minutes so you use fewer RAWG requests.
    res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");

    return res.status(response.status).json(data);
  } catch {
    return res.status(502).json({ error: "Couldn't reach RAWG." });
  }
};