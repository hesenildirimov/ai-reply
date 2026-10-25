# AI Reply: Instagram və WhatsApp üçün AI avtomatik cavab sistemi (MVP)

Müştəri hesablarını admin yaradır. Biznes öz panelində məlumatlarını yazır, Instagram və WhatsApp hesablarını bağlayır. Gələn DM-lərə Claude AI cavab verir. Lazım olduqda söhbət əməkdaşa ötürülür.

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
| `src/web/` | Giriş sistemi, CSRF, panel səhifələri, admin panel (`admin.ts`), hüquqi səhifələr, Meta callback-ləri |
| `src/automations/` | Avtomatlaşdırma: trigger-lər, imkan matrisi, flow mühərriki (açar söz, şərhdən DM, story, düymələr) |
| `src/context.ts`, `config/ai-models.json` | AI konteksti: bilik bazası seçimi, xülasə, model routing, token büdcələri |
| `src/analytics.ts` | Analitika sorğuları (hamısı xam məlumatdan yenidən hesablanır) |
| `src/plans.ts` | Tarif limitləri (serverdə yoxlanılır) |
| `src/webhooks.ts` | Çıxan webhook-lar (HMAC imza, SSRF qoruması, təkrar cəhd) |
| `src/create-admin.ts` | İlk admin hesabını yaradır |

## Lokal işə salma

```bash
cp .env.example .env              # ENCRYPTION_KEY: openssl rand -base64 32
docker compose up -d db redis     # və ya lokal Postgres 16 + Redis 7
npm install
npm run migrate
npm run create-admin -- siz@example.com   # şifrə təyin etmə linkini çap edir
npm run dev                       # http://localhost:3000
npm run dev:worker                # ayrı terminalda
npm test
```

SMTP məcburi deyil. Təyin olunsa, operatora ötürmə bildirişləri e-poçtla gəlir və "Şifrəni unutmusunuz?" funksiyası aktivləşir.

## Müştəri idarəetməsi (Admin panel: `/admin`)

Açıq qeydiyyat yoxdur. Ödəniş nağd və ya kartdan karta alınır, sistemdə yalnız tarix kimi qeyd olunur.

1. **Yeni müştəri** formasını doldurun: biznes adı, e-poçt, aylıq AI limiti, "Ödənilib (bu tarixə qədər)", qeyd.
2. Sistem **şifrə təyin etmə linki** göstərir (72 saat, birdəfəlik). Onu müştəriyə WhatsApp ilə göndərin.
3. Müştəri şifrəsini təyin edib daxil olur, məlumatlarını yazır, kanallarını bağlayır.
4. Ödəniş alanda müştərinin səhifəsində **"+30 gün ödəniş"** düyməsini basın.
5. Ödəniş tarixi keçəndə AI avtomatik dayanır. Müştəri panelə girib əl ilə cavab verə bilir və xəbərdarlıq görür.
6. Şifrəni unudan müştəri üçün **"Yeni şifrə linki"** düyməsindən istifadə edin.

Admin hesabının öz "Demo" workspace-i var. Meta App Review screencast-ı üçün ondan istifadə edin.

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
| `instagram_business_manage_comments` | Açar sözlü şərhə bir dəfə private reply (DM) və ictimai cavab üçün |
| `whatsapp_business_management` | Embedded Signup ilə WABA və nömrəni bağlamaq, webhook-a abunə olmaq üçün |
| `whatsapp_business_messaging` | Müştəri mesajlarına 24 saat ərzində cavab göndərmək üçün |
| Human Agent (lazım deyil) | Sistem 24 saatdan sonra mesaj göndərmir |

Ətraflı addımlar, trigger→icazə cədvəli və təqdimat mətnləri: **`docs/META_APP_REVIEW.md`**.

**Screencast** (hər icazə üçün ingiliscə subtitr əlavə edin):

1. Giriş (hesab admin tərəfindən yaradılır)
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
- **AI olduğunu bildirmək**: default olaraq söndürülüb. AI özünü təqdim etmir, amma ciddi soruşulanda yalan danışmır (bax `SECURITY.md` §11).
- **Minimal icazələr**, **məlumatların silinməsi** (callback-lər, kanalı ayırmaq, hesabı silmək, `PARTNER_REMOVED` webhook-u), **saxlama müddəti** (`RETENTION_DAYS`, standart 90 gün), **məlumatların yüklənməsi** (JSON export).

## Təbii danışıq və üslub öyrənmə

- AI biznesin əməkdaşı kimi yazır. "Operator", "AI" və ya "sistem" sözlərini işlətmir. Bilmədiyi sualda öz üslubunda qısa gözləmə cavabı yazır ("bir dəqiqə, baxım yazıram") və biznesə bildiriş göndərir.
- **AI köməkçi → "Yazışmalarımdan öyrən"** düyməsi Instagram-dakı son yazışmaları və paneldən yazılan cavabları oxuyur. Yazılış ("qiymet"), "sən/siz", emoji və uzunluq barədə qısa bir üslub təsviri yaradır. Instagram bağlananda bu avtomatik edilir. WhatsApp API keçmiş yazışmaları vermir: orada üslub paneldən yazılan cavablardan öyrənilir.

## Bildirişlər (WhatsApp, Telegram, Chrome, e-poçt)

Müştəri **Ayarlar → Bildirişlər** bölməsində istədiyi kanalları qoşur (bir neçəsini birlikdə də):
- **WhatsApp:** platformanın öz WhatsApp Business nömrəsindən gəlir. Meta-da *Utility* kateqoriyalı template təsdiqlənməlidir, məsələn: `🔔 {{1}}: {{2}} cavabınızı gözləyir: “{{3}}”` + "Cavab ver" URL düyməsi. Hər mesaj Meta tərəfindən ödənişlidir (utility tarifi). Qoşulanda müştəri kodu öz WhatsApp-ından göndərir.
- **Chrome:** `npx web-push generate-vapid-keys` ilə `VAPID_*` dəyərlərini təyin edin. Android, kompüter və iPhone-da (Ana ekrana əlavə etdikdən sonra) işləyir.

