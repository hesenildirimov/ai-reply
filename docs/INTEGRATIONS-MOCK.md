# Test (mock) rejimi və real inteqrasiyaya keçid

Instagram (Meta) və Telegram üçün iki provayder var. `INTEGRATION_MODE` hansının işləyəcəyini seçir.

| | `mock` | `production` (default) |
|---|---|---|
| Instagram | `MockInstagramProvider` | `MetaInstagramProvider` (mövcud Graph çağırışları) |
| Telegram | `MockTelegramProvider` | `TelegramBotProvider` (Bot API) |
| Nəticə statusu | `SIMULATED` | `DELIVERED` (provayder təsdiq edəndə) və ya `FAILED` |
| `NODE_ENV=production` ilə | **qadağandır** (server başlamır) | işləyir |

Kod: `src/integrations/` (`types.ts` interfeyslər, `index.ts` seçim, `ig.ts` bütün gedən Instagram çağırışlarının tək yeri, `events.ts` hadisə jurnalı).

## Mock rejimi nə edir, nə etmir

Mock yalnız şəbəkə kənarını əvəz edir. Qalan hər şey real koddur: webhook intake → worker → `processComment` / `replyLocked` → `deliver` → provayder. Buna görə testlər real biznes məntiqini yoxlayır.

- Mesaj göndərmək: `SIMULATED` qaytarır, heç nə göndərilmir. Mesaj bazada `status = 'simulated'` ilə saxlanır, inboxda `SIMULATED` yazısı görünür. "Çatdırıldı" kimi göstərilmir.
- `DELIVERED` mock rejimində mümkün deyil: hadisə jurnalında yazılmazdan əvvəl `SIMULATED`-ə çevrilir və bazanın `CHECK` məhdudiyyəti də buraxmır.
- Instagram postları `mock_ig_media` cədvəlindədir; Simulyator onları "dərc edir".
- Telegram mesajları və inline düymələr hadisə jurnalında saxlanır; Simulyator düyməyə basanda Telegram-ın `callback_query` formasında yeniləmə yaradıb real webhook-un çağırdığı `handleTelegramUpdate` funksiyasına verir.
- Mock rejimində `/webhooks/telegram` kənardan gələn sorğunu qəbul etmir.

## İşə salma

```bash
cp .env.example .env            # INTEGRATION_MODE=mock
npm run migrate
npm run seed:mock -- siz@example.com
npm run dev                     # və ayrı terminalda: npm run dev:worker
```

Panel → **Simulyator** (`/app/dev`):
1. Demo məlumatlar (bir biznes "Demo Butik", bir Instagram hesabı, 12 məhsul, 5 FAQ, 4 post: 1 məhsullu, 3 məhsullu, məhsulsuz, seçim gözləyən).
2. Telegram hesabını qoş (simulyasiya).
3. Post dərc et → "Yeni postları aşkar et": Telegram-da məhsul seçimi düymələri çıxır, paneldə "yeni post" bildirişi görünür.
4. Müştəri şərhi ("Qiymət?"): çox məhsullu postda kart karuseli, tək məhsullu postda birbaşa qiymət cavabı.
5. Kart düyməsinə bas: cavab bazadakı **cari** qiymətlə yazılır.

**Hadisələr** (`/app/activity`) bütün gedən-gələn hadisələri statusu ilə göstərir. **Postlar** və **Kataloq** səhifələrində məhsulları əl ilə də seçmək olur.

## Kataloq axını (AI çağırılmır)

- Post məhsulları: Telegram düymələri (`pt:` seç/çıxar, `pd:` yadda saxla, `pn:` məhsul yoxdur) və ya Postlar səhifəsi. Bir postda ən çox 10 məhsul (karusel limiti). Saxlanana qədər seçim qaralamadır, şərhlərə təsir etmir.
- Şərh, post və məhsul: yalnız məhsulları **yadda saxlanmış** postun altında, qiymət sualı olan şərh (qiymət, qiymət?, neçəyə, price, цена, ...) kataloqdan cavablanır. Başqa hallarda mövcud axınlar işləyir (açar söz avtomatlaşdırması qalib gəlir, sonra AI şərh cavabı).
- Kart düyməsinin payload-u `prod:<seq>`-dir. Məhsul həm nömrəsi, həm də söhbətin bizneslə oxunur: başqa biznesin nömrəsi heç nə tapmır.
- Cavab mətni `productAnswer` ilə hazırlanır (`src/commerce/catalog.ts`). Kataloq qiymətləri AI cavablarının qiymət yoxlamasında da "bilinən fakt" sayılır.
- Post aşkarlama: Instagram-da yeni post webhook-u yoxdur, ona görə worker hər 5 dəqiqə (`post_sweep`) kataloqu olan hesabların son postlarına baxır. İlk yoxlama yalnız mövcud postları qeyd edir (bildiriş göndərmir).

## İstehsal rejimi (`INTEGRATION_MODE=production`)

Lazım olan məlumatlar (heç biri kodda yoxdur və uydurulmur):

- Meta App ID, Meta App Secret (`META_APP_ID`, `META_APP_SECRET`), Instagram access token (Kanallar → Instagram bağlayın)
- Telegram bot token və webhook secret (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`, `TELEGRAM_WEBHOOK_SECRET`)

Mövcud funksiyalar (mətn DM, şərhə cavab, bildirişlər) əvvəlki kimi işləyir. Yeni kataloq axınları (post aşkarlama, kart karuseli, Telegram düymələri) mock-a qarşı yazılıb və canlı API ilə **hələ yoxlanılmayıb**. Ona görə `META_COMMERCE_VERIFIED=on` qoyulmayana qədər söndürülüdür. **Hadisələr** səhifəsi istehsal rejimində çatışmayan hər şeyi göstərir (`PRODUCTION MODE — hazır deyil`).

`META_COMMERCE_VERIFIED=on` qoymazdan əvvəl canlı hesabla yoxlayın:

1. Generic Template-in **şərhə şəxsi cavab** (`recipient.comment_id`) kimi qəbul olunması (Meta bunu bəzi hesablarda məhdudlaşdıra bilər; alınmasa əvvəlcə mətn + `quick_replies`-ə keçin).
2. Kart düymələrinin postback webhook-u (`messaging_postbacks` abunəliyi) ilə gəlməsi.
3. `/me/media` ilə yeni post aşkarlama və `instagram_business_basic` icazəsi.
4. Telegram `allowed_updates` içində `callback_query` (webhook yenidən qeydiyyat: server başlayanda avtomatik).
5. App Review üçün `docs/META_APP_REVIEW.md`-də kataloq axınını təsvir edin.

## Testlər

`test/commerce.test.ts` (mock), `test/commerce-production.test.ts` (real provayderlər, saxta Meta/Telegram serverinə qarşı), `test/commerce-gating.test.ts` (təsdiqlənməmiş istehsal, rejim qoruması), `test/tenant-isolation.test.ts` (yeni marşrutlar). Kataloq testləri AI və xarici (Meta, Telegram) zəng sayını da yoxlayır.
