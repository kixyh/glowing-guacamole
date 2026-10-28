// Key system backend for Vercel
// Env vars needed: ADMIN, plus Upstash Redis (KV_REST_API_URL + KV_REST_API_TOKEN)

const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

async function redis(...cmd) {
  const r = await fetch(URL_, {
    method: "POST",
    headers: { Authorization: "Bearer " + TOKEN },
    body: JSON.stringify(cmd),
  });
  return (await r.json()).result;
}
const get = async k => { const v = await redis("GET", k); return v ? JSON.parse(v) : null; };
const put = (k, v) => redis("SET", k, JSON.stringify(v));

module.exports = async (req, res) => {
  const q = req.query, route = q.route;
  const send = t => res.status(200).send(t);

  // Public: called by the Roblox script
  if (route === "check") {
    const d = await get("key:" + q.key);
    if (!d) return send("invalid");
    if (await redis("GET", "bl:" + d.discord)) return send("blacklisted");
    if (d.expires && Date.now() > d.expires) return send("expired");
    if (!d.hwid) { d.hwid = q.hwid; await put("key:" + q.key, d); }
    else if (d.hwid !== q.hwid) return send("wrong device");
    return send("ok");
  }

  // Admin only: called by the BDFD bot
  if (req.headers.authorization !== "Bearer " + process.env.ADMIN)
    return res.status(401).send("unauthorized");
  const id = q.id;

  if (route === "whitelist") {
    await redis("DEL", "bl:" + id);
    let key = await redis("GET", "user:" + id);
    if (!key) {
      key = "KEY-" + crypto.randomUUID().slice(0, 13).toUpperCase();
      const days = parseInt(q.days);
      await put("key:" + key, { discord: id, expires: days ? Date.now() + days * 864e5 : null });
      await redis("SET", "user:" + id, key);
    }
    return send(key);
  }

  if (route === "unwhitelist") {
    const key = await redis("GET", "user:" + id);
    if (!key) return send("User has no key.");
    await redis("DEL", "key:" + key);
    await redis("DEL", "user:" + id);
    return send("Removed.");
  }

  if (route === "blacklist") { await redis("SET", "bl:" + id, "1"); return send("Blacklisted."); }
  if (route === "unblacklist") { await redis("DEL", "bl:" + id); return send("Unblacklisted."); }
  if (route === "getkey") return send((await redis("GET", "user:" + id)) || "No key.");

  if (route === "resethwid") {
    const key = await redis("GET", "user:" + id);
    if (!key) return send("User has no key.");
    const d = await get("key:" + key);
    delete d.hwid;
    await put("key:" + key, d);
    return send("HWID reset.");
  }

  if (route === "compensate") {
    const days = parseInt(q.days) || 0;
    let cursor = "0", n = 0;
    do {
      const [next, keys] = await redis("SCAN", cursor, "MATCH", "key:*", "COUNT", 100);
      cursor = next;
      for (const k of keys) {
        const d = await get(k);
        if (d && d.expires) { d.expires += days * 864e5; await put(k, d); n++; }
      }
    } while (cursor !== "0");
    return send("Added " + days + " days to " + n + " keys.");
  }

  return res.status(404).send("not found");
};
