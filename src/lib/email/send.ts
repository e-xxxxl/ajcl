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
  const recipients = Array.isArray(input.to) ? input.to : [input.to];
  const to = recipients.filter((r) => r && r.includes("@"));
  if (to.length === 0) return false;

  if (!isEmailConfigured) {
    console.info(`[email] (not configured) would send "${input.subject}" to ${to.join(", ")}`);
    return false;
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
      return false;
    }
    console.info(`[email] sent "${input.subject}" to ${to.join(", ")}`);
    return true;
  } catch (err) {
    console.error(`[email] send failed for "${input.subject}":`, err instanceof Error ? err.message : err);
    return false;
  }
}
