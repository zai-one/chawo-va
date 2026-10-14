# Chawo VA: конкуренты и чего у нас нет

Дата: 2026-10-13. Только исследование, кода нет. Факты взяты с сайтов и README продуктов (ссылки ниже). Где написано **(не проверено)**, это из обзоров или выдачи поиска, первоисточник я не открывал. Цены могут меняться.

Что уже есть у нас (README + `ts/IDEAS.md`): локальная диктовка и расшифровка файлов (GigaAM ONNX) с упором на русский, удержание клавиши + вставка с возвратом буфера, плашка, Мозг (локальный llama/Qwen или облако, совместимое с OpenAI), команды «Чаво, …», команды над выделенным текстом, режимы по программам, перевод, голосовая пунктуация и числа, словарь, история с поиском, VAD, звуковые сигналы, запись встреч (микрофон + системный звук), диаризация, расшифровка по ссылке (yt-dlp), экспорт txt/srt/vtt/json/md/docx, карточка «Кратко и задачи», свой скрипт пост-обработки, слово-активатор, редактор транскрипта, выгрузка моделей при простое, ассистент продаж (каталог, RAG-папка), сеть хост/клиент, CLI, Linux-сервер с API, сниппеты («вставь …»), шаблоны карточки после встречи, статистика разговора, вопросы к истории и встречам («Спросить историю»).

## Конкуренты

