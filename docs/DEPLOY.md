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
