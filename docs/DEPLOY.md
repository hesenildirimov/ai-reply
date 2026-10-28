# Serverə yerləşdirmə (production)

Tələblər: Ubuntu 24.04 VPS (2 GB RAM kifayətdir), domen, Docker.

## 1. Server
```bash
apt update && apt install -y docker.io docker-compose-v2 ufw
ufw allow OpenSSH && ufw allow 80,443/tcp && ufw allow 443/udp && ufw enable   # yalnız SSH və HTTPS açıqdır
git clone https://github.com/hesenildirimov/ai-reply && cd ai-reply
cp .env.example .env && chmod 600 .env
```
DNS-də domenin (məsələn `app.sizinbiznes.az`) **A record**-unu serverin IP-sinə yönləndirin.

## 2. `.env` faylını doldurun
| Dəyişən | Necə |
|---|---|
| `NODE_ENV` | `production` |
| `APP_URL` / `DOMAIN` | `https://app.sizinbiznes.az` / `app.sizinbiznes.az` |
| `ENCRYPTION_KEY` | `openssl rand -base64 32` |
| `POSTGRES_PASSWORD`, `REDIS_PASSWORD`, `APP_DB_PASSWORD` | `openssl rand -hex 24` (hər biri ayrıca). Tətbiq bazaya məhdud `app_rw` rolu ilə qoşulur, superuser yalnız miqrasiya və backup üçündür |
| `BACKUP_AGE_RECIPIENT` | Backup-ların açıq açarı (`age1...`). **Öz kompüterinizdə** yaradın: `age-keygen -o age-key.txt`. Faylda `# public key: age1...` sətri var, onu bura yazın. `age-key.txt` (gizli açar) serverə qoyulmur: parol menecerində və oflayn saxlayın |
| `ANTHROPIC_API_KEY` | console.anthropic.com |
| Meta, Telegram, WhatsApp bildiriş və VAPID dəyərləri | README-dəki bölmələrə baxın |

## 3. `ENCRYPTION_KEY`-in ehtiyat nüsxəsi (vacib)
Instagram və WhatsApp token-ları bu açarla şifrələnir. **Açar itsə, bütün müştərilər kanallarını yenidən bağlamalı olacaq.**
1. `.env` faylının tam məzmununu parol menecerinə (Bitwarden, 1Password) **"AI Reply production"** adlı qeyd kimi yazın.
2. İkinci nüsxəni oflayn saxlayın (çap edilmiş və ya şifrəli USB).
3. Açarı heç vaxt GitHub-a, mesajlaşmaya və ya e-poçta yazmayın.

Sistem açarın barmaq izini (fingerprint) DB-də saxlayır. Səhv açar ilə işə düşməyi rədd edir, ona görə token-lar səssizcə xarab olmur.

## 4. İşə salma
```bash
docker compose up -d --build
docker compose run --rm web node dist/create-admin.js siz@email.com   # şifrə linkini çap edir
```
Linki açın, şifrə təyin edin. Daxil olanda **iki faktorlu girişi qurmaq məcburidir** (Google Authenticator və ya Authy).
Telefonu itirsəniz, eyni əmri yenidən işə salın: 2FA sıfırlanır və yeni şifrə linki çap olunur. Bunun üçün serverə giriş lazımdır.

Caddy SSL sertifikatını avtomatik alır və yeniləyir. HTTP sorğuları HTTPS-ə yönləndirilir.

## 5. Backup
- `backup` servisi hər gün `./backups/aireply-*.dump.age` faylını yaradır və 14 gündən köhnələri silir.
- Fayl yazılmazdan əvvəl `age` ilə `BACKUP_AGE_RECIPIENT` açıq açarına şifrələnir. Serverdə yalnız açıq açar var:
  server və ya backup diski oğurlansa da yazışmalar oxunmur. Açmaq üçün gizli açar (`age-key.txt`) lazımdır.
- **Serverdən kənara da köçürün** (eyni diskdə olan backup tam backup deyil), məsələn rclone ilə şifrəli Backblaze B2 və ya S3-ə:
  `rclone sync ./backups b2crypt:aireply-backups` (cron ilə gündəlik).
- Bərpa: `apt install age`, gizli açarı müvəqqəti serverə köçürün və
  `./scripts/restore.sh backups/aireply-YYYYMMDD-HHMM.dump.age age-key.txt` işlədin. Sonra açarı serverdən silin
  (`shred -u age-key.txt`). Köhnə şifrəsiz `.dump` faylları üçün ikinci arqument lazım deyil. Ayda bir dəfə test
  serverində yoxlayın.

## 6. Yeniləmə
```bash
git pull && docker compose up -d --build   # miqrasiyalar avtomatik işləyir
```

