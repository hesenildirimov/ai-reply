import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { html } from './html.js';
import { view } from './public.js';

// Reviewed by Meta during App Review. Have a lawyer check them before launch.
export function legalRoutes(app: FastifyInstance) {
  const c = config.LEGAL_COMPANY_NAME;
  const mail = config.SUPPORT_EMAIL;

  app.get('/privacy', (req, reply) =>
    view(
      req,
      reply,
      'Privacy Policy',
      html`<article class="card legal"><h1>Privacy Policy</h1>
<p>${c}, ${config.LEGAL_ADDRESS} ("we") operates AI Reply, a service that lets businesses answer their Instagram and WhatsApp messages with an AI assistant. Contact: <a href="mailto:${mail}">${mail}</a>.</p>
<h2>Data we process</h2>
<ul><li><b>Business account data:</b> email, hashed password, business name and the business information you enter.</li>
<li><b>Connected accounts:</b> Instagram professional account ID and username, WhatsApp Business Account ID and phone number ID, and access tokens issued by Meta (stored encrypted with AES-256-GCM).</li>
<li><b>Messages:</b> the text of messages your customers send to your connected accounts, their platform-scoped ID and public name/username, and the replies sent.</li></ul>
<h2>How we use it</h2>
<p>Only to provide the service: receive messages, generate a reply with an AI model, send it on your behalf, show conversations in your inbox and notify you when a human is needed. We do not sell data, use it for advertising, or use it to train AI models.</p>
<h2>Processors</h2>
<p>Message text and your business information are sent to Anthropic (Claude API) to generate replies. Photos and frames of videos customers send are sent to Anthropic to be described${config.STT_API_URL ? `; voice messages and the sound of videos are sent to the speech-to-text provider (${new URL(config.STT_API_URL).hostname}) to be transcribed` : ''}. The description or transcript is stored encrypted with the message. To match your writing style, the service reads the messages your business sent in recent Instagram conversations and your staff replies, and stores only a short style summary (no customer data). If you connect Telegram alerts, the name of a waiting customer and the first characters of their message are sent to your Telegram chat. Anthropic does not train on API data. Hosting, database and email providers process data on our behalf under confidentiality obligations. Meta Platforms delivers and sends messages.</p>
<h2>Retention</h2>
<p>Messages are deleted automatically after ${config.RETENTION_DAYS} days. Disconnecting a channel deletes its tokens and conversations immediately. Deleting your account deletes all your data immediately.</p>
<h2>Your rights and deletion</h2>
<p>You can access, export or delete your data from the dashboard or by emailing us. See <a href="/data-deletion">Data deletion</a>. Customers of a business can ask that business, or us, to delete their conversation.</p>
<h2>Security</h2>
<p>TLS in transit, encrypted tokens at rest, verified webhook signatures, hashed passwords (Argon2id), least-privilege permissions.</p>
<h2>Changes</h2><p>We will notify account owners by email of material changes.</p></article>`,
    ),
  );

  app.get('/terms', (req, reply) =>
    view(
      req,
      reply,
      'Terms of Service',
      html`<article class="card legal"><h1>Terms of Service</h1>
<p>These terms govern use of AI Reply provided by ${c}.</p>
<ol><li>You must own or be authorized to manage the Instagram and WhatsApp accounts you connect, and comply with Meta's Platform Terms, WhatsApp Business Policy and Instagram Community Guidelines.</li>
<li>The AI assistant only answers questions about your business using the information you provide. You are responsible for that information being accurate. You must not use the service for spam, unsolicited marketing, or prohibited content.</li>
<li>AI replies can be wrong. Sensitive matters are handed to your staff; you remain responsible for communication with your customers.</li>
<li>We may suspend accounts that violate these terms or platform policies.</li>
<li>The service is provided "as is" to the extent permitted by the laws of the Republic of Azerbaijan.</li>
<li>Contact: <a href="mailto:${mail}">${mail}</a>.</li></ol></article>`,
    ),
  );

  app.get('/data-deletion', (req, reply) =>
    view(
      req,
      reply,
      'Data deletion',
      html`<article class="card legal"><h1>Data deletion instructions</h1>
<ul><li><b>Disconnect a channel:</b> Dashboard → Channels → Disconnect. Its tokens and all conversations are deleted immediately.</li>
<li><b>Delete your account:</b> Dashboard → Settings → Delete account. All data is deleted immediately.</li>
<li><b>Remove the app in Meta:</b> removing AI Reply from your Instagram/Facebook business integrations triggers automatic deletion of the related data.</li>
<li><b>By email:</b> write to <a href="mailto:${mail}">${mail}</a>; we delete within 30 days and confirm.</li></ul>
<p>Məlumatların silinməsi: Panel → Kanallar → Ayır, və ya Ayarlar → Hesabı sil. Sualınız varsa: ${mail}</p></article>`,
    ),
  );
}