### Telegram

1. @BotFather-də bot yaradın. `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME` və uzun təsadüfi `TELEGRAM_WEBHOOK_SECRET` təyin edin. Webhook server işə düşəndə avtomatik qeydiyyatdan keçir.
2. Müştəri **Ayarlar → Bildirişlər → "Telegram-ı qoş"** düyməsini basır və botda **Start**-a toxunur.
3. Müştəri cavab gözləyəndə bildiriş gəlir: ad, mesajın əvvəli və söhbətin linki. Eyni söhbət üçün ən çox 10 dəqiqədə bir dəfə göndərilir.

## Təhlükəsizlik

Audit nəticələri və tövsiyələr: [`SECURITY.md`](SECURITY.md). İnteqrasiya testləri:
`TEST_DATABASE_URL=postgres://… TEST_REDIS_URL=redis://… npm test` (CI-da avtomatik işləyir).

## Serverə yerləşdirmə

Addım-addım: [`docs/DEPLOY.md`](docs/DEPLOY.md) (Caddy/HTTPS, 2FA, backup, `ENCRYPTION_KEY`-in ehtiyat nüsxəsi).

## Təhlükəsizlik detalları

- Webhook-lar `X-Hub-Signature-256` HMAC ilə raw body üzərindən yoxlanır (timing-safe müqayisə).
- Meta access token-ları AES-256-GCM ilə şifrələnir. Loglara token, cookie və query string yazılmır.
- Şifrələr Argon2id ilə hash-lənir. Login cəhdləri IP və e-poçt üzrə məhdudlaşdırılır (15 dəqiqəlik bloklama). Hesab mövcudluğu (enumeration) gizlədilir. Açıq qeydiyyat yoxdur, hesabları yalnız admin yaradır.
- Sessiyalar DB-də yalnız SHA-256 hash kimi saxlanır. Cookie `__Host-` prefiksli, `HttpOnly`, `Secure`, `SameSite`. Şifrə dəyişəndə bütün sessiyalar silinir.
- CSRF: hər POST üçün token və Origin yoxlaması. OAuth `state` birdəfəlik, 10 dəqiqəlikdir və workspace-ə bağlıdır.
- Embedded Signup-dan gələn `waba_id` və `phone_number_id` token ilə yoxlanır, saxta ID qəbul edilmir.
- Multi-tenant izolyasiya: bütün sorğular `workspace_id` ilə məhdudlaşdırılır.
- Helmet: CSP (inline skript yoxdur), HSTS, frame-ancestors none. Rate limit Redis-də saxlanır.
- AI tərəfi: müştəri mesajları etibarsız sayılır (prompt injection qaydaları), kart və şifrə məlumatı soruşulmur, cavab uzunluğu limitlənir.

## Production yoxlama siyahısı

- [ ] HTTPS domen, `NODE_ENV=production`, `APP_URL=https://...`
- [ ] `ENCRYPTION_KEY`-in ehtiyat nüsxəsi (itsə, token-lar oxunmaz və bütün kanallar yenidən bağlanmalıdır)
- [ ] `npm run create-admin:prod -- email` ilə admin yaradılması
- [ ] (İstəyə görə) SMTP, domen üçün SPF/DKIM
- [ ] Postgres üçün avtomatik backup, Redis persistence (AOF)
- [ ] Hüquqi səhifələrdəki şirkət adı, ünvan və e-poçt (`LEGAL_*`). Mətnləri hüquqşünasa yoxlatdırın.
- [ ] Monitorinq: `/healthz`, worker logları, uğursuz job-lar

## AI xərci

Modellər, qiymətlər və token büdcələri `config/ai-models.json`-dadır. Sadə, qısa suallar sürətli modelə (`claude-haiku-5-5`), mürəkkəb və həssas suallar isə əsas modelə (`claude-opus-5-5`) gedir (`AI_ROUTING`).
- Kiçik bilik bazası (≈4000 token) bütövlükdə cache-lənən hissəyə qoyulur. Böyük baza üçün isə hər mesaja yalnız uyğun maddələr seçilir.
- Köhnə yazışma xülasə ilə əvəz olunur.
- Hər çağırış `ai_usage` jurnalına yazılır: tokenlər, cache, təxmini xərc və gecikmə. Analitika səhifəsində görünür.
- Biznes üzrə gündəlik/aylıq büdcə və dəqiqəlik limit var.

Ölçmə: `npx tsx --env-file=.env scripts/measure-context.ts`. Nəticə təxminidir; real API açarı və `MEASURE_EXACT=1` ilə `count_tokens` istifadə olunur. Son nəticə `docs/token-measurement.txt` faylındadır.

## TikTok

TikTok-un DM API-si (Business Messaging API) hamı üçün açıq deyil, partnyorluq müraciəti tələb edir. Kanal arxitekturası (`src/channels/`) yeni platforma üçün hazırdır. Giriş əldə edildikdən sonra `tiktok` adapteri əlavə olunacaq.

## Növbəti addımlar

Onlayn ödəniş (Payriff / Epoint), TikTok (partnyor girişi lazımdır), bilik bazası üçün PDF və sayt importu, birbaşa CRM adapterləri (hazırda webhook + Make/Zapier/n8n vasitəsilə: `docs/INTEGRATIONS.md`), şərti budaqlanan vizual qrafik redaktor (indiki builder ardıcıl addımlar + düymə keçidləri + şərt addımıdır).