## 7. Miqrasiyalar və geri qaytarma (rollback)
Miqrasiyalar (`migrations/NNN_*.sql`) hər buraxılışda avtomatik və ardıcıl işləyir, hər biri tək tranzaksiyada. Hər birinin geri qaytarma faylı var: `migrations/down/NNN_*.down.sql`.

Yeniləmədən **əvvəl** həmişə backup götürün:
```bash
docker compose exec backup bash -c 'set -o pipefail; pg_dump -h db -U aireply_owner -d aireply -Fc | age -r "$BACKUP_AGE_RECIPIENT" -o /backups/pre-update-$(date -u +%Y%m%d-%H%M).dump.age'
git log --oneline -1                     # hazırkı versiyanı qeyd edin
```

Problem olarsa (məs. 010-dan sonra):
```bash
git checkout <əvvəlki-commit>
docker compose exec -T db psql -U aireply_owner aireply < migrations/down/010_saas.down.sql
docker compose exec -T db psql -U aireply_owner aireply -c "DELETE FROM schema_migrations WHERE name = '010_saas.sql'"
docker compose up -d --build
```
Down faylları yalnız həmin miqrasiyanın əlavə etdiyi cədvəl və sütunları silir: o vaxtdan bəri yazılmış məlumatlar (məs. webhook-lar, kontakt birləşdirmələri) itir. Məlumat itkisi qəbuledilməzdirsə, down əvəzinə yenilənmədən əvvəlki backup-dan bərpa edin (`scripts/restore.sh`).
Bir neçə addım geri getmək üçün down fayllarını tərs ardıcıllıqla işlədin (010 → 009 → …). `006`/`007`-nin down-u kontakt və tarif məlumatlarını silir.

## 8. Yeni mühit dəyişənləri (P0–P4)
| Dəyişən | Standart | Mənası |
|---|---|---|
| `AI_ROUTING` | `on` | Sadə mesajlar sürətli/ucuz modelə (`config/ai-models.json` → `routing.fast`) |
| `AI_WORKSPACE_RPM` | `30` | Bir biznes üçün dəqiqədə maksimum AI çağırışı |
| `AI_MODEL`, `AI_MODEL_FAST` | config-dən | Modelləri env ilə dəyişmək (istəyə görə) |
| `AI_MODELS_FILE` | `config/ai-models.json` | Model qiymətləri, routing, token büdcələri |
| `ENCRYPTION_KEY_PREVIOUS` | — | Yalnız açar rotasiyası zamanı: köhnə açar. Worker məlumatları (mesajlar da daxil, saatda bir hissə) yeni açarla yenidən şifrələyir. `app_meta`-da `encryption_key_fp` yeni açara keçəndə (və `msg_rotation_cursor` silinəndə) rotasiya bitib. Bundan sonra silin |
| `WEBHOOK_ALLOW_PRIVATE` | — | **Yalnız lokal test**: lokal IP-yə webhook. Production-da nəzərə alınmır |
| `HUMAN_PAUSE_MINUTES` | `60` | Əməkdaş yazandan sonra AI neçə dəqiqə susur |
| `AI_CONV_HOURLY_CAP` | `30` | Bir söhbətdə saatda maksimum AI cavabı (sonra operatora keçir) |
| `MEDIA_ANALYSIS` | `on` | Şəkil, video və səsli mesajlara baxılır (ffmpeg lazımdır, Docker image-də var) |
| `STT_API_URL`, `STT_API_KEY`, `STT_MODEL` | — / `whisper-1` | Səsli mesajlar üçün nitqi mətnə çevirmə (OpenAI-uyğun `/audio/transcriptions`). Boşdursa, AI müştəridən yazmağı xahiş edir |
| `WORKER_CONCURRENCY` | `100` | Bir worker prosesində eyni anda AI cavabı/göndəriş sayı (ölçmə: README → "Tutum") |
| `INBOUND_CONCURRENCY` | `50` | Bir worker prosesində eyni anda webhook qəbulu işi (qısa DB işləri) |
| `DB_POOL_MAX` | `20` | Proses başına Postgres bağlantısı. Cəmi (web + worker-lər) Postgres `max_connections`-dan az olmalıdır |
| `LOG_LEVEL` | `info` (prod) | `warn` / `error` ilə log həcmini azaltmaq olar |

### Bu versiyaya keçid (mesaj şifrələməsi)
Yeni worker mesajları şifrəli yazır. Köhnə worker şifrəli sətri oxuya bilmir. Ona görə də yeni worker başlamazdan əvvəl
köhnəsini dayandırın (`docker compose up -d` bunu özü edir; Railway-də worker xidmətində deploy overlap olmamalıdır).
Köhnə açıq mətnli sətirləri worker hər saat paketlərlə şifrələyir (`messages WHERE NOT enc` sayı 0-a enir).

