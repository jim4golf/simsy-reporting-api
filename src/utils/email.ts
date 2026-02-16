/**
 * Email sending via Brevo (formerly Sendinblue) transactional API.
 *
 * Sends branded OTP emails for login verification and password resets.
 */

const BREVO_API_URL = 'https://api.brevo.com/v3/smtp/email';

interface SendOTPOptions {
  to: string;
  name: string;
  code: string;
  purpose: 'login' | 'password_reset';
  apiKey: string;
  fromEmail: string;
}

/**
 * Send an OTP email via Brevo.
 * Throws on failure so the caller can decide how to handle it.
 */
export async function sendOTPEmail(opts: SendOTPOptions): Promise<void> {
  const { to, name, code, purpose, apiKey, fromEmail } = opts;

  const subject =
    purpose === 'login'
      ? `${code} is your S-IMSY verification code`
      : `${code} is your S-IMSY password reset code`;

  const purposeText =
    purpose === 'login' ? 'login verification' : 'password reset';

  const html = buildEmailHTML(name, code, purposeText);
  const text = `Hi ${name},\n\nYour ${purposeText} code is: ${code}\n\nThis code expires in 5 minutes. If you didn't request this, you can safely ignore this email.\n\n— S-IMSY Reporting Portal`;

  const response = await fetch(BREVO_API_URL, {
    method: 'POST',
    headers: {
      'api-key': apiKey,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify({
      sender: {
        name: 'S-IMSY Reporting',
        email: fromEmail,
      },
      to: [
        {
          email: to,
          name: name,
        },
      ],
      subject,
      htmlContent: html,
      textContent: text,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => 'unknown error');
    console.error(`[EMAIL] Brevo API error (${response.status}): ${body}`);
    throw new Error(`Failed to send OTP email: ${response.status}`);
  }
}

function buildEmailHTML(name: string, code: string, purposeText: string): string {
  // Split code into individual digits for styled display
  const digits = code.split('').map(
    (d) =>
      `<td style="padding:0 4px;"><div style="width:40px;height:48px;background:#0a0e1a;border:1px solid #334155;border-radius:8px;text-align:center;line-height:48px;font-size:24px;font-weight:bold;color:#0ea5e9;font-family:'Courier New',monospace;">${d}</div></td>`,
  ).join('');

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#0a0e1a;font-family:Arial,'Helvetica Neue',sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0a0e1a;">
    <tr><td align="center" style="padding:40px 20px;">
      <table role="presentation" width="420" cellpadding="0" cellspacing="0" style="background:#1e293b;border-radius:16px;border:1px solid #334155;">
        <tr><td style="padding:32px;">
          <!-- Header -->
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td style="padding-bottom:24px;">
                <div style="display:inline-block;width:36px;height:36px;background:linear-gradient(135deg,#0ea5e9,#22d3ee);border-radius:10px;text-align:center;line-height:36px;font-size:18px;color:white;font-weight:bold;">S</div>
                <span style="font-size:16px;font-weight:700;color:#f8fafc;vertical-align:middle;margin-left:8px;">S-IMSY Reporting</span>
              </td>
            </tr>
          </table>

          <!-- Body -->
          <p style="color:#94a3b8;font-size:14px;line-height:1.6;margin:0 0 8px;">Hi ${name},</p>
          <p style="color:#94a3b8;font-size:14px;line-height:1.6;margin:0 0 24px;">
            Here is your ${purposeText} code:
          </p>

          <!-- OTP Code -->
          <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto 24px;">
            <tr>${digits}</tr>
          </table>

          <!-- Expiry note -->
          <p style="color:#64748b;font-size:12px;line-height:1.5;margin:0 0 16px;text-align:center;">
            This code expires in <strong style="color:#94a3b8;">5 minutes</strong>.
          </p>

          <!-- Divider -->
          <hr style="border:none;border-top:1px solid #334155;margin:24px 0;">

          <!-- Footer -->
          <p style="color:#475569;font-size:11px;line-height:1.5;margin:0;">
            If you didn't request this code, you can safely ignore this email.
            This is an automated message from the S-IMSY Reporting Portal.
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}
