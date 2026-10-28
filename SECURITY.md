# Təhlükəsizlik auditi (25.10.2026)

Qiymətləndirmə: ✅ yoxlanıldı/qaydasındadır · 🔧 auditdə düzəldildi · ⚠️ qalan risk/tövsiyə

## 1. Secrets management
- ✅ Git tarixçəsində API açarı, token, parol və ya private key yoxdur. `.env` heç vaxt commit olunmayıb, `.gitignore`-dadır.
- ✅ Frontend-ə heç bir sirr getmir. Brauzerə yalnız Meta App ID və Embedded Signup config ID gedir; bunlar ictimai dəyərlərdir.
- ✅ Meta token-ları DB-də AES-256-GCM ilə şifrələnir. Sessiya və şifrə linki token-larının yalnız SHA-256 hash-i saxlanır.
- ✅ Loglara `Authorization`, cookie və CSRF başlıqları yazılmır. URL query string-ləri (OAuth `code`) loglanmır. Telegram token-ı olan URL xəta mesajlarına düşmür.
- 🔧 Production-da SMTP yoxdursa, məktub mətnləri (şifrə linkləri) artıq loga yazılmır.
- 🔧 `ENCRYPTION_KEY`-in barmaq izi DB-də saxlanır; səhv açarla sistem işə düşmür. Ehtiyat nüsxə qaydası: `docs/DEPLOY.md` §3.

## 2. Authentication
- ✅ Şifrələr Argon2id ilə hash-lənir (OWASP parametrləri). Mövcud olmayan hesab üçün də hash yoxlaması aparılır ki, cavab müddətindən hesabın varlığı bilinməsin.
- ✅ Hər girişdə yeni sessiya yaradılır (session fixation qorunması). Cookie-lər `HttpOnly`, `Secure`, `SameSite`, `__Host-` prefiksli, ömrü 7 gün, sürüşkəndir.
- 🔧 Sessiyanın mütləq ömrü var: nə qədər aktiv istifadə olunsa da 30 gün, platforma admini üçün 12 saat. Oğurlanmış cookie sonsuz işləmir. Köhnə sessiyalar maintenance-də silinir.
- ✅ Şifrə linkləri birdəfəlikdir, 72 saat (unutma halında 1 saat) etibarlıdır. Şifrə təyin olunanda bütün sessiyalar və digər açıq linklər ləğv edilir.
- 🔧 Login cəhdləri: IP üzrə dəqiqədə 10 sorğu; "e-poçt + IP" üzrə 15 dəqiqədə 10 səhv şifrə; yalnız e-poçt üzrə 15 dəqiqədə 100 səhv şifrə (paylanmış hücum). Bir IP-dən səhv şifrə yazmaqla başqasının hesabını bloklamaq artıq mümkün deyil. Uğurlu giriş yalnız həmin IP-nin sayğacını sıfırlayır.
- 🔧 İki faktorlu giriş (TOTP, RFC 6238): admin üçün məcburidir, müştərilər üçün istəyə bağlıdır. Kod təkrar istifadə edilə bilmir (time-step yadda saxlanır). Bir login üzrə 5 səhv kod; **istifadəçi üzrə 15 dəqiqədə 10 səhv koddan sonra bloklanır, təkrar login sayğacı sıfırlamır** (şifrəni bilən hücumçu "login → 5 kod → yenidən login" dövrü ilə 2FA-nı keçə bilmir). Limit dolanda sahibə e-poçt gedir. Bərpa: serverdə `create-admin` əmri.
- 🔧 2FA-nı aktivləşdirmək və söndürmək cari şifrəni tələb edir: təkcə oğurlanmış sessiya cookie-si ilə hücumçu öz 2FA sirrini qeydiyyatdan keçirə və ya 2FA-nı söndürə bilmir. 2FA aktivləşəndə digər bütün sessiyalar bağlanır.
- 🔧 "Şifrəni unutdum": cavab hesabın olub-olmamasından asılı olmayaraq eyni və eyni sürətdədir (məktub fonda göndərilir), bir e-poçta saatda ən çox 3 məktub.
- 🔧 Platforma admini aktiv müştəri hesabı üçün şifrə linkini görmür: link yalnız müştərinin öz e-poçtuna gedir və müştərinin audit jurnalına (`admin.password_link`, "Platforma admini" filtri) yazılır.
- ✅ Redis dayananda login və 2FA "bağlı" işləyir (blok sayğacı oxunmursa, 500 qaytarır, yoxlamasız buraxmır).

