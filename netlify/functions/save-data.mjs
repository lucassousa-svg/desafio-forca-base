import { getStore } from "@netlify/blobs";

const ptsMap = {
  '50':50,'60':60,'30':30,'40':40,'15':15,
  '25u':25,'30r':30,'40i':40,'10a':10,
};

function resolvePoints(pts) {
  return ptsMap[String(pts)] ?? parseInt(pts) ?? 0;
}

export default async (req, context) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const body = await req.json();
  const { action, payload } = body;
  const store = getStore({ name: "painel-desafio", consistency: "strong" });

  const getItem = async (key, fallback) => {
    try { const raw = await store.get(key); return raw ? JSON.parse(raw) : fallback; }
    catch { return fallback; }
  };

  if (action === "add-pending") {
    const pending = await getItem("pending", []);
    pending.push(payload);
    await store.set("pending", JSON.stringify(pending));
    return Response.json({ ok: true });
  }

  if (action === "validate") {
    const { id, playerKey, pts } = payload;
    const pending = await getItem("pending", []);
    const points = await getItem("points", {});
    const validated = await getItem("validated", 0);
    const history = await getItem("history", []);
    const item = pending.find(p => p.id === id);
    const resolvedPts = resolvePoints(pts);
    points[playerKey] = (points[playerKey] || 0) + resolvedPts;
    history.unshift({ id, playerKey, pts: item?.pts || pts, resolvedPts, link: item?.link || "", validatedAt: new Date().toISOString() });
    await store.set("pending", JSON.stringify(pending.filter(p => p.id !== id)));
    await store.set("points", JSON.stringify(points));
    await store.set("validated", JSON.stringify(validated + 1));
    await store.set("history", JSON.stringify(history));
    return Response.json({ ok: true });
  }

  if (action === "deny-pending") {
    const { id, reason } = payload;
    const pending = await getItem("pending", []);
    const denied = await getItem("denied", []);
    const item = pending.find(p => p.id === id);
    if (item) denied.unshift({ ...item, reason, deniedAt: new Date().toISOString() });
    await store.set("pending", JSON.stringify(pending.filter(p => p.id !== id)));
    await store.set("denied", JSON.stringify(denied));
    return Response.json({ ok: true });
  }

  if (action === "delete-pending") {
    const pending = await getItem("pending", []);
    await store.set("pending", JSON.stringify(pending.filter(p => p.id !== payload.id)));
    return Response.json({ ok: true });
  }

  if (action === "delete-history") {
    const { id } = payload;
    const history = await getItem("history", []);
    const points = await getItem("points", {});
    const validated = await getItem("validated", 0);
    const item = history.find(h => h.id === id);
    if (item) points[item.playerKey] = Math.max(0, (points[item.playerKey] || 0) - resolvePoints(item.pts));
    await store.set("history", JSON.stringify(history.filter(h => h.id !== id)));
    await store.set("points", JSON.stringify(points));
    await store.set("validated", JSON.stringify(Math.max(0, validated - 1)));
    return Response.json({ ok: true });
  }

  if (action === "edit-points") {
    const { playerKey, op, value } = payload;
    const points = await getItem("points", {});
    if (op === "add") points[playerKey] = (points[playerKey] || 0) + Number(value);
    else if (op === "remove") points[playerKey] = Math.max(0, (points[playerKey] || 0) - Number(value));
    else if (op === "set") points[playerKey] = Number(value);
    await store.set("points", JSON.stringify(points));
    return Response.json({ ok: true });
  }

  if (action === "update-metas") {
    await store.set("metas", JSON.stringify(payload.metas));
    return Response.json({ ok: true });
  }

  if (action === "add-daily") {
    const { date, receita, vendas } = payload;
    const daily = await getItem("dailyHistory", []);
    const idx = daily.findIndex(d => d.date === date);
    if (idx >= 0) daily[idx] = { date, receita, vendas };
    else daily.push({ date, receita, vendas });
    await store.set("dailyHistory", JSON.stringify(daily));
    return Response.json({ ok: true });
  }

  if (action === "remove-daily") {
    const daily = await getItem("dailyHistory", []);
    await store.set("dailyHistory", JSON.stringify(daily.filter(d => d.date !== payload.date)));
    return Response.json({ ok: true });
  }

  if (action === "zero-today") {
    const history = await getItem("history", []);
    const points = await getItem("points", {});
    const validated = await getItem("validated", 0);
    const today = new Date().toLocaleDateString('pt-BR');
    const todayItems = history.filter(h => h.validatedAt && new Date(h.validatedAt).toLocaleDateString('pt-BR') === today);
    todayItems.forEach(h => { points[h.playerKey] = Math.max(0, (points[h.playerKey] || 0) - resolvePoints(h.pts)); });
    await store.set("history", JSON.stringify(history.filter(h => !h.validatedAt || new Date(h.validatedAt).toLocaleDateString('pt-BR') !== today)));
    await store.set("points", JSON.stringify(points));
    await store.set("validated", JSON.stringify(Math.max(0, validated - todayItems.length)));
    return Response.json({ ok: true });
  }

  if (action === "close-week") {
    const { label } = payload;
    const points = await getItem("points", {});
    const validated = await getItem("validated", 0);
    const weeks = await getItem("weeks", []);
    weeks.unshift({ label, points: { ...points }, validated, closedAt: new Date().toISOString() });
    await store.set("weeks", JSON.stringify(weeks));
    await store.set("points", JSON.stringify({}));
    await store.set("validated", JSON.stringify(0));
    await store.set("history", JSON.stringify([]));
    await store.set("pending", JSON.stringify([]));
    await store.set("denied", JSON.stringify([]));
    return Response.json({ ok: true });
  }

  return Response.json({ error: "Unknown action" }, { status: 400 });
};

export const config = { path: "/api/save-data" };
