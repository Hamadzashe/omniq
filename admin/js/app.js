const cfg = window.OMNIQ_ADMIN;
const { createClient } = window.supabase;

const sb = createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
});

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  session: null,
  route: "dashboard",
  search: "",
  cache: {},
};

const TIER_LABELS = {
  tier_1: "Tier 1 (50–1,000 subjects)",
  tier_2: "Tier 2 (1,001–100,000)",
  tier_3: "Tier 3 (100,001–500,000)",
  tier_4: "Tier 4 (500,000+)",
  under_threshold: "Under threshold (<50)",
  exempt: "Exempt",
  unknown: "Not assessed",
};

function money(amount, currency = "USD") {
  const n = Number(amount || 0);
  try {
    return new Intl.NumberFormat("en-ZW", {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    }).format(n);
  } catch {
    return `${currency} ${n.toFixed(2)}`;
  }
}

function fmtDate(value) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function addMonths(isoDate, months = 1) {
  const d = new Date(`${isoDate}T12:00:00`);
  d.setMonth(d.getMonth() + months);
  return d.toISOString().slice(0, 10);
}

function isStaffEmail(email) {
  return String(email || "")
    .trim()
    .toLowerCase()
    .endsWith(`@${cfg.allowedEmailDomain}`);
}

function toast(message) {
  const root = $("#toast-root");
  root.innerHTML = `<div class="toast">${escapeHtml(message)}</div>`;
  setTimeout(() => {
    root.innerHTML = "";
  }, 2800);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function paymentStatus(row) {
  if (row.status === "paid") return "paid";
  if (row.status === "cancelled") return "cancelled";
  if (row.due_date && row.due_date < todayISO()) return "overdue";
  return "pending";
}

function statusPill(status) {
  const map = {
    paid: "paid",
    overdue: "overdue",
    pending: "pending",
    cancelled: "pending-status",
    registered: "registered",
    sent: "sent",
    active: "active",
    paused: "paused",
    pending_status: "pending-status",
  };
  const cls = map[status] || "pending-status";
  return `<span class="pill pill--${cls}">${escapeHtml(status.replaceAll("_", " "))}</span>`;
}

async function requireSession() {
  const { data } = await sb.auth.getSession();
  state.session = data.session;
  if (!state.session) {
    showLogin();
    return false;
  }
  const email = state.session.user?.email || "";
  if (!isStaffEmail(email)) {
    await sb.auth.signOut();
    showLogin("Only @omniq.co.zw accounts can access admin.");
    return false;
  }
  showApp();
  return true;
}

function showLogin(message = "") {
  document.body.classList.add("login-body");
  $("#login-view").classList.remove("hidden");
  $("#app-view").classList.add("hidden");
  const status = $("#login-status");
  status.textContent = message;
  status.classList.toggle("is-ok", false);
}

function showApp() {
  document.body.classList.remove("login-body");
  $("#login-view").classList.add("hidden");
  $("#app-view").classList.remove("hidden");
  const email = state.session.user.email || "";
  $("#user-email").textContent = email;
  $("#user-name").textContent = email.split("@")[0] || "Director";
}

function closeModal() {
  $("#modal-root").innerHTML = "";
}

function openModal(title, bodyHtml, onSubmit) {
  const root = $("#modal-root");
  root.innerHTML = `
    <div class="modal-backdrop" data-close>
      <form class="modal" id="modal-form">
        <h2>${escapeHtml(title)}</h2>
        ${bodyHtml}
        <div class="modal__actions">
          <button type="button" class="btn btn--ghost" data-close>Cancel</button>
          <button type="submit" class="btn btn--primary">Save</button>
        </div>
      </form>
    </div>
  `;
  root.querySelectorAll("[data-close]").forEach((el) => {
    el.addEventListener("click", (e) => {
      if (e.target.hasAttribute("data-close")) closeModal();
    });
  });
  $("#modal-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const values = Object.fromEntries(fd.entries());
    try {
      await onSubmit(values, e.currentTarget);
      closeModal();
    } catch (err) {
      toast(err.message || "Could not save.");
    }
  });
}

async function loadAll() {
  const [clients, services, dpo, payments, expenses, revenue, receipts] =
    await Promise.all([
      sb.from("clients").select("*").order("name"),
      sb.from("services").select("*").order("sort_order"),
      sb
        .from("dpo_engagements")
        .select("*, clients(name, organisation, email, phone)")
        .order("next_due_date"),
      sb
        .from("payments")
        .select("*, clients(name, organisation), services(name)")
        .order("due_date", { ascending: true }),
      sb.from("expenses").select("*").order("expense_date", { ascending: false }),
      sb
        .from("revenue_entries")
        .select("*")
        .order("entry_date", { ascending: false }),
      sb
        .from("receipts")
        .select("*, clients(name, organisation)")
        .order("issued_at", { ascending: false }),
    ]);

  const firstError = [
    clients.error,
    services.error,
    dpo.error,
    payments.error,
    expenses.error,
    revenue.error,
    receipts.error,
  ].find(Boolean);

  if (firstError) throw firstError;

  state.cache = {
    clients: clients.data || [],
    services: services.data || [],
    dpo: dpo.data || [],
    payments: payments.data || [],
    expenses: expenses.data || [],
    revenue: revenue.data || [],
    receipts: receipts.data || [],
  };
}

