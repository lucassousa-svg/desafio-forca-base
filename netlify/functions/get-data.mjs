import { getStore } from "@netlify/blobs";

export default async (req, context) => {
  const store = getStore({ name: "painel-desafio", consistency: "strong" });

  const getItem = async (key, fallback) => {
    try { const raw = await store.get(key); return raw ? JSON.parse(raw) : fallback; }
    catch { return fallback; }
  };

  const points = await getItem("points", {});
  const pending = await getItem("pending", []);
  const validated = await getItem("validated", 0);
  const history = await getItem("history", []);
  const weeks = await getItem("weeks", []);
  const denied = await getItem("denied", []);
  const metas = await getItem("metas", { upsell: 20, upgrade: 30, receita: 0, vendas: 0 });
  const dailyHistory = await getItem("dailyHistory", []);

  return Response.json({ points, pending, validated, history, weeks, denied, metas, dailyHistory });
};

export const config = { path: "/api/get-data" };