## 3. Authorization (IDOR/BOLA)
- ✅ Bütün müştəri sorğuları sessiyadakı `workspace_id` ilə məhdudlaşdırılıb (söhbət, cavab, silmə, kanal, export).
- ✅ Admin marşrutları `is_admin` yoxlayır və başqalarına 404 qaytarır. Kanal bağlama və hesab silmə yalnız `owner` üçündür.
- 🔧 Analitik rolu avtomatlaşdırmaları və bilik bazasını görmür (`automations.view`, `knowledge.view`). Avtomatlaşdırma testi və Instagram post seçimi (`/test`, `/media`) `automations.write` tələb edir.
- 🔧 "Bir istifadəçi = bir biznes" DB səviyyəsində məcburidir (`memberships_user_unique`, `014`).
- 🔧 Hesab silinəndə bütün komanda üzvlərinin `users` sətirləri də silinir (e-poçt, şifrə hash-i, 2FA sirri qalmır); platforma adminləri saxlanılır.
- ✅ OAuth `state` birdəfəlikdir, 10 dəqiqəlikdir və workspace-ə bağlıdır. Embedded Signup-dan gələn `waba_id`/`phone_number_id` Meta token-ı ilə yoxlanır.
- 🔧 Avtomatik testlər əlavə olundu: başqa workspace-in söhbətini oxumaq, silmək və ona cavab yazmaq mümkün deyil; adi istifadəçi `/admin`-ə çata bilmir.

## 4. Input validation
- ✅ SQL: bütün sorğular parametrlidir. String interpolasiyası yalnız kod daxilindəki sabitlərlədir.
- ✅ XSS: bütün HTML avtomatik escape olunur, inline skript yoxdur, CSP var. Test: müştəri mesajındakı `<script>` escape edilmiş görünür.
- 🔧 Instagram-dan gələn media linklərindən yalnız `https` saxlanılır. İnboxda şəkil/video yalnız Meta CDN-dən (`cdninstagram.com`, `fbcdn.net`, `fbsbx.com`) göstərilir, qalanları adi link kimi; CSP də `img-src`/`media-src`-i bu host-larla məhdudlaşdırır (operatorun IP-si üçüncü tərəfə getmir).
- 🔧 Avtomatlaşdırma linkləri (`/r/<kod>`) birbaşa yönləndirmir: ara səhifə hədəf saytı göstərir ("bu sayt AI Reply-a aid deyil"). Platformanın domeni fişinq üçün yönləndirici kimi istifadə oluna bilmir.
- 🔧 AI cavabındakı qiymət yoxlaması AZN-dən əlavə USD/$, EUR/€, TL/₺, RUB/₽/руб formatlarını tanıyır; biznes məlumatındakı uzun rəqəmlər (telefon, IBAN) "məlum qiymət" sayılmır.
- 🔧 Instagram şərhlərinə AI cavabı (`src/comments.ts`): şərh mətni AI-yə "etibarsız müştəri mətni" kimi işarələnmiş gedir. Şərhin altına yazılan ictimai cavabda qiymət, məbləğ, link və telefon ola bilməz (`publicTextOk`, əməkdaşın düzəlişi də yoxlanır). DM cavabı adi qiymət və link yoxlamasından keçir. Şikayətlərə AI yazmır. Təsdiq qaralamaları DB-də şifrəlidir. Şərhlər səhifəsi `inbox.view`, təsdiq `inbox.reply`, ayarlar `assistant.write` tələb edir.
- ✅ Bütün formalar zod ilə yoxlanır (uzunluq, format, enum). Command injection, fayl yükləmə və path traversal səthi yoxdur (statik fayllar sabit qovluqdan verilir).

