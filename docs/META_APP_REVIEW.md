# Meta App Review: addım-addım

Bu sənəd sizin (app sahibinin) Meta Developer panelində etməli olduğunuz işlərdir. Kod bu icazələrdən **yalnız** aşağıdakı cədvəldə yazılanları istəyir.
İcazələrin və webhook sahələrinin dəqiq adlarını təqdimatdan əvvəl developers.facebook.com sənədlərində bir daha yoxlayın: Meta adları vaxtaşırı dəyişir, bu sənəd isə 2026-10 vəziyyətinə əsaslanır.

## 1. Hər trigger üçün nə lazımdır

| Funksiya | İcazə (Instagram API with Instagram Login) | Webhook sahəsi | Kodda status |
|---|---|---|---|
| DM-ə AI / açar söz cavabı | `instagram_business_basic`, `instagram_business_manage_messages` | `messages` | ✅ hazır |
| Quick reply düymələri, postback | eyni | `messages`, `messaging_postbacks` | ✅ hazır |
| Story reply / story mention | eyni (`message.reply_to.story`, `story_mention` attachment) | `messages` | ✅ hazır |
| Şərhə DM (private reply) + ictimai cavab | + `instagram_business_manage_comments` | `comments` | ✅ hazır (icazə yoxdursa trigger aktiv edilə bilmir) |
| Yeni izləyici (follow) trigger | — Meta ümumi istifadə üçün follow webhook-u vermir | — | ⛔ `unsupported` (aktivləşdirilə bilmir) |
| WhatsApp mesaj/açar söz/düymələr | `whatsapp_business_messaging`, `whatsapp_business_management` | `messages` | ✅ hazır |
| TikTok DM | TikTok Business Messaging API partnyor girişi | — | ⛔ yoxdur |

Panel hər kanal üçün bu statusu göstərir (`available` / `requires_approval` / `configuration_required` / `unsupported`). Kanalın token-ında icazə yoxdursa, avtomatlaşdırma **serverdə** aktivləşdirilmir.

## 2. Hazırlıq (təqdimatdan əvvəl)

1. **Business Verification** (Meta Business Suite → Security Center). Advanced Access üçün lazımdır.
2. App → Settings → Basic: Privacy Policy URL `https://DOMEN/privacy`, Terms `https://DOMEN/terms`, Data deletion `https://DOMEN/data-deletion` (səhifələr hazırdır, `LEGAL_*` dəyərlərini doldurun).
3. Instagram → API setup with Instagram Login:
   - Redirect URI: `https://DOMEN/oauth/instagram/callback`.
   - Webhook URL: `https://DOMEN/webhooks/instagram`, verify token = `META_WEBHOOK_VERIFY_TOKEN`.
   - Subscribe: `messages`, `messaging_postbacks`, `comments`.
4. WhatsApp: Embedded Signup konfiqurasiyası (`WA_EMBEDDED_SIGNUP_CONFIG_ID`), webhook `https://DOMEN/webhooks/whatsapp`, sahə `messages`.
5. Test üçün: app-ə **Instagram Tester** rolunda test hesabı əlavə edin. Bu hesab icazə almadan da işləyir və review videosunu çəkmək üçün lazımdır.

## 3. Hər icazə üçün təqdimat mətni (ingiliscə nümunə)

- **instagram_business_manage_messages**: "Businesses connect their Instagram professional account. Incoming DMs, story replies and quick-reply taps are shown in a shared inbox and answered by the business's staff or by an AI assistant that uses only the business's own product information. Replies are sent only within the 24-hour messaging window; customers can type STOP to opt out and can ask for a human at any time."
- **instagram_business_manage_comments**: "When a user comments a chosen keyword on the business's post, the app sends one private reply to that comment (within 7 days, once per comment) and optionally a short public reply. The business configures which posts and keywords trigger this; nothing is sent to users who did not comment."
- **instagram_business_basic**: "Used to show which Instagram account is connected (ID, username) and to receive webhooks for it."
- **whatsapp_business_messaging / management**: "Businesses connect their number via Embedded Signup; customer messages are answered within the customer service window by staff or by the business's assistant. No marketing templates are sent."

## 4. Screencast (hər icazə üçün ayrıca, ingiliscə subtitr)

1. Giriş → "Kanallar" → "Instagram bağla" → Instagram icazə ekranı (istənən icazələr görünsün) → bağlandı.
2. **messages**: test hesabından DM → paneldə "Söhbətlər" → AI cavabı → test telefonunda cavab görünür. "operator" yazmaq → söhbət operatora keçir, əməkdaş paneldən cavab yazır.
3. **story**: test hesabından story-yə reply → avtomatlaşdırma cavabı.
4. **comments**: "Avtomatlaşdırma" → "Şərhə DM" → post və açar söz seçimi → aktiv et → test hesabından şərh yazmaq → DM gəlir. Eyni şərhə ikinci DM getmədiyini göstərin.
5. STOP yazmaq → avtomatik mesajlar dayanır.
6. Kanalı ayırmaq və "Ayarlar → Hesabı sil" (məlumatların silinməsi).

## 5. Ümumi rədd səbəbləri və bizim cavabımız

| Səbəb | Bu kodda |
|---|---|
| 24 saatdan sonra mesaj | Göndərmə yalnız pəncərə daxilində; pəncərə bağlıdırsa, flow addımı `window_closed` ilə dayanır |
| İstifadəçi istəmədən mesaj | Yalnız istifadəçi yazanda / şərh yazanda; follow trigger yoxdur |
| İnsana keçid yoxdur | Açar sözlər, AI `request_human` aləti, operator təyini botu susdurur |
| Lazımsız icazə | Yalnız cədvəldəki icazələr istənir |
| Şifrə ilə giriş / scraping | Yoxdur: yalnız rəsmi OAuth və Graph API |
