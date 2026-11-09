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
  return env.ASSETS.fetch(new Request(assetUrl.toString(), request));
}

async function handleAdminHost(request, env, url) {
  const path = url.pathname;

  // Shared public assets (logo, favicons)
  if (path.startsWith("/assets/")) {
    return env.ASSETS.fetch(request);
  }

  // Admin app static files
  if (path.startsWith("/admin/")) {
    return env.ASSETS.fetch(request);
  }

  // Convenient aliases on the admin hostname
  if (path.startsWith("/css/") || path.startsWith("/js/")) {
    return serveAssets(request, env, `/admin${path}`);
  }

  // SPA shell for / and client-side admin routes
  return serveAssets(request, env, "/admin/index.html");
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
      return handleAdminHost(request, env, url);
    }

    // Public marketing site must not expose /admin — use admin.omniq.co.zw only
    if (
      url.pathname === "/admin" ||
      url.pathname === "/admin/" ||
      url.pathname.startsWith("/admin/")
    ) {
      return Response.redirect("https://admin.omniq.co.zw/", 302);
    }

    return env.ASSETS.fetch(request);
  },
};
