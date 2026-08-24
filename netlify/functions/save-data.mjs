import { getStore } from "@netlify/blobs";

const ptsMap = {
  '50': 50, '60': 60, '30': 30, '40': 40, '15': 15,
  '30u': 30, '30r': 30, '40i': 40, '10a': 10,
};

function resolvePoints(pts) {
  return ptsMap[String(pts)] ?? parseInt(pts) ?? 0;
}

export default async (req, context) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const body = await req.json();
  const { action, payload } = body;
  const store = getStore({ name: "painel-desafio", consistency: "strong" });

  const getItem = async (key, fallback) => {
    try {
      const raw = await store.get(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch { return fallback; }
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
    const points = await getItem("points", { jane: 0, lucas: 0, ana: 0, larissa: 0, arthur: 0 });
    const validated = await getItem("validated", 0);
    const history = await getItem("history", []);

    const item = pending.find(p => p.id === id);
    const newPending = pending.filter(p => p.id !== id);
    const resolvedPts = resolvePoints(pts);
    points[playerKey] = (points[playerKey] || 0) + resolvedPts;

    history.unshift({
      id, playerKey,
      pts: item?.pts || pts,
      resolvedPts,
      link: item?.link || "",
      validatedAt: new Date().toISOString()
    });

    await store.set("pending", JSON.stringify(newPending));
    await store.set("points", JSON.stringify(points));
    await store.set("validated", JSON.stringify(validated + 1));
    await store.set("history", JSON.stringify(history));
    return Response.json({ ok: true });
  }

  if (action === "edit-points") {
    const { playerKey, op, value } = payload;
    const points = await getItem("points", { jane: 0, lucas: 0, ana: 0, larissa: 0, arthur: 0 });
    if (op === "add") points[playerKey] = (points[playerKey] || 0) + Number(value);
    else if (op === "remove") points[playerKey] = Math.max(0, (points[playerKey] || 0) - Number(value));
    else if (op === "set") points[playerKey] = Number(value);
    await store.set("points", JSON.stringify(points));
    return Response.json({ ok: true });
  }

  if (action === "delete-pending") {
    const { id } = payload;
    const pending = await getItem("pending", []);
    await store.set("pending", JSON.stringify(pending.filter(p => p.id !== id)));
    return Response.json({ ok: true });
  }

  if (action === "zero-today") {
    const history = await getItem("history", []);
    const points = await getItem("points", { jane: 0, lucas: 0, ana: 0, larissa: 0, arthur: 0 });
    const validated = await getItem("validated", 0);

    const today = new Date().toLocaleDateString('pt-BR');
    const todayItems = history.filter(h => {
      if (!h.validatedAt) return false;
      return new Date(h.validatedAt).toLocaleDateString('pt-BR') === today;
    });

    todayItems.forEach(h => {
      const resolvedPts = resolvePoints(h.pts);
      points[h.playerKey] = Math.max(0, (points[h.playerKey] || 0) - resolvedPts);
    });

    const newHistory = history.filter(h => {
      if (!h.validatedAt) return true;
      return new Date(h.validatedAt).toLocaleDateString('pt-BR') !== today;
    });

    await store.set("history", JSON.stringify(newHistory));
    await store.set("points", JSON.stringify(points));
    await store.set("validated", JSON.stringify(Math.max(0, validated - todayItems.length)));
    return Response.json({ ok: true, removed: todayItems.length });
  }

  if (action === "close-week") {
    const { label } = payload;
    const points = await getItem("points", { jane: 0, lucas: 0, ana: 0, larissa: 0, arthur: 0 });
    const validated = await getItem("validated", 0);
    const weeks = await getItem("weeks", []);

    weeks.unshift({
      label, points: { ...points }, validated,
      closedAt: new Date().toISOString()
    });

    await store.set("weeks", JSON.stringify(weeks));
    await store.set("points", JSON.stringify({ jane: 0, lucas: 0, ana: 0, larissa: 0, arthur: 0 }));
    await store.set("validated", JSON.stringify(0));
    await store.set("history", JSON.stringify([]));
    await store.set("pending", JSON.stringify([]));
    return Response.json({ ok: true });
  }

  return Response.json({ error: "Unknown action" }, { status: 400 });
};

export const config = { path: "/api/save-data" };
