/**
 * Конфигурация сайта.
 *
 * Файл подключается ПЕРВЫМ (до logic.js, sync.js и app.js), чтобы все модули
 * читали настройки из одного места. Значения ниже можно менять — правки
 * применятся после перезагрузки страницы.
 */
window.FT_CONFIG = window.FT_CONFIG || {};

/* --- Где хранятся общие данные турнира (репозиторий на GitHub) --- */
window.FT_CONFIG.github = Object.assign({
    // Владелец и имя репозитория, в котором лежит сайт
    owner: 'Footballorchestra',
    repo: 'Football-turnament',

    // Ветка и файл с данными
    branch: 'main',
    path: 'data.json',

    // Адреса API GitHub. Менять не нужно: они подставляются в запросы,
    // а в автотестах подменяются на локальный макет, чтобы не трогать реальный GitHub.
    apiBase: 'https://api.github.com',
    rawBase: 'https://raw.githubusercontent.com'
}, window.FT_CONFIG.github || {});

/* --- Автообновление данных у зрителей, миллисекунды (0 — выключено) ---
   Пока вкладка открыта, страница сама подтягивает свежую версию из репозитория:
   нажимать «Обновить данные» не нужно. Дополнительно данные обновляются сразу,
   когда посетитель возвращается во вкладку, и не тратятся запросы, пока вкладка
   скрыта. По умолчанию — одна минута: этого достаточно, чтобы результаты,
   опубликованные администратором, появились у всех сами. */
window.FT_CONFIG.refreshIntervalMs = window.FT_CONFIG.refreshIntervalMs === undefined
    ? 60000 // одна минута
    : window.FT_CONFIG.refreshIntervalMs;

/* --- Пауза перед авто-публикацией: несколько быстрых правок склеиваются в один коммит --- */
window.FT_CONFIG.autoPublishDelayMs = window.FT_CONFIG.autoPublishDelayMs === undefined
    ? 12000
    : window.FT_CONFIG.autoPublishDelayMs;

/* --- Фото игроков: подготовка в браузере и загрузка в репозиторий ---
   Значения читает assets/js/photo.js: фото сжимается до квадрата maxSize
   с качеством quality и кладётся файлом в папку folder репозитория. */
window.FT_CONFIG.photo = Object.assign({
    folder: 'assets/photos/',          // папка с фото в репозитории сайта
    maxSize: 512,                      // сторона квадрата, px
    quality: 0.82,                     // качество JPEG (0…1)
    maxSourceBytes: 15 * 1024 * 1024,  // исходный файл: до 15 МБ
    maxResultBytes: 400 * 1024,        // после сжатия: до 400 КБ

    // Паузы перед повторной загрузкой картинки, мс. Сайт (GitHub Pages) отдаёт
    // новый файл примерно через минуту после загрузки, а ответ 404 браузер
    // запоминает на 10 минут — поэтому фото догружаем сами.
    retryDelays: [4000, 15000, 45000]
}, window.FT_CONFIG.photo || {});

/* --- Ключи в localStorage --- */
window.FT_CONFIG.storageKeys = Object.assign({
    token: 'ft.githubToken',        // токен GitHub (только на устройстве администратора)
    autoPublish: 'ft.autoPublish',  // «публиковать автоматически»
    publishedAt: 'ft.publishedAt',  // метка последней успешной публикации
    localBackup: 'ft.localBackup',  // копия данных перед заменой версией из репозитория
    localEdits: 'ft.localEdits'     // отметка «на устройстве есть неопубликованные правки»
}, window.FT_CONFIG.storageKeys || {});
