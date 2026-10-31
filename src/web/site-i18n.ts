/**
 * Texts of the public website in three languages. First drafts: the business edits them here (one place per language).
 * Plan prices and limits are not here: they come from the plans table, the same numbers the admin panel uses.
 */
export const LANGS = ['az', 'ru', 'en'] as const;
export type Lang = (typeof LANGS)[number];

export interface SiteText {
  nav: { features: string; how: string; pricing: string; faq: string; login: string; demo: string; book: string };
  hero: { title: string; lead: string; book: string; demo: string; note: string };
  featuresTitle: string;
  features: [string, string][];
  howTitle: string;
  how: [string, string][];
  pricingTitle: string;
  pricingLead: string;
  perMonth: string;
  choose: string;
  unknownPlan: string;
  limits: { replies: string; channels: string; members: string; knowledge: string; automations: string; unlimited: string };
  onboarding: string;
  faqTitle: string;
  faq: [string, string][];
  ctaTitle: string;
  ctaLead: string;
  form: {
    title: string;
    lead: string;
    name: string;
    business: string;
    phone: string;
    email: string;
    instagram: string;
    industry: string;
    industries: Record<string, string>;
    volume: string;
    volumes: Record<string, string>;
    plan: string;
    intent: string;
    intents: { demo: string; call: string };
    time: string;
    timePlaceholder: string;
    message: string;
    consent: string;
    privacy: string;
    submit: string;
    invalid: string;
  };
  thanks: { title: string; lead: string; demo: string; home: string };
}

