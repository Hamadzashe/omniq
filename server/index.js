import path from "node:path";
import { fileURLToPath } from "node:url";
import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import nodemailer from "nodemailer";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

dotenv.config({ path: path.join(rootDir, ".env") });
dotenv.config({ path: path.join(__dirname, ".env") });

const {
  OQUMAIL_API_KEY,
  CONTACT_TO,
  MAIL_FROM_NAME = "OMNIQ Integrated Systems",
  PORT = "3000",
  CORS_ORIGIN = "*",
} = process.env;

if (!OQUMAIL_API_KEY) {
  console.warn(
    "[omniq-mail] OQUMAIL_API_KEY is missing. Set it in .env before sending mail."
  );
}

if (!CONTACT_TO) {
  console.warn(
    "[omniq-mail] CONTACT_TO is missing. Set the inbox that should receive form submissions."
  );
}

const transport = nodemailer.createTransport({
  host: "mail.oqumail.com",
  port: 2587,
  secure: false,
  auth: {
    user: "apikey",
    pass: OQUMAIL_API_KEY || "",
  },
});

const app = express();
app.use(
  cors({
    origin: CORS_ORIGIN === "*" ? true : CORS_ORIGIN.split(",").map((v) => v.trim()),
  })
);
app.use(express.json({ limit: "32kb" }));
app.use(express.static(rootDir));

function sanitize(value, max = 500) {
  return String(value || "")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .trim()
    .slice(0, max);
}

function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    mailConfigured: Boolean(OQUMAIL_API_KEY && CONTACT_TO),
  });
});

app.post("/api/contact", async (req, res) => {
  try {
    if (!OQUMAIL_API_KEY || !CONTACT_TO) {
      return res.status(503).json({
        ok: false,
        error: "Mail is not configured on the server yet.",
      });
    }

    const name = sanitize(req.body?.name, 120);
    const email = sanitize(req.body?.email, 160).toLowerCase();
    const organisation = sanitize(req.body?.organisation, 160);
    const message = sanitize(req.body?.message, 4000);

    if (!name || !email || !message) {
      return res.status(400).json({
        ok: false,
        error: "Name, email, and message are required.",
      });
    }

    if (!isEmail(email)) {
      return res.status(400).json({
        ok: false,
        error: "Please provide a valid email address.",
      });
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

    await transport.sendMail({
      from: `${MAIL_FROM_NAME}`,
      to: CONTACT_TO,
      replyTo: `${name} <${email}>`,
      subject,
      text,
      html,
    });

    return res.json({ ok: true });
  } catch (error) {
    console.error("[omniq-mail] send failed:", error?.message || error);
    return res.status(502).json({
      ok: false,
      error: "We could not send your message right now. Please try again shortly.",
    });
  }
});

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

app.listen(Number(PORT), () => {
  console.log(`[omniq-mail] listening on http://localhost:${PORT}`);
});
