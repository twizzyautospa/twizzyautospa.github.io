import { cleanWebhookUrl } from "./pricing.mts";
import { env } from "./util.mts";

export type EventName = "lead.created" | "quote.sent" | "quote.accepted" | "quote.declined";

/**
 * POST an event to the installer's webhook (Zapier, Make, GoHighLevel, a CRM).
 * Failures are logged and swallowed so a slow or broken receiver never breaks the customer flow.
 */
export async function sendWebhook(webhookUrl: string, event: EventName, data: unknown): Promise<void> {
  const url = cleanWebhookUrl(webhookUrl);
  if (!url) return;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "light-quote-webhook/1" },
      body: JSON.stringify({ event, sentAt: new Date().toISOString(), data }),
      redirect: "manual",
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) console.warn(`Webhook ${event} answered ${res.status}`);
  } catch (err) {
    console.warn(`Webhook ${event} failed:`, (err as Error).message);
  }
}

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/**
 * Optional email alerts through Resend. Active only when RESEND_API_KEY and EMAIL_FROM are set.
 */
export async function sendEmail(to: string, subject: string, lines: string[], link?: { label: string; url: string }): Promise<void> {
  const key = env("RESEND_API_KEY");
  const from = env("EMAIL_FROM");
  if (!key || !from || !to) return;
  const body =
    lines.map((line) => `<p style="margin:0 0 10px">${escapeHtml(line)}</p>`).join("") +
    (link ? `<p style="margin:18px 0 0"><a href="${escapeHtml(link.url)}">${escapeHtml(link.label)}</a></p>` : "");
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ from, to: [to], subject, html: `<div style="font-family:system-ui,sans-serif;font-size:15px">${body}</div>` }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) console.warn(`Email send answered ${res.status}`);
  } catch (err) {
    console.warn("Email send failed:", (err as Error).message);
  }
}
