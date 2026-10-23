import { getStore } from "@netlify/blobs";

const ptsMap = {
  '60':60,'50':50,'40i':40,'40':40,'40k':40,
  '30':30,'30ts':30,'30sa':30,'30r':30,'25u':25,'20k':20,'10a':10,
  '30u':30,'25':25,'20':20,'18':18,'10':10,'15':15,
};
function resolvePoints(pts) { return ptsMap[String(pts)] ?? (parseInt(pts) || 0); }

export default async (req, context) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const body = await req.json();
  const { action, payload } = body;
  const store = getStore({ name: "painel-desafio", consistency: "strong" });
  const getItem = async (key, fallback) => {
    try { const raw = await store.get(key); return raw ? JSON.parse(raw) : fallback; }
    catch { return fallback; }
  };
  const setItem = (key, value) => store.set(key, JSON.stringify(value));

  if (action === "add-pending") {
    const pending = await getItem("pending", []);
    pending.push(payload);
    await setItem("pending", pending);
    return Response.json({ ok: true });
  }

  if (action === "validate") {
    const { id, playerKey, pts, label } = payload;
    const pending = await getItem("pending", []);
    const item = pending.find(p => p.id === id);
    if (!item) return Response.json({ error: "not found" }, { status: 404 });
    const points = await getItem("points", {});
    const validated = await getItem("validated", 0);
    const history = await getItem("history", []);
    const code = item.pts ?? pts;
    const resolvedPts = resolvePoints(code);
    const key = item.playerKey || playerKey;
    points[key] = (points[key] || 0) + resolvedPts;
    history.unshift({
      id, playerKey: key, pts: code, resolvedPts,
      label: item.label || label || "",
      link: item.link || "", validatedAt: new Date().toISOString()
    });
    await setItem("pending", pending.filter(p => p.id !== id));
    await setItem("points", points);
    await setItem("validated", validated + 1);
    await setItem("history", history);
    return Response.json({ ok: true });
  }

  if (action === "deny-pending") {
    const { id, reason } = payload;
    const pending = await getItem("pending", []);
    const item = pending.find(p => p.id === id);
    if (!item) return Response.json({ error: "not found" }, { status: 404 });
    const denied = await getItem("denied", []);
    denied.unshift({ ...item, reason, deniedAt: new Date().toISOString() });
    await setItem("pending", pending.filter(p => p.id !== id));
    await setItem("denied", denied);
    return Response.json({ ok: true });
  }

  if (action === "delete-pending") {
    const pending = await getItem("pending", []);
    await setItem("pending", pending.filter(p => p.id !== payload.id));
    return Response.json({ ok: true });
  }

  if (action === "delete-history") {
    const { id } = payload;
    const history = await getItem("history", []);
    const points = await getItem("points", {});
    const validated = await getItem("validated", 0);
    const item = history.find(h => h.id === id);
    if (!item) return Response.json({ error: "not found" }, { status: 404 });
    const back = Number(item.resolvedPts) > 0 ? Number(item.resolvedPts) : resolvePoints(item.pts);
    points[item.playerKey] = Math.max(0, (points[item.playerKey] || 0) - back);
    await setItem("history", history.filter(h => h.id !== id));
    await setItem("points", points);
    await setItem("validated", Math.max(0, validated - 1));
    return Response.json({ ok: true });
  }

  if (action === "edit-points") {
    const { playerKey, op, value } = payload;
    const points = await getItem("points", {});
    if (op === "add") points[playerKey] = (points[playerKey] || 0) + Number(value);
    else if (op === "remove") points[playerKey] = Math.max(0, (points[playerKey] || 0) - Number(value));
    else if (op === "set") points[playerKey] = Number(value);
    await setItem("points", points);
    return Response.json({ ok: true });
  }

  if (action === "update-motiv") {
    await setItem("motiv", payload.text);
    return Response.json({ ok: true });
  }

  if (action === "update-metas") {
    await setItem("metas", payload.metas);
    return Response.json({ ok: true });
  }

  if (action === "add-daily") {
    const { date, receita } = payload;
    const daily = await getItem("dailyHistory", []);
    const idx = daily.findIndex(d => d.date === date);
    if (idx >= 0) daily[idx] = { date, receita };
    else daily.push({ date, receita });
    await setItem("dailyHistory", daily);
    return Response.json({ ok: true });
  }

  if (action === "remove-daily") {
    const daily = await getItem("dailyHistory", []);
    await setItem("dailyHistory", daily.filter(d => d.date !== payload.date));
    return Response.json({ ok: true });
  }

  if (action === "zero-today") {
    const history = await getItem("history", []);
    const points = await getItem("points", {});
    const validated = await getItem("validated", 0);
    const tz = { timeZone: "America/Sao_Paulo" };
    const today = new Date().toLocaleDateString("pt-BR", tz);
    const isToday = h => h.validatedAt && new Date(h.validatedAt).toLocaleDateString("pt-BR", tz) === today;
    const todayItems = history.filter(isToday);
    todayItems.forEach(h => {
      const back = Number(h.resolvedPts) > 0 ? Number(h.resolvedPts) : resolvePoints(h.pts);
      points[h.playerKey] = Math.max(0, (points[h.playerKey] || 0) - back);
    });
    await setItem("history", history.filter(h => !isToday(h)));
    await setItem("points", points);
    await setItem("validated", Math.max(0, validated - todayItems.length));
    return Response.json({ ok: true });
  }

  if (action === "close-week") {
    const { label } = payload;
    const points = await getItem("points", {});
    const validated = await getItem("validated", 0);
    const history = await getItem("history", []);
    const weeks = await getItem("weeks", []);
    weeks.unshift({ label, points: { ...points }, validated, history: [...history], closedAt: new Date().toISOString() });
    await setItem("weeks", weeks);
    await setItem("points", {});
    await setItem("validated", 0);
    await setItem("history", []);
    await setItem("pending", []);
    await setItem("denied", []);
    return Response.json({ ok: true });
  }

  if (action === "close-month") {
    const { label, counts, receita, meta, ranking, closedAt } = payload;
    const monthHistory = await getItem("monthHistory", []);
    monthHistory.unshift({ label, counts, receita, meta, ranking: ranking || [], closedAt });
    await setItem("monthHistory", monthHistory);
    await setItem("points", {});
    await setItem("history", []);
    await setItem("validated", 0);
    await setItem("dailyHistory", []);
    await setItem("pending", []);
    await setItem("denied", []);
    return Response.json({ ok: true });
  }

  return Response.json({ error: "Unknown action" }, { status: 400 });
};

export const config = { path: "/api/save-data" };
