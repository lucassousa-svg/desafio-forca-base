import { getStore } from "@netlify/blobs";

export default async (req, context) => {
  const store = getStore("painel-desafio");

  const points = await store.get("points", { type: "json" }).catch(() => ({
    jane: 0, lucas: 0, ana: 0, larissa: 0
  }));

  const pending = await store.get("pending", { type: "json" }).catch(() => []);
  const validated = await store.get("validated", { type: "json" }).catch(() => 0);

  return Response.json({ points, pending, validated });
};

export const config = { path: "/api/get-data" };
