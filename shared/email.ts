/**
 * Generic notification-email sender. Dispatches to Postmark or Resend based
 * on which env vars are set. No-op (logs only) if neither is configured.
 */

// Runtime globals (Workers provide these; shared/tsconfig.json targets only ES2022 lib)
declare const fetch: (input: string, init?: {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
declare const console: { log(...args: unknown[]): void; error(...args: unknown[]): void };

export interface EmailEnv {
  POSTMARK_API_TOKEN?: string;
  POSTMARK_MESSAGE_STREAM?: string;
  RESEND_API_KEY?: string;
  NOTIFICATION_TO: string;
  NOTIFICATION_FROM: string;
}

export async function sendEmail(
  env: EmailEnv,
  subject: string,
  html: string,
): Promise<void> {
  if (env.POSTMARK_API_TOKEN) {
    const resp = await fetch("https://api.postmarkapp.com/email", {
      method: "POST",
      headers: {
        "X-Postmark-Server-Token": env.POSTMARK_API_TOKEN,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        From: env.NOTIFICATION_FROM,
        To: env.NOTIFICATION_TO,
        Subject: subject,
        HtmlBody: html,
        MessageStream: env.POSTMARK_MESSAGE_STREAM || "outbound",
      }),
    });
    if (!resp.ok) {
      throw new Error(`Postmark returned ${resp.status}: ${await resp.text()}`);
    }
    return;
  }

  if (env.RESEND_API_KEY) {
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: env.NOTIFICATION_FROM,
        to: env.NOTIFICATION_TO,
        subject,
        html,
      }),
    });
    if (!resp.ok) {
      throw new Error(`Resend returned ${resp.status}: ${await resp.text()}`);
    }
    return;
  }

  console.log("No email API token configured — skipping notification email");
}
