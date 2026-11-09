function sanitize(value, max = 500) {
  return String(value || "")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .trim()
    .slice(0, max);
}

function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function isAdminHost(hostname) {
  const host = String(hostname || "").toLowerCase();
  return host === "admin.omniq.co.zw" || host.startsWith("admin.");
}

async function handleHealth(env) {
  return json({
    ok: true,
    mailConfigured: Boolean(env.OQUMAIL_API_KEY && env.CONTACT_TO),
    runtime: "cloudflare-worker",
  });
}

async function handleContact(request, env) {
  const apiKey = env.OQUMAIL_API_KEY;
  const contactTo = env.CONTACT_TO;
  const fromName = env.MAIL_FROM_NAME || "OMNIQ Integrated Systems";
  const fromEmail = env.MAIL_FROM || "";

  if (!apiKey || !contactTo) {
    return json(
      { ok: false, error: "Mail is not configured on the server yet." },
      503
    );
  }

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return json({ ok: false, error: "Invalid request body." }, 400);
  }

  const name = sanitize(body.name, 120);
  const email = sanitize(body.email, 160).toLowerCase();
  const organisation = sanitize(body.organisation, 160);
  const message = sanitize(body.message, 4000);

  if (!name || !email || !message) {
    return json(
      { ok: false, error: "Name, email, and message are required." },
      400
    );
  }

  if (!isEmail(email)) {
    return json({ ok: false, error: "Please provide a valid email address." }, 400);
  }

  const subject = `OMNIQ website enquiry from ${name}`;
  const text = [
    "New contact form submission from the OMNIQ website.",
    "",
    `Name: ${name}`,
    `Email: ${email}`,
    `Organisation: ${organisation || "Not provided"}`,
    "",
    "Message:",
    message,
  ].join("\n");

  const html = `
    <div style="font-family: Arial, sans-serif; line-height: 1.5; color: #12141a;">
      <h2 style="margin: 0 0 12px;">New website enquiry</h2>
      <p><strong>Name:</strong> ${escapeHtml(name)}</p>
      <p><strong>Email:</strong> ${escapeHtml(email)}</p>
      <p><strong>Organisation:</strong> ${escapeHtml(organisation || "Not provided")}</p>
      <p><strong>Message:</strong></p>
      <p style="white-space: pre-wrap;">${escapeHtml(message)}</p>
    </div>
  `;

  const payload = {
    to: [contactTo],
    subject,
    text,
    html,
    fromName,
    replyTo: email,
  };

  if (fromEmail) {
    payload.from = fromEmail;
  }

  const mailRes = await fetch("https://api.oqumail.com/api/v1/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!mailRes.ok) {
    const detail = await mailRes.text().catch(() => "");
    console.error("[omniq-mail] OquMail error:", mailRes.status, detail);
    return json(
      {
        ok: false,
        error:
          "We could not send your message right now. Please try again shortly.",
      },
      502
    );
  }

  return json({ ok: true });
}

async function serveAssets(request, env, pathname) {
  const url = new URL(request.url);
  const assetUrl = new URL(pathname, url.origin);
  // Follow asset redirects internally so the browser never enters a loop
  // (e.g. /admin/index.html -> /admin/)
  let res = await env.ASSETS.fetch(new Request(assetUrl.toString(), request));
  let hops = 0;
  while (res.status >= 300 && res.status < 400 && hops < 3) {
    const loc = res.headers.get("Location");
    if (!loc) break;
    const next = new URL(loc, url.origin);
    res = await env.ASSETS.fetch(new Request(next.toString(), request));
    hops += 1;
  }
  return res;
}

async function serveNotFoundPage(request, env, { noindex = true } = {}) {
  const page = await serveAssets(request, env, "/404.html");
  const headers = new Headers(page.headers);
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  if (noindex) headers.set("X-Robots-Tag", "noindex, nofollow");

  // Always return HTTP 404 even if the HTML asset itself loaded with 200
  if (page.ok || page.status === 404) {
    return new Response(page.body, {
      status: 404,
      statusText: "Not Found",
      headers,
    });
  }

  // Fallback if 404.html is missing from the deploy
  return new Response(
    `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/><title>Page not found | OMNIQ</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:system-ui,sans-serif;background:#eef0f2;color:#12141a;padding:1.5rem}main{max-width:28rem;text-align:center;background:#fff;border-radius:1.25rem;padding:2rem;box-shadow:0 12px 40px rgba(0,0,0,.08)}a{display:inline-block;margin-top:1rem;padding:.75rem 1.1rem;border-radius:.75rem;background:#00a8d5;color:#fff;text-decoration:none;font-weight:600}</style></head><body><main><h1>Page not found</h1><p>The page you requested is not available.</p><a href="/">Return home</a></main></body></html>`,
    {
      status: 404,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Robots-Tag": "noindex, nofollow",
      },
    }
  );
}

async function handleAdminHost(request, env, url) {
  const path = url.pathname;

  // Shared public assets (logo, favicons)
  if (path.startsWith("/assets/")) {
    return env.ASSETS.fetch(request);
  }

  // Admin app static files (/admin/css, /admin/js, /admin/assets, /admin/)
  if (path === "/admin" || path.startsWith("/admin/")) {
    return env.ASSETS.fetch(request);
  }

  // Convenient aliases on the admin hostname
  if (path.startsWith("/css/") || path.startsWith("/js/")) {
    return serveAssets(request, env, `/admin${path}`);
  }

  // SPA shell for / — fetch /admin/ content without sending a browser redirect
  return serveAssets(request, env, "/admin/");
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/health" && request.method === "GET") {
      return handleHealth(env);
    }

    if (url.pathname === "/api/contact" && request.method === "POST") {
      return handleContact(request, env);
    }

    if (url.pathname.startsWith("/api/")) {
      return json({ ok: false, error: "Not found." }, 404);
    }

    if (isAdminHost(url.hostname)) {
      const adminResponse = await handleAdminHost(request, env, url);
      const headers = new Headers(adminResponse.headers);
      headers.set("X-Robots-Tag", "noindex, nofollow");
      headers.set("Cache-Control", headers.get("Cache-Control") || "private, no-store");
      return new Response(adminResponse.body, {
        status: adminResponse.status,
        statusText: adminResponse.statusText,
        headers,
      });
    }

    // Public marketing site: never expose admin app files
    if (
      url.pathname === "/admin" ||
      url.pathname === "/admin/" ||
      url.pathname.startsWith("/admin/") ||
      url.pathname.startsWith("/admin.")
    ) {
      return serveNotFoundPage(request, env);
    }

    // Explicit custom 404 route
    if (url.pathname === "/404" || url.pathname === "/404.html") {
      return serveNotFoundPage(request, env);
    }

    const assetResponse = await env.ASSETS.fetch(request);

    // Replace plain asset misses with the branded 404 page
    if (assetResponse.status === 404) {
      return serveNotFoundPage(request, env);
    }

    return assetResponse;
  },
};