function matchesSearch(text) {
  const q = state.search.trim().toLowerCase();
  if (!q) return true;
  return String(text || "")
    .toLowerCase()
    .includes(q);
}

function duePayments() {
  return (state.cache.payments || []).filter((p) => {
    const st = paymentStatus(p);
    return st === "pending" || st === "overdue";
  });
}

function updateAlertsBadge() {
  const n = duePayments().length;
  const badge = $("#alerts-badge");
  badge.textContent = String(n);
  badge.classList.toggle("hidden", n === 0);
}

async function nextReceiptNumber() {
  const year = new Date().getFullYear();
  const prefix = `OMNIQ-${year}-`;
  const { data, error } = await sb
    .from("receipts")
    .select("receipt_number")
    .like("receipt_number", `${prefix}%`)
    .order("receipt_number", { ascending: false })
    .limit(1);
  if (error) throw error;
  const last = data?.[0]?.receipt_number;
  const seq = last ? Number(last.split("-").pop()) + 1 : 1;
  return `${prefix}${String(seq).padStart(4, "0")}`;
}

async function createReceiptForPayment(paymentId) {
  const payment = state.cache.payments.find((p) => p.id === paymentId);
  if (!payment) throw new Error("Payment not found.");

  const receiptNumber = await nextReceiptNumber();
  const lineItems = [
    {
      description: payment.description,
      amount: Number(payment.amount),
      service: payment.services?.name || null,
    },
  ];

  const { data: receipt, error } = await sb
    .from("receipts")
    .insert({
      receipt_number: receiptNumber,
      client_id: payment.client_id,
      payment_id: payment.id,
      amount: payment.amount,
      currency: payment.currency,
      line_items: lineItems,
      created_by: state.session.user.id,
      notes: payment.notes || null,
    })
    .select("*")
    .single();
  if (error) throw error;

  const { error: payErr } = await sb
    .from("payments")
    .update({
      status: "paid",
      paid_at: new Date().toISOString(),
      receipt_id: receipt.id,
    })
    .eq("id", payment.id);
  if (payErr) throw payErr;

  await sb.from("revenue_entries").insert({
    title: payment.description,
    amount: payment.amount,
    currency: payment.currency,
    entry_date: todayISO(),
    client_id: payment.client_id,
    payment_id: payment.id,
    created_by: state.session.user.id,
  });

  if (payment.dpo_engagement_id) {
    const eng = state.cache.dpo.find((d) => d.id === payment.dpo_engagement_id);
    if (eng) {
      await sb
        .from("dpo_engagements")
        .update({ next_due_date: addMonths(eng.next_due_date || todayISO(), 1) })
        .eq("id", eng.id);
    }
  }

  await refresh();
  renderReceipt(receipt.id);
  toast(`Receipt ${receiptNumber} created.`);
}

function renderReceipt(receiptId) {
  const receipt = state.cache.receipts.find((r) => r.id === receiptId);
  if (!receipt) return;
  const client = state.cache.clients.find((c) => c.id === receipt.client_id);
  const lines = Array.isArray(receipt.line_items) ? receipt.line_items : [];
  const html = `
    <div class="receipt-sheet">
      <div class="receipt-sheet__head">
        <div>
          <img src="${cfg.company.logoUrl}" alt="OMNIQ" />
          <p><strong>${escapeHtml(cfg.company.name)}</strong></p>
          <p>${escapeHtml(cfg.company.email)} · ${escapeHtml(cfg.company.phone)}</p>
          <p>${escapeHtml(cfg.company.country)}</p>
        </div>
        <div style="text-align:right">
          <h2 style="margin:0">RECEIPT</h2>
          <p><strong>${escapeHtml(receipt.receipt_number)}</strong></p>
          <p>${fmtDate(receipt.issued_at)}</p>
        </div>
      </div>
      <p><strong>Received from:</strong><br/>
        ${escapeHtml(client?.organisation || client?.name || "Client")}<br/>
        ${escapeHtml(client?.name || "")}<br/>
        ${escapeHtml(client?.email || "")}
      </p>
      <table>
        <thead><tr><th>Description</th><th>Amount</th></tr></thead>
        <tbody>
          ${lines
            .map(
              (l) =>
                `<tr><td>${escapeHtml(l.description)}</td><td>${money(
                  l.amount,
                  receipt.currency
                )}</td></tr>`
            )
            .join("")}
        </tbody>
      </table>
      <p style="margin-top:1rem;font-size:1.2rem"><strong>Total paid: ${money(
        receipt.amount,
        receipt.currency
      )}</strong></p>
      <p style="color:#6b7385">Thank you for your payment.</p>
      <div class="row-actions" style="margin-top:1rem">
        <button class="btn btn--primary" type="button" onclick="window.print()">Print / Save PDF</button>
      </div>
    </div>
  `;
  $("#receipt-print").innerHTML = html;
  $("#receipt-print").classList.remove("hidden");
  openModal("Receipt", html + `<p class="empty">Use Print to save a PDF.</p>`, async () => {});
  // Replace modal submit with close-only
  const actions = $(".modal__actions");
  if (actions) {
    actions.innerHTML = `<button type="button" class="btn btn--primary" data-close>Close</button>`;
    actions.querySelector("[data-close]")?.addEventListener("click", closeModal);
  }
}

