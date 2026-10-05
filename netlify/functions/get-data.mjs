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
  const metas = await getItem("metas", { receita: 0 });
  const dailyHistory = await getItem("dailyHistory", []);
  const motiv = await getItem("motiv", "Bora, time! Cada ação conta. 🚀");
  const monthHistory = await getItem("monthHistory", []);
  return Response.json({ points, pending, validated, history, weeks, denied, metas, dailyHistory, motiv, monthHistory });
};

export const config = { path: "/api/get-data" };
