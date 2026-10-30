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

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
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
      return json(
        { ok: false, error: "Please provide a valid email address." },
        400
      );
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
      to: contactTo,
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
  } catch (error) {
    console.error("[omniq-mail] send failed:", error?.message || error);
    return json(
      {
        ok: false,
        error:
          "We could not send your message right now. Please try again shortly.",
      },
      502
    );
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
    },
  });
}