## 5. API security
- ✅ Meta webhook-ları raw body üzərindən HMAC-SHA256 imza ilə timing-safe yoxlanır. Telegram webhook-u secret başlığı ilə yoxlanır. Təkrar göndərilən mesajlar message ID ilə deduplikasiya olunur.
- ✅ CSRF üçün token və Origin yoxlaması var. CORS açılmayıb (yalnız eyni origin).
- ✅ Rate limit Redis-də saxlanır. Body limiti: 512KB JSON, 128KB form.
- 🔧 Canlı inbox axını (SSE): istifadəçi başına proses daxilində ən çox 5 bağlantı. Hər 25 saniyədə sessiya və üzvlük yenidən yoxlanır: çıxış edən və ya komandadan çıxarılan üzvün açıq tabı dərhal bağlanır.
- 🔧 `NODE_ENV` məcburidir (standart dəyər yoxdur): unudulsa, sistem "development" kimi (Secure cookie-siz) səssizcə işləmir, başlamır.
- 🔧 Production-da web/worker superuser və ya DDL hüquqlu DB rolu ilə işə düşmür (`assertLeastPrivilege`). Miqrasiyalar ayrıca `MIGRATE_DATABASE_URL` ilə işləyir. Railway quraşdırması: `docs/DEPLOY.md` §10.
- 🔧 Webhook çatdırılma xətaları müştəriyə yalnız ümumi kateqoriya ilə göstərilir ("bağlantı alınmadı", "domen tapılmadı", "TLS xətası"...): xam soket xətası ilə host/port yoxlamaq olmur.
- ✅ Xəta cavabları ümumidir, stack trace istifadəçiyə göstərilmir.
- ✅ SSRF: xarici URL-lər yalnız konfiqurasiyadan gəlir. ID-lər rəqəm formatında yoxlanılır.
- 🔧 `trustProxy` yalnız 1 hop-a etibar edir. Əvvəl hamısına etibar edirdi və `X-Forwarded-For` saxtalaşdırılaraq IP rate limit-dən yayınmaq olurdu.
- 🔧 Redis dayananda rate limiter bütün saytı dondururdu. İndi sorğular davam edir.

## 5b. Bildiriş kanalları
- 🔧 Chrome push: server push servisinə sorğu göndərdiyi üçün endpoint yalnız real push servislərinə (FCM, Mozilla, Microsoft, Apple) icazəlidir (SSRF qorunması). Abunəlik şifrəli saxlanır.
- 🔧 WhatsApp və Telegram qoşulması birdəfəlik, 15 dəqiqəlik kodla olur. Nömrə/çat sahibi özü kodu göndərir, başqasının nömrəsinə bildiriş yazdırmaq olmur.

## 6. Data protection
- ✅ Mesajlar 90 gündən sonra avtomatik silinir. Kanal ayrılanda və ya hesab silinəndə bütün məlumatlar dərhal silinir. JSON export var. Meta data-deletion callback-ləri işləyir.
- 🔧 Queue job-ları Redis-də 1 saatdan çox saxlanmır (uğursuzlar 7 gün). Müştəri məzmunu daşıyan job-ların (webhook qəbulu, şərh, echo) məlumatı şifrəlidir.
- 🔧 Privacy Policy-yə üslub öyrənmə və Telegram bildirişləri əlavə olundu.
- ✅ Mesaj mətnləri DB-də AES-256-GCM ilə şifrəlidir (`messages.enc`, `012_message_encryption.sql`). AI xülasələri, əməkdaşların daxili qeydləri, saxlanılan webhook payload-ları, Redis job-ları və intake outbox-u da şifrəlidir. Kontakt adları və xüsusi sahələr axtarış və CSV üçün açıq qalır. İnbox axtarışı açar ilə HMAC-lanmış söz/söz başlanğıcı indeksi ilə işləyir (`search_tokens`). Bu indeks söz bərabərliyini (tezliyi) açar olmadan da göstərə bilər, mətnin özünü göstərmir. Köhnə açıq sətirləri maintenance paketlərlə şifrələyir. Açar rotasiyası mesajları da yenidən şifrələyir (kursorla, bir neçə maintenance-ə bölünə bilər). Disk şifrələməsi olan managed DB yenə də tövsiyə olunur.

