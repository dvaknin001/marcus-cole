// Private book file server. Streams a print ready PDF (cover or interior) out of the
// BOOKFILES KV namespace, gated by the ASSET_TOKEN secret, so the full books are never
// committed to this public repo yet Lulu can still fetch them at order time.
//
// Route: GET https://marcuscole.pages.dev/api/asset?id=<key>&k=<ASSET_TOKEN>
//   id must be one of the allowlisted keys below (no arbitrary KV reads).
//
// SECRET (set in Cloudflare Pages, never in the repo): ASSET_TOKEN
// BINDING (wrangler.toml): BOOKFILES KV namespace.

const ALLOWED = new Set(["lockin-cover", "lockin-interior", "yourphone-cover", "yourphone-interior"]);

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const id = url.searchParams.get("id") || "";
  const k = url.searchParams.get("k") || "";

  if (!env.ASSET_TOKEN || k !== env.ASSET_TOKEN) return new Response("forbidden", { status: 403 });
  if (!ALLOWED.has(id)) return new Response("not found", { status: 404 });
  if (!env.BOOKFILES) return new Response("no store", { status: 500 });

  const body = await env.BOOKFILES.get(id, "arrayBuffer");
  if (!body) return new Response("not found", { status: 404 });

  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": 'inline; filename="' + id + '.pdf"',
      "Cache-Control": "no-store",
    },
  });
}
