# AI Reply: Instagram və WhatsApp üçün AI avtomatik cavab sistemi (MVP)

Bizneslər qeydiyyatdan keçir, biznes məlumatlarını yazır, Instagram və WhatsApp hesablarını bağlayır. Gələn DM-lərə Claude AI cavab verir. Lazım olduqda söhbət əməkdaşa ötürülür.

## Arxitektura

```
Meta webhook → /webhooks/* (imza yoxlanır) → Postgres (dedupe) → Redis növbəsi (4 san. debounce)
   → worker: limit və 24 saat pəncərəsi yoxlanır → Claude → Graph API ilə cavab → Postgres
```

| Qovluq | Məzmun |
|---|---|
| `src/server.ts` | Fastify veb server (panel + webhooks) |
| `src/worker.ts` | AI cavab növbəsi, token yeniləmə, köhnə məlumatların silinməsi |
| `src/pipeline.ts` | Mesaj qəbulu, AI cavabı, operatora ötürmə, əl ilə cavab |
| `src/ai.ts` | Claude inteqrasiyası (prompt caching, `request_human` aləti, fallback) |
| `src/channels/` | WhatsApp Cloud API, Instagram API (Instagram Login) |
| `src/web/` | Giriş sistemi, CSRF, panel səhifələri, hüquqi səhifələr, Meta callback-ləri |

## Lokal işə salma

```bash
cp .env.example .env              # ENCRYPTION_KEY: openssl rand -base64 32
docker compose up -d db redis     # və ya lokal Postgres 16 + Redis 7
npm install
npm run migrate
npm run dev                       # http://localhost:3000
npm run dev:worker                # ayrı terminalda
npm test
```

SMTP təyin olunmayıbsa, development rejimində təsdiq linkləri konsola yazılır.

Meta webhook-larını lokalda yoxlamaq üçün HTTPS tunel lazımdır (məsələn `cloudflared tunnel --url http://localhost:3000`). `APP_URL` tunel ünvanı olmalıdır.

## Meta qurulumu (addım-addım)

1. **Meta Business portfolio** yaradın: business.facebook.com.
2. **Business Verification**: VÖEN, şirkət sənədləri, sayt və domen e-poçtu lazımdır. Advanced Access üçün mütləqdir.
3. **developers.facebook.com → Create App → Business** tipli tətbiq yaradın.
4. **App settings → Basic**:
   - Privacy Policy URL: `https://DOMAIN/privacy`
   - Terms of Service URL: `https://DOMAIN/terms`
   - User data deletion → Data deletion callback URL: `https://DOMAIN/meta/data-deletion`
   - App icon (1024×1024), Category, Contact email
5. **App settings → Advanced**: *Require App Secret* → **ON** (kod `appsecret_proof` göndərir).
6. **WhatsApp məhsulu** əlavə edin:
   - Webhook: `https://DOMAIN/webhooks/whatsapp`, verify token = `META_WEBHOOK_VERIFY_TOKEN`. Abunə: `messages`, `account_update`.
   - **Tech Provider** olun (WhatsApp → Overview → Become a Tech Provider).
7. **Facebook Login for Business → Configurations → Create**: "WhatsApp Embedded Signup" şablonunu seçin. Alınan `config_id`-ni `WA_EMBEDDED_SIGNUP_CONFIG_ID`-ə yazın. Allowed domains siyahısına domeninizi əlavə edin.
8. **Instagram məhsulu → API setup with Instagram login**:
   - Instagram App ID və Secret-i `IG_APP_ID` və `IG_APP_SECRET`-ə yazın.
   - Webhook: `https://DOMAIN/webhooks/instagram`, abunə: `messages`.
   - Business login settings → Redirect URL: `https://DOMAIN/oauth/instagram/callback`. Deauthorize: `https://DOMAIN/meta/deauthorize`. Data deletion: `https://DOMAIN/meta/data-deletion`.
9. Test üçün öz Instagram və WhatsApp hesablarınızı **App Roles → Testers** bölməsinə əlavə edin. Development rejimində yalnız onlar işləyir.

## App Review: tələb olunan icazələr

| İcazə | Nə üçün (Review formasına yazılacaq izah) |
|---|---|
| `instagram_business_basic` | Bağlanan peşəkar hesabın ID və istifadəçi adını göstərmək üçün |
| `instagram_business_manage_messages` | Müştəri DM-lərini qəbul edib biznes adından cavab göndərmək üçün |
| `whatsapp_business_management` | Embedded Signup ilə WABA və nömrəni bağlamaq, webhook-a abunə olmaq üçün |
| `whatsapp_business_messaging` | Müştəri mesajlarına 24 saat ərzində cavab göndərmək üçün |
| Human Agent (lazım deyil) | Sistem 24 saatdan sonra mesaj göndərmir |

**Screencast** (hər icazə üçün ingiliscə subtitr əlavə edin):