### Miqyaslama
- Worker-i bir neçə nüsxədə işə salmaq təhlükəsizdir (BullMQ işi bir worker-ə verir, söhbət kilidi Redis-dədir). 500
  biznesə qədər 2 nüsxə kifayətdir (README → "Tutum və yük testi").
- Redis üçün AOF və `maxmemory-policy noeviction` (BullMQ tələbi). Railway/managed Redis-də bu ayarı yoxlayın.
- Redis dayananda webhook-lar Postgres `inbound_outbox`-a yazılır. Worker onları özü növbəyə qaytarır, əl ilə iş
  lazım deyil.

## 9. Tarif limitləri
Tariflər `plans` cədvəlindədir (Start / Biznes / Pro, `migrations/007`). Admin panelində müştəri səhifəsindən tarif seçilir və istənilən limit fərdi olaraq dəyişdirilir ("limitsiz" və ya rəqəm). Limitlər serverdə yoxlanılır: kanallar, komanda üzvləri, aktiv avtomatlaşdırmalar, aktiv kontaktlar (30 gün), aylıq avtomatik mesaj sayı, AI büdcəsi (gün/ay), analitika tarixçəsi. Limit dolanda avtomatik cavablar dayanır, gələn mesajlar saxlanılır və əl ilə cavab vermək mümkün qalır. Hadisə audit jurnalına `plan.limit_reached` kimi yazılır.

## 10. Railway (docker-compose olmadan)
Railway-in Postgres istifadəçisi (`postgres`) **superuser**-dir. Web və worker onunla işləsə, gələcəkdə yaranan hər
hansı SQL injection DB serverində əmr icrasına (`COPY ... TO PROGRAM`) çevrilə bilər. Ona görə də tətbiq yalnız data
oxuyub-yazan `app_rw` rolu ilə işləyir. Production-da web/worker imtiyazlı rolla **işə düşmür**
(`FATAL: DATABASE_URL uses a privileged role`).

**Sıra vacibdir:** əvvəl 1 və 2-ci addımlar, sonra bu versiyanın deploy-u.

**1. Rolu yaradın** (Railway → Postgres → Data → Query, `postgres` istifadəçisi ilə, bir dəfə). `<PAROL>` =
`openssl rand -hex 24`. Baza adı adətən `railway`-dir, fərqlidirsə dəyişin.
```sql
CREATE ROLE app_rw LOGIN PASSWORD '<PAROL>' NOSUPERUSER NOCREATEDB NOCREATEROLE;
GRANT CONNECT ON DATABASE railway TO app_rw;
GRANT USAGE ON SCHEMA public TO app_rw;
-- Mövcud cədvəllər (default privileges yalnız yeni cədvəllərə aiddir)
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_rw;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_rw;
-- Gələcək miqrasiyaların yaratdığı cədvəllər
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_rw;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO app_rw;
-- Miqrasiya cədvəlinə tətbiq yazmır (014 miqrasiyası da bunu edir)
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON schema_migrations FROM app_rw;
```

**2. Mühit dəyişənləri**

| Servis | Dəyişən | Dəyər |
|---|---|---|
| web | `DATABASE_URL` | `postgresql://app_rw:<PAROL>@<host>:<port>/railway` |
| web | `MIGRATE_DATABASE_URL` | `${{Postgres.DATABASE_URL}}` (owner; yalnız `preDeployCommand` miqrasiyası istifadə edir) |
| worker | `DATABASE_URL` | `postgresql://app_rw:<PAROL>@<host>:<port>/railway` |
| web, worker | `NODE_ENV` | `production` (Dockerfile da təyin edir; məcburidir, standart dəyər yoxdur) |

Worker-ə `MIGRATE_DATABASE_URL` verilmir. `<host>`/`<port>` Postgres servisinin `PGHOST`/`PGPORT` dəyişənləridir.

**Keçid dövrü:** rol hələ hazır deyilsə, müvəqqəti `ALLOW_PRIVILEGED_DB=1` qoymaq olar. Hazır olan kimi silin.

**Yoxlama:** deploy logunda `FATAL: DATABASE_URL uses a privileged role` yoxdur, `/readyz` 200 qaytarır və
`SELECT user_id, count(*) FROM memberships GROUP BY 1 HAVING count(*) > 1;` boşdur (014 miqrasiyası bunu tələb edir).

**Backup:** Railway Postgres-in öz backup-larını aktiv edin. Əlavə nüsxə üçün `scripts/backup.sh`-ı ayrıca servis kimi
(`docker/backup.Dockerfile`, `BACKUP_AGE_RECIPIENT` ilə) işlədib faylları serverdən kənara köçürmək olar.
