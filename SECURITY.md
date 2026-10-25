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
- ✅ Şifrə linkləri birdəfəlikdir, 72 saat (unutma halında 1 saat) etibarlıdır. Şifrə təyin olunanda bütün sessiyalar və digər açıq linklər ləğv edilir.
- ✅ Login cəhdləri IP üzrə dəqiqədə 10, e-poçt üzrə 15 dəqiqədə 10 ilə məhdudlaşdırılıb.
- ⚠️ E-poçt üzrə bloklamadan sui-istifadə edib başqasının hesabını 15 dəqiqəlik bloklamaq olar. Hazırkı miqyasda qəbul ediləndir.
- 🔧 İki faktorlu giriş (TOTP, RFC 6238) əlavə olundu: admin üçün məcburidir, müştərilər üçün istəyə bağlıdır. Kod təkrar istifadə edilə bilmir (time-step yadda saxlanır), 5 cəhddən sonra bloklanır. Bərpa: serverdə `create-admin` əmri.

## 3. Authorization (IDOR/BOLA)
- ✅ Bütün müştəri sorğuları sessiyadakı `workspace_id` ilə məhdudlaşdırılıb (söhbət, cavab, silmə, kanal, export).
- ✅ Admin marşrutları `is_admin` yoxlayır və başqalarına 404 qaytarır. Kanal bağlama və hesab silmə yalnız `owner` üçündür.
- ✅ OAuth `state` birdəfəlikdir, 10 dəqiqəlikdir və workspace-ə bağlıdır. Embedded Signup-dan gələn `waba_id`/`phone_number_id` Meta token-ı ilə yoxlanır.
- 🔧 Avtomatik testlər əlavə olundu: başqa workspace-in söhbətini oxumaq, silmək və ona cavab yazmaq mümkün deyil; adi istifadəçi `/admin`-ə çata bilmir.

## 4. Input validation
- ✅ SQL: bütün sorğular parametrlidir. String interpolasiyası yalnız kod daxilindəki sabitlərlədir.
- ✅ XSS: bütün HTML avtomatik escape olunur, inline skript yoxdur, CSP var. Test: müştəri mesajındakı `<script>` escape edilmiş görünür.
- ✅ Bütün formalar zod ilə yoxlanır (uzunluq, format, enum). Command injection, fayl yükləmə və path traversal səthi yoxdur (statik fayllar sabit qovluqdan verilir).

## 5. API security
- ✅ Meta webhook-ları raw body üzərindən HMAC-SHA256 imza ilə timing-safe yoxlanır. Telegram webhook-u secret başlığı ilə yoxlanır. Təkrar göndərilən mesajlar message ID ilə deduplikasiya olunur.
- ✅ CSRF üçün token və Origin yoxlaması var. CORS açılmayıb (yalnız eyni origin).
- ✅ Rate limit Redis-də saxlanır. Body limiti: 512KB JSON, 128KB form.
- ✅ Xəta cavabları ümumidir, stack trace istifadəçiyə göstərilmir.
- ✅ SSRF: xarici URL-lər yalnız konfiqurasiyadan gəlir. ID-lər rəqəm formatında yoxlanılır.
- 🔧 `trustProxy` yalnız 1 hop-a etibar edir. Əvvəl hamısına etibar edirdi və `X-Forwarded-For` saxtalaşdırılaraq IP rate limit-dən yayınmaq olurdu.
- 🔧 Redis dayananda rate limiter bütün saytı dondururdu. İndi sorğular davam edir.

## 5b. Bildiriş kanalları
- 🔧 Chrome push: server push servisinə sorğu göndərdiyi üçün endpoint yalnız real push servislərinə (FCM, Mozilla, Microsoft, Apple) icazəlidir (SSRF qorunması). Abunəlik şifrəli saxlanır.
- 🔧 WhatsApp və Telegram qoşulması birdəfəlik, 15 dəqiqəlik kodla olur. Nömrə/çat sahibi özü kodu göndərir, başqasının nömrəsinə bildiriş yazdırmaq olmur.

## 6. Data protection
- ✅ Mesajlar 90 gündən sonra avtomatik silinir. Kanal ayrılanda və ya hesab silinəndə bütün məlumatlar dərhal silinir. JSON export var. Meta data-deletion callback-ləri işləyir.
- 🔧 Queue job-ları (mesaj mətni daşıyır) artıq Redis-də 1 saatdan çox saxlanmır (uğursuzlar 7 gün).
- 🔧 Privacy Policy-yə üslub öyrənmə və Telegram bildirişləri əlavə olundu.
- ⚠️ Mesaj mətnləri DB-də açıq mətndir. Disk şifrələməsi olan managed DB istifadə edin.

## 7. Dependencies
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
- ⚠️ Çatışmayan testlər: şifrə linkinin təkrar istifadəsi və vaxtının bitməsi, login bloklanması, OAuth `state` replay-i, data-deletion callback-i, Instagram echo ilə AI-nin dayanması, prompt injection üçün qiymətləndirmə (eval) dəsti.
