export async function onRequestGet(context) {
  const { env } = context;
  return new Response(
    JSON.stringify({
      ok: true,
      mailConfigured: Boolean(env.OQUMAIL_API_KEY && env.CONTACT_TO),
      runtime: "cloudflare-pages",
    }),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      },
    }
  );
}
