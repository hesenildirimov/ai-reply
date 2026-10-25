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
| `POSTGRES_PASSWORD`, `REDIS_PASSWORD` | `openssl rand -hex 24` (hər biri ayrıca) |
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
- `backup` servisi hər gün `./backups/aireply-*.dump` faylını yaradır və 14 gündən köhnələri silir.
- **Serverdən kənara da köçürün** (eyni diskdə olan backup tam backup deyil), məsələn rclone ilə şifrəli Backblaze B2 və ya S3-ə:
  `rclone sync ./backups b2crypt:aireply-backups` (cron ilə gündəlik).
- Bərpa: `./scripts/restore.sh backups/aireply-YYYYMMDD-HHMM.dump`. Ayda bir dəfə test serverində yoxlayın.

## 6. Yeniləmə
```bash
git pull && docker compose up -d --build   # miqrasiyalar avtomatik işləyir
```

## 7. Miqrasiyalar və geri qaytarma (rollback)
Miqrasiyalar (`migrations/NNN_*.sql`) hər buraxılışda avtomatik və ardıcıl işləyir, hər biri tək tranzaksiyada. Hər birinin geri qaytarma faylı var: `migrations/down/NNN_*.down.sql`.

Yeniləmədən **əvvəl** həmişə backup götürün:
```bash
docker compose exec backup sh -c 'pg_dump -h db -U app -d aireply -Fc -f /backups/pre-update-$(date -u +%Y%m%d-%H%M).dump'
git log --oneline -1                     # hazırkı versiyanı qeyd edin
```

Problem olarsa (məs. 010-dan sonra):
```bash
git checkout <əvvəlki-commit>
docker compose exec -T db psql -U app aireply < migrations/down/010_saas.down.sql
docker compose exec -T db psql -U app aireply -c "DELETE FROM schema_migrations WHERE name = '010_saas.sql'"
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
| `ENCRYPTION_KEY_PREVIOUS` | — | Yalnız açar rotasiyası zamanı: köhnə açar. Worker məlumatları yeni açarla yenidən şifrələyir. Bitdikdən sonra silin |
| `WEBHOOK_ALLOW_PRIVATE` | — | **Yalnız lokal test**: lokal IP-yə webhook. Production-da nəzərə alınmır |

## 9. Tarif limitləri
Tariflər `plans` cədvəlindədir (Start / Biznes / Pro, `migrations/007`). Admin panelində müştəri səhifəsindən tarif seçilir və istənilən limit fərdi olaraq dəyişdirilir ("limitsiz" və ya rəqəm). Limitlər serverdə yoxlanılır: kanallar, komanda üzvləri, aktiv avtomatlaşdırmalar, aktiv kontaktlar (30 gün), aylıq avtomatik mesaj sayı, AI büdcəsi (gün/ay), analitika tarixçəsi. Limit dolanda avtomatik cavablar dayanır, gələn mesajlar saxlanılır və əl ilə cavab vermək mümkün qalır. Hadisə audit jurnalına `plan.limit_reached` kimi yazılır.