## 7. Dependencies
- 🔧 Dependabot (npm, GitHub Actions, Docker) həftəlik yeniləmə PR-ları açır. CI-da gitleaks bütün tarixçədə sirr axtarır (`.gitleaks.toml`). `.gitignore`/`.dockerignore` `.env.*`, açar faylları və backup-ları kənarda saxlayır.
- ⚠️ GitHub Actions hələ teqlə (`@v4`), Docker image-ləri `node:22-slim` teqi ilə göstərilib. Tam qoruma üçün commit SHA və image digest ilə pin edin (`uses: actions/checkout@<sha> # v4`, `FROM node:22-slim@sha256:...`); Dependabot sonra onları yeniləyir.
- ✅ `npm audit`: 0 zəiflik. `package-lock.json` commit olunub. Docker-də `npm ci` istifadə olunur. Şübhəli paket yoxdur.
- 🔧 CI-a `npm audit --audit-level=high` əlavə olundu.
- ⚠️ Docker base image-i (`node:22-slim`) digest ilə pinləyin və Dependabot və ya Renovate qoşun.

## 8. Configuration
- ✅ Production rejimində HTTPS `APP_URL` və Anthropic açarı məcburidir. HSTS, CSP, `frame-ancestors none` və `Referrer-Policy: same-origin` aktivdir.
- 🔧 `docker-compose`-da Postgres üçün `app` default parolu silindi, artıq `POSTGRES_PASSWORD` məcburidir. Redis parol tələb edir. Web portu yalnız `127.0.0.1`-də açılır. Konteynerlər `read_only` və `no-new-privileges` ilə işləyir, `node` istifadəçisi kimi.
- 🔧 Caddy əlavə olundu: avtomatik Let's Encrypt, HTTP→HTTPS, access log yoxdur (URL-lərdə birdəfəlik token ola bilər). İnternetə yalnız 80/443 açıqdır.

## 9. Business logic
- ✅ Limit, ödəniş tarixi və rol yalnız serverdə yoxlanır. Müştəri bunları dəyişə bilmir. Limitin azaldılması atomik `UPDATE … WHERE` ilə edilir (race yoxdur).
- 🔧 Bir söhbətə saatda maksimum 15 AI cavabı verilir. Spam mesajlarla biznesin aylıq limitini yandırmağın qarşısı alınır.
- 🔧 Bildirişlər eyni söhbət üçün 10 dəqiqədə 1 dəfə göndərilir (spam qorunması).

## 10. Logging & monitoring
- 🔧 Təhlükəsizlik hadisələri loglanır: `login_failed`, `login_locked`, `login_ok`, `password_set`. Admin əməliyyatları da `audit` kimi loglanır (müştəri yaratma, dəyişmə, ödəniş, silmə, şifrə linki). E-poçt açıq yazılmır, yalnız hash-in bir hissəsi.
- ⚠️ Logları mərkəzi sistemə göndərin (Better Stack, Grafana Loki və s.) və `login_locked`, 5xx artımı və uğursuz job-lar üçün alert qurun.

## 11. AI və avtomatlaşdırma
- ✅ AI-nin yeganə aləti `request_human`-dır: heç bir məlumatı dəyişə, pul köçürə və ya xarici sorğu göndərə bilməz.
- ✅ Müştəri mesajları prompt-da etibarsız sayılır. Faktlar yalnız `business_info`-dan götürülür. Kart və şifrə məlumatı soruşulmur.
- ✅ Üslub öyrənmədə yalnız biznesin öz göndərdiyi mesajlar istifadə olunur, "data, təlimat deyil" kimi təqdim edilir. Nəticə 1500 simvolla məhdudlaşdırılıb və biznes onu redaktə edə bilir.
- ⚠️ AI-nin özünü təqdim etməməsi biznesin seçimidir (default: söndürülüb). AI birbaşa və ciddi soruşulanda yalan danışmır. Bəzi ölkələrdə (məs. AB AI Act, 2026) AI ilə danışıldığını bildirmək tələb olunur. Xaricə satış olarsa, bu ayarı yenidən nəzərdən keçirin.

