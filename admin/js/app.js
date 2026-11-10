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
  financePeriod: sessionStorage.getItem("omniq_finance_period") || "this_month",
  realtimeReady: false,
};

const REALTIME_TABLES = [
  "clients",
  "services",
  "dpo_engagements",
  "service_engagements",
  "payments",
  "receipts",
  "expenses",
  "revenue_entries",
  "capital_contributions",
];

let realtimeChannel = null;
let refreshTimer = null;
let refreshInFlight = null;
let refreshDirty = false;
let livePollTimer = null;

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

/** Expenses are drawn from capital by default (startup pot), or from income. */
function expenseFundedBy(row) {
  return row?.funded_by === "income" ? "income" : "capital";
}

function fundedByLabel(row) {
  return expenseFundedBy(row) === "income" ? "From income" : "From capital";
}

function sumAmounts(rows) {
  return (rows || []).reduce((s, r) => s + Number(r.amount || 0), 0);
}

/** Days from today to a YYYY-MM-DD due date (negative = overdue). */
function daysUntilDue(dueDate) {
  if (!dueDate) return null;
  const today = new Date(`${todayISO()}T12:00:00`);
  const due = new Date(`${String(dueDate).slice(0, 10)}T12:00:00`);
  if (Number.isNaN(due.getTime())) return null;
  return Math.round((due - today) / 86400000);
}

function dueCountdownLabel(dueDate) {
  const days = daysUntilDue(dueDate);
  if (days == null) return "";
  if (days === 0) return "Due today";
  if (days === 1) return "1 day left";
  if (days > 1) return `${days} days left`;
  const overdue = Math.abs(days);
  if (overdue === 1) return "1 day overdue";
  return `${overdue} days overdue`;
}

