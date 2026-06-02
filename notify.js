// Email (nodemailer) + web push (web-push) helpers.
// Both degrade gracefully: if not configured, they log instead of throwing,
// so the app still runs out of the box for testing.
const nodemailer = require('nodemailer');
const webpush = require('web-push');

let transporter = null;
if (process.env.SMTP_HOST && process.env.SMTP_USER) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}

let pushReady = false;
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:admin@sailone.ai',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
  pushReady = true;
}

async function sendEmail(to, subject, body) {
  if (!transporter) {
    console.log(`[email:not-configured] would send to ${to}: ${subject}`);
    return { simulated: true };
  }
  return transporter.sendMail({
    from: process.env.MAIL_FROM || process.env.SMTP_USER,
    to,
    subject,
    text: body,
    html: `<div style="font-family:sans-serif;line-height:1.5">${body.replace(/\n/g, '<br>')}</div>`,
  });
}

async function sendPush(subscriptionJson, payload) {
  if (!pushReady) {
    console.log(`[push:not-configured] would notify: ${payload.title}`);
    return { simulated: true };
  }
  return webpush.sendNotification(JSON.parse(subscriptionJson), JSON.stringify(payload));
}

module.exports = { sendEmail, sendPush, pushReady };