## 12. Infrastructure & deployment
- 🔧 GitHub Actions CI əlavə olundu: typecheck, unit və inteqrasiya testləri (Postgres və Redis ilə), `npm audit`.
- 🔧 Gündəlik avtomatik Postgres backup (`backup` servisi, 14 gün) və `scripts/restore.sh`. ⚠️ Backup-ları serverdən kənara şifrəli köçürün və ayda bir bərpanı yoxlayın.
- ⚠️ Sirləri hostinqin secret manager-ində saxlayın, `.env` faylını serverdə `chmod 600` edin.

## 13. Testing
- 🔧 Əlavə olunan inteqrasiya testləri (`test/integration.test.ts`): giriş tələbi, CSRF və yanlış Origin, IDOR (oxuma/silmə/cavab), admin girişi, webhook imzası, deduplikasiya, XSS escape, Telegram secret, ödəniş tarixi və limit.
- ⚠️ Çatışmayan testlər: şifrə linkinin təkrar istifadəsi və vaxtının bitməsi, login bloklanması, OAuth `state` replay-i, data-deletion callback-i, prompt injection üçün qiymətləndirmə (eval) dəsti.

## 14. P0–P4 əlavələri (2026-10)
- 🔧 **Rollar** (`owner`, `admin`, `agent`, `analyst`): icazə matrisi `src/web/auth.ts` (`PERMS`) serverdə hər marşrutda yoxlanılır (`requirePerm`). Menyuda gizlətmək yalnız kosmetikdir. Admin başqa admin yarada və ya dəyişə bilmir, sahibi heç kim dəyişə bilmir. Üzv çıxarılanda bütün sessiyaları silinir.
- 🔧 **Audit jurnalı** (`audit_log`, panel: Komanda → Audit jurnalı): üzv dəvəti/rol/çıxarma, kanal bağlama/ayırma, söhbət təyini və ötürmə, kontakt tag/bayraq/birləşdirmə/import/eksport, avtomatlaşdırma, bilik bazası, webhook, tarif limiti və AI büdcəsi. Mesaj mətni və sirlər yazılmır.
- 🔧 **Webhook-lar (SSRF)**: yalnız `https`. Lokal, şəxsi, link-local (169.254.x — cloud metadata), CGNAT və multicast ünvanlar həm saxlanarkən, həm də qoşulma anında (DNS rebinding-ə qarşı `lookup` səviyyəsində) bloklanır. Yönləndirmələrə əməl olunmur, 10 san. timeout var. Secret AES-GCM ilə şifrəlidir və açar rotasiyasında yenidən şifrələnir. Sorğular HMAC-SHA256 ilə imzalanır (timestamp ilə).
- 🔧 **CSV**: eksportda formula inyeksiyası qorunur (`= + - @` ilə başlayan xanalar). İmport yalnız öz workspace-indəki mövcud kontaktları dəyişir: maks. 5000 sətir, 1 MB, CSRF header tələb olunur.
- 🔧 **Tarif limitləri** serverdə yoxlanılır (`src/plans.ts` → `checkLimit` / `automationBlocked`). Limit dolanda bot susur, gələn mesajlar itmir.
- 🔧 **AI xərci**: gündəlik/aylıq büdcə (təxmini, `ai_usage` jurnalından), workspace üzrə dəqiqəlik limit (`AI_WORKSPACE_RPM`), çağırış başına `max_tokens`, 30 san. timeout.
- ✅ Testlər: `test/reliability|automations|inbox|analytics|saas.test.ts`. Rollar, tenant izolyasiyası, SSRF, imza, CSV, limitlər, birləşdirmə, idempotent göndərmə, təkrarlanan webhook, paralel worker-lər yoxlanılır.
- ⚠️ Model davranışı (qiymət uydurmamaq, prompt injection) unit testlə yoxlanıla bilməz: `scripts/eval-prices.ts` real API açarı ilə əl ilə işlədilməlidir.