| Продукт | Тип | Платформы | Модель цены | Локально / облако |
|---|---|---|---|---|
| [Superwhisper](https://superwhisper.com/docs/billing/plans) | диктовка + AI-режимы | macOS, Windows, iOS, Android | Free; Pro $8.49/мес, $84.99/год, $249.99 навсегда | локальный Whisper/Parakeet; облачные модели и LLM через их прокси |
| [Wispr Flow](https://wisprflow.ai/pricing) | диктовка + Notetaker | macOS, Windows, iOS, Android | Free 2000 слов/нед; Pro $15/мес; Growth/Enterprise | облако |
| [MacWhisper](https://goodsnooze.gumroad.com/l/macwhisper) | расшифровка файлов + диктовка | macOS | Free + разовая Pro-лицензия | локально, облако по желанию |
| [Aqua Voice](https://aquavoice.com) | диктовка | macOS, Windows, iPhone (не проверено) | подписка (не проверено) | облако (не проверено) |
| [Otter.ai](https://otter.ai) | бот для встреч / заметки | веб, iOS, Android | Free; Pro ~$8.33/мес при оплате за год (не проверено) | облако |
| [Fireflies.ai](https://fireflies.ai) | бот для встреч, продажи | веб, моб. | Free; Business ~$19/место (не проверено) | облако |
| [tl;dv](https://tldv.io) | запись встреч, коучинг продаж | веб, расширение | Pro ~$18, Business ~$59 (не проверено) | облако |
| [Granola](https://www.granola.ai/pricing) | заметки встреч без бота | macOS, Windows, iOS, Android | Basic бесплатно (30 дней истории); Business $14; Enterprise от $35 | облако (звук с устройства) |
| [Krisp](https://krisp.ai/pricing/) | шумоподавление + заметки встреч | macOS, Windows | Core $16, Advanced $30 в мес. | шумоподавление на устройстве; заметки в облаке |
| [Dragon Professional](https://dragon.nuance.com/en-us/dragon-professional) | классическая диктовка + управление голосом | Windows | разово ~$699 (не проверено) | локально |
| [Яндекс SpeechKit](https://yandex.cloud/ru/services/speechkit) / [SpeechSense](https://yandex.cloud/ru/docs/stackland/concepts/components/speechsense) | API речи / речевая аналитика | облако, on-prem (Stackland) | поминутно | облако / on-prem |
| [Телемост: конспекты Алисы](https://yandex.ru/support/yandex-360/business/telemost/web/ru/call/summary) | конспекты встреч | веб/Телемост | корпоративные тарифы Яндекс 360 | облако |
| [SaluteSpeech](https://developers.sber.ru/help/salutespeech/faq) | API распознавания/синтеза | облако, on-prem | физлицам 100 мин/мес бесплатно; юрлицам 0,01 ₽/с, минимум 15 000 ₽/мес | облако / on-prem |
| [T-Bank VoiceKit](https://www.tbank.ru/software/voicekit/) | API распознавания/синтеза | облако | по договору | облако |
| Стенографист / Voice2Text / сервисы «Расшифровка» (Войси, MyMeet, MeetScribe) | расшифровка онлайн | веб | поминутно / подписка (не проверено) | облако |
| [Gong](https://www.gong.io/conversation-intelligence) | conversation intelligence | веб | enterprise, по запросу | облако |
| Chorus (ZoomInfo) | conversation intelligence | веб | enterprise (не проверено) | облако |
| [MANGO OFFICE речевая аналитика](https://www.mango-office.ru/products/virtualnaya_ats/vozmozhnosti/speech-analytics/) | аналитика звонков в АТС | веб | доп. услуга к АТС | облако |
| Скайлаб речевая аналитика | аналитика звонков | веб | подписка (не проверено) | облако |
| [Calltouch](https://www.calltouch.ru) | коллтрекинг + AI-оценка звонков | веб | подписка | облако |
| [Handy](https://github.com/cjpais/Handy) | OSS диктовка | Win/macOS/Linux | MIT, бесплатно | локально |
| [OpenWhispr](https://github.com/OpenWhispr/openwhispr) | OSS диктовка + встречи | Win/macOS/Linux | MIT | локально + BYOK облако |
| [Vibe](https://github.com/thewh1teagle/vibe) | OSS расшифровка файлов | Win/macOS/Linux | MIT | локально |
| [Buzz](https://github.com/chidiwilliams/buzz) | OSS расшифровка файлов | Win/macOS/Linux | MIT | локально |
| [VoiceInk](https://github.com/Beingpax/VoiceInk) | OSS диктовка | macOS | GPL-3.0 (бинарник платный) | локально |
| [Whispering (Epicenter)](https://github.com/EpicenterHQ/epicenter) | OSS диктовка | Win/macOS/Linux | open source | локально / BYOK |
| [Meetily](https://github.com/Zackriya-Solutions/meetily) | OSS заметки встреч | macOS, Windows | MIT; Pro платный | локально |
| [Hyprnote → Anarlog](https://github.com/fastrepl/hyprnote) | OSS заметки встреч | macOS (не проверено) | MIT | local-first, BYOK/локальный LLM |

## Чего у нас нет

Обозначения: 👤 пользователи диктовки, 💼 менеджеры по продажам. Приватность: ✅ можно полностью локально, ⚠️ локально, но с оговорками, ❌ нужно облако/сеть. Трудоёмкость: S/M/L. ⭐ = топ-10.

| # | Функция | У кого есть | Польза | Приватность | Трудоёмкость |
|---|---|---|---|---|---|
| 1 ⭐ ✅ | **Сниппеты: голосовые сокращения.** Говоришь «моя подпись», «реквизиты», «ссылка на календарь», вставляется готовый текст (сделано 2026-10-14, `ts/feat-snippets`) | [Wispr Flow](https://wisprflow.ai/features) (snippets, общие для команды), [Dragon](https://dragon.nuance.com/en-us/dragon-professional) (Auto-Texts) | 👤 подписи, адреса; 💼 типовые ответы, КП-абзацы, реквизиты | ✅ | S |
| 2 ⭐ | **Словарь пополняется сам из исправлений** (поправил слово после вставки, оно попало в словарь) | [Wispr Flow](https://wisprflow.ai/features) | 👤 имена и жаргон без ручной настройки; 💼 названия клиентов и товаров | ✅ (сравнивать вставленное с тем, что стало в поле) | M |
| 3 ⭐ | **Контекст для Мозга: буфер, программа, текст на экране** (не только выделенный текст) | [Superwhisper](https://superwhisper.com/docs/modes/modes) (Application / Copied text / Selected text), Aqua Voice (screen-aware, не проверено) | 👤 ответ на письмо, которое открыто; 💼 ответ клиенту с учётом переписки | ✅ при локальном Мозге; для облака спрашивать | M |
| 4 ⭐ ✅ | **Шаблоны/«рецепты» для карточки после встречи** (разбор звонка продаж, протокол, краткое резюме + свои) с выбором шаблона (сделано 2026-10-14, `ts/feat-templates`) | [Granola](https://www.granola.ai/pricing) (templates, Recipes), [Meetily](https://github.com/Zackriya-Solutions/meetily) (Pro templates), [Superwhisper](https://superwhisper.com/docs/modes/built-in) (Meeting mode) | 💼 единый формат отчёта по каждому звонку | ✅ | S |
| 5 ⭐ ✅ | **Вопросы к встречам и истории («что обещали клиенту Х?»)**: чат по одной или многим расшифровкам (сделано 2026-10-14, `ts/feat-ask-history`) | [Granola](https://www.granola.ai/pricing) (chat across meetings), Fireflies AskFred, Otter AI Chat (не проверено), [Wispr Notetaker](https://wisprflow.ai/) | 💼 подготовка к следующему звонку; 👤 поиск по смыслу | ✅ (локальный Мозг + та же RAG, что в ассистенте продаж) | M |
| 6 ⭐ | **Проверка звонка по чек-листу/скрипту** (поздоровался, выявил потребность, назвал цену, договорился о шаге) с баллами | [MANGO OFFICE](https://docs.mango-office.ru/ru/3_produkty-i-prilozheniya/8_rechevaya-analitika-i-skoring/4_ra-skoring/4_otchety_i_analitika/1_4_rabota_s_chek_listami/4_4_1_konstruktor_chek_listov_dlya_otsenki_zvonkov.html), [Yandex SpeechSense](https://yandex.cloud/ru/blog/posts/2023/09/yandex-speechsense), Calltouch, Скайлаб (не проверено) | 💼 самоконтроль менеджера и РОПа без облака | ✅ | M |
| 7 ⭐ ✅ | **Статистика разговора: доля речи (talk ratio), монологи, трекеры ключевых слов** (конкуренты, «дорого», «скидка») (сделано 2026-10-14, `ts/feat-call-stats`) | [Gong](https://help.gong.io/v1/docs/analyze-team-performance) (talk ratio, trackers), Chorus (не проверено) | 💼 коучинг: Gong приводит 43:57 как лучшее соотношение в B2B | ✅ (уже есть диаризация и таймкоды) | S |
| 8 ⭐ | **Выгрузка в CRM** (заметка/задача в amoCRM, Bitrix24, HubSpot) после встречи | [Gong](https://help.gong.io/docs/crm-integrations), Fireflies (не проверено), [Granola](https://www.granola.ai/pricing) (HubSpot, Attio, Notion, Zapier), tl;dv (не проверено) | 💼 не переписывать итоги руками | ⚠️ уходит только итог и только по кнопке; локальный вебхук/скрипт как вариант | M |
| 9 ⭐ | **MCP-сервер для расшифровок и истории**, чтобы Claude/ChatGPT/IDE могли читать заметки | [Wispr Flow](https://wisprflow.ai/pricing), [Granola](https://www.granola.ai/pricing), [Hyprnote/Anarlog](https://github.com/fastrepl/hyprnote) (CLI/MCP), Meetily Pro | 👤💼 использовать встречи в других AI-инструментах | ✅ (локальный stdio-сервер; облачный клиент решает пользователь) | M |
| 10 ⭐ | **Автоопределение встречи** (Zoom/Teams/Телемост захватил микрофон или событие в календаре): предложить «Записать?» | [Granola](https://www.granola.ai/) (календарь, авто-обнаружение встреч), Wispr Notetaker (календарь, не проверено) | 💼 не забыть записать звонок | ✅ (проверка, кто занял микрофон; локальный .ics) | M |
| 11 | Стили/тон по программе (официально ↔ неформально), ползунок | [Superwhisper](https://superwhisper.com/docs/modes/modes) (Tone slider), [Wispr Flow](https://wisprflow.ai/features) (Styles) | 👤 | ✅ | S (поверх режимов по программам) |
| 12 | Расшифровка в реальном времени во время встречи (текст идёт по ходу) | [Superwhisper](https://superwhisper.com/docs/billing/plans) (Realtime), Otter (live, не проверено) | 💼 подсказки по ходу звонка | ✅ | L |
| 13 | Подсказки менеджеру по ходу звонка (возражение → ответ из каталога/RAG) | Gong (real-time signals, [сайт](https://www.gong.io/conversation-intelligence)) | 💼 | ✅ | L (нужен п.12) |
| 14 | Бриф перед встречей (кто участники, о чём говорили в прошлый раз) | [Granola](https://www.granola.ai/), [Gong](https://help.gong.io/docs/understanding-deal-boards) (Briefs) | 💼 | ✅ (по локальной истории) | M |
| 15 | Тональность/эмоции клиента | [SaluteSpeech](https://developers.sber.ru/help/salutespeech/faq) (эмоции, не проверено), [SpeechSense](https://yandex.cloud/ru/blog/posts/2023/09/yandex-speechsense), Gong | 💼 | ✅ через Мозг (качество ⚠️) | M |
| 16 | Шумоподавление микрофона для звонков (виртуальный микрофон) | [Krisp](https://krisp.ai/) | 👤💼 | ✅ | L |
| 17 | Пользовательские голосовые команды/макросы (нажать клавиши, открыть программу) | [Dragon](https://dragon.nuance.com/en-us/dragon-professional) (custom commands, macros) | 👤 | ✅ | M |
| 18 | Мобильное приложение / синхронизация между устройствами | Wispr Flow, Superwhisper, Granola, Otter | 👤💼 диктофон на встрече офлайн | ⚠️ (синхронизация через свой хост) | L |
| 19 | Общие для команды словарь и сниппеты | [Wispr Flow](https://wisprflow.ai/pricing) (shared dictionary and snippets) | 💼 отдел продаж | ✅ через наш хост | M (после п.1) |
| 20 | Видеоклипы/хайлайты встречи для отправки | tl;dv (не проверено) | 💼 | ✅ | L |
| 21 | Экспорт PDF/HTML | [Vibe](https://github.com/thewh1teagle/vibe), Meetily Pro (PDF) | 👤 | ✅ | S |
| 22 | Сводки по многим звонкам (отчёт за неделю, частые возражения) | tl;dv (multi-meeting reports, не проверено), [Gong](https://help.gong.io/docs/understanding-deals) (win/loss) | 💼 РОП | ✅ | M |
| 23 | Захват слайдов с экрана во время встречи | Otter (не проверено) | 💼 | ✅ | L |
| 24 | Корпоративное: SSO, политики хранения, журнал аудита | Wispr Flow Growth/Enterprise, Granola Enterprise | 💼 крупные клиенты | ✅ (для хоста) | L |

## Топ-10 рекомендаций (по порядку)

1. ✅ Сниппеты (S): Wispr Flow, Dragon. — сделано 2026-10-14 (`ts/feat-snippets`).
2. ✅ Шаблоны карточки после встречи (S): Granola, Meetily, Superwhisper. — сделано 2026-10-14 (`ts/feat-templates`).
3. ✅ Статистика разговора и трекеры слов (S): Gong. — сделано 2026-10-14 (`ts/feat-call-stats`).
4. Словарь из исправлений (M): Wispr Flow.
5. Контекст для Мозга: буфер и программа (M): Superwhisper, Aqua.
6. Проверка звонка по чек-листу (M): MANGO, SpeechSense, Calltouch.
7. ✅ Вопросы ко всем встречам (M): Granola, Fireflies, Otter, Wispr. — сделано 2026-10-14 (`ts/feat-ask-history`).
8. Автоопределение встречи (M): Granola.
9. Выгрузка в CRM (M): Gong, Granola, Fireflies.
10. MCP-сервер (M): Wispr Flow, Granola, Anarlog.

Все десять работают без облака или отправляют данные только по явной кнопке. Это наш главный плюс перед Gong, Fireflies и Otter: у них запись по умолчанию идёт в облако.
