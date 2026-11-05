import { env, isEmailConfigured } from "../env";

const RESEND_URL = "https://api.resend.com/emails";

/** An inline image referenced from the HTML as `<img src="cid:{contentId}">`. */
export type InlineImage = {
  filename: string;
  /** Base64 file content. */
  content: string;
  contentId: string;
  contentType?: string;
};

export type SendEmailInput = {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
  inlineImages?: InlineImage[];
};

/**
 * Send a transactional email via Resend. Never throws — a failed send is logged
 * and swallowed so it can't break a booking / payment flow. No-ops (with a log)
 * when RESEND_API_KEY is not configured.
 */
export async function sendEmail(input: SendEmailInput): Promise<boolean> {
  return (await sendEmailChecked(input)).ok;
}

/** Same as sendEmail, but says why it failed (for the Super Admin's "send a test email" check). */
export async function sendEmailChecked(input: SendEmailInput): Promise<{ ok: boolean; reason?: string }> {
  const recipients = Array.isArray(input.to) ? input.to : [input.to];
  const to = recipients.filter((r) => r && r.includes("@"));
  if (to.length === 0) return { ok: false, reason: "There is no recipient address." };

  if (!isEmailConfigured) {
    console.info(`[email] (not configured) would send "${input.subject}" to ${to.join(", ")}`);
    return { ok: false, reason: "Email is not set up: RESEND_API_KEY is missing on the server." };
  }

  try {
    const res = await fetch(RESEND_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.resendApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: env.emailFrom,
        to,
        subject: input.subject,
        html: input.html,
        text: input.text,
        reply_to: input.replyTo ?? env.supportEmail,
        ...(input.inlineImages?.length
          ? {
              attachments: input.inlineImages.map((img) => ({
                filename: img.filename,
                content: img.content,
                content_id: img.contentId,
                content_type: img.contentType ?? "image/png",
              })),
            }
          : {}),
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`[email] Resend rejected "${input.subject}" (${res.status}): ${body.slice(0, 300)}`);
      let message = body.slice(0, 300);
      try {
        message = (JSON.parse(body) as { message?: string }).message ?? message;
      } catch {
        /* keep the raw text */
      }
      return { ok: false, reason: `Resend refused it (${res.status}): ${message}` };
    }
    console.info(`[email] sent "${input.subject}" to ${to.join(", ")}`);
    return { ok: true };
  } catch (err) {
    console.error(`[email] send failed for "${input.subject}":`, err instanceof Error ? err.message : err);
    return { ok: false, reason: `Could not reach Resend: ${err instanceof Error ? err.message : "network error"}` };
  }
}
