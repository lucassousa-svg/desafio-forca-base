import { getStore } from "@netlify/blobs";

export default async (req, context) => {
  const store = getStore({ name: "painel-desafio", consistency: "strong" });
  const getItem = async (key, fallback) => {
    try { const raw = await store.get(key); return raw ? JSON.parse(raw) : fallback; }
    catch { return fallback; }
  };
  const [points, pending, validated, history, weeks, denied, metas, dailyHistory] = await Promise.all([
    getItem("points", {}),
    getItem("pending", []),
    getItem("validated", 0),
    getItem("history", []),
    getItem("weeks", []),
    getItem("denied", []),
    getItem("metas", { upsell:20, upgrade:30, receita:0, vendas:0 }),
    getItem("dailyHistory", []),
  ]);
  const motiv = await getItem("motiv", "Bora, time! Cada ação conta. 🚀");
  return Response.json({ points, pending, validated, history, weeks, denied, metas, dailyHistory, motiv });
};

export const config = { path: "/api/get-data" };