function dueCountdownPill(dueDate) {
  const days = daysUntilDue(dueDate);
  if (days == null) return "";
  const label = dueCountdownLabel(dueDate);
  const cls = days < 0 ? "overdue" : days === 0 ? "pending" : "pending-status";
  return `<span class="pill pill--${cls}">${escapeHtml(label)}</span>`;
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

function refreshIcons() {
  if (window.lucide?.createIcons) {
    window.lucide.createIcons({
      attrs: { "stroke-width": 2 },
      nameAttr: "data-lucide",
    });
  }
}

function setSidebarOpen(open) {
  const sidebar = $("#sidebar");
  const backdrop = $("#sidebar-backdrop");
  if (!sidebar) return;
  sidebar.classList.toggle("is-open", open);
  if (backdrop) {
    if (open) backdrop.removeAttribute("hidden");
    else backdrop.setAttribute("hidden", "");
  }
}

function showApp() {
  document.body.classList.remove("login-body");
  $("#login-view").classList.add("hidden");
  $("#app-view").classList.remove("hidden");
  const email = state.session.user.email || "";
  $("#user-email").textContent = email;
  $("#user-name").textContent = email.split("@")[0] || "Director";
  refreshIcons();
}

function closeModal() {
  $("#modal-root").innerHTML = "";
  document.body.classList.remove("modal-open");
}

function openModal(title, bodyHtml, onSubmit) {
  const root = $("#modal-root");
  document.body.classList.add("modal-open");
  root.innerHTML = `
    <div class="modal-backdrop" id="modal-backdrop" role="presentation">
      <form class="modal" id="modal-form" role="dialog" aria-modal="true">
        <h2>${escapeHtml(title)}</h2>
        ${bodyHtml}
        <div class="modal__actions">
          <button type="button" class="btn btn--ghost" id="modal-cancel">Cancel</button>
          <button type="submit" class="btn btn--primary">Save</button>
        </div>
      </form>
    </div>
  `;
  refreshIcons();

  const backdrop = $("#modal-backdrop");
  const form = $("#modal-form");
  $("#modal-cancel")?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    closeModal();
  });

  // Ignore the same tap/click that opened the modal (common on mobile)
  let allowBackdropClose = false;
  window.setTimeout(() => {
    allowBackdropClose = true;
  }, 350);

  backdrop?.addEventListener("click", (e) => {
    if (!allowBackdropClose) return;
    if (e.target === backdrop) closeModal();
  });

  form?.addEventListener("click", (e) => e.stopPropagation());
  form?.addEventListener("submit", async (e) => {
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

function runAction(fn) {
  // Defer so the opening click cannot hit the new modal backdrop
  window.setTimeout(() => {
    try {
      fn();
    } catch (err) {
      toast(err.message || "Action failed.");
    }
  }, 0);
}

async function loadAll() {
  const [
    clients,
    services,
    dpo,
    engagements,
    payments,
    expenses,
    revenue,
    capital,
    receipts,
  ] = await Promise.all([
    sb.from("clients").select("*").order("name"),
    sb.from("services").select("*").order("sort_order"),
    sb
      .from("dpo_engagements")
      .select("*, clients(name, organisation, email, phone)")
      .order("next_due_date"),
    sb
      .from("service_engagements")
      .select("*, clients(name, organisation, email, phone), services(name)")
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
      .from("capital_contributions")
      .select("*")
      .order("contribution_date", { ascending: false }),
    sb
      .from("receipts")
      .select("*, clients(name, organisation)")
      .order("issued_at", { ascending: false }),
  ]);

  const firstError = [
    clients.error,
    services.error,
    dpo.error,
    engagements.error,
    payments.error,
    expenses.error,
    revenue.error,
    capital.error,
    receipts.error,
  ].find(Boolean);

  if (firstError) throw firstError;

  state.cache = {
    clients: clients.data || [],
    services: services.data || [],
    dpo: dpo.data || [],
    engagements: engagements.data || [],
    payments: payments.data || [],
    expenses: expenses.data || [],
    revenue: revenue.data || [],
    capital: capital.data || [],
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

  const existingRevenue = (state.cache.revenue || []).find(
    (r) => r.payment_id === payment.id
  );
  if (!existingRevenue) {
    await sb.from("revenue_entries").insert({
      title: payment.description,
      amount: payment.amount,
      currency: payment.currency,
      entry_date: todayISO(),
      client_id: payment.client_id,
      payment_id: payment.id,
      source: "client_payment",
      created_by: state.session.user.id,
    });
  }

  if (payment.dpo_engagement_id) {
    const eng = state.cache.dpo.find((d) => d.id === payment.dpo_engagement_id);
    if (eng) {
      await sb
        .from("dpo_engagements")
        .update({ next_due_date: addMonths(eng.next_due_date || todayISO(), 1) })
        .eq("id", eng.id);
    }
  }

  if (payment.service_engagement_id) {
    const eng = state.cache.engagements.find(
      (d) => d.id === payment.service_engagement_id
    );
    if (eng && eng.billing_cycle === "monthly") {
      await sb
        .from("service_engagements")
        .update({ next_due_date: addMonths(eng.next_due_date || todayISO(), 1) })
        .eq("id", eng.id);
    }
  }

  await refresh();
  renderReceipt(receipt.id);
  toast(`Receipt ${receiptNumber} created.`);
}

function buildReceiptHtml(receipt, client, { forPrint = false } = {}) {
  const lines = Array.isArray(receipt.line_items) ? receipt.line_items : [];
  const logoSrc = cfg.company.logoReceiptUrl || cfg.company.logoUrl;
  const actions = forPrint
    ? ""
    : `<div class="row-actions no-print" style="margin-top:1rem">
        <button class="btn btn--primary" type="button" data-print-receipt>Print / Save PDF</button>
      </div>`;
  return `
    <div class="receipt-sheet">
      <div class="receipt-sheet__head">
        <div>
          <div class="receipt-logo">
            <img src="${logoSrc}" alt="OMNIQ Integrated Systems" width="200" height="120" />
          </div>
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
      ${actions}
    </div>
  `;
}

function renderReceipt(receiptId) {
  const receipt = state.cache.receipts.find((r) => r.id === receiptId);
  if (!receipt) return;
  const client = state.cache.clients.find((c) => c.id === receipt.client_id);
  const modalHtml = buildReceiptHtml(receipt, client, { forPrint: false });
  const printHtml = buildReceiptHtml(receipt, client, { forPrint: true });

  const printHost = $("#receipt-print");
  if (printHost) {
    printHost.innerHTML = printHtml;
    printHost.setAttribute("aria-hidden", "true");
  }

  openModal(
    "Receipt",
    `<div class="receipt-modal-body">${modalHtml}</div>
     <p class="lede-mini no-print">Print or save this receipt as a PDF.</p>`,
    async () => {}
  );
  const actions = $(".modal__actions");
  if (actions) {
    actions.innerHTML = `
      <button type="button" class="btn btn--ghost no-print" id="modal-close-receipt">Close</button>
      <button type="button" class="btn btn--primary no-print" id="modal-print-receipt">Print / Save PDF</button>
    `;
    $("#modal-close-receipt")?.addEventListener("click", closeModal);
    $("#modal-print-receipt")?.addEventListener("click", () => window.print());
    $("#modal-form button[type='submit']")?.remove();
  }
  $$("[data-print-receipt]").forEach((btn) => {
    btn.addEventListener("click", () => window.print());
  });
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
  const dues = duePayments();
  const overdue = dues.filter((p) => paymentStatus(p) === "overdue");
  const month = todayISO().slice(0, 7);
  const revenueMonth = (state.cache.revenue || [])
    .filter((r) => String(r.entry_date || "").startsWith(month))
    .reduce((sum, r) => sum + Number(r.amount || 0), 0);
  const expensesAll = state.cache.expenses || [];
  const expenseMonthRows = expensesAll.filter((r) =>
    String(r.expense_date || "").startsWith(month)
  );
  const expenseMonth = sumAmounts(expenseMonthRows);
  const capitalSpendMonth = sumAmounts(
    expenseMonthRows.filter((e) => expenseFundedBy(e) === "capital")
  );
  const capitalAll = state.cache.capital || [];
  const capitalMonth = capitalAll
    .filter((c) => String(c.contribution_date || "").startsWith(month))
    .reduce((sum, c) => sum + Number(c.amount || 0), 0);
  const capitalTotal = sumAmounts(capitalAll);
  const capitalSpendAll = sumAmounts(
    expensesAll.filter((e) => expenseFundedBy(e) === "capital")
  );
  const capitalRemaining = capitalTotal - capitalSpendAll;
  const recentCapital = [...capitalAll]
    .sort((a, b) =>
      String(b.contribution_date || "").localeCompare(
        String(a.contribution_date || "")
      )
    )
    .slice(0, 5);
  const activeDpo = (state.cache.dpo || []).filter((d) => d.status === "active")
    .length;

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
        <h2>Overview</h2>
        <p>Clients, services, billing, and finance at a glance.</p>
      </div>
      <button class="btn btn--primary" type="button" data-action="quick-payment">Record payment due</button>
    </div>
    <div class="grid grid--stats" style="margin-bottom:1rem">
      <div class="card stat stat--ok">
        <div class="stat__label">Income this month</div>
        <div class="stat__value">${money(revenueMonth)}</div>
        <div class="stat__meta">${state.cache.clients.length} clients</div>
      </div>
      <div class="card stat stat--accent">
        <div class="stat__label">Capital remaining</div>
        <div class="stat__value">${money(capitalRemaining)}</div>
        <div class="stat__meta">Introduced ${money(capitalTotal)} · spent ${money(
          capitalSpendAll
        )}</div>
      </div>
      <div class="card stat stat--warn">
        <div class="stat__label">Expenses this month</div>
        <div class="stat__value">${money(expenseMonth)}</div>
        <div class="stat__meta">From capital ${money(
          capitalSpendMonth
        )} · capital in ${money(capitalMonth)}</div>
      </div>
      <div class="card stat stat--danger">
        <div class="stat__label">Overdue</div>
        <div class="stat__value">${overdue.length}</div>
        <div class="stat__meta">${dues.length} open dues · ${activeDpo} active DPO</div>
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
                        <span>${escapeHtml(p.description)} · ${fmtDate(p.due_date)}</span>
                        <div class="stack-card__meta" style="margin-top:0.35rem">${dueCountdownPill(
                          p.due_date
                        )}</div>
                      </div>
                      <div class="row-actions">
                        ${statusPill(st)}
                        <strong>${money(p.amount, p.currency)}</strong>
                        <button class="btn btn--primary btn--sm" data-action="pay-receipt" data-id="${p.id}">Mark paid + receipt</button>
                      </div>
                    </div>`;
                  })
                  .join("")
              : `<div class="empty">No outstanding payments.</div>`
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
        <p class="stat__meta" style="margin-top:0.75rem">Paid receipts recorded this week.</p>
      </div>
    </div>
    <div class="card" style="margin-top:1rem">
      <h3>Capital contributions</h3>
      <div class="list">
        ${
          recentCapital.length
            ? recentCapital
                .map(
                  (c) => `<div class="list-item">
                    <div>
                      <strong>${escapeHtml(c.contributor_name)}</strong>
                      <span>${fmtDate(c.contribution_date)}${
                        c.notes ? ` · ${escapeHtml(c.notes)}` : ""
                      }</span>
                    </div>
                    <strong>${money(c.amount, c.currency)}</strong>
                  </div>`
                )
                .join("")
            : `<div class="empty">No capital contributions recorded.</div>`
        }
      </div>
    </div>
  `;
}

function emptyCard(message) {
  return `<div class="card"><div class="empty">${escapeHtml(message)}</div></div>`;
}

function renderClients() {
  const rows = state.cache.clients.filter((c) =>
    matchesSearch(`${c.name} ${c.organisation} ${c.email} ${c.phone}`)
  );
  return `
    <div class="page-head">
      <div>
        <h1>Clients</h1>
        <p>Client and organisation records.</p>
      </div>
      <button class="btn btn--primary" type="button" data-action="client-new">Add client</button>
    </div>
    ${
      rows.length
        ? `<div class="stack-list">${rows
            .map(
              (c) => `<article class="stack-card">
                <div class="stack-card__main">
                  <strong>${escapeHtml(c.name)}</strong>
                  <span>${escapeHtml(c.organisation || "No organisation")}</span>
                  <span>${escapeHtml(c.email || "No email")}${c.phone ? ` · ${escapeHtml(c.phone)}` : ""}</span>
                </div>
                <div class="row-actions">
                  <button class="btn btn--ghost btn--sm" type="button" data-action="client-edit" data-id="${c.id}">Edit</button>
                  <button class="btn btn--danger btn--sm" type="button" data-action="client-del" data-id="${c.id}">Delete</button>
                </div>
              </article>`
            )
            .join("")}</div>`
        : emptyCard("No clients yet.")
    }
  `;
}

function nonDpoServiceOptions(selected = "") {
  return state.cache.services
    .filter((s) => s.is_active && !/dpo/i.test(s.name))
    .map(
      (s) =>
        `<option value="${s.id}" ${s.id === selected ? "selected" : ""}>${escapeHtml(
          s.name
        )}</option>`
    )
    .join("");
}

function renderServices() {
  const catalogue = state.cache.services.filter((s) =>
    matchesSearch(`${s.name} ${s.description}`)
  );
  const engagements = (state.cache.engagements || []).filter((e) =>
    matchesSearch(
      `${e.service_name} ${e.clients?.name} ${e.clients?.organisation}`
    )
  );
  return `
    <div class="page-head">
      <div>
        <h1>Services</h1>
        <p>Service catalogue and client service engagements.</p>
      </div>
      <div class="row-actions page-head__actions">
        <button class="btn btn--ghost" type="button" data-action="service-new">Add catalogue item</button>
        <button class="btn btn--primary" type="button" data-action="engagement-new">New engagement</button>
      </div>
    </div>

    <h3 class="section-label">Client engagements</h3>
    ${
      engagements.length
        ? `<div class="stack-list" style="margin-bottom:1.25rem">${engagements
            .map((e) => {
              return `<article class="stack-card">
                <div class="stack-card__main">
                  <strong>${escapeHtml(e.service_name)}</strong>
                  <span>${escapeHtml(e.clients?.organisation || e.clients?.name || "—")}</span>
                  <div class="stack-card__meta">${statusPill(e.status)} ${
                    e.status === "active" ? dueCountdownPill(e.next_due_date) : ""
                  }</div>
                  <span>${escapeHtml(e.billing_cycle)} · Started ${fmtDate(e.start_date)} · Next due ${fmtDate(
                    e.next_due_date
                  )}</span>
                  <span class="stack-card__amount">${money(e.fee, e.currency)}${
                    e.billing_cycle === "monthly" ? " / month" : ""
                  }</span>
                </div>
                <div class="row-actions">
                  <button class="btn btn--ghost btn--sm" type="button" data-action="engagement-edit" data-id="${e.id}">Edit</button>
                  <button class="btn btn--primary btn--sm" type="button" data-action="engagement-bill" data-id="${e.id}">Create due</button>
                  <button class="btn btn--danger btn--sm" type="button" data-action="engagement-del" data-id="${e.id}">Delete</button>
                </div>
              </article>`;
            })
            .join("")}</div>`
        : `<div style="margin-bottom:1.25rem">${emptyCard(
            "No client service engagements yet."
          )}</div>`
    }

    <h3 class="section-label">Service catalogue</h3>
    <div class="stack-list">
      ${catalogue
        .map(
          (s) => `<article class="stack-card">
            <div class="stack-card__main">
              <strong>${escapeHtml(s.name)}</strong>
              <span>${escapeHtml(s.description || "")}</span>
              <span>${escapeHtml(s.billing_cycle)}${s.is_recurring ? " · recurring" : ""} · ${
                s.default_amount != null ? money(s.default_amount, s.currency) : "No default fee"
              } · ${s.is_custom ? "Custom" : "Catalogue"} · ${s.is_active ? "Active" : "Inactive"}</span>
            </div>
            <div class="row-actions">
              <button class="btn btn--ghost btn--sm" type="button" data-action="service-edit" data-id="${s.id}">Edit</button>
            </div>
          </article>`
        )
        .join("")}
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
        <p>Retainers, SI 155 tiers, controller registration, and POTRAZ notification status.</p>
      </div>
      <button class="btn btn--primary" type="button" data-action="dpo-new">Add DPO client</button>
    </div>
    ${
      rows.length
        ? `<div class="stack-list">${rows
            .map((d) => {
              return `<article class="stack-card">
                <div class="stack-card__main">
                  <strong>${escapeHtml(d.clients?.organisation || d.clients?.name || "—")}</strong>
                  <div class="stack-card__meta">${statusPill(d.status)} ${
                    d.status === "active" ? dueCountdownPill(d.next_due_date) : ""
                  }</div>
                  <span>Started ${fmtDate(d.start_date)} · Next due ${fmtDate(d.next_due_date)}</span>
                  <span>${escapeHtml(TIER_LABELS[d.si155_tier] || d.si155_tier)}</span>
                  <span>Controller: ${escapeHtml(d.controller_status.replaceAll("_", " "))}${
                    d.controller_licence_no ? ` (${escapeHtml(d.controller_licence_no)})` : ""
                  }</span>
                  <span>POTRAZ DPO notice: ${escapeHtml(
                    d.potra_dpo_notification.replaceAll("_", " ")
                  )}${
                    d.potra_notification_date ? ` · ${fmtDate(d.potra_notification_date)}` : ""
                  }</span>
                  <span class="stack-card__amount">${money(d.monthly_fee, d.currency)} / month</span>
                </div>
                <div class="row-actions">
                  <button class="btn btn--ghost btn--sm" type="button" data-action="dpo-edit" data-id="${d.id}">Edit</button>
                  <button class="btn btn--primary btn--sm" type="button" data-action="dpo-bill" data-id="${d.id}">Create due</button>
                  <button class="btn btn--danger btn--sm" type="button" data-action="dpo-del" data-id="${d.id}">Delete</button>
                </div>
              </article>`;
            })
            .join("")}</div>`
        : emptyCard("No DPO engagements yet.")
    }
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
        <p>Outstanding and paid invoices for client services.</p>
      </div>
      <button class="btn btn--primary" type="button" data-action="quick-payment">Add payment due</button>
    </div>
    ${
      rows.length
        ? `<div class="stack-list">${rows
            .map((p) => {
              const st = paymentStatus(p);
              return `<article class="stack-card">
                <div class="stack-card__main">
                  <strong>${escapeHtml(p.clients?.organisation || p.clients?.name || "—")}</strong>
                  <span>${escapeHtml(p.description)}</span>
                  <span>Due ${fmtDate(p.due_date)}</span>
                  <div class="stack-card__meta">${statusPill(st)}${
                    st === "paid" || st === "cancelled"
                      ? ""
                      : ` ${dueCountdownPill(p.due_date)}`
                  }</div>
                  <span class="stack-card__amount">${money(p.amount, p.currency)}</span>
                </div>
                <div class="row-actions">
                  ${
                    st !== "paid" && st !== "cancelled"
                      ? `<button class="btn btn--primary btn--sm" type="button" data-action="pay-receipt" data-id="${p.id}">Mark paid + receipt</button>`
                      : p.receipt_id
                        ? `<button class="btn btn--ghost btn--sm" type="button" data-action="receipt-view" data-id="${p.receipt_id}">View receipt</button>`
                        : ""
                  }
                  <button class="btn btn--ghost btn--sm" type="button" data-action="payment-edit" data-id="${p.id}">Edit</button>
                  <button class="btn btn--danger btn--sm" type="button" data-action="payment-del" data-id="${p.id}">Delete</button>
                </div>
              </article>`;
            })
            .join("")}</div>`
        : emptyCard("No billing records yet.")
    }
  `;
}

const FINANCE_PERIODS = [
  { id: "this_month", label: "This month" },
  { id: "last_month", label: "Last month" },
  { id: "this_quarter", label: "This quarter" },
  { id: "last_quarter", label: "Last quarter" },
  { id: "this_year", label: "This year" },
  { id: "last_year", label: "Last year" },
  { id: "all_time", label: "All time" },
];

function monthLabel(year, monthIndex) {
  return new Date(year, monthIndex, 1).toLocaleDateString("en-GB", {
    month: "long",
    year: "numeric",
  });
}

function financeRange(period = state.financePeriod) {
  const now = new Date(`${todayISO()}T12:00:00`);
  const y = now.getFullYear();
  const m = now.getMonth(); // 0-11
  const iso = (d) => d.toISOString().slice(0, 10);
  const startOfMonth = (yy, mm) => new Date(yy, mm, 1, 12);
  const endOfMonth = (yy, mm) => new Date(yy, mm + 1, 0, 12);

  switch (period) {
    case "last_month": {
      const d = startOfMonth(y, m - 1);
      const e = endOfMonth(y, m - 1);
      return {
        start: iso(d),
        end: iso(e),
        label: monthLabel(d.getFullYear(), d.getMonth()),
      };
    }
    case "this_quarter": {
      const q = Math.floor(m / 3) * 3;
      return {
        start: iso(startOfMonth(y, q)),
        end: iso(endOfMonth(y, q + 2)),
        label: `Q${Math.floor(m / 3) + 1} ${y}`,
      };
    }
    case "last_quarter": {
      const q = Math.floor(m / 3) * 3 - 3;
      const d = startOfMonth(y, q);
      const e = endOfMonth(y, q + 2);
      return {
        start: iso(d),
        end: iso(e),
        label: `Q${Math.floor(d.getMonth() / 3) + 1} ${d.getFullYear()}`,
      };
    }
    case "this_year":
      return { start: `${y}-01-01`, end: `${y}-12-31`, label: String(y) };
    case "last_year":
      return {
        start: `${y - 1}-01-01`,
        end: `${y - 1}-12-31`,
        label: String(y - 1),
      };
    case "all_time":
      return { start: null, end: null, label: "All time" };
    case "this_month":
    default:
      return {
        start: iso(startOfMonth(y, m)),
        end: iso(endOfMonth(y, m)),
        label: monthLabel(y, m),
      };
  }
}

function inFinanceRange(dateStr, range = financeRange()) {
  if (!dateStr) return false;
  const d = String(dateStr).slice(0, 10);
  if (!range.start && !range.end) return true;
  if (range.start && d < range.start) return false;
  if (range.end && d > range.end) return false;
  return true;
}

function getFilteredFinance() {
  const range = financeRange();
  const expenses = (state.cache.expenses || []).filter(
    (e) =>
      inFinanceRange(e.expense_date, range) &&
      matchesSearch(`${e.title} ${e.category} ${fundedByLabel(e)}`)
  );
  const income = (state.cache.revenue || []).filter(
    (r) =>
      inFinanceRange(r.entry_date, range) && matchesSearch(`${r.title}`)
  );
  // Capital is a running pot — always show all contributions (search only),
  // not filtered by the income/expense period.
  const capital = (state.cache.capital || []).filter((c) =>
    matchesSearch(`${c.contributor_name} ${c.notes || ""}`)
  );
  const capitalInPeriod = capital.filter((c) =>
    inFinanceRange(c.contribution_date, range)
  );
  const capitalExpenses = expenses.filter(
    (e) => expenseFundedBy(e) === "capital"
  );
  const incomeExpenses = expenses.filter(
    (e) => expenseFundedBy(e) === "income"
  );
  const incomeTotal = sumAmounts(income);
  const capitalAllTime = sumAmounts(capital);
  const capitalPeriodTotal = sumAmounts(capitalInPeriod);
  const capitalTotal = capitalAllTime;
  const expenseTotal = sumAmounts(expenses);
  const capitalSpend = sumAmounts(capitalExpenses);
  const incomeSpend = sumAmounts(incomeExpenses);
  const capitalSpendAllTime = sumAmounts(
    (state.cache.expenses || []).filter((e) => expenseFundedBy(e) === "capital")
  );
  return {
    range,
    expenses,
    income,
    capital,
    capitalInPeriod,
    capitalExpenses,
    incomeExpenses,
    incomeTotal,
    expenseTotal,
    capitalTotal,
    capitalPeriodTotal,
    capitalSpend,
    incomeSpend,
    incomeRemaining: incomeTotal - incomeSpend,
    capitalRemainingPeriod: capitalAllTime - capitalSpend,
    capitalRemaining: capitalAllTime - capitalSpendAllTime,
    capitalAllTime,
    capitalSpendAllTime,
  };
}

function csvEscape(value) {
  const s = String(value ?? "");
  if (/[",\n]/.test(s)) return `"${s.replaceAll('"', '""')}"`;
  return s;
}

function exportFinanceCsv() {
  const data = getFilteredFinance();
  const rows = [
    ["Type", "Date", "Title", "Category / Source", "Amount", "Currency", "Notes"],
  ];

  data.income.forEach((r) => {
    rows.push([
      "Income",
      r.entry_date,
      r.title,
      r.source === "client_payment" ? "Client payment" : "Manual",
      Number(r.amount || 0).toFixed(2),
      r.currency || "USD",
      r.notes || "",
    ]);
  });
  data.capital.forEach((c) => {
    rows.push([
      "Capital",
      c.contribution_date,
      c.contributor_name,
      "Capital introduced",
      Number(c.amount || 0).toFixed(2),
      c.currency || "USD",
      c.notes || "",
    ]);
  });
  data.expenses.forEach((e) => {
    rows.push([
      "Expense",
      e.expense_date,
      e.title,
      `${e.category || "Uncategorised"} · ${fundedByLabel(e)}`,
      Number(e.amount || 0).toFixed(2),
      e.currency || "USD",
      e.notes || "",
    ]);
  });

  rows.push([]);
  rows.push(["Summary", "", "", "", "", "", ""]);
  rows.push(["Income total", "", "", "", data.incomeTotal.toFixed(2), "USD", ""]);
  rows.push([
    "Income after costs",
    "",
    "",
    "",
    data.incomeRemaining.toFixed(2),
    "USD",
    "",
  ]);
  rows.push(["Capital introduced", "", "", "", data.capitalTotal.toFixed(2), "USD", ""]);
  rows.push([
    "Spent from capital",
    "",
    "",
    "",
    data.capitalSpend.toFixed(2),
    "USD",
    "",
  ]);
  rows.push([
    "Capital remaining (all time)",
    "",
    "",
    "",
    data.capitalRemaining.toFixed(2),
    "USD",
    "",
  ]);
  rows.push(["Expense total", "", "", "", data.expenseTotal.toFixed(2), "USD", ""]);
  rows.push(["Period", data.range.label, data.range.start || "", data.range.end || "", "", "", ""]);

  const csv = rows.map((row) => row.map(csvEscape).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  const stamp = todayISO();
  const periodSlug = String(state.financePeriod || "period").replaceAll("_", "-");
  a.href = URL.createObjectURL(blob);
  a.download = `omniq-finance-${periodSlug}-${stamp}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(a.href);
  toast("Finance export downloaded.");
}

function renderFinance() {
  // Keep "This month" aligned to the calendar automatically each new month
  const calendarMonth = todayISO().slice(0, 7);
  const storedMonth = sessionStorage.getItem("omniq_finance_calendar_month");
  if (storedMonth && storedMonth !== calendarMonth) {
    state.financePeriod = "this_month";
    sessionStorage.setItem("omniq_finance_period", "this_month");
  }
  sessionStorage.setItem("omniq_finance_calendar_month", calendarMonth);

  const data = getFilteredFinance();
  const periodOptions = FINANCE_PERIODS.map(
    (p) =>
      `<option value="${p.id}" ${
        state.financePeriod === p.id ? "selected" : ""
      }>${escapeHtml(p.label)}</option>`
  ).join("");

  return `
    <div class="page-head">
      <div>
        <h1>Finance</h1>
        <p>${escapeHtml(data.range.label)}${
          data.range.start
            ? ` · ${fmtDate(data.range.start)} – ${fmtDate(data.range.end)}`
            : ""
        }</p>
      </div>
      <div class="row-actions page-head__actions">
        <button class="btn btn--ghost" type="button" data-action="expense-new">Add expense</button>
        <button class="btn btn--ghost" type="button" data-action="capital-new">Add capital</button>
        <button class="btn btn--primary" type="button" data-action="revenue-new">Add income</button>
      </div>
    </div>

    <div class="finance-toolbar card">
      <div class="field finance-toolbar__period">
        <label for="finance-period">Period</label>
        <select id="finance-period" name="finance_period">${periodOptions}</select>
      </div>
      <button class="btn btn--ghost" type="button" data-action="finance-export">Export CSV</button>
    </div>

    <div class="grid grid--stats" style="margin-bottom:1rem">
      <div class="card stat stat--ok">
        <div class="stat__label">Income</div>
        <div class="stat__value">${money(data.incomeTotal)}</div>
        <div class="stat__meta">After income costs ${money(data.incomeRemaining)}</div>
      </div>
      <div class="card stat stat--warn">
        <div class="stat__label">Total expenses</div>
        <div class="stat__value">${money(data.expenseTotal)}</div>
        <div class="stat__meta">From capital ${money(
          data.capitalSpend
        )} · from income ${money(data.incomeSpend)}</div>
      </div>
      <div class="card stat stat--accent">
        <div class="stat__label">Capital introduced</div>
        <div class="stat__value">${money(data.capitalAllTime)}</div>
        <div class="stat__meta">This period ${money(data.capitalPeriodTotal)}</div>
      </div>
      <div class="card stat">
        <div class="stat__label">Capital remaining</div>
        <div class="stat__value">${money(data.capitalRemaining)}</div>
        <div class="stat__meta">After capital expenses ${money(
          data.capitalSpendAllTime
        )}</div>
      </div>
    </div>

    <div class="grid grid--2">
      <section>
        <h3 class="section-label">Income</h3>
        ${
          data.income.length
            ? `<div class="stack-list">${data.income
                .map(
                  (r) => `<article class="stack-card">
                    <div class="stack-card__main">
                      <strong>${escapeHtml(r.title)}</strong>
                      <span>${fmtDate(r.entry_date)}${
                        r.source === "client_payment" ? " · Client payment" : ""
                      }</span>
                      <span class="stack-card__amount">${money(r.amount, r.currency)}</span>
                    </div>
                    <div class="row-actions">
                      <button class="btn btn--ghost btn--sm" type="button" data-action="revenue-edit" data-id="${r.id}">Edit</button>
                      <button class="btn btn--danger btn--sm" type="button" data-action="revenue-del" data-id="${r.id}">Delete</button>
                    </div>
                  </article>`
                )
                .join("")}</div>`
            : emptyCard("No income in this period.")
        }
      </section>
      <section>
        <h3 class="section-label">Capital introduced</h3>
        ${
          data.capital.length
            ? `<div class="stack-list">${data.capital
                .map(
                  (c) => `<article class="stack-card">
                    <div class="stack-card__main">
                      <strong>${escapeHtml(c.contributor_name)}</strong>
                      <span>${fmtDate(c.contribution_date)}${
                        c.notes ? ` · ${escapeHtml(c.notes)}` : ""
                      }</span>
                      <span class="stack-card__amount">${money(c.amount, c.currency)}</span>
                    </div>
                    <div class="row-actions">
                      <button class="btn btn--ghost btn--sm" type="button" data-action="capital-edit" data-id="${c.id}">Edit</button>
                      <button class="btn btn--danger btn--sm" type="button" data-action="capital-del" data-id="${c.id}">Delete</button>
                    </div>
                  </article>`
                )
                .join("")}</div>`
            : emptyCard("No capital contributions recorded.")
        }
      </section>
      <section class="finance-expenses">
        <h3 class="section-label">Expenses</h3>
        ${
          data.expenses.length
            ? `<div class="stack-list">${data.expenses
                .map(
                  (e) => `<article class="stack-card">
                    <div class="stack-card__main">
                      <strong>${escapeHtml(e.title)}</strong>
                      <span>${fmtDate(e.expense_date)} · ${escapeHtml(
                        e.category || "Uncategorised"
                      )}</span>
                      <div class="stack-card__meta"><span class="pill pill--${
                        expenseFundedBy(e) === "capital" ? "accent" : "ok"
                      }">${escapeHtml(fundedByLabel(e))}</span></div>
                      <span class="stack-card__amount">${money(e.amount, e.currency)}</span>
                    </div>
                    <div class="row-actions">
                      <button class="btn btn--ghost btn--sm" type="button" data-action="expense-edit" data-id="${e.id}">Edit</button>
                      <button class="btn btn--danger btn--sm" type="button" data-action="expense-del" data-id="${e.id}">Delete</button>
                    </div>
                  </article>`
                )
                .join("")}</div>`
            : emptyCard("No expenses in this period.")
        }
      </section>
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
        <p>Issued receipts for paid invoices.</p>
      </div>
    </div>
    ${
      rows.length
        ? `<div class="stack-list">${rows
            .map(
              (r) => `<article class="stack-card">
                <div class="stack-card__main">
                  <strong>${escapeHtml(r.receipt_number)}</strong>
                  <span>${escapeHtml(r.clients?.organisation || r.clients?.name || "—")}</span>
                  <span>Issued ${fmtDate(r.issued_at)}</span>
                  <span class="stack-card__amount">${money(r.amount, r.currency)}</span>
                </div>
                <div class="row-actions">
                  <button class="btn btn--ghost btn--sm" type="button" data-action="receipt-view" data-id="${r.id}">Open</button>
                  <button class="btn btn--ghost btn--sm" type="button" data-action="receipt-edit" data-id="${r.id}">Edit</button>
                  <button class="btn btn--danger btn--sm" type="button" data-action="receipt-del" data-id="${r.id}">Delete</button>
                </div>
              </article>`
            )
            .join("")}</div>`
        : emptyCard("No receipts yet. Mark a payment as paid to create one.")
    }
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
  refreshIcons();
}

async function refresh() {
  // If a load is already running, mark dirty so we reload again after it
  // finishes — otherwise a save can await a stale in-flight fetch.
  if (refreshInFlight) {
    refreshDirty = true;
    return refreshInFlight;
  }
  refreshInFlight = (async () => {
    do {
      refreshDirty = false;
      await loadAll();
      render();
    } while (refreshDirty);
  })();
  try {
    await refreshInFlight;
  } finally {
    refreshInFlight = null;
  }
}

function scheduleRefresh() {
  window.clearTimeout(refreshTimer);
  refreshTimer = window.setTimeout(() => {
    refresh().catch((err) => console.error(err));
  }, 80);
}

/** Patch local cache and re-render immediately, then sync from server. */
async function commitAndRefresh(mutator) {
  const result = await mutator();
  if (result?.error) throw result.error;
  const row = result?.data;
  const table = result?.table;
  const action = result?.action || "upsert";
  if (row && table && state.cache[table]) {
    const list = state.cache[table] || [];
    if (action === "delete") {
      state.cache[table] = list.filter((item) => item.id !== row.id);
    } else {
      const without = list.filter((item) => item.id !== row.id);
      state.cache[table] = [row, ...without];
    }
    render();
  }
  // Ensure any concurrent refresh re-runs with the new row
  refreshDirty = true;
  await refresh();
  return row;
}

function stopRealtime() {
  if (realtimeChannel) {
    sb.removeChannel(realtimeChannel);
    realtimeChannel = null;
  }
  if (livePollTimer) {
    window.clearInterval(livePollTimer);
    livePollTimer = null;
  }
  state.realtimeReady = false;
}

function startRealtime() {
  if (!state.session) return;
  if (realtimeChannel) {
    sb.removeChannel(realtimeChannel);
    realtimeChannel = null;
  }
  let channel = sb.channel(`omniq-admin-live-${state.session.user.id}`);
  REALTIME_TABLES.forEach((table) => {
    channel = channel.on(
      "postgres_changes",
      { event: "*", schema: "public", table },
      () => scheduleRefresh()
    );
  });
  realtimeChannel = channel.subscribe((status) => {
    state.realtimeReady = status === "SUBSCRIBED";
    if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
      window.setTimeout(() => {
        if (state.session) startRealtime();
      }, 1500);
    }
  });
  if (!livePollTimer) {
    livePollTimer = window.setInterval(() => {
      if (!state.session || document.hidden) return;
      scheduleRefresh();
    }, 8000);
  }
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

function paymentForm(existing = null) {
  if (!state.cache.clients.length) {
    toast("Add a client first.");
    return;
  }
  const status = existing?.status || "pending";
  openModal(
    existing ? "Edit payment" : "Add payment due",
    `
      <div class="field"><label>Client</label><select name="client_id" required>${clientOptions(
        existing?.client_id || ""
      )}</select></div>
      <div class="field"><label>Service</label><select name="service_id"><option value="">Custom / other</option>${serviceOptions(
        existing?.service_id || ""
      )}</select></div>
      <div class="field"><label>Description</label><input name="description" required placeholder="e.g. Website development deposit" value="${escapeHtml(
        existing?.description || ""
      )}" /></div>
      <div class="field"><label>Amount</label><input name="amount" type="number" step="0.01" required value="${
        existing?.amount ?? ""
      }" /></div>
      <div class="field"><label>Due date</label><input name="due_date" type="date" required value="${
        existing?.due_date || todayISO()
      }" /></div>
      <div class="field"><label>Status</label>
        <select name="status">
          <option value="pending" ${status === "pending" ? "selected" : ""}>Pending</option>
          <option value="paid" ${status === "paid" ? "selected" : ""}>Paid</option>
          <option value="cancelled" ${
            status === "cancelled" ? "selected" : ""
          }>Cancelled</option>
        </select>
      </div>
      <div class="field"><label>Notes</label><textarea name="notes">${escapeHtml(
        existing?.notes || ""
      )}</textarea></div>
    `,
    async (values) => {
      const service = state.cache.services.find((s) => s.id === values.service_id);
      const nextStatus = ["pending", "paid", "cancelled"].includes(values.status)
        ? values.status
        : "pending";
      const payload = {
        client_id: values.client_id,
        service_id: values.service_id || null,
        description:
          values.description || service?.name || "Service payment",
        amount: Number(values.amount),
        due_date: values.due_date,
        notes: values.notes || null,
        status: nextStatus,
        paid_at:
          nextStatus === "paid"
            ? existing?.paid_at || new Date().toISOString()
            : null,
        updated_at: new Date().toISOString(),
      };
      if (existing) {
        const { error } = await sb
          .from("payments")
          .update(payload)
          .eq("id", existing.id);
        if (error) throw error;
      } else {
        const { error } = await sb.from("payments").insert({
          ...payload,
          status: "pending",
          paid_at: null,
        });
        if (error) throw error;
      }
      await refresh();
      toast(existing ? "Payment updated." : "Payment due recorded.");
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

function engagementForm(existing = null) {
  if (!state.cache.clients.length) {
    toast("Add a client first.");
    return;
  }
  openModal(
    existing ? "Edit service engagement" : "New service engagement",
    `
      <div class="field"><label>Client</label><select name="client_id" required>${clientOptions(
        existing?.client_id || ""
      )}</select></div>
      <div class="field"><label>Service</label><select name="service_id" required>
        <option value="">Select service</option>
        ${nonDpoServiceOptions(existing?.service_id || "")}
      </select></div>
      <div class="field"><label>Display name (optional)</label><input name="service_name" value="${escapeHtml(
        existing?.service_name || ""
      )}" placeholder="Defaults to catalogue name" /></div>
      <div class="field"><label>Start date</label><input name="start_date" type="date" required value="${
        existing?.start_date || todayISO()
      }" /></div>
      <div class="field"><label>Fee</label><input name="fee" type="number" step="0.01" required value="${
        existing?.fee ?? ""
      }" /></div>
      <div class="field"><label>Billing cycle</label>
        <select name="billing_cycle">
          <option value="one_off" ${
            existing?.billing_cycle !== "monthly" ? "selected" : ""
          }>One-off</option>
          <option value="monthly" ${
            existing?.billing_cycle === "monthly" ? "selected" : ""
          }>Monthly</option>
        </select>
      </div>
      <div class="field"><label>Next due date</label><input name="next_due_date" type="date" required value="${
        existing?.next_due_date || todayISO()
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
      const service = state.cache.services.find((s) => s.id === values.service_id);
      const payload = {
        client_id: values.client_id,
        service_id: values.service_id || null,
        service_name:
          values.service_name?.trim() || service?.name || "Service",
        start_date: values.start_date,
        fee: Number(values.fee),
        billing_cycle: values.billing_cycle,
        next_due_date: values.next_due_date,
        status: values.status,
        notes: values.notes || null,
      };
      if (existing) {
        const { error } = await sb
          .from("service_engagements")
          .update(payload)
          .eq("id", existing.id);
        if (error) throw error;
      } else {
        const { error } = await sb.from("service_engagements").insert(payload);
        if (error) throw error;
      }
      await refresh();
      toast("Client service saved.");
    }
  );
}

async function createServiceDue(engagementId) {
  const eng = state.cache.engagements.find((d) => d.id === engagementId);
  if (!eng) return;
  const label =
    eng.billing_cycle === "monthly" ? "monthly fee" : "service fee";
  const { error } = await sb.from("payments").insert({
    client_id: eng.client_id,
    service_engagement_id: eng.id,
    service_id: eng.service_id || null,
    description: `${eng.service_name} ${label} — ${
      eng.clients?.organisation || eng.clients?.name || "client"
    }`,
    amount: eng.fee,
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
  toast("Payment due created.");
}

function capitalForm(existing = null) {
  openModal(
    existing ? "Edit capital contribution" : "Add capital contribution",
    `
      <div class="field"><label>Contributor</label><input name="contributor_name" required placeholder="Contributor name" value="${escapeHtml(
        existing?.contributor_name || "Directors"
      )}" /></div>
      <div class="field"><label>Amount</label><input name="amount" type="number" step="0.01" required value="${
        existing?.amount ?? ""
      }" /></div>
      <div class="field"><label>Date</label><input name="contribution_date" type="date" required value="${
        existing?.contribution_date || todayISO()
      }" /></div>
      <div class="field"><label>Notes</label><textarea name="notes" placeholder="Optional notes">${escapeHtml(
        existing?.notes || ""
      )}</textarea></div>
    `,
    async (values) => {
      const payload = {
        contributor_name: values.contributor_name,
        amount: Number(values.amount),
        contribution_date: values.contribution_date,
        notes: values.notes || null,
        updated_at: new Date().toISOString(),
      };
      await commitAndRefresh(async () => {
        if (existing) {
          const res = await sb
            .from("capital_contributions")
            .update(payload)
            .eq("id", existing.id)
            .select("*")
            .single();
          return { ...res, table: "capital", action: "upsert" };
        }
        const res = await sb
          .from("capital_contributions")
          .insert({
            ...payload,
            created_by: state.session.user.id,
          })
          .select("*")
          .single();
        return { ...res, table: "capital", action: "upsert" };
      });
      toast(existing ? "Capital contribution updated." : "Capital contribution recorded.");
    }
  );
}

function expenseForm(existing = null) {
  const funded = expenseFundedBy(existing || { funded_by: "capital" });
  openModal(
    existing ? "Edit expense" : "Add expense",
    `
      <div class="field"><label>Title</label><input name="title" required value="${escapeHtml(
        existing?.title || ""
      )}" /></div>
      <div class="field"><label>Category</label><input name="category" placeholder="e.g. Software, Travel" value="${escapeHtml(
        existing?.category || ""
      )}" /></div>
      <div class="field"><label>Amount</label><input name="amount" type="number" step="0.01" required value="${
        existing?.amount ?? ""
      }" /></div>
      <div class="field"><label>Paid from</label>
        <select name="funded_by">
          <option value="capital" ${funded === "capital" ? "selected" : ""}>Capital</option>
          <option value="income" ${funded === "income" ? "selected" : ""}>Income</option>
        </select>
      </div>
      <div class="field"><label>Date</label><input name="expense_date" type="date" required value="${
        existing?.expense_date || todayISO()
      }" /></div>
      <div class="field"><label>Notes</label><textarea name="notes">${escapeHtml(
        existing?.notes || ""
      )}</textarea></div>
    `,
    async (values) => {
      const fundedBy =
        values.funded_by === "income" ? "income" : "capital";
      const payload = {
        title: values.title,
        category: values.category || null,
        amount: Number(values.amount),
        expense_date: values.expense_date,
        funded_by: fundedBy,
        notes: values.notes || null,
        updated_at: new Date().toISOString(),
      };
      await commitAndRefresh(async () => {
        if (existing) {
          const res = await sb
            .from("expenses")
            .update(payload)
            .eq("id", existing.id)
            .select("*")
            .single();
          return { ...res, table: "expenses", action: "upsert" };
        }
        const res = await sb
          .from("expenses")
          .insert({
            ...payload,
            created_by: state.session.user.id,
          })
          .select("*")
          .single();
        return { ...res, table: "expenses", action: "upsert" };
      });
      toast(existing ? "Expense updated." : "Expense saved.");
    }
  );
}

function revenueForm(existing = null) {
  openModal(
    existing ? "Edit income" : "Add income",
    `
      <div class="field"><label>Title</label><input name="title" required placeholder="Income description" value="${escapeHtml(
        existing?.title || ""
      )}" /></div>
      <div class="field"><label>Amount</label><input name="amount" type="number" step="0.01" required value="${
        existing?.amount ?? ""
      }" /></div>
      <div class="field"><label>Date</label><input name="entry_date" type="date" required value="${
        existing?.entry_date || todayISO()
      }" /></div>
      <div class="field"><label>Client (optional)</label><select name="client_id"><option value="">—</option>${clientOptions(
        existing?.client_id || ""
      )}</select></div>
      <div class="field"><label>Notes</label><textarea name="notes">${escapeHtml(
        existing?.notes || ""
      )}</textarea></div>
    `,
    async (values) => {
      const payload = {
        title: values.title,
        amount: Number(values.amount),
        entry_date: values.entry_date,
        client_id: values.client_id || null,
        notes: values.notes || null,
        updated_at: new Date().toISOString(),
      };
      await commitAndRefresh(async () => {
        if (existing) {
          const res = await sb
            .from("revenue_entries")
            .update(payload)
            .eq("id", existing.id)
            .select("*")
            .single();
          return { ...res, table: "revenue", action: "upsert" };
        }
        const res = await sb
          .from("revenue_entries")
          .insert({
            ...payload,
            source: "manual",
            created_by: state.session.user.id,
          })
          .select("*")
          .single();
        return { ...res, table: "revenue", action: "upsert" };
      });
      toast(existing ? "Income updated." : "Income saved.");
    }
  );
}

function receiptForm(existing) {
  if (!existing) return;
  const issuedDate = String(existing.issued_at || todayISO()).slice(0, 10);
  openModal(
    "Edit receipt",
    `
      <div class="field"><label>Receipt number</label><input name="receipt_number" required value="${escapeHtml(
        existing.receipt_number || ""
      )}" /></div>
      <div class="field"><label>Amount</label><input name="amount" type="number" step="0.01" required value="${
        existing.amount ?? ""
      }" /></div>
      <div class="field"><label>Issued date</label><input name="issued_date" type="date" required value="${issuedDate}" /></div>
      <div class="field"><label>Notes</label><textarea name="notes">${escapeHtml(
        existing.notes || ""
      )}</textarea></div>
    `,
    async (values) => {
      const { error } = await sb
        .from("receipts")
        .update({
          receipt_number: values.receipt_number,
          amount: Number(values.amount),
          issued_at: `${values.issued_date}T12:00:00.000Z`,
          notes: values.notes || null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", existing.id);
      if (error) throw error;
      await refresh();
      toast("Receipt updated.");
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
    stopRealtime();
    await sb.auth.signOut();
    showLogin();
  });

  $("#menu-toggle").addEventListener("click", () => {
    setSidebarOpen(!$("#sidebar").classList.contains("is-open"));
  });

  $("#sidebar-backdrop")?.addEventListener("click", () => setSidebarOpen(false));

  $("#main-nav").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-route]");
    if (!btn) return;
    state.route = btn.dataset.route;
    setSidebarOpen(false);
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

  $("#page-root").addEventListener("change", (e) => {
    if (e.target?.id !== "finance-period") return;
    state.financePeriod = e.target.value || "this_month";
    sessionStorage.setItem("omniq_finance_period", state.financePeriod);
    render();
  });

  $("#page-root").addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    const { action, id } = btn.dataset;

    if (action === "client-new") return runAction(() => clientForm());
    if (action === "client-edit") {
      return runAction(() =>
        clientForm(state.cache.clients.find((c) => c.id === id))
      );
    }
    if (action === "client-del") {
      if (!confirm("Delete this client?")) return;
      const { error } = await sb.from("clients").delete().eq("id", id);
      if (error) return toast(error.message);
      await refresh();
      return toast("Client deleted.");
    }
    if (action === "service-new") return runAction(() => serviceForm());
    if (action === "service-edit") {
      return runAction(() =>
        serviceForm(state.cache.services.find((s) => s.id === id))
      );
    }
    if (action === "engagement-new") {
      if (!state.cache.clients.length) return toast("Add a client first.");
      return runAction(() => engagementForm());
    }
    if (action === "engagement-edit") {
      return runAction(() =>
        engagementForm(state.cache.engagements.find((d) => d.id === id))
      );
    }
    if (action === "engagement-bill") return createServiceDue(id);
    if (action === "engagement-del") {
      if (!confirm("Delete this service engagement?")) return;
      const { error } = await sb
        .from("service_engagements")
        .delete()
        .eq("id", id);
      if (error) return toast(error.message);
      await refresh();
      return toast("Engagement deleted.");
    }
    if (action === "dpo-new") {
      if (!state.cache.clients.length) return toast("Add a client first.");
      return runAction(() => dpoForm());
    }
    if (action === "dpo-edit") {
      return runAction(() => dpoForm(state.cache.dpo.find((d) => d.id === id)));
    }
    if (action === "dpo-bill") return createDpoDue(id);
    if (action === "dpo-del") {
      if (!confirm("Delete this DPO engagement?")) return;
      const { error } = await sb.from("dpo_engagements").delete().eq("id", id);
      if (error) return toast(error.message);
      await refresh();
      return toast("DPO engagement deleted.");
    }
    if (action === "quick-payment") return runAction(() => paymentForm());
    if (action === "payment-edit") {
      return runAction(() =>
        paymentForm(state.cache.payments.find((p) => p.id === id))
      );
    }
    if (action === "payment-del") {
      if (!confirm("Delete this payment record?")) return;
      const payment = state.cache.payments.find((p) => p.id === id);
      if (payment?.receipt_id) {
        const unlink = await sb
          .from("payments")
          .update({ receipt_id: null, updated_at: new Date().toISOString() })
          .eq("id", id);
        if (unlink.error) return toast(unlink.error.message);
        const delReceipt = await sb
          .from("receipts")
          .delete()
          .eq("id", payment.receipt_id);
        if (delReceipt.error) return toast(delReceipt.error.message);
      }
      const { error } = await sb.from("payments").delete().eq("id", id);
      if (error) return toast(error.message);
      await refresh();
      return toast("Payment deleted.");
    }
    if (action === "pay-receipt") {
      try {
        await createReceiptForPayment(id);
      } catch (err) {
        toast(err.message || "Could not create receipt.");
      }
      return;
    }
    if (action === "receipt-view") return runAction(() => renderReceipt(id));
    if (action === "receipt-edit") {
      return runAction(() =>
        receiptForm(state.cache.receipts.find((r) => r.id === id))
      );
    }
    if (action === "receipt-del") {
      if (!confirm("Delete this receipt?")) return;
      const receipt = state.cache.receipts.find((r) => r.id === id);
      if (receipt?.payment_id) {
        const unlink = await sb
          .from("payments")
          .update({
            receipt_id: null,
            updated_at: new Date().toISOString(),
          })
          .eq("id", receipt.payment_id);
        if (unlink.error) return toast(unlink.error.message);
      }
      const { error } = await sb.from("receipts").delete().eq("id", id);
      if (error) return toast(error.message);
      await refresh();
      return toast("Receipt deleted.");
    }
    if (action === "expense-new") return runAction(() => expenseForm());
    if (action === "expense-edit") {
      return runAction(() =>
        expenseForm(state.cache.expenses.find((e) => e.id === id))
      );
    }
    if (action === "expense-del") {
      if (!confirm("Delete this expense?")) return;
      const { error } = await sb.from("expenses").delete().eq("id", id);
      if (error) return toast(error.message);
      await refresh();
      return toast("Expense deleted.");
    }
    if (action === "revenue-new") return runAction(() => revenueForm());
    if (action === "revenue-edit") {
      return runAction(() =>
        revenueForm(state.cache.revenue.find((r) => r.id === id))
      );
    }
    if (action === "revenue-del") {
      if (!confirm("Delete this income entry?")) return;
      const { error } = await sb.from("revenue_entries").delete().eq("id", id);
      if (error) return toast(error.message);
      await refresh();
      return toast("Income deleted.");
    }
    if (action === "capital-new") return runAction(() => capitalForm());
    if (action === "capital-edit") {
      return runAction(() =>
        capitalForm(state.cache.capital.find((c) => c.id === id))
      );
    }
    if (action === "capital-del") {
      if (!confirm("Delete this capital contribution?")) return;
      const { error } = await sb
        .from("capital_contributions")
        .delete()
        .eq("id", id);
      if (error) return toast(error.message);
      await refresh();
      return toast("Capital contribution deleted.");
    }
    if (action === "finance-export") {
      exportFinanceCsv();
      return;
    }
  });
}

async function boot() {
  const ok = await requireSession();
  if (!ok) {
    stopRealtime();
    return;
  }
  try {
    await refresh();
    startRealtime();
  } catch (err) {
    console.error(err);
    toast(err.message || "Failed to load admin data. Check Supabase auth/RLS.");
    $("#page-root").innerHTML = `<div class="card empty">${escapeHtml(
      err.message || "Load failed"
    )}</div>`;
  }
}

bindUi();
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && state.session) {
    scheduleRefresh();
  }
});
sb.auth.onAuthStateChange((_event, session) => {
  state.session = session;
  if (!session) {
    stopRealtime();
    showLogin();
    return;
  }
  startRealtime();
});
boot();
