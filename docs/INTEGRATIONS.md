# İnteqrasiyalar (webhook, Google Sheets, CRM)

Panel → **İnteqrasiyalar** → yeni webhook. Yalnız açıq internetdəki `https://` ünvanları qəbul olunur: daxili, lokal və cloud-metadata IP-ləri həm yadda saxlayanda, həm də qoşulma anında (DNS rebinding-ə qarşı) bloklanır. Yönləndirmələrə (redirect) əməl olunmur.

## Hadisələr

| `event` | Nə vaxt | `data` |
|---|---|---|
| `message.received` | Müştəri mesajı gəldi | `message_id, conversation_id, contact_id, channel, kind, text, contact{username,name}` |
| `conversation.handoff` | Söhbət operatora keçdi | `conversation_id, contact_id, channel, reason` |
| `contact.tag_added` | Kontakta yeni tag | `contact_id, tag` |
| `automation.run_finished` | Flow icrası bitdi | `run_id, automation_id, contact_id, conversation_id, status, reason` |
| `ping` | "Test" düyməsi | `message` |

Sorğu gövdəsi: `{"id": "<delivery id>", "event": "...", "created_at": "ISO", "data": {...}}`.
`message.received` müştərinin mesaj mətnini göndərir. Bunu yalnız etibar etdiyiniz və məlumatı qoruyan sistemə qoşun.

## İmzanın yoxlanması

Başlıqlar:
- `X-AIReply-Event`, `X-AIReply-Delivery`, `X-AIReply-Timestamp` (unix saniyə);
- `X-AIReply-Signature: sha256=<hex>`, burada `hex = HMAC_SHA256(secret, timestamp + "." + raw_body)`.

Secret (`whsec_...`) yalnız bir dəfə göstərilir, serverdə şifrəli saxlanılır. "Yeni secret" köhnəsini dərhal etibarsız edir.

```js
// Node.js (Express): raw body lazımdır
import crypto from 'node:crypto';
app.post('/aireply', express.raw({ type: 'application/json' }), (req, res) => {
  const ts = req.get('x-aireply-timestamp');
  const expected = 'sha256=' + crypto.createHmac('sha256', process.env.AIREPLY_SECRET).update(`${ts}.${req.body}`).digest('hex');
  const got = req.get('x-aireply-signature') ?? '';
  const fresh = Math.abs(Date.now() / 1000 - Number(ts)) < 300; // replay qoruması
  if (!fresh || got.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected))) return res.sendStatus(401);
  const evt = JSON.parse(req.body);
  // evt.id ilə dedupe edin: eyni çatdırılma təkrar gələ bilər (at-least-once)
  res.sendStatus(200);
});
```

Təkrar cəhdlər: 2xx olmayan cavab, timeout (10 san.) və 408/429/5xx 6 dəfəyə qədər təkrarlanır (eksponensial, 30 san.-dən başlayaraq). Digər 4xx cavablar təkrarlanmır. 50 ardıcıl uğursuz çatdırılmadan sonra webhook avtomatik söndürülür və audit jurnalına yazılır. Çatdırılma tarixçəsi 14 gün saxlanılır.

## Google Sheets

**Variant A (tövsiyə olunur): Make, Zapier və ya n8n.** "Custom webhook" trigger yaradın, URL-ni panelə yazın, sonra "Google Sheets → Add row" addımını əlavə edin. Bu servislər HMAC-ı yoxlaya bilir (n8n Crypto node, Make "Webhook response" + HMAC funksiyası).

**Variant B: Google Apps Script.** Apps Script `doPost(e)` sorğu başlıqlarını oxuya bilmir, ona görə imzanı yoxlamaq olmur. Bunun əvəzinə URL-ə uzun, təsadüfi bir açar əlavə edin və onu yoxlayın:

```js
// Extensions → Apps Script; Deploy → Web app (Execute as: Me, Access: Anyone)
const KEY = 'uzun-təsadüfi-açar';            // URL: https://script.google.com/macros/s/XXX/exec?key=uzun-təsadüfi-açar
function doPost(e) {
  if (e.parameter.key !== KEY) return ContentService.createTextOutput('forbidden');
  const evt = JSON.parse(e.postData.contents);
  if (evt.event !== 'message.received') return ContentService.createTextOutput('ok');
  SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Mesajlar')
    .appendRow([evt.created_at, evt.data.channel, evt.data.contact.username || evt.data.contact.name, evt.data.text, evt.id]);
  return ContentService.createTextOutput('ok');
}
```

Qeyd: Apps Script `/exec` ünvanı cavabı yönləndirmə (302) ilə qaytarır. Biz yönləndirməyə əməl etmirik, ona görə çatdırılma `HTTP 302` kimi görünə bilər, amma sətir yazılmış olur. Etibarlı nəticə üçün Variant A-nı seçin.

## CRM (amoCRM, Bitrix24, HubSpot və s.)

Birbaşa CRM adapteri yoxdur. Webhook → Make/Zapier/n8n → CRM-in "lead/contact yarat" addımını istifadə edin. Məsələn, `conversation.handoff` hadisəsi ilə operator tələb edən söhbət üçün CRM-də lead açın, `contact.tag_added` (`tag = "sifariş"`) ilə isə deal yaradın.

## Kontakt importu və eksportu

"Kontaktlar" → CSV. Eksport sütunları: `id, channel, username, display_name, tags, opted_out, blocked, first_seen_at, last_seen_at, <sahələr>`.

İmport mövcud kontaktları `id` və ya `username` sütunu ilə tapır:
- `tags` sütunu `;` ilə ayrılmış tag-lər əlavə edir;
- `opted_out` sütunu `1` və ya `0` qəbul edir;
- digər sütunlar sahə kimi yazılır (adı kiçik hərf, rəqəm və `_` olmalıdır).

Yeni kontakt yaradılmır: Instagram və WhatsApp siyasəti insana ilk sizin yazmağınıza icazə vermir. Eksport faylı Excel formula inyeksiyasına qarşı qorunur.