function clientOptions(selected = "") {
  return state.cache.clients
    .map(
      (c) =>
        `<option value="${c.id}" ${c.id === selected ? "selected" : ""}>${escapeHtml(
          c.organisation || c.name
        )}</option>`
    )
    .join("");
}

function serviceOptions(selected = "") {
  return state.cache.services
    .filter((s) => s.is_active)
    .map(
      (s) =>
        `<option value="${s.id}" ${s.id === selected ? "selected" : ""}>${escapeHtml(
          s.name
        )}</option>`
    )
    .join("");
}

function renderDashboard() {
  const payments = state.cache.payments || [];
  const dues = duePayments();
  const overdue = dues.filter((p) => paymentStatus(p) === "overdue");
  const month = todayISO().slice(0, 7);
  const revenueMonth = (state.cache.revenue || [])
    .filter((r) => String(r.entry_date || "").startsWith(month))
    .reduce((sum, r) => sum + Number(r.amount || 0), 0);
  const expenseMonth = (state.cache.expenses || [])
    .filter((r) => String(r.expense_date || "").startsWith(month))
    .reduce((sum, r) => sum + Number(r.amount || 0), 0);
  const activeDpo = (state.cache.dpo || []).filter((d) => d.status === "active").length;

  const weekBars = [0, 1, 2, 3, 4, 5, 6].map((i) => {
    const d = new Date();
    d.setDate(d.getDate() - (6 - i));
    const key = d.toISOString().slice(0, 10);
    const total = (state.cache.revenue || [])
      .filter((r) => r.entry_date === key)
      .reduce((s, r) => s + Number(r.amount || 0), 0);
    return total;
  });
  const maxBar = Math.max(...weekBars, 1);

  return `
    <div class="welcome">
      <div>
        <h2>Welcome back</h2>
        <p>Track DPO retainers, client payments, expenses, and receipts in one place.</p>
      </div>
      <button class="btn btn--primary" type="button" data-action="quick-payment">Record payment due</button>
    </div>
    <div class="grid grid--stats" style="margin-bottom:1rem">
      <div class="card stat stat--accent">
        <div class="stat__label">Revenue this month</div>
        <div class="stat__value">${money(revenueMonth)}</div>
        <div class="stat__meta">${state.cache.clients.length} clients</div>
      </div>
      <div class="card stat stat--warn">
        <div class="stat__label">Expenses this month</div>
        <div class="stat__value">${money(expenseMonth)}</div>
        <div class="stat__meta">Net ${money(revenueMonth - expenseMonth)}</div>
      </div>
      <div class="card stat stat--danger">
        <div class="stat__label">Overdue</div>
        <div class="stat__value">${overdue.length}</div>
        <div class="stat__meta">${dues.length} open dues</div>
      </div>
      <div class="card stat stat--ok">
        <div class="stat__label">Active DPO clients</div>
        <div class="stat__value">${activeDpo}</div>
        <div class="stat__meta">SI 155 engagements</div>
      </div>
    </div>
    <div class="grid grid--dash">
      <div class="card">
        <h3>Due & overdue payments</h3>
        <div class="list">
          ${
            dues.length
              ? dues
                  .slice(0, 8)
                  .map((p) => {
                    const st = paymentStatus(p);
                    return `<div class="list-item">
                      <div>
                        <strong>${escapeHtml(p.clients?.organisation || p.clients?.name || "Client")}</strong>
                        <span>${escapeHtml(p.description)} · due ${fmtDate(p.due_date)}</span>
                      </div>
                      <div class="row-actions">
                        ${statusPill(st)}
                        <strong>${money(p.amount, p.currency)}</strong>
                        <button class="btn btn--primary btn--sm" data-action="pay-receipt" data-id="${p.id}">Mark paid + receipt</button>
                      </div>
                    </div>`;
                  })
                  .join("")
              : `<div class="empty">No outstanding payments. Nice work.</div>`
          }
        </div>
      </div>
      <div class="card">
        <h3>Income (last 7 days)</h3>
        <div class="bars">
          ${weekBars
            .map(
              (v) =>
                `<span title="${money(v)}" style="height:${Math.max(
                  8,
                  (v / maxBar) * 100
                )}%"></span>`
            )
            .join("")}
        </div>
        <p class="stat__meta" style="margin-top:0.75rem">DPO monthly fees and other receipts appear here when marked paid.</p>
      </div>
    </div>
  `;
}

function renderClients() {
  const rows = state.cache.clients.filter((c) =>
    matchesSearch(`${c.name} ${c.organisation} ${c.email} ${c.phone}`)
  );
  return `
    <div class="page-head">
      <div>
        <h1>Clients</h1>
        <p>Store organisations and contacts for billing and DPO work.</p>
      </div>
      <button class="btn btn--primary" data-action="client-new">Add client</button>
    </div>
    <div class="card table-wrap">
      <table>
        <thead>
          <tr><th>Name</th><th>Organisation</th><th>Email</th><th>Phone</th><th></th></tr>
        </thead>
        <tbody>
          ${
            rows.length
              ? rows
                  .map(
                    (c) => `<tr>
                      <td>${escapeHtml(c.name)}</td>
                      <td>${escapeHtml(c.organisation || "—")}</td>
                      <td>${escapeHtml(c.email || "—")}</td>
                      <td>${escapeHtml(c.phone || "—")}</td>
                      <td class="row-actions">
                        <button class="btn btn--ghost btn--sm" data-action="client-edit" data-id="${c.id}">Edit</button>
                        <button class="btn btn--danger btn--sm" data-action="client-del" data-id="${c.id}">Delete</button>
                      </td>
                    </tr>`
                  )
                  .join("")
              : `<tr><td colspan="5" class="empty">No clients yet.</td></tr>`
          }
        </tbody>
      </table>
    </div>
  `;
}

function renderServices() {
  const rows = state.cache.services.filter((s) =>
    matchesSearch(`${s.name} ${s.description}`)
  );
  return `
    <div class="page-head">
      <div>
        <h1>Services</h1>
        <p>Catalogue from the public site, plus custom services you add.</p>
      </div>
      <button class="btn btn--primary" data-action="service-new">Add custom service</button>
    </div>
    <div class="card table-wrap">
      <table>
        <thead>
          <tr><th>Service</th><th>Billing</th><th>Default fee</th><th>Type</th><th>Active</th><th></th></tr>
        </thead>
        <tbody>
          ${rows
            .map(
              (s) => `<tr>
                <td><strong>${escapeHtml(s.name)}</strong><br/><span style="color:#6b7385;font-size:0.82rem">${escapeHtml(
                  s.description || ""
                )}</span></td>
                <td>${escapeHtml(s.billing_cycle)}${s.is_recurring ? " · recurring" : ""}</td>
                <td>${s.default_amount != null ? money(s.default_amount, s.currency) : "—"}</td>
                <td>${s.is_custom ? "Custom" : "Catalogue"}</td>
                <td>${s.is_active ? "Yes" : "No"}</td>
                <td class="row-actions">
                  <button class="btn btn--ghost btn--sm" data-action="service-edit" data-id="${s.id}">Edit</button>
                </td>
              </tr>`
            )
            .join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderDpo() {
  const rows = state.cache.dpo.filter((d) =>
    matchesSearch(
      `${d.clients?.name} ${d.clients?.organisation} ${d.si155_tier} ${d.controller_status}`
    )
  );
  return `
    <div class="page-head">
      <div>
        <h1>DPO engagements</h1>
        <p>Monthly retainers, SI 155 tiers, controller licensing, and POTRAZ DPO notification.</p>
      </div>
      <button class="btn btn--primary" data-action="dpo-new">Add DPO client</button>
    </div>
    <div class="card table-wrap">
      <table>
        <thead>
          <tr>
            <th>Client</th><th>Started</th><th>SI 155 tier</th><th>Controller</th>
            <th>POTRAZ DPO notice</th><th>Monthly fee</th><th>Next due</th><th></th>
          </tr>
        </thead>
        <tbody>
          ${
            rows.length
              ? rows
                  .map((d) => {
                    const dueSoon =
                      d.status === "active" && d.next_due_date <= todayISO();
                    return `<tr>
                      <td>
                        <strong>${escapeHtml(d.clients?.organisation || d.clients?.name || "—")}</strong><br/>
                        ${statusPill(d.status)}
                      </td>
                      <td>${fmtDate(d.start_date)}</td>
                      <td>${escapeHtml(TIER_LABELS[d.si155_tier] || d.si155_tier)}</td>
                      <td>${statusPill(d.controller_status === "pending" ? "pending_status" : d.controller_status)}${
                        d.controller_licence_no
                          ? `<br/><span style="font-size:0.78rem;color:#6b7385">${escapeHtml(
                              d.controller_licence_no
                            )}</span>`
                          : ""
                      }</td>
                      <td>${statusPill(
                        d.potra_dpo_notification === "pending"
                          ? "pending_status"
                          : d.potra_dpo_notification
                      )}${
                        d.potra_notification_date
                          ? `<br/><span style="font-size:0.78rem;color:#6b7385">${fmtDate(
                              d.potra_notification_date
                            )}</span>`
                          : ""
                      }</td>
                      <td>${money(d.monthly_fee, d.currency)}</td>
                      <td>${fmtDate(d.next_due_date)} ${
                        dueSoon ? statusPill("overdue") : ""
                      }</td>
                      <td class="row-actions">
                        <button class="btn btn--ghost btn--sm" data-action="dpo-edit" data-id="${d.id}">Edit</button>
                        <button class="btn btn--primary btn--sm" data-action="dpo-bill" data-id="${d.id}">Create due</button>
                      </td>
                    </tr>`;
                  })
                  .join("")
              : `<tr><td colspan="8" class="empty">No DPO engagements yet.</td></tr>`
          }
        </tbody>
      </table>
    </div>
  `;
}

function renderBilling() {
  const rows = state.cache.payments.filter((p) =>
    matchesSearch(
      `${p.description} ${p.clients?.name} ${p.clients?.organisation} ${p.services?.name}`
    )
  );
  return `
    <div class="page-head">
      <div>
        <h1>Billing</h1>
        <p>Track who owes what, for which service, and issue receipts when paid.</p>
      </div>
      <button class="btn btn--primary" data-action="quick-payment">Add payment due</button>
    </div>
    <div class="card table-wrap">
      <table>
        <thead>
          <tr><th>Client</th><th>Service / description</th><th>Due</th><th>Amount</th><th>Status</th><th></th></tr>
        </thead>
        <tbody>
          ${
            rows.length
              ? rows
                  .map((p) => {
                    const st = paymentStatus(p);
                    return `<tr>
                      <td>${escapeHtml(p.clients?.organisation || p.clients?.name || "—")}</td>
                      <td>${escapeHtml(p.description)}</td>
                      <td>${fmtDate(p.due_date)}</td>
                      <td>${money(p.amount, p.currency)}</td>
                      <td>${statusPill(st)}</td>
                      <td class="row-actions">
                        ${
                          st !== "paid" && st !== "cancelled"
                            ? `<button class="btn btn--primary btn--sm" data-action="pay-receipt" data-id="${p.id}">Mark paid + receipt</button>`
                            : p.receipt_id
                              ? `<button class="btn btn--ghost btn--sm" data-action="receipt-view" data-id="${p.receipt_id}">View receipt</button>`
                              : ""
                        }
                      </td>
                    </tr>`;
                  })
                  .join("")
              : `<tr><td colspan="6" class="empty">No billing records yet.</td></tr>`
          }
        </tbody>
      </table>
    </div>
  `;
}

function renderFinance() {
  const expenses = state.cache.expenses.filter((e) =>
    matchesSearch(`${e.title} ${e.category}`)
  );
  const revenue = state.cache.revenue.filter((r) =>
    matchesSearch(`${r.title}`)
  );
  return `
    <div class="page-head">
      <div>
        <h1>Finance</h1>
        <p>Expenses and revenue for a clear income picture.</p>
      </div>
      <div class="row-actions">
        <button class="btn btn--ghost" data-action="expense-new">Add expense</button>
        <button class="btn btn--primary" data-action="revenue-new">Add revenue</button>
      </div>
    </div>
    <div class="grid grid--2">
      <div class="card table-wrap">
        <h3>Expenses</h3>
        <table>
          <thead><tr><th>Date</th><th>Title</th><th>Category</th><th>Amount</th></tr></thead>
          <tbody>
            ${
              expenses.length
                ? expenses
                    .map(
                      (e) => `<tr>
                        <td>${fmtDate(e.expense_date)}</td>
                        <td>${escapeHtml(e.title)}</td>
                        <td>${escapeHtml(e.category || "—")}</td>
                        <td>${money(e.amount, e.currency)}</td>
                      </tr>`
                    )
                    .join("")
                : `<tr><td colspan="4" class="empty">No expenses logged.</td></tr>`
            }
          </tbody>
        </table>
      </div>
      <div class="card table-wrap">
        <h3>Revenue</h3>
        <table>
          <thead><tr><th>Date</th><th>Title</th><th>Amount</th></tr></thead>
          <tbody>
            ${
              revenue.length
                ? revenue
                    .map(
                      (r) => `<tr>
                        <td>${fmtDate(r.entry_date)}</td>
                        <td>${escapeHtml(r.title)}</td>
                        <td>${money(r.amount, r.currency)}</td>
                      </tr>`
                    )
                    .join("")
                : `<tr><td colspan="3" class="empty">No revenue entries yet.</td></tr>`
            }
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function renderReceipts() {
  const rows = state.cache.receipts.filter((r) =>
    matchesSearch(
      `${r.receipt_number} ${r.clients?.name} ${r.clients?.organisation}`
    )
  );
  return `
    <div class="page-head">
      <div>
        <h1>Receipts</h1>
        <p>Professional receipts with the OMNIQ logo for paid services.</p>
      </div>
    </div>
    <div class="card table-wrap">
      <table>
        <thead>
          <tr><th>Number</th><th>Client</th><th>Issued</th><th>Amount</th><th></th></tr>
        </thead>
        <tbody>
          ${
            rows.length
              ? rows
                  .map(
                    (r) => `<tr>
                      <td>${escapeHtml(r.receipt_number)}</td>
                      <td>${escapeHtml(r.clients?.organisation || r.clients?.name || "—")}</td>
                      <td>${fmtDate(r.issued_at)}</td>
                      <td>${money(r.amount, r.currency)}</td>
                      <td><button class="btn btn--ghost btn--sm" data-action="receipt-view" data-id="${r.id}">Open</button></td>
                    </tr>`
                  )
                  .join("")
              : `<tr><td colspan="5" class="empty">No receipts yet. Mark a payment as paid to create one.</td></tr>`
          }
        </tbody>
      </table>
    </div>
  `;
}

const pages = {
  dashboard: renderDashboard,
  clients: renderClients,
  services: renderServices,
  dpo: renderDpo,
  billing: renderBilling,
  finance: renderFinance,
  receipts: renderReceipts,
};

function render() {
  const root = $("#page-root");
  const view = pages[state.route] || pages.dashboard;
  root.innerHTML = view();
  updateAlertsBadge();
  $$("#main-nav [data-route]").forEach((btn) => {
    btn.classList.toggle("is-active", btn.dataset.route === state.route);
  });
}

async function refresh() {
  await loadAll();
  render();
}

function clientForm(existing = null) {
  openModal(
    existing ? "Edit client" : "Add client",
    `
      <div class="field"><label>Contact name</label><input name="name" required value="${escapeHtml(
        existing?.name || ""
      )}" /></div>
      <div class="field"><label>Organisation</label><input name="organisation" value="${escapeHtml(
        existing?.organisation || ""
      )}" /></div>
      <div class="field"><label>Email</label><input name="email" type="email" value="${escapeHtml(
        existing?.email || ""
      )}" /></div>
      <div class="field"><label>Phone</label><input name="phone" value="${escapeHtml(
        existing?.phone || ""
      )}" /></div>
      <div class="field"><label>Notes</label><textarea name="notes">${escapeHtml(
        existing?.notes || ""
      )}</textarea></div>
    `,
    async (values) => {
      if (existing) {
        const { error } = await sb.from("clients").update(values).eq("id", existing.id);
        if (error) throw error;
      } else {
        const { error } = await sb.from("clients").insert(values);
        if (error) throw error;
      }
      await refresh();
      toast("Client saved.");
    }
  );
}

function serviceForm(existing = null) {
  openModal(
    existing ? "Edit service" : "Add custom service",
    `
      <div class="field"><label>Name</label><input name="name" required value="${escapeHtml(
        existing?.name || ""
      )}" /></div>
      <div class="field"><label>Description</label><textarea name="description">${escapeHtml(
        existing?.description || ""
      )}</textarea></div>
      <div class="field"><label>Billing cycle</label>
        <select name="billing_cycle">
          <option value="one_off" ${
            existing?.billing_cycle === "one_off" ? "selected" : ""
          }>One-off</option>
          <option value="monthly" ${
            existing?.billing_cycle === "monthly" ? "selected" : ""
          }>Monthly</option>
        </select>
      </div>
      <div class="field"><label>Default amount</label><input name="default_amount" type="number" step="0.01" value="${
        existing?.default_amount ?? ""
      }" /></div>
      <div class="field"><label>Active</label>
        <select name="is_active">
          <option value="true" ${existing?.is_active !== false ? "selected" : ""}>Yes</option>
          <option value="false" ${existing?.is_active === false ? "selected" : ""}>No</option>
        </select>
      </div>
    `,
    async (values) => {
      const payload = {
        name: values.name,
        description: values.description || null,
        billing_cycle: values.billing_cycle,
        is_recurring: values.billing_cycle === "monthly",
        default_amount: values.default_amount
          ? Number(values.default_amount)
          : null,
        is_active: values.is_active === "true",
        is_custom: existing ? existing.is_custom : true,
      };
      if (existing) {
        const { error } = await sb.from("services").update(payload).eq("id", existing.id);
        if (error) throw error;
      } else {
        const { error } = await sb.from("services").insert(payload);
        if (error) throw error;
      }
      await refresh();
      toast("Service saved.");
    }
  );
}

function dpoForm(existing = null) {
  openModal(
    existing ? "Edit DPO engagement" : "Add DPO engagement",
    `
      <div class="field"><label>Client</label><select name="client_id" required>${clientOptions(
        existing?.client_id || ""
      )}</select></div>
      <div class="field"><label>Start date</label><input name="start_date" type="date" required value="${
        existing?.start_date || todayISO()
      }" /></div>
      <div class="field"><label>Monthly fee</label><input name="monthly_fee" type="number" step="0.01" required value="${
        existing?.monthly_fee ?? ""
      }" /></div>
      <div class="field"><label>Next due date</label><input name="next_due_date" type="date" required value="${
        existing?.next_due_date || todayISO()
      }" /></div>
      <div class="field"><label>SI 155 tier</label>
        <select name="si155_tier">
          ${Object.entries(TIER_LABELS)
            .map(
              ([k, label]) =>
                `<option value="${k}" ${
                  existing?.si155_tier === k ? "selected" : ""
                }>${escapeHtml(label)}</option>`
            )
            .join("")}
        </select>
      </div>
      <div class="field"><label>Estimated data subjects</label><input name="data_subjects_estimate" type="number" value="${
        existing?.data_subjects_estimate ?? ""
      }" /></div>
      <div class="field"><label>Controller registration</label>
        <select name="controller_status">
          <option value="not_started">Not started</option>
          <option value="pending" ${
            existing?.controller_status === "pending" ? "selected" : ""
          }>Pending</option>
          <option value="registered" ${
            existing?.controller_status === "registered" ? "selected" : ""
          }>Registered</option>
        </select>
      </div>
      <div class="field"><label>Controller licence no.</label><input name="controller_licence_no" value="${escapeHtml(
        existing?.controller_licence_no || ""
      )}" /></div>
      <div class="field"><label>POTRAZ DPO notification</label>
        <select name="potra_dpo_notification">
          <option value="not_started">Not started</option>
          <option value="pending" ${
            existing?.potra_dpo_notification === "pending" ? "selected" : ""
          }>Pending</option>
          <option value="sent" ${
            existing?.potra_dpo_notification === "sent" ? "selected" : ""
          }>Sent</option>
          <option value="not_required" ${
            existing?.potra_dpo_notification === "not_required" ? "selected" : ""
          }>Not required</option>
        </select>
      </div>
      <div class="field"><label>POTRAZ notification date</label><input name="potra_notification_date" type="date" value="${
        existing?.potra_notification_date || ""
      }" /></div>
      <div class="field"><label>Status</label>
        <select name="status">
          <option value="active">Active</option>
          <option value="paused" ${existing?.status === "paused" ? "selected" : ""}>Paused</option>
          <option value="ended" ${existing?.status === "ended" ? "selected" : ""}>Ended</option>
        </select>
      </div>
      <div class="field"><label>Notes</label><textarea name="notes">${escapeHtml(
        existing?.notes || ""
      )}</textarea></div>
    `,
    async (values) => {
      const payload = {
        client_id: values.client_id,
        start_date: values.start_date,
        monthly_fee: Number(values.monthly_fee),
        next_due_date: values.next_due_date,
        si155_tier: values.si155_tier,
        data_subjects_estimate: values.data_subjects_estimate
          ? Number(values.data_subjects_estimate)
          : null,
        controller_status: values.controller_status,
        controller_licence_no: values.controller_licence_no || null,
        potra_dpo_notification: values.potra_dpo_notification,
        potra_notification_date: values.potra_notification_date || null,
        status: values.status,
        notes: values.notes || null,
      };
      if (existing) {
        const { error } = await sb
          .from("dpo_engagements")
          .update(payload)
          .eq("id", existing.id);
        if (error) throw error;
      } else {
        const { error } = await sb.from("dpo_engagements").insert(payload);
        if (error) throw error;
      }
      await refresh();
      toast("DPO engagement saved.");
    }
  );
}

function paymentForm() {
  if (!state.cache.clients.length) {
    toast("Add a client first.");
    return;
  }
  openModal(
    "Add payment due",
    `
      <div class="field"><label>Client</label><select name="client_id" required>${clientOptions()}</select></div>
      <div class="field"><label>Service</label><select name="service_id"><option value="">Custom / other</option>${serviceOptions()}</select></div>
      <div class="field"><label>Description</label><input name="description" required placeholder="e.g. Website development deposit" /></div>
      <div class="field"><label>Amount</label><input name="amount" type="number" step="0.01" required /></div>
      <div class="field"><label>Due date</label><input name="due_date" type="date" required value="${todayISO()}" /></div>
      <div class="field"><label>Notes</label><textarea name="notes"></textarea></div>
    `,
    async (values) => {
      const service = state.cache.services.find((s) => s.id === values.service_id);
      const { error } = await sb.from("payments").insert({
        client_id: values.client_id,
        service_id: values.service_id || null,
        description:
          values.description ||
          service?.name ||
          "Service payment",
        amount: Number(values.amount),
        due_date: values.due_date,
        notes: values.notes || null,
        status: "pending",
      });
      if (error) throw error;
      await refresh();
      toast("Payment due recorded.");
    }
  );
}

async function createDpoDue(engagementId) {
  const eng = state.cache.dpo.find((d) => d.id === engagementId);
  if (!eng) return;
  const { error } = await sb.from("payments").insert({
    client_id: eng.client_id,
    dpo_engagement_id: eng.id,
    service_id:
      state.cache.services.find((s) => s.name.includes("DPO"))?.id || null,
    description: `DPO monthly fee — ${eng.clients?.organisation || eng.clients?.name || "client"}`,
    amount: eng.monthly_fee,
    currency: eng.currency,
    due_date: eng.next_due_date || todayISO(),
    status: "pending",
  });
  if (error) {
    toast(error.message);
    return;
  }
  await refresh();
  state.route = "billing";
  render();
  toast("DPO payment due created.");
}

function expenseForm() {
  openModal(
    "Add expense",
    `
      <div class="field"><label>Title</label><input name="title" required /></div>
      <div class="field"><label>Category</label><input name="category" placeholder="e.g. Software, Travel" /></div>
      <div class="field"><label>Amount</label><input name="amount" type="number" step="0.01" required /></div>
      <div class="field"><label>Date</label><input name="expense_date" type="date" required value="${todayISO()}" /></div>
      <div class="field"><label>Notes</label><textarea name="notes"></textarea></div>
    `,
    async (values) => {
      const { error } = await sb.from("expenses").insert({
        title: values.title,
        category: values.category || null,
        amount: Number(values.amount),
        expense_date: values.expense_date,
        notes: values.notes || null,
        created_by: state.session.user.id,
      });
      if (error) throw error;
      await refresh();
      toast("Expense saved.");
    }
  );
}

function revenueForm() {
  openModal(
    "Add revenue",
    `
      <div class="field"><label>Title</label><input name="title" required /></div>
      <div class="field"><label>Amount</label><input name="amount" type="number" step="0.01" required /></div>
      <div class="field"><label>Date</label><input name="entry_date" type="date" required value="${todayISO()}" /></div>
      <div class="field"><label>Client (optional)</label><select name="client_id"><option value="">—</option>${clientOptions()}</select></div>
      <div class="field"><label>Notes</label><textarea name="notes"></textarea></div>
    `,
    async (values) => {
      const { error } = await sb.from("revenue_entries").insert({
        title: values.title,
        amount: Number(values.amount),
        entry_date: values.entry_date,
        client_id: values.client_id || null,
        notes: values.notes || null,
        created_by: state.session.user.id,
      });
      if (error) throw error;
      await refresh();
      toast("Revenue saved.");
    }
  );
}

function bindUi() {
  $("#login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const status = $("#login-status");
    status.textContent = "";
    const email = $("#login-email").value.trim().toLowerCase();
    const password = $("#login-password").value;
    if (!isStaffEmail(email)) {
      status.textContent = `Use an @${cfg.allowedEmailDomain} email.`;
      return;
    }
    status.textContent = "Signing in…";
    const { error } = await sb.auth.signInWithPassword({ email, password });
    if (error) {
      status.textContent = error.message;
      return;
    }
    await boot();
  });

  $("#logout-btn").addEventListener("click", async () => {
    await sb.auth.signOut();
    showLogin();
  });

  $("#menu-toggle").addEventListener("click", () => {
    $("#sidebar").classList.toggle("is-open");
  });

  $("#main-nav").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-route]");
    if (!btn) return;
    state.route = btn.dataset.route;
    $("#sidebar").classList.remove("is-open");
    render();
  });

  $("#global-search").addEventListener("input", (e) => {
    state.search = e.target.value;
    render();
  });

  $("#alerts-btn").addEventListener("click", () => {
    state.route = "billing";
    render();
  });

  $("#page-root").addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    const { action, id } = btn.dataset;

    if (action === "client-new") return clientForm();
    if (action === "client-edit") {
      return clientForm(state.cache.clients.find((c) => c.id === id));
    }
    if (action === "client-del") {
      if (!confirm("Delete this client?")) return;
      const { error } = await sb.from("clients").delete().eq("id", id);
      if (error) return toast(error.message);
      await refresh();
      return toast("Client deleted.");
    }
    if (action === "service-new") return serviceForm();
    if (action === "service-edit") {
      return serviceForm(state.cache.services.find((s) => s.id === id));
    }
    if (action === "dpo-new") {
      if (!state.cache.clients.length) return toast("Add a client first.");
      return dpoForm();
    }
    if (action === "dpo-edit") {
      return dpoForm(state.cache.dpo.find((d) => d.id === id));
    }
    if (action === "dpo-bill") return createDpoDue(id);
    if (action === "quick-payment") return paymentForm();
    if (action === "pay-receipt") {
      try {
        await createReceiptForPayment(id);
      } catch (err) {
        toast(err.message || "Could not create receipt.");
      }
      return;
    }
    if (action === "receipt-view") return renderReceipt(id);
    if (action === "expense-new") return expenseForm();
    if (action === "revenue-new") return revenueForm();
  });
}

async function boot() {
  const ok = await requireSession();
  if (!ok) return;
  try {
    await refresh();
  } catch (err) {
    console.error(err);
    toast(err.message || "Failed to load admin data. Check Supabase auth/RLS.");
    $("#page-root").innerHTML = `<div class="card empty">${escapeHtml(
      err.message || "Load failed"
    )}</div>`;
  }
}

bindUi();
sb.auth.onAuthStateChange((_event, session) => {
  state.session = session;
  if (!session) showLogin();
});
boot();
