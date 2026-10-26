// Runs on Vercel's server. It adds the secret RAWG key so visitors never see it.
module.exports = async (req, res) => {
  const key = process.env.RAWG_API_KEY;

  if (!key) {
    return res.status(500).json({
      error: "The server is missing RAWG_API_KEY. Add it in your Vercel project settings."
    });
  }

  const { path, key: ignored, ...params } = req.query;
  const endpoint = Array.isArray(path) ? path.join("/") : String(path || "");

  // Only allow the RAWG requests Game Note actually uses.
  const allowed = /^(games|games\/\d+|games\/\d+\/screenshots|genres)$/;

  if (!allowed.test(endpoint)) {
    return res.status(400).json({ error: "Endpoint not allowed." });
  }

  const url = new URL(`https://api.rawg.io/api/${endpoint}`);

  Object.entries(params).forEach(([name, value]) => {
    url.searchParams.set(name, Array.isArray(value) ? value[0] : value);
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