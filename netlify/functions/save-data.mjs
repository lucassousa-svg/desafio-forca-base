import { getStore } from "@netlify/blobs";

export default async (req, context) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const body = await req.json();
  const { action, payload } = body;

  const store = getStore("painel-desafio");

  if (action === "add-pending") {
    const pending = await store.get("pending", { type: "json" }).catch(() => []);
    pending.push(payload);
    await store.set("pending", JSON.stringify(pending));
    return Response.json({ ok: true });
  }

  if (action === "validate") {
    const { id, playerKey, pts } = payload;
    const pending = await store.get("pending", { type: "json" }).catch(() => []);
    const points = await store.get("points", { type: "json" }).catch(() => ({
      jane: 0, lucas: 0, ana: 0, larissa: 0
    }));
    const validated = await store.get("validated", { type: "json" }).catch(() => 0);

    const newPending = pending.filter(p => p.id !== id);
    points[playerKey] = (points[playerKey] || 0) + pts;

    await store.set("pending", JSON.stringify(newPending));
    await store.set("points", JSON.stringify(points));
    await store.set("validated", JSON.stringify(validated + 1));

    return Response.json({ ok: true });
  }

  if (action === "edit-points") {
    const { playerKey, op, value } = payload;
    const points = await store.get("points", { type: "json" }).catch(() => ({
      jane: 0, lucas: 0, ana: 0, larissa: 0
    }));

    if (op === "add") points[playerKey] = (points[playerKey] || 0) + value;
    else if (op === "remove") points[playerKey] = Math.max(0, (points[playerKey] || 0) - value);
    else if (op === "set") points[playerKey] = value;

    await store.set("points", JSON.stringify(points));
    return Response.json({ ok: true });
  }

  if (action === "delete-pending") {
    const { id } = payload;
    const pending = await store.get("pending", { type: "json" }).catch(() => []);
    const newPending = pending.filter(p => p.id !== id);
    await store.set("pending", JSON.stringify(newPending));
    return Response.json({ ok: true });
  }

  return Response.json({ error: "Unknown action" }, { status: 400 });
};

export const config = { path: "/api/save-data" };