export const TEXT: Record<Lang, SiteText> = {
  az: {
    nav: { features: 'İmkanlar', how: 'Necə işləyir', pricing: 'Qiymətlər', faq: 'Suallar', login: 'Daxil ol', demo: 'Demoya bax', book: 'Görüş təyin et' },
    hero: {
      title: 'Instagram və WhatsApp mesajlarınıza AI cavab versin',
      lead: 'Müştəriləriniz gecə-gündüz saniyələr içində dəqiq cavab alır: qiymət, ölçü, çatdırılma, ünvan. AI bilmədiyini sizə ötürür, bütün yazışmalar bir paneldədir.',
      book: 'Pulsuz görüş təyin et',
      demo: 'Demoya bax →',
      note: '15 dəqiqəlik görüş · Kart tələb olunmur · Öhdəlik yoxdur',
    },
    featuresTitle: 'Satıcınız kimi cavab verir, yorulmur',
    features: [
      [
        'Sizin məlumatlarınızla',
        'Qiymət, məhsul, çatdırılma və qaydaları bir dəfə yazırsınız, faylla və ya saytınızdan yükləyirsiniz. AI yalnız bunlara əsasən cavab verir.',
      ],
      ['Uydurma qiymət yoxdur', 'Cavabda bazada olmayan qiymət və ya link varsa, göndərilmir: söhbət sizə ötürülür.'],
      ['Azərbaycan, rus, ingilis', 'Müştərinin dilində yazır. "skolko stoit" kimi latın hərfləri ilə yazılan rus dilini də başa düşür.'],
      ['Şəkil, səs və video', 'Müştəri məhsulun şəklini, səsli mesaj və ya video atanda AI onu başa düşüb cavab verir.'],
      ['Şərhlərə cavab', 'Postun altında "qiymət?" yazana DM-də cavab verir, şərhin altına qısa cavab qoyur. Şikayətləri sizə ötürür.'],
      ['Vahid panel və komanda', 'Instagram və WhatsApp yazışmaları bir yerdə. Əməkdaşlar istənilən söhbəti götürür, bot o vaxt susur.'],
    ],
    howTitle: 'Necə başlayırıq',
    how: [
      ['Görüş təyin edirsiniz', 'Formanı doldurursunuz, 24 saat ərzində sizinlə əlaqə saxlayırıq.'],
      ['15 dəqiqədə quraşdırırıq', 'Görüşdə sistemi göstəririk, hesabınızı açıb Instagram və WhatsApp-ı birlikdə bağlayırıq.'],
      ['Bot eyni gün işləyir', 'Biznes məlumatlarınızı əlavə edirik, ilk cavablara birlikdə baxırıq.'],
    ],
    pricingTitle: 'Qiymətlər',
    pricingLead: 'Aylıq ödəniş, istənilən vaxt dayandırmaq olar.',
    perMonth: '/ay',
    choose: 'Bu paketlə başla',
    unknownPlan: 'Hələ bilmirəm, görüşdə məsləhət verin',
    limits: {
      replies: 'AI cavabı ayda',
      channels: 'bağlı hesab',
      members: 'komanda üzvü',
      knowledge: 'MB bilik bazası',
      automations: 'aktiv avtomatlaşdırma',
      unlimited: 'limitsiz',
    },
    onboarding: 'Sınaq müddəti əvəzinə hazır quraşdırma veririk: görüşdə hər şeyi birlikdə qururuq, bot eyni gün işə düşür.',
    faqTitle: 'Tez-tez verilən suallar',
    faq: [
      [
        'AI səhv cavab versə nə olur?',
        'AI yalnız sizin yazdığınız məlumatlara əsasən cavab verir. Bilmədiyi sualı və ya bazada olmayan qiyməti yazmır, söhbəti sizə ötürür və bildiriş göndərir.',
      ],
      [
        'Müştəri botla danışdığını biləcək?',
        'AI təbii, sizin üslubunuzda yazır. İstəsəniz ilk cavabda özünü AI köməkçi kimi təqdim edir. Müştəri ciddi soruşsa, yalan danışmır.',
      ],
      ['Mən özüm də cavab yaza bilərəmmi?', 'Bəli. Paneldən istənilən söhbətə yazırsınız. Siz yazanda bot 1 saat susur, sonra lazım olsa yenidən qoşulur.'],
      [
        'Hansı hesablar lazımdır?',
        'Instagram peşəkar (Business və ya Creator) hesabı və ya WhatsApp Business nömrəsi. Bağlamaq bir neçə dəqiqə çəkir, görüşdə birlikdə edirik.',
      ],
      ['Məlumatlarım təhlükəsizdirmi?', 'Mesajlar şifrəli saxlanılır, hər biznes yalnız öz məlumatlarını görür. Hesabı silsəniz, bütün məlumatlar silinir.'],
      ['Limit bitsə nə olur?', 'Bot dayanır, gələn mesajlar itmir, siz əl ilə cavab verə bilirsiniz. Paketi istənilən vaxt dəyişmək olar.'],
    ],
    ctaTitle: 'Botunuzu bu həftə işə salaq',
    ctaLead: '15 dəqiqəlik görüşdə sistemi sizin biznesiniz üzərində göstərək.',
    form: {
      title: 'Görüş təyin edin',
      lead: 'Məlumatlarınızı yazın, 24 saat ərzində sizinlə əlaqə saxlayaq.',
      name: 'Adınız',
      business: 'Biznesin adı',
      phone: 'Telefon (WhatsApp)',
      email: 'E-poçt',
      instagram: 'Instagram səhifəsi',
      industry: 'Sahə',
      industries: {
        clothing: 'Geyim və aksesuar',
        beauty: 'Gözəllik və kosmetika',
        food: 'Restoran, kafe, yemək',
        services: 'Xidmətlər',
        education: 'Təhsil və kurslar',
        electronics: 'Elektronika',
        other: 'Digər',
      },
      volume: 'Ayda təxminən neçə mesaj gəlir?',
      volumes: { lt500: '500-dən az', '500_2000': '500 – 2 000', '2000_10000': '2 000 – 10 000', gt10000: '10 000-dən çox', unknown: 'Bilmirəm' },
      plan: 'Paket',
      intent: 'Nə istəyirsiniz?',
      intents: { demo: 'Demo görüşü (sistemi canlı göstərək)', call: 'Qiymət və qoşulma barədə zəng' },
      time: 'Sizə uyğun vaxt',
      timePlaceholder: 'məs. iş günləri 14:00-dan sonra',
      message: 'Əlavə qeyd',
      consent: 'Şəxsi məlumatlarımın bu müraciət üçün emalına razıyam',
      privacy: 'Məxfilik siyasəti',
      submit: 'Göndər',
      invalid: 'Zəhmət olmasa, işarələnmiş sahələri yoxlayın.',
    },
    thanks: {
      title: 'Təşəkkürlər!',
      lead: 'Müraciətiniz qəbul edildi. 24 saat ərzində sizinlə əlaqə saxlayacağıq.',
      demo: 'Gözləyərkən demoya baxın',
      home: 'Ana səhifə',
    },
  },
  ru: {
    nav: {
      features: 'Возможности',
      how: 'Как это работает',
      pricing: 'Цены',
      faq: 'Вопросы',
      login: 'Войти',
      demo: 'Посмотреть демо',
      book: 'Записаться на встречу',
    },
    hero: {
      title: 'ИИ отвечает на сообщения в Instagram и WhatsApp',
      lead: 'Клиенты круглосуточно получают точный ответ за секунды: цена, размер, доставка, адрес. Чего ИИ не знает, он передаёт вам, а вся переписка в одной панели.',
      book: 'Записаться на бесплатную встречу',
      demo: 'Посмотреть демо →',
      note: 'Встреча 15 минут · Без карты · Без обязательств',
    },
    featuresTitle: 'Отвечает как ваш продавец и не устаёт',
    features: [
      ['На основе ваших данных', 'Цены, товары, доставку и правила вы указываете один раз, из файла или с вашего сайта. ИИ отвечает только на их основе.'],
      ['Никаких выдуманных цен', 'Если в ответе цена или ссылка, которых нет в базе, он не отправляется: переписка переходит к вам.'],
      ['Азербайджанский, русский, английский', 'Пишет на языке клиента. Понимает и русский, набранный латиницей, например «skolko stoit».'],
      ['Фото, голос и видео', 'Когда клиент присылает фото товара, голосовое или видео, ИИ понимает его и отвечает.'],
      ['Ответы на комментарии', 'На «цена?» под постом отвечает в директ и оставляет короткий ответ под комментарием. Жалобы передаёт вам.'],
      ['Единая панель и команда', 'Переписка из Instagram и WhatsApp в одном месте. Сотрудник берёт любой диалог, бот в это время молчит.'],
    ],
    howTitle: 'Как мы начинаем',
    how: [
      ['Вы записываетесь на встречу', 'Заполняете форму, мы связываемся с вами в течение 24 часов.'],
      ['Настраиваем за 15 минут', 'На встрече показываем систему, открываем аккаунт и вместе подключаем Instagram и WhatsApp.'],
      ['Бот работает в тот же день', 'Добавляем данные о вашем бизнесе и вместе смотрим первые ответы.'],
    ],
    pricingTitle: 'Цены',
    pricingLead: 'Ежемесячная оплата, отменить можно в любой момент.',
    perMonth: '/мес',
    choose: 'Начать с этим тарифом',
    unknownPlan: 'Пока не знаю, посоветуйте на встрече',
    limits: {
      replies: 'ответов ИИ в месяц',
      channels: 'подключённых аккаунта',
      members: 'сотрудников',
      knowledge: 'МБ базы знаний',
      automations: 'активных автоматизаций',
      unlimited: 'без ограничений',
    },
    onboarding: 'Вместо пробного периода — готовая настройка: на встрече всё настраиваем вместе, бот запускается в тот же день.',
    faqTitle: 'Частые вопросы',
    faq: [
      [
        'Что если ИИ ответит неправильно?',
        'ИИ отвечает только на основе ваших данных. Если не знает ответа или цены нет в базе, он не придумывает, а передаёт диалог вам и присылает уведомление.',
      ],
      [
        'Клиент поймёт, что говорит с ботом?',
        'ИИ пишет естественно, в вашем стиле. По желанию в первом ответе представляется ИИ-ассистентом. На прямой вопрос не обманывает.',
      ],
      ['Могу ли я отвечать сам?', 'Да, в любой диалог из панели. Когда вы пишете, бот молчит час, затем при необходимости снова подключается.'],
      [
        'Какие аккаунты нужны?',
        'Профессиональный аккаунт Instagram (Business или Creator) или номер WhatsApp Business. Подключение занимает несколько минут, делаем вместе на встрече.',
      ],
      ['Мои данные в безопасности?', 'Сообщения хранятся в зашифрованном виде, каждый бизнес видит только свои данные. При удалении аккаунта удаляется всё.'],
      [
        'Что будет, если лимит закончится?',
        'Бот остановится, но входящие сообщения не потеряются, вы сможете отвечать вручную. Тариф можно сменить в любой момент.',
      ],
    ],
    ctaTitle: 'Запустим вашего бота на этой неделе',
    ctaLead: 'За 15 минут покажем систему на примере вашего бизнеса.',
    form: {
      title: 'Запись на встречу',
      lead: 'Оставьте данные, мы свяжемся с вами в течение 24 часов.',
      name: 'Ваше имя',
      business: 'Название бизнеса',
      phone: 'Телефон (WhatsApp)',
      email: 'Эл. почта',
      instagram: 'Страница в Instagram',
      industry: 'Сфера',
      industries: {
        clothing: 'Одежда и аксессуары',
        beauty: 'Красота и косметика',
        food: 'Ресторан, кафе, еда',
        services: 'Услуги',
        education: 'Образование и курсы',
        electronics: 'Электроника',
        other: 'Другое',
      },
      volume: 'Сколько сообщений примерно приходит в месяц?',
      volumes: { lt500: 'Меньше 500', '500_2000': '500 – 2 000', '2000_10000': '2 000 – 10 000', gt10000: 'Больше 10 000', unknown: 'Не знаю' },
      plan: 'Тариф',
      intent: 'Что вам удобнее?',
      intents: { demo: 'Демо-встреча (покажем систему вживую)', call: 'Звонок о ценах и подключении' },
      time: 'Удобное время',
      timePlaceholder: 'напр. в будни после 14:00',
      message: 'Комментарий',
      consent: 'Я согласен(на) на обработку моих данных для этой заявки',
      privacy: 'Политика конфиденциальности',
      submit: 'Отправить',
      invalid: 'Пожалуйста, проверьте отмеченные поля.',
    },
    thanks: { title: 'Спасибо!', lead: 'Заявка принята. Мы свяжемся с вами в течение 24 часов.', demo: 'Пока ждёте, посмотрите демо', home: 'На главную' },
  },
  en: {
    nav: { features: 'Features', how: 'How it works', pricing: 'Pricing', faq: 'FAQ', login: 'Log in', demo: 'See the demo', book: 'Book a meeting' },
    hero: {
      title: 'Let AI answer your Instagram and WhatsApp messages',
      lead: 'Customers get a precise answer in seconds, day and night: price, size, delivery, address. Whatever the AI does not know goes to you, and every conversation is in one inbox.',
      book: 'Book a free meeting',
      demo: 'See the demo →',
      note: '15-minute meeting · No card needed · No commitment',
    },
    featuresTitle: 'Answers like your best sales assistant, never gets tired',
    features: [
      [
        'Built on your information',
        'Enter prices, products, delivery and policies once, or import them from a file or your website. The AI answers from that only.',
      ],
      ['No made-up prices', 'A reply with a price or link that is not in your information is never sent: the conversation comes to you instead.'],
      ['Azerbaijani, Russian, English', 'Writes in the customer’s language, and understands Russian typed in Latin letters too.'],
      ['Photos, voice and video', 'When a customer sends a product photo, a voice note or a video, the AI understands it and answers.'],
      ['Replies to comments', 'Answers “price?” under a post in DM and leaves a short public reply. Complaints go to you.'],
      ['One inbox for the team', 'Instagram and WhatsApp in one place. Staff can take over any conversation; the bot steps back meanwhile.'],
    ],
    howTitle: 'How we get you started',
    how: [
      ['You book a meeting', 'Fill in the form; we get back to you within 24 hours.'],
      ['We set it up in 15 minutes', 'We show you the system, open your account and connect Instagram and WhatsApp together.'],
      ['Your bot works the same day', 'We add your business information and review the first answers together.'],
    ],
    pricingTitle: 'Pricing',
    pricingLead: 'Monthly plans, cancel any time.',
    perMonth: '/mo',
    choose: 'Start with this plan',
    unknownPlan: 'Not sure yet, advise me in the meeting',
    limits: {
      replies: 'AI replies per month',
      channels: 'connected accounts',
      members: 'team members',
      knowledge: 'MB knowledge base',
      automations: 'active automations',
      unlimited: 'unlimited',
    },
    onboarding: 'Instead of a trial we set everything up with you in the meeting, so your bot goes live the same day.',
    faqTitle: 'Frequently asked questions',
    faq: [
      [
        'What if the AI gets it wrong?',
        'The AI answers only from your information. When it does not know, or a price is not in your information, it does not guess: it hands the conversation to you and notifies you.',
      ],
      [
        'Will customers know it is a bot?',
        'It writes naturally, in your style. If you want, it introduces itself as an AI assistant in its first reply, and it never denies being one when asked.',
      ],
      ['Can I still answer myself?', 'Yes, in any conversation from the inbox. When you write, the bot stays quiet for an hour, then joins again if needed.'],
      [
        'Which accounts do I need?',
        'An Instagram professional account (Business or Creator) or a WhatsApp Business number. Connecting takes minutes; we do it together in the meeting.',
      ],
      ['Is my data safe?', 'Messages are stored encrypted and every business sees only its own data. Deleting your account deletes everything.'],
      ['What happens when I reach my limit?', 'The bot pauses, incoming messages are kept and you can answer by hand. You can change plans at any time.'],
    ],
    ctaTitle: 'Let’s launch your bot this week',
    ctaLead: 'In 15 minutes we show you the system on your own business.',
    form: {
      title: 'Book a meeting',
      lead: 'Leave your details and we will contact you within 24 hours.',
      name: 'Your name',
      business: 'Business name',
      phone: 'Phone (WhatsApp)',
      email: 'Email',
      instagram: 'Instagram page',
      industry: 'Industry',
      industries: {
        clothing: 'Clothing and accessories',
        beauty: 'Beauty and cosmetics',
        food: 'Restaurant, café, food',
        services: 'Services',
        education: 'Education and courses',
        electronics: 'Electronics',
        other: 'Other',
      },
      volume: 'About how many messages a month?',
      volumes: { lt500: 'Under 500', '500_2000': '500 – 2,000', '2000_10000': '2,000 – 10,000', gt10000: 'Over 10,000', unknown: 'Not sure' },
      plan: 'Plan',
      intent: 'What would you like?',
      intents: { demo: 'Demo meeting (we show the system live)', call: 'A call about prices and setup' },
      time: 'Best time for you',
      timePlaceholder: 'e.g. weekdays after 2 pm',
      message: 'Anything else',
      consent: 'I agree to my details being processed for this request',
      privacy: 'Privacy Policy',
      submit: 'Send',
      invalid: 'Please check the highlighted fields.',
    },
    thanks: { title: 'Thank you!', lead: 'We got your request and will contact you within 24 hours.', demo: 'See the demo while you wait', home: 'Home' },
  },
};