1. Qeydiyyat, e-poçt təsdiqi, giriş
2. AI köməkçi səhifəsində biznes məlumatlarının doldurulması
3. "Instagram bağla" → Instagram icazə ekranı → bağlandı
4. Test hesabından DM yazmaq → AI cavabı telefonda görünür → paneldə "Söhbətlər" səhifəsində görünür
5. "operator" yazmaq → operatora ötürmə → əməkdaşın paneldən cavab verməsi
6. "WhatsApp bağla" → Embedded Signup → WhatsApp-dan mesaj → AI cavabı
7. Kanalı ayırmaq (məlumatların silinməsi) və Ayarlar → Hesabı sil

## Meta siyasətləri: kodda necə nəzərə alınıb

- **24 saat qaydası**: AI və əl ilə cavab yalnız müştərinin son mesajından 24 saat ərzində göndərilir (`pipeline.ts`).
- **Ümumi təyinatlı AI chatbot qadağası** (WhatsApp Business Solution Terms, 2026): bot yalnız biznesin öz mövzularında cavab verir, kənar suallardan imtina edir (`ai.ts` → RULES). Məhsulu "WhatsApp-da ChatGPT" kimi reklam etməyin. Bu, biznesin müştəri xidməti köməkçisidir.
- **İnsana ötürmə**: açar sözlər ("operator", "insan", "оператор"...), AI-nin `request_human` aləti, limitin bitməsi. Əməkdaş Instagram tətbiqindən yazdıqda AI həmin söhbətdə 12 saat dayanır.
- **AI olduğunu bildirmək**: ilk cavabda (paneldən söndürmək olar).
- **Minimal icazələr**, **məlumatların silinməsi** (callback-lər, kanalı ayırmaq, hesabı silmək, `PARTNER_REMOVED` webhook-u), **saxlama müddəti** (`RETENTION_DAYS`, standart 90 gün), **məlumatların yüklənməsi** (JSON export).

## Təhlükəsizlik

- Webhook-lar `X-Hub-Signature-256` HMAC ilə raw body üzərindən yoxlanır (timing-safe müqayisə).
- Meta access token-ları AES-256-GCM ilə şifrələnir. Loglara token, cookie və query string yazılmır.
- Şifrələr Argon2id ilə hash-lənir. Login cəhdləri IP və e-poçt üzrə məhdudlaşdırılır (15 dəqiqəlik bloklama). Hesab mövcudluğu (enumeration) gizlədilir.
- Sessiyalar DB-də yalnız SHA-256 hash kimi saxlanır. Cookie `__Host-` prefiksli, `HttpOnly`, `Secure`, `SameSite`. Şifrə dəyişəndə bütün sessiyalar silinir.
- CSRF: hər POST üçün token və Origin yoxlaması. OAuth `state` birdəfəlik, 10 dəqiqəlikdir və workspace-ə bağlıdır.
- Embedded Signup-dan gələn `waba_id` və `phone_number_id` token ilə yoxlanır, saxta ID qəbul edilmir.
- Multi-tenant izolyasiya: bütün sorğular `workspace_id` ilə məhdudlaşdırılır.
- Helmet: CSP (inline skript yoxdur), HSTS, frame-ancestors none. Rate limit Redis-də saxlanır.
- AI tərəfi: müştəri mesajları etibarsız sayılır (prompt injection qaydaları), kart və şifrə məlumatı soruşulmur, cavab uzunluğu limitlənir.

## Production yoxlama siyahısı

- [ ] HTTPS domen, `NODE_ENV=production`, `APP_URL=https://...`
- [ ] `ENCRYPTION_KEY`-in ehtiyat nüsxəsi (itsə, token-lar oxunmaz və bütün kanallar yenidən bağlanmalıdır)
- [ ] SMTP (məsələn Amazon SES, Postmark, Brevo), domen üçün SPF/DKIM
- [ ] Postgres üçün avtomatik backup, Redis persistence (AOF)
- [ ] Hüquqi səhifələrdəki şirkət adı, ünvan və e-poçt (`LEGAL_*`). Mətnləri hüquqşünasa yoxlatdırın.
- [ ] Monitorinq: `/healthz`, worker logları, uğursuz job-lar

## AI xərci

Standart model `claude-opus-5-5`-dir (ən yüksək keyfiyyət, $4 / $20 / 1M token). Xərci təxminən 40 dəfə azaltmaq üçün `AI_MODEL=claude-haiku-5-5` təyin edin ($0.10 / $0.50). Sistem promptu cache-lənir (`cache_control`).

## TikTok

TikTok-un DM API-si (Business Messaging API) hamı üçün açıq deyil, partnyorluq müraciəti tələb edir. Kanal arxitekturası (`src/channels/`) yeni platforma üçün hazırdır. Giriş əldə edildikdən sonra `tiktok` adapteri əlavə olunacaq.

## Növbəti addımlar

Ödəniş (Payriff / Epoint), planlar, TikTok, Instagram şərhlərinə cavab, bir workspace-də bir neçə əməkdaş, bilik bazası üçün PDF və sayt importu.
