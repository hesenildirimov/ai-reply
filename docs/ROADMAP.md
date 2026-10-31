# Yol xəritəsi

## Edildi
- Bilik bazası mənbələri: fayl (PDF, Word, TXT, CSV, Excel), sayt (səhifə və ya bütün sayt), sual-cavab; limit Start 10 / Biznes 20 / Pro 40 MB.
- Şəkil analizi modeli seçimi (standart ucuz model, "Dəqiq şəkil analizi" ilə güclü model).
- Sayt (az/ru/en), müraciət forması, admin "Lead-lər" (statuslar, qeydlər, CSV, bir kliklə müştəri yaratmaq), e-poçt və Telegram bildirişi.
- AI cavab limiti tarifdən (Start 1 500, Biznes 6 000, Pro 20 000).
- Test (mock) rejimi: `INTEGRATION_MODE=mock`, Instagram/Telegram provayderləri, məhsul kataloqu, post-məhsul əlaqəsi, "Qiymət?" şərhinə kart karuseli və bazadan qiymət cavabı (AI çağırılmadan), Hadisələr və Simulyator səhifələri (`docs/INTEGRATIONS-MOCK.md`).

## Növbəti
- Saytın mətnlərini və dizaynını demo üzərində yoxlamaq, düzəlişlər.

## Deploy və Meta
- Deploy (Railway, domen, HTTPS, iki şifrə açarı, `app_rw`, SMTP, STT açarı).
- Meta Business Verification, Meta App (Development rejimi, tester hesabları), real sınaq, App Review.
- Kataloq axınlarını canlı Meta və Telegram ilə yoxlamaq (Generic Template şərhə şəxsi cavab kimi, post aşkarlama, Telegram düymələri), sonra `META_COMMERCE_VERIFIED=on`.
- Hüquqi səhifələr: şirkət adı seçiləndən sonra.

## Sonraya
- Platforma admini üçün passkey (WebAuthn).
- TikTok (partnyor girişi lazımdır; kanal arxitekturası hazırdır).
- Birbaşa CRM inteqrasiyaları (indi webhook + Make/Zapier/n8n).
- Budaqlanan vizual ssenari redaktoru.
- Onlayn ödəniş (Payriff / Epoint), məhsul tanınandan sonra.
