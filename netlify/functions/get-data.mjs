import { getStore } from "@netlify/blobs";

export default async (req, context) => {
  const store = getStore({ name: "painel-desafio", consistency: "strong" });

  const getItem = async (key, fallback) => {
    try {
      const raw = await store.get(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch { return fallback; }
  };

  const points = await getItem("points", { jane: 0, lucas: 0, ana: 0, larissa: 0 });
  const pending = await getItem("pending", []);
  const validated = await getItem("validated", 0);
  const history = await getItem("history", []);
  const weeks = await getItem("weeks", []);

  return Response.json({ points, pending, validated, history, weeks });
};

export const config = { path: "/api/get-data" };