## 15. Production audit (2026-10) — status
Tools: Semgrep (GitHub rules), Gitleaks (history clean), OSV-Scanner + npm audit (0 vulns), OWASP ZAP (local, unauthenticated).
Regression tests: `test/security.test.ts`, `test/tenant-isolation.test.ts` (every route as tenant A with tenant B's ids).

| Id | Risk | Finding | Status |
|---|---|---|---|
| F-01 | High | Agent/analyst could change knowledge/prices and switch the AI off | ✅ `assistant.write` + audit |
| F-02 | High | Any role could export all conversations | ✅ owner only (`data.export`), audited, 3/hour |
| F-03 | Medium | Analysts could read conversations | ✅ `inbox.view` (owner/admin/agent) |
| F-04 | Medium | Any member deleted everyone's alert channels | ✅ only own targets |
| F-05/06 | Low | "Test" open to all roles, no AI budget | ✅ `assistant.write` + budget |
| F-07 | Medium | SSRF via IPv4-mapped IPv6 (`[::ffff:127.0.0.1]`) | ✅ `BlockList` incl. embedded IPv4, 6to4, NAT64 |
| F-08 | Low | Invite race exceeded member limit | ✅ advisory lock |
| F-09 | Medium | Concurrent replies overshot monthly message limit | ✅ atomic reservation at send time |
| F-10 | Medium | Summary of customer text placed in system prompt | ✅ moved to user turn as marked data |
| F-11 | Medium | AI text sent unchecked (unknown prices / links) | ✅ `src/guard.ts` → handoff + audit |
| F-12…F-21 | Low–Medium | DB superuser, webhook rate limit, GCM tag length, lockout DoS, CSP wildcards, media URL/SVG, admin audit, session lifetime, image pinning, backup encryption | ✅ except image/action pinning (⚠️ above); see audit 2026-10-27 below |

### Audit 2026-10-27 (O-1, O-2, A-1…A-13, M-1…M-4)
| Id | Finding | Status |
|---|---|---|
| O-1 | 2FA brute force by re-login | ✅ per-user counter (10 / 15 min), not reset by login; owner mailed |
| O-2 | Web/worker as DB superuser on Railway | ✅ `MIGRATE_DATABASE_URL`, `assertLeastPrivilege`, DEPLOY §10 |
| A-1 | Account lockout DoS | ✅ email+IP 10, email 100 |
| A-2 | `/forgot` timing + mail spam | ✅ background send, 3/hour per email |
| A-3 | 2FA on/off without password | ✅ password required, other sessions ended |
| A-4 | Admin sees reset link of active customer | ✅ mailed to customer, customer audit log |
| A-5 | Members left after account delete | ✅ deleted (admins kept) |
| A-6 | No UNIQUE on `memberships.user_id` | ✅ `014` |
| A-7 | `/r/:code` open redirect | ✅ interstitial |
| A-8 | Media URL scheme/host | ✅ https only, Meta CDN embed only, CSP narrowed |
| A-9 | Price guard: AZN only | ✅ USD/EUR/TRY/RUB, short numbers only |
| A-10 | SSE unlimited, no re-check | ✅ 5 per user, session re-check each ping |
| A-11 | Analyst reads automations/knowledge | ✅ `automations.view`, `knowledge.view` |
| A-12 | No absolute session lifetime | ✅ 30 days, admin 12 h |
| A-13 | `NODE_ENV` defaults to development | ✅ required |
| M-1 | Ignore files, secret scan | ✅ `.gitignore`, `.dockerignore`, gitleaks |
| M-2 | Plain backups | ✅ age (public key on server) |
| M-3 | Supply chain pinning | ⚠️ Dependabot added; SHA/digest pins still to do |
| M-4 | Raw webhook socket errors | ✅ coarse categories |

Not verified: real model behaviour (`scripts/eval-prices.ts` needs a key), real Meta webhooks/data-deletion ids, IPv6 exploitation, production TLS.
