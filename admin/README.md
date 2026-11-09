# OMNIQ Admin

Private directors console for clients, DPO (SI 155), billing, finance, and receipts.

## URLs

| Environment | URL |
|-------------|-----|
| Production | `https://admin.omniq.co.zw` |

`https://omniq.co.zw/admin` redirects to the admin subdomain. No login link on the public site.

## Cloudflare subdomain

1. Workers & Pages → omniq project → **Custom domains** → add `admin.omniq.co.zw`
2. Wait until SSL is Active
3. Deploy this repo (Worker routes admin host → `/admin/index.html`)

Later you can move `/admin` into its own Pages project and point only the `admin` hostname at that project.

## Supabase setup (required once)

Project: **OMNIQ Admin** (`ptsmyssrtyfzdjnhkzzm`)

1. Staff users are seeded for `hamadzashe@omniq.co.zw` and `directors@omniq.co.zw` (change passwords after first login).  
2. **Authentication → URL configuration**  
   - Site URL: `https://admin.omniq.co.zw`  
   - Redirect URLs: `https://admin.omniq.co.zw/**`  
3. Disable public sign-ups; only invite `@omniq.co.zw` users  
4. RLS allows only authenticated users whose JWT email ends with `@omniq.co.zw`

## Modules

- **Dashboard** — revenue/expenses, overdue alerts, DPO count  
- **Clients** — CRM contacts  
- **Services** — seeded from the public catalogue + custom services  
- **DPO** — start date, monthly fee, SI 155 tier (1–4), controller registration, POTRAZ DPO notification, next due  
- **Billing** — dues by service; mark paid → branded receipt  
- **Finance** — expenses + revenue  
- **Receipts** — print / save PDF with OMNIQ logo  

## Split later

When ready to isolate admin:

1. Copy `admin/` into a new Pages project  
2. Point `admin.omniq.co.zw` at that project only  
3. Remove admin rewrite from this Worker (keep public site as-is)
