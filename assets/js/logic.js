/**
 * Чистая логика турнира — без DOM.
 *
 * Модуль используется двумя потребителями:
 *   1) браузером (подключается обычным <script>, доступ через window.FTLogic);
 *   2) юнит-тестами Node.js (tests/logic.test.js, через module.exports).
 *
 * Здесь собраны расчёт турнирной таблицы, валидация ввода, работа с датами,
 * нормализация данных и чтение/запись в localStorage.
 */
(function (root, factory) {
    'use strict';

    var api = factory();

    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }

    if (root) {
        root.FTLogic = api;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    /**
     * Общая среда: в браузере — окно, в тестах Node.js — globalThis.
     * Отсюда читаются настройки сайта (FT_CONFIG из assets/js/config.js).
     */
    var ENV = typeof globalThis !== 'undefined' ? globalThis : {};

    /** Настройки приложения. */
    var CONFIG = {
        storageKey: 'footballTournamentData',
        sessionKey: 'footballTournamentAdmin',
        // 3 — в матчах появились события (голы и голевые передачи игроков)
        // 4 — вместо голевых передач отмечаются жёлтые и красные карточки
        // 5 — у игроков появились фото (карта photos с путями к файлам репозитория)
        // 6 — у команд появились эмблемы (карта teamPhotos)
        // 7 — у игроков появились дата рождения и принадлежность (карта playerInfo)
        // 8 — у команд появились фотографии: галерея на странице команды (карта teamImages)
        // 9 — у игроков появился игровой номер (поле number в карточке playerInfo)
        // 10 — появились правила дисциплины (блок settings): жёлтые карточки
        //      превращаются в красную, игрок пропускает следующий матч команды
        // 11 — из карточек игроков убрана дата рождения (лишние персональные данные):
        //      в данных остались игровой номер и принадлежность. Прежнее поле
        //      birthDate отбрасывается при загрузке данных.
        // 12 — появился выбор оформления сайта (settings.theme): администратор
        //      включает второй стиль «Афиша матча» одной кнопкой в панели.
        dataVersion: 12,
        // Пароль администратора в репозитории не хранится. В коде лежит только
        // солёный отпечаток пароля — он читается из настроек сайта
        // (FT_CONFIG.admin в assets/js/config.js), а сверку делает
        // adminPasswordMatches ниже. Подробности — в README.
        maxTeamNameLength: 30,
        maxPlayerNameLength: 40,
        // Игровой номер: целое число от 0 до этого значения
        maxPlayerNumber: 99,
        // Принадлежность игрока — свободный текст (школа, клуб, тренер):
        // примерно 3–4 коротких предложения
        maxPlayerNoteLength: 200,
        maxScore: 99,
        recentMatches: 3,
        // Фото игроков лежат файлами в репозитории сайта, а в данных хранится путь
        photoPathPrefix: 'assets/photos/',
        maxPhotoPathLength: 120,
        // Сколько фотографий можно добавить одной команде (галерея на её странице)
        maxTeamImages: 6,
        // Дисциплина игроков: пределы настроек из админки
        maxYellowLimit: 12,
        maxYellowPeriodDays: 3650
    };

    /** Палитра бейджей команд (классы описаны в src/input.css). */
    var BADGE_COLORS = [
        'badge-color-1', 'badge-color-2', 'badge-color-3', 'badge-color-4',
        'badge-color-5', 'badge-color-6', 'badge-color-7', 'badge-color-8'
    ];

    /**
     * Правила дисциплины по умолчанию: 4-я жёлтая карточка за турнир превращается
     * в красную, игрок пропускает следующий матч своей команды.
     * yellowPeriodDays = 0 — жёлтые считаются за весь турнир (без срока давности).
     */
    var DEFAULT_DISCIPLINE = { yellowLimit: 4, yellowPeriodDays: 0 };

    /**
     * Оформление сайта (settings.theme):
     *   • classic — обычный стиль, включён по умолчанию;
     *   • afisha — второй стиль «Афиша матча» (файл assets/css/theme-afisha.css).
     * Стиль выбирает администратор в панели, значение хранится вместе с данными
     * турнира, поэтому его видят все зрители. Неизвестное значение — это classic:
     * испорченные настройки не должны ломать вид страницы.
     */
    var THEMES = {
        classic: 'Классическое',
        afisha: 'Афиша матча'
    };
    var DEFAULT_THEME = 'classic';

    /** Демонстрационный набор данных (первый запуск и сброс). */
    function createDefaultData() {
        // Даты демонстрационных матчей считаем от сегодняшнего дня: свежая установка
        // сразу показывает живое расписание («матч через 3 дня»), а не даты из прошлого.
        var dayFromToday = function (offset) {
            var date = new Date();

            date.setDate(date.getDate() + offset);

            return toISODate(date);
        };

        return {
            version: CONFIG.dataVersion,
            revision: 1,
            updatedAt: new Date().toISOString(),
            photos: {},
            teamPhotos: {},
            // Фотографии команд (галереи): «id команды» → список путей к файлам
            teamImages: {},
            // Данные игроков: игровой номер и принадлежность.
            // Ключ — «команда|имя в нижнем регистре» (тот же, что и у фото)
            playerInfo: {
                '1|иванов а.': {
                    number: 10,
                    note: 'Школа №5, первый тренер — Петров И. До 2023 года играл за «Динамо».'
                }
            },
            // Правила дисциплины: сколько жёлтых карточек приводит к красной
            // и за какой период они считаются (0 — весь турнир).
            // theme — оформление сайта («Афиша матча» включает администратор).
            settings: {
                yellowLimit: DEFAULT_DISCIPLINE.yellowLimit,
                yellowPeriodDays: DEFAULT_DISCIPLINE.yellowPeriodDays,
                theme: DEFAULT_THEME
            },
            teams: [
                { id: 1, name: 'Спартак', players: ['Иванов А.', 'Петров П.', 'Сидоров С.'] },
                { id: 2, name: 'Локомотив', players: ['Кузнецов К.', 'Попов П.'] },
                { id: 3, name: 'Динамо', players: ['Смирнов Д.', 'Волков В.'] },
                { id: 4, name: 'ЦСКА', players: ['Михайлов М.', 'Новиков Н.'] }
            ],
            matches: [
                { id: 1, teamA: 1, teamB: 2, scoreA: 2, scoreB: 1, date: dayFromToday(-7), time: '19:30', finished: true },
                { id: 2, teamA: 3, teamB: 4, scoreA: 1, scoreB: 1, date: dayFromToday(-6), finished: true },
                { id: 3, teamA: 1, teamB: 3, scoreA: null, scoreB: null, date: dayFromToday(3), time: '19:30', finished: false },
                { id: 4, teamA: 2, teamB: 4, scoreA: null, scoreB: null, date: dayFromToday(4), finished: false }
            ]
        };
    }

    /* ------------------------------------------------------------------ */
    /* Общие утилиты                                                       */
    /* ------------------------------------------------------------------ */

    /**
     * Экранирование пользовательского текста перед вставкой через innerHTML.
     * Защищает от «сломанной» вёрстки и XSS при вводе имён команд и игроков.
     */
    function escapeHtml(value) {
        if (value === null || value === undefined) {
            return '';
        }

        return String(value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function isPlainObject(value) {
        return !!value && typeof value === 'object' && !Array.isArray(value);
    }

    /** Аккуратно приводит значение к целому числу, иначе возвращает null. */
    function toInt(value) {
        if (typeof value === 'number') {
            return Number.isFinite(value) ? Math.trunc(value) : null;
        }

        var parsed = parseInt(String(value === null || value === undefined ? '' : value).trim(), 10);
        return Number.isFinite(parsed) ? parsed : null;
    }

    /** Убирает лишние пробелы и обрезает строку до нужной длины. */
    function cleanText(value, maxLength) {
        var text = String(value === null || value === undefined ? '' : value)
            .replace(/\s+/g, ' ')
            .trim();

        if (maxLength && text.length > maxLength) {
            text = text.slice(0, maxLength).trim();
        }

        return text;
    }

    /** Следующий свободный идентификатор для новой записи. */
    function nextFreeId(items, idField) {
        var field = idField || 'id';
        var max = 0;

        (items || []).forEach(function (item) {
            var id = isPlainObject(item) || typeof item === 'object' ? toInt(item[field]) : null;
            if (id !== null && id > max) {
                max = id;
            }
        });

        return max + 1;
    }

    function deepCopy(value) {
        return JSON.parse(JSON.stringify(value));
    }

    /* ------------------------------------------------------------------ */
    /* Даты                                                                */
    /* ------------------------------------------------------------------ */

    /**
     * Разбирает дату формата ГГГГ-ММ-ДД как ЛОКАЛЬНУЮ дату.
     * Это исправляет старую проблему: new Date('2026-09-10') трактуется как
     * UTC-полночь, из-за чего в западных часовых поясах показывался предыдущий день.
     */
    function parseISODate(value) {
        if (typeof value !== 'string') {
            return null;
        }

        var match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
        if (!match) {
            return null;
        }

        var year = parseInt(match[1], 10);
        var month = parseInt(match[2], 10);
        var day = parseInt(match[3], 10);
        var date = new Date(year, month - 1, day, 0, 0, 0, 0);

        // Отсекаем несуществующие даты вроде 31 февраля
        if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
            return null;
        }

        return date;
    }

    function pad2(value) {
        return value < 10 ? '0' + value : String(value);
    }

    /** Date → «ГГГГ-ММ-ДД» по локальному времени. */
    function toISODate(date) {
        return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate());
    }

    function todayISO() {
        return toISODate(new Date());
    }

    var MONTHS_SHORT = ['янв.', 'февр.', 'мар.', 'апр.', 'мая', 'июн.', 'июл.', 'авг.', 'сент.', 'окт.', 'нояб.', 'дек.'];
    var MONTHS_LONG = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

    /* ------------------------------------------------------------------ */
    /* Время матча и отсчёт до начала                                      */
    /* ------------------------------------------------------------------ */

    /**
     * Время начала матча в виде «ЧЧ:ММ».
     * Пустая строка — время не назначено: для любительского турнира это обычное
     * дело (известен только день), поэтому поле необязательное.
     * Принимаем «19:30», «9:5» и «19:30:00» (значение поля времени в браузере)
     * и приводим к одному виду.
     */
    function normalizeMatchTime(value) {
        if (typeof value !== 'string') {
            return '';
        }

        var parsed = /^(\d{1,2}):(\d{1,2})(?::\d{2})?$/.exec(value.trim());

        if (!parsed) {
            return '';
        }

        var hours = parseInt(parsed[1], 10);
        var minutes = parseInt(parsed[2], 10);

        if (hours > 23 || minutes > 59) {
            return '';
        }

        return pad2(hours) + ':' + pad2(minutes);
    }

    /**
     * Момент начала матча: дата плюс время (локальное время устройства).
     * Время не указано — считаем началом дня, иначе матч «сегодня» выглядел бы
     * уже начавшимся. Если дата неизвестна — null.
     */
    function matchStart(match) {
        if (!isPlainObject(match)) {
            return null;
        }

        var date = parseISODate(match.date);

        if (!date) {
            return null;
        }

        var time = normalizeMatchTime(match.time);
        var parts = time ? time.split(':') : [];

        date.setHours(parts.length ? parseInt(parts[0], 10) : 0, parts.length ? parseInt(parts[1], 10) : 0, 0, 0);

        return date;
    }

    /** Начало суток — чтобы считать «через сколько календарных дней» матч. */
    function dayStart(date) {
        return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
    }

    /** «6 октября 2026, 19:30» — дата и время матча. Времени нет — только дата. */
    function formatMatchWhen(match, style) {
        var source = isPlainObject(match) ? match : {};
        var time = normalizeMatchTime(source.time);

        return formatDate(source.date, style) + (time ? ', ' + time : '');
    }

    /** «час», «часа», «часов» */
    function hoursWord(count) {
        return pluralWord(count, 'час', 'часа', 'часов');
    }

    /** «минуту», «минуты», «минут» */
    function minutesWord(count) {
        return pluralWord(count, 'минуту', 'минуты', 'минут');
    }

    /**
     * Отсчёт до начала матча словами: «через 4 дня», «завтра в 19:30»,
     * «сегодня в 19:30», «сегодня», «через 3 часа», «через 25 минут».
     *
     * Пустая строка — матч уже сыгран, дата в прошлом, время начала прошло или
     * дата неизвестна: тогда показываем обычную дату, ничего не выдумывая.
     * В день матча счёт идёт по времени, в остальные дни — по календарным дням,
     * иначе «завтра в 9:00» читалось бы как «через 15 часов».
     * now передаётся явно, чтобы отсчёт можно было проверить.
     */
    function countdownLabel(match, now) {
        // Сыгранный матч (счёт уже есть) — отсчитывать не до чего, даже если
        // результат внесли заранее: показываем только дату
        if (isFinished(match)) {
            return '';
        }

        var start = matchStart(match);

        if (!start) {
            return '';
        }

        var current = (now instanceof Date && !Number.isNaN(now.getTime())) ? now : new Date();
        var diff = start.getTime() - current.getTime();
        var days = Math.round((dayStart(start).getTime() - dayStart(current).getTime()) / 86400000);
        var time = normalizeMatchTime(match.time);

        if (days > 1) {
            return 'через ' + days + ' ' + daysWord(days);
        }

        if (days === 1) {
            return 'завтра' + (time ? ' в ' + time : '');
        }

        // Дата в прошлом: сколько именно дней назад — уже не новость, показываем дату
        if (days < 0) {
            return '';
        }

        // Время не назначено: известно только то, что матч сегодня
        if (!time) {
            return 'сегодня';
        }

        // Время начала уже прошло, а счёта ещё нет — отсчитывать не до чего
        if (diff < 0) {
            return '';
        }

        var minutes = Math.floor(diff / 60000);

        if (minutes < 1) {
            return 'вот-вот начнётся';
        }

        if (minutes < 60) {
            return 'через ' + minutes + ' ' + minutesWord(minutes);
        }

        return 'через ' + Math.floor(minutes / 60) + ' ' + hoursWord(Math.floor(minutes / 60));
    }

    /**
     * Отсчёт до начала матча по частям: дни, часы, минуты и секунды — для табло
     * на главной, где счёт идёт посекундно.
     *
     * Возвращает null, когда счётчика быть не должно: матч сыгран, дата или время
     * начала неизвестны, начало уже прошло. Без времени начала секунды отсчитывать
     * не от чего — получилась бы выдуманная точность до полуночи; в этом случае
     * текст отсчёта берётся из countdownLabel («через 4 дня»).
     *
     * days — целые сутки, оставшиеся до начала: когда их не осталось, плитка дней
     * не показывается и табло читается как «часы · минуты · секунды».
     * now передаётся явно, чтобы отсчёт можно было проверить.
     */
    function countdownParts(match, now) {
        if (isFinished(match) || !normalizeMatchTime(match.time)) {
            return null;
        }

        var start = matchStart(match);

        if (!start) {
            return null;
        }

        var current = (now instanceof Date && !Number.isNaN(now.getTime())) ? now : new Date();
        var total = Math.floor((start.getTime() - current.getTime()) / 1000);

        if (total < 0) {
            return null;
        }

        return {
            days: Math.floor(total / 86400),
            hours: Math.floor(total / 3600) % 24,
            minutes: Math.floor(total / 60) % 60,
            seconds: total % 60,
            total: total
        };
    }

    /**
     * Форматирование даты без зависимости от локали браузера.
     * style: 'short' → «10 сент.», 'long' → «10 сентября 2026», 'numeric' → «10.09.2026».
     */
    function formatDate(value, style) {
        var date = parseISODate(value);

        if (!date) {
            return 'Дата не указана';
        }

        var day = date.getDate();
        var month = date.getMonth();
        var year = date.getFullYear();

        if (style === 'long') {
            return day + ' ' + MONTHS_LONG[month] + ' ' + year;
        }

        if (style === 'numeric') {
            return pad2(day) + '.' + pad2(month + 1) + '.' + year;
        }

        return day + ' ' + MONTHS_SHORT[month];
    }

    /** «15 сентября 2026, 10:35» — для строки «данные обновлены …». */
    function formatDateTime(value) {
        var date = (value instanceof Date)
            ? value
            : new Date(String(value === null || value === undefined ? '' : value));

        if (Number.isNaN(date.getTime())) {
            return '';
        }

        return date.getDate() + ' ' + MONTHS_LONG[date.getMonth()] + ' ' + date.getFullYear() + ', ' +
            pad2(date.getHours()) + ':' + pad2(date.getMinutes());
    }

    /** Числовой ключ даты для сортировки (для дат без значения — «в конце» или «в начале»). */
    function dateKey(value, missingLast) {

        var date = parseISODate(value);

        if (!date) {
            return missingLast ? Number.MAX_SAFE_INTEGER : -1;
        }

        return date.getTime();
    }

    /* ------------------------------------------------------------------ */
    /* Команды: отображение                                               */
    /* ------------------------------------------------------------------ */

    function findTeam(teams, id) {
        var teamId = toInt(id);

        for (var i = 0; i < (teams || []).length; i++) {
            if (toInt(teams[i].id) === teamId) {
                return teams[i];
            }
        }

        return null;
    }

    function getTeamName(teams, id) {
        var team = findTeam(teams, id);
        return team ? team.name : 'Неизвестная команда';
    }

    /**
     * Инициалы для бейджа команды.
     * «Спартак» → «СП», «Реал Мадрид» → «РМ», «ЦСКА» → «ЦС».
     */
    function getTeamInitials(name) {
        var clean = cleanText(name);

        if (!clean) {
            return '?';
        }

        var words = clean.split(' ');

        if (words.length > 1) {
            return (Array.from(words[0])[0] + Array.from(words[1])[0]).toUpperCase();
        }

        // Одно слово: берём первые две буквы (раньше для «ЦСКА» показывалась одна «Ц»)
        return Array.from(words[0]).slice(0, 2).join('').toUpperCase();
    }

    /** Устойчивый цвет бейджа для команды (без inline-стилей — под строгую CSP). */
    function badgeColorForTeam(id) {
        var numeric = toInt(id);
        var index = Math.abs(numeric === null ? 0 : numeric) % BADGE_COLORS.length;
        return BADGE_COLORS[index];
    }

    /* ------------------------------------------------------------------ */
    /* Валидация ввода                                                     */
    /* ------------------------------------------------------------------ */

    /**
     * Проверяет название команды.
     * options.ignoreId — команда, которую сейчас переименовывают (чтобы не считать её дублем самой себя).
     */
    function validateTeamName(name, teams, options) {
        var value = cleanText(name, CONFIG.maxTeamNameLength);
        var ignoreId = options && options.ignoreId !== undefined ? toInt(options.ignoreId) : null;

        if (!value) {
            return { ok: false, error: 'Введите название команды' };
        }

        var duplicate = (teams || []).some(function (team) {
            return toInt(team.id) !== ignoreId && cleanText(team.name).toLowerCase() === value.toLowerCase();
        });

        if (duplicate) {
            return { ok: false, error: 'Команда с таким названием уже есть' };
        }

        return { ok: true, value: value };
    }

    /** Проверяет имя игрока (в рамках одной команды имена не должны повторяться). */
    function validatePlayerName(name, team, options) {
        var value = cleanText(name, CONFIG.maxPlayerNameLength);
        var ignoreIndex = options && options.ignoreIndex !== undefined ? toInt(options.ignoreIndex) : null;

        if (!value) {
            return { ok: false, error: 'Введите имя игрока' };
        }

        var players = (team && Array.isArray(team.players)) ? team.players : [];
        var duplicate = players.some(function (player, index) {
            return index !== ignoreIndex && cleanText(player).toLowerCase() === value.toLowerCase();
        });

        if (duplicate) {
            return { ok: false, error: 'Такой игрок уже есть в этой команде' };
        }

        return { ok: true, value: value };
    }

    /**
     * Разбор введённого счёта.
     * '' (пусто) → null, корректное целое 0…maxScore → число, иначе NaN (признак ошибки).
     */
    function normalizeScore(value) {
        if (value === null || value === undefined || String(value).trim() === '') {
            return null;
        }

        var text = String(value).trim();

        if (!/^\d+$/.test(text)) {
            return NaN;
        }

        var number = parseInt(text, 10);

        if (number > CONFIG.maxScore) {
            return NaN;
        }

        return number;
    }

    /**
     * Полная проверка данных матча (при добавлении, изменении и вводе счёта).
     * Возвращает нормализованный объект матча либо текст ошибки.
     */
    function validateMatchInput(input, teams) {
        var source = input || {};
        var teamIds = (teams || []).map(function (team) {
            return toInt(team.id);
        });
        var teamA = toInt(source.teamA);
        var teamB = toInt(source.teamB);
        var date = String(source.date === null || source.date === undefined ? '' : source.date).trim();
        var rawTime = String(source.time === null || source.time === undefined ? '' : source.time).trim();
        var time = normalizeMatchTime(rawTime);

        if (teamA === null || teamIds.indexOf(teamA) === -1) {
            return { ok: false, error: 'Выберите первую команду' };
        }

        if (teamB === null || teamIds.indexOf(teamB) === -1) {
            return { ok: false, error: 'Выберите вторую команду' };
        }

        if (teamA === teamB) {
            return { ok: false, error: 'Команды должны быть разными' };
        }

        if (!parseISODate(date)) {
            return { ok: false, error: 'Укажите дату матча' };
        }

        // Время необязательно: без него матч просто «на этот день».
        if (rawTime && !time) {
            return { ok: false, error: 'Время матча указывается как ЧЧ:ММ' };
        }

        var scoreA = normalizeScore(source.scoreA);
        var scoreB = normalizeScore(source.scoreB);

        if (Number.isNaN(scoreA) || Number.isNaN(scoreB)) {
            return { ok: false, error: 'Счёт — целое число от 0 до ' + CONFIG.maxScore };
        }

        // Раньше можно было ввести только один счёт: значение молча терялось.
        // Теперь требуется заполнить оба поля или ни одного.
        if ((scoreA === null) !== (scoreB === null)) {
            return { ok: false, error: 'Заполните счёт обеих команд или оставьте оба поля пустыми' };
        }

        var finished = scoreA !== null && scoreB !== null;

        return {
            ok: true,
            match: {
                teamA: teamA,
                teamB: teamB,
                date: date,
                time: time,
                scoreA: finished ? scoreA : null,
                scoreB: finished ? scoreB : null,
                finished: finished
            }
        };
    }

    /* ------------------------------------------------------------------ */
    /* Вход в панель: пароль сверяется по солёному отпечатку               */
    /* ------------------------------------------------------------------ */

    /**
     * SHA-256 на чистом JavaScript (FIPS 180-4).
     *
     * Свой, а не из библиотеки, по двум причинам: сайт собирается без зависимостей
     * (никаких CDN — так требует Content Security Policy), и тот же код должен
     * работать в Node во время тестов. Правильность свечена со стандартным
     * SHA-256 из Node.js (node:crypto).
     */

    /** Циклический сдвиг 32-битного слова вправо. */
    function rotr(word, bits) {
        return ((word >>> bits) | (word << (32 - bits))) >>> 0;
    }

    /** Константы SHA-256: первые 32 бита дробных частей кубических корней простых чисел. */
    var SHA256_K = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
        0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
        0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
    ];

    /** Байты строки в UTF-8: пароль может содержать кириллицу. */
    function utf8Bytes(text) {
        var bytes = [];
        var index;
        var code;
        var next;
        var point;

        for (index = 0; index < text.length; index += 1) {
            code = text.charCodeAt(index);

            if (code < 0x80) {
                bytes.push(code);
            } else if (code < 0x800) {
                bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
            } else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
                next = text.charCodeAt(index + 1);

                if (next >= 0xdc00 && next <= 0xdfff) {
                    // Суррогатная пара (символ вне основной плоскости) — четыре байта
                    point = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
                    index += 1;
                    bytes.push(0xf0 | (point >> 18), 0x80 | ((point >> 12) & 0x3f),
                        0x80 | ((point >> 6) & 0x3f), 0x80 | (point & 0x3f));
                } else {
                    bytes.push(0xef, 0xbf, 0xbd);
                }
            } else if (code >= 0xd800 && code <= 0xdfff) {
                // Одиночная суррогатная пара: в UTF-8 это символ замены
                bytes.push(0xef, 0xbf, 0xbd);
            } else {
                bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
            }
        }

        return bytes;
    }

    /** Отпечаток строки: шестнадцатеричный SHA-256 (64 символа, только строчные). */
    function sha256Hex(text) {
        var message = utf8Bytes(String(text === null || text === undefined ? '' : text));
        var bitLength = message.length * 8;
        var high = Math.floor(bitLength / 0x100000000);
        var low = bitLength - high * 0x100000000;
        var h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
            0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
        var w = new Array(64);
        var offset;
        var round;
        var a;
        var b;
        var c;
        var d;
        var e;
        var f;
        var g;
        var last;
        var small0;
        var small1;
        var choice;
        var majority;
        var temp1;
        var temp2;

        // Дополнение по стандарту: 0x80, нули до 56 байт в блоке и длина в битах (64 бита)
        message.push(0x80);

        while (message.length % 64 !== 56) {
            message.push(0);
        }

        message.push((high >>> 24) & 0xff, (high >>> 16) & 0xff, (high >>> 8) & 0xff, high & 0xff);
        message.push((low >>> 24) & 0xff, (low >>> 16) & 0xff, (low >>> 8) & 0xff, low & 0xff);

        for (offset = 0; offset < message.length; offset += 64) {
            for (round = 0; round < 16; round += 1) {
                w[round] = ((message[offset + round * 4] << 24) | (message[offset + round * 4 + 1] << 16) |
                    (message[offset + round * 4 + 2] << 8) | message[offset + round * 4 + 3]) >>> 0;
            }

            for (round = 16; round < 64; round += 1) {
                small0 = rotr(w[round - 15], 7) ^ rotr(w[round - 15], 18) ^ (w[round - 15] >>> 3);
                small1 = rotr(w[round - 2], 17) ^ rotr(w[round - 2], 19) ^ (w[round - 2] >>> 10);
                w[round] = (w[round - 16] + small0 + w[round - 7] + small1) >>> 0;
            }

            a = h[0];
            b = h[1];
            c = h[2];
            d = h[3];
            e = h[4];
            f = h[5];
            g = h[6];
            last = h[7];

            for (round = 0; round < 64; round += 1) {
                small1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
                choice = (e & f) ^ (~e & g);
                temp1 = (last + small1 + choice + SHA256_K[round] + w[round]) >>> 0;
                small0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
                majority = (a & b) ^ (a & c) ^ (b & c);
                temp2 = (small0 + majority) >>> 0;

                last = g;
                g = f;
                f = e;
                e = (d + temp1) >>> 0;
                d = c;
                c = b;
                b = a;
                a = (temp1 + temp2) >>> 0;
            }

            h[0] = (h[0] + a) >>> 0;
            h[1] = (h[1] + b) >>> 0;
            h[2] = (h[2] + c) >>> 0;
            h[3] = (h[3] + d) >>> 0;
            h[4] = (h[4] + e) >>> 0;
            h[5] = (h[5] + f) >>> 0;
            h[6] = (h[6] + g) >>> 0;
            h[7] = (h[7] + last) >>> 0;
        }

        return h.map(function (word) {
            return ('00000000' + word.toString(16)).slice(-8);
        }).join('');
    }

    /** Соль и отпечаток пароля из настроек сайта (FT_CONFIG.admin в config.js). */
    function adminCredentials() {
        var settings = (ENV.FT_CONFIG && ENV.FT_CONFIG.admin) || {};

        return {
            salt: typeof settings.passwordSalt === 'string' ? settings.passwordSalt : '',
            hash: typeof settings.passwordHash === 'string' ? settings.passwordHash.toLowerCase() : ''
        };
    }

    /**
     * Совпадает ли пароль с парой «соль + отпечаток».
     * Пустой отпечаток означает, что вход в панель закрыт для всех.
     */
    function passwordMatches(value, salt, hash) {
        var expected = String(hash === null || hash === undefined ? '' : hash).toLowerCase();

        if (!expected) {
            return false;
        }

        var password = String(value === null || value === undefined ? '' : value);

        return sha256Hex(String(salt === null || salt === undefined ? '' : salt) + ':' + password) === expected;
    }

    /** Проверка пароля администратора. */
    function adminPasswordMatches(value) {
        var credentials = adminCredentials();

        return passwordMatches(value, credentials.salt, credentials.hash);
    }

    /* ------------------------------------------------------------------ */
    /* Турнирная таблица и статистика                                      */
    /* ------------------------------------------------------------------ */

    function isFinished(match) {
        return !!match && match.finished === true &&
            Number.isInteger(match.scoreA) && Number.isInteger(match.scoreB);
    }

    /**
     * Сортировка матчей по дате и времени. order: 'asc' | 'desc';
     * матчи без даты всегда в конце. В один день порядок задаёт время начала:
     * расписание дня читается сверху вниз, как в программке.
     */
    function sortMatches(matches, order) {
        var direction = order === 'asc' ? 1 : -1;

        return (matches || []).slice().sort(function (a, b) {
            var keyA = dateKey(a.date, false);
            var keyB = dateKey(b.date, false);
            var missingA = keyA < 0;
            var missingB = keyB < 0;

            // Матч без даты не должен «всплывать» наверх даже при обратной сортировке
            if (missingA !== missingB) {
                return missingA ? 1 : -1;
            }

            if (!missingA && keyA !== keyB) {
                return (keyA - keyB) * direction;
            }

            if (!missingA) {
                // Время не указано — считаем началом дня
                var timeA = normalizeMatchTime(a.time) || '00:00';
                var timeB = normalizeMatchTime(b.time) || '00:00';

                if (timeA !== timeB) {
                    return (timeA < timeB ? -1 : 1) * direction;
                }
            }

            return toInt(a.id) - toInt(b.id);
        });
    }

    /**
     * Фильтр матчей для публичного списка: 'all' | 'finished' | 'upcoming'.
     * Предстоящие читаются как расписание — ближайший матч первым,
     * поэтому для них порядок прямой (остальные — от новых к старым).
     */
    function selectMatches(matches, filter) {
        var list = (matches || []).filter(function (match) {
            if (filter === 'finished') {
                return isFinished(match);
            }

            if (filter === 'upcoming') {
                return !isFinished(match);
            }

            return true;
        });

        return sortMatches(list, filter === 'upcoming' ? 'asc' : 'desc');
    }

    /**
     * Матчи одной команды: сначала прошедшие (от новых к старым), затем предстоящие
     * (от ближайших к дальним) — тот же порядок, что и в общем списке матчей.
     */
    function teamMatches(matches, teamId) {
        var id = toInt(teamId);
        var own = (matches || []).filter(function (match) {
            return toInt(match.teamA) === id || toInt(match.teamB) === id;
        });

        var finished = sortMatches(own.filter(isFinished), 'desc');
        var upcoming = sortMatches(own.filter(function (match) {
            return !isFinished(match);
        }), 'asc');

        return finished.concat(upcoming);
    }

    /**
     * Поиск матчей по названию команды: подходит часть названия или слово
     * (регистр и лишние пробелы не важны). Пустой запрос ничего не отсеивает.
     */
    function searchMatches(matches, teams, query) {
        var list = Array.isArray(matches) ? matches.slice() : [];
        var needle = cleanText(query).toLowerCase();

        if (!needle) {
            return list;
        }

        return list.filter(function (match) {
            var nameA = getTeamName(teams, match.teamA).toLowerCase();
            var nameB = getTeamName(teams, match.teamB).toLowerCase();

            return nameA.indexOf(needle) !== -1 || nameB.indexOf(needle) !== -1;
        });
    }

    /**
     * Расчёт турнирной таблицы: победа — 3 очка, ничья — 1.
     * Сортировка: очки → разница мячей → забитые мячи → название (детерминированно).
     */
    function computeStandings(teams, matches) {
        var rows = new Map();

        (teams || []).forEach(function (team) {
            rows.set(toInt(team.id), {
                id: toInt(team.id),
                name: team.name,
                squadSize: Array.isArray(team.players) ? team.players.length : 0,
                played: 0,
                wins: 0,
                draws: 0,
                losses: 0,
                goalsFor: 0,
                goalsAgainst: 0,
                goalDiff: 0,
                points: 0
            });
        });

        var finished = (matches || []).filter(isFinished);

        finished.forEach(function (match) {
            var teamA = rows.get(toInt(match.teamA));
            var teamB = rows.get(toInt(match.teamB));

            if (!teamA || !teamB) {
                return;
            }

            teamA.played += 1;
            teamB.played += 1;
            teamA.goalsFor += match.scoreA;
            teamA.goalsAgainst += match.scoreB;
            teamB.goalsFor += match.scoreB;
            teamB.goalsAgainst += match.scoreA;

            if (match.scoreA > match.scoreB) {
                teamA.wins += 1;
                teamA.points += 3;
                teamB.losses += 1;
            } else if (match.scoreA < match.scoreB) {
                teamB.wins += 1;
                teamB.points += 3;
                teamA.losses += 1;
            } else {
                teamA.draws += 1;
                teamB.draws += 1;
                teamA.points += 1;
                teamB.points += 1;
            }
        });

        var standings = Array.from(rows.values());

        standings.forEach(function (row) {
            row.goalDiff = row.goalsFor - row.goalsAgainst;
        });

        standings.sort(function (a, b) {
            return b.points - a.points ||
                b.goalDiff - a.goalDiff ||
                b.goalsFor - a.goalsFor ||
                String(a.name).localeCompare(String(b.name), 'ru');
        });

        standings.forEach(function (row, index) {
            row.place = index + 1;
        });

        return standings;
    }

    /** Сводная статистика для главной страницы. */
    function getStats(data) {
        var teams = (data && Array.isArray(data.teams)) ? data.teams : [];
        var matches = (data && Array.isArray(data.matches)) ? data.matches : [];

        return {
            teams: teams.length,
            matches: matches.length,
            players: teams.reduce(function (total, team) {
                return total + (Array.isArray(team.players) ? team.players.length : 0);
            }, 0),
            finished: matches.filter(isFinished).length,
            upcoming: matches.filter(function (match) {
                return !isFinished(match);
            }).length,
            goals: matches.filter(isFinished).reduce(function (total, match) {
                return total + match.scoreA + match.scoreB;
            }, 0)
        };
    }

    /**
     * Лучшие бомбардиры: забитые мячи по всем матчам турнира.
     * Сортировка — по голам (больше — выше), при равенстве — по имени.
     * В список попадают только те, кто забивал: это таблица результативности,
     * а не весь заявочный лист. Жёлтые и красные карточки в ней не показываются,
     * но считаются в данных — они видны в карточке матча и в детальном результате.
     */
    function computePlayerStats(data) {
        var teams = (data && Array.isArray(data.teams)) ? data.teams : [];
        var matches = (data && Array.isArray(data.matches)) ? data.matches : [];
        var byKey = {};
        var rows = [];

        var rowFor = function (teamId, player) {
            var id = toInt(teamId);
            var name = cleanText(player, CONFIG.maxPlayerNameLength);
            var key = id + '|' + name.toLowerCase();

            if (!byKey[key]) {
                var team = findTeam(teams, id);

                byKey[key] = {
                    teamId: id,
                    teamName: team ? team.name : 'Неизвестная команда',
                    player: name,
                    // Игровой номер берём из данных игрока ('' — номер не задан)
                    number: getPlayerInfo(data, id, name).number,
                    goals: 0,
                    yellow: 0,
                    red: 0
                };
                rows.push(byKey[key]);
            }

            return byKey[key];
        };

        matches.forEach(function (match) {
            (Array.isArray(match.events) ? match.events : []).forEach(function (event) {
                if (!isPlainObject(event) || !isEventType(event.type)) {
                    return;
                }

                var player = cleanText(event.player, CONFIG.maxPlayerNameLength);

                if (!player) {
                    return;
                }

                var row = rowFor(event.team, player);

                if (event.type === 'goal') {
                    row.goals += 1;
                } else if (event.type === 'yellow') {
                    row.yellow += 1;
                } else {
                    row.red += 1;
                }
            });
        });

        // В таблице бомбардиров остаются только те, кто забивал
        var scorers = rows.filter(function (row) {
            return row.goals > 0;
        });

        scorers.sort(function (a, b) {
            return b.goals - a.goals ||
                String(a.player).localeCompare(String(b.player), 'ru') ||
                String(a.teamName).localeCompare(String(b.teamName), 'ru');
        });

        scorers.forEach(function (row, index) {
            row.place = index + 1;
        });

        return scorers;
    }

    /** Номер игрока в заявке команды (−1 — такого игрока в составе нет). */
    function playerIndex(team, player) {
        var name = cleanText(player, CONFIG.maxPlayerNameLength).toLowerCase();

        if (!team || !name || !Array.isArray(team.players)) {
            return -1;
        }

        for (var i = 0; i < team.players.length; i++) {
            if (cleanText(team.players[i], CONFIG.maxPlayerNameLength).toLowerCase() === name) {
                return i;
            }
        }

        return -1;
    }

    /** Голы и карточки одного игрока по всем матчам турнира. */
    function playerStats(data, teamId, player) {
        var id = toInt(teamId);
        var name = cleanText(player, CONFIG.maxPlayerNameLength);
        var result = { goals: 0, yellow: 0, red: 0 };

        if (id === null || !name || !data || !Array.isArray(data.matches)) {
            return result;
        }

        data.matches.forEach(function (match) {
            result.goals += playerEventCount(match.events, id, name, 'goal');
            result.yellow += playerEventCount(match.events, id, name, 'yellow');
            result.red += playerEventCount(match.events, id, name, 'red');
        });

        return result;
    }

    /** Голы и карточки всех игроков одним проходом: ключ — «команда|имя в нижнем регистре». */
    function collectPlayerStats(data) {
        var events = {};
        var matches = (data && Array.isArray(data.matches)) ? data.matches : [];

        matches.forEach(function (match) {
            (Array.isArray(match.events) ? match.events : []).forEach(function (event) {
                if (!isPlainObject(event) || !isEventType(event.type)) {
                    return;
                }

                var key = photoKey(event.team, event.player);

                if (!key || key.charAt(key.length - 1) === '|') {
                    return;
                }

                if (!events[key]) {
                    events[key] = { goals: 0, yellow: 0, red: 0 };
                }

                if (event.type === 'goal') {
                    events[key].goals += 1;
                } else if (event.type === 'yellow') {
                    events[key].yellow += 1;
                } else {
                    events[key].red += 1;
                }
            });
        });

        return events;
    }

    /**
     * Все игроки турнира (по всем командам): имя, команда, голы и карточки.
     * Порядок — как в заявках: команды по списку, внутри команды — как записаны игроки.
     */
    function computeAllPlayers(data) {
        var teams = (Array.isArray(data && data.teams)) ? data.teams : [];
        var stats = collectPlayerStats(data);
        var rows = [];

        teams.forEach(function (team) {
            (team.players || []).forEach(function (player, index) {
                var key = photoKey(team.id, player);
                var info = getPlayerInfo(data, team.id, player);
                var totals = stats[key] || { goals: 0, yellow: 0, red: 0 };

                rows.push({
                    teamId: toInt(team.id),
                    teamName: team.name,
                    index: index,
                    player: cleanText(player, CONFIG.maxPlayerNameLength),
                    number: info.number,
                    goals: totals.goals,
                    yellow: totals.yellow,
                    red: totals.red
                });
            });
        });

        return rows;
    }

    /* ------------------------------------------------------------------ */
    /* Сортировка таблиц                                                   */
    /* ------------------------------------------------------------------ */

    /**
     * Тип значения для сортировки: «число» — голы и карточки, «текст» — имена
     * игроков и названия команд.
     */
    var SORT_TYPES = {
        player: 'text',
        teamName: 'text',
        name: 'text',
        goals: 'number',
        yellow: 'number',
        red: 'number',
        place: 'number'
    };

    /** Направление сортировки по умолчанию: числа — от большего, остальное — по алфавиту. */
    function defaultSortDirection(key) {
        return (SORT_TYPES[key] === 'number') ? 'desc' : 'asc';
    }

    /** Пустое значение (нет данных) — такие строки всегда идут в конец списка. */
    function isEmptySortValue(value) {
        return value === null || value === undefined || value === '';
    }

    /** Сравнение двух непустых значений по типу столбца. */
    function compareSortValues(type, left, right) {
        if (type === 'number') {
            return (Number(left) || 0) - (Number(right) || 0);
        }

        return String(left).localeCompare(String(right), 'ru');
    }

    /**
     * Сортирует строки таблицы по столбцу. rows — обычные объекты (player, teamName,
     * goals…), options — { key, dir, type }. Строки без значения всегда
     * оказываются в конце (независимо от направления), а при равенстве порядок
     * определяют команда и имя — так список выглядит предсказуемо.
     */
    function sortRows(rows, options) {
        var opts = options || {};
        var key = opts.key;
        var type = opts.type || SORT_TYPES[key] || 'text';
        var dir = opts.dir === 'asc' ? 'asc' : 'desc';
        var sign = dir === 'asc' ? 1 : -1;
        var list = (Array.isArray(rows) ? rows : []).slice();

        if (!key) {
            return list;
        }

        var teamOf = function (row) {
            return row.teamName || row.name || '';
        };
        var playerOf = function (row) {
            return row.player || row.name || '';
        };
        var byName = function (a, b) {
            return String(teamOf(a)).localeCompare(String(teamOf(b)), 'ru') ||
                String(playerOf(a)).localeCompare(String(playerOf(b)), 'ru');
        };

        list.sort(function (a, b) {
            var left = a[key];
            var right = b[key];
            var emptyLeft = isEmptySortValue(left);
            var emptyRight = isEmptySortValue(right);

            if (emptyLeft || emptyRight) {
                return emptyLeft === emptyRight ? byName(a, b) : (emptyLeft ? 1 : -1);
            }

            return sign * compareSortValues(type, left, right) || byName(a, b);
        });

        return list;
    }

    /* ------------------------------------------------------------------ */
    /* События матча: голы и карточки                                      */
    /* ------------------------------------------------------------------ */

    /** Типы событий: гол, жёлтая и красная карточки (порядок — как в интерфейсе). */
    var EVENT_TYPES = ['goal', 'yellow', 'red'];
    var EVENT_LABELS = { goal: 'Гол', yellow: 'Жёлтая карточка', red: 'Красная карточка' };

    function isEventType(value) {
        return EVENT_TYPES.indexOf(value) !== -1;
    }

    function eventLabel(type) {
        return EVENT_LABELS[type] || '';
    }

    /** Одно событие матча: какая команда, какой игрок и что сделал. */
    function createEvent(teamId, player, type) {
        return {
            team: toInt(teamId),
            player: cleanText(player, CONFIG.maxPlayerNameLength),
            type: type
        };
    }

    /**
     * Приводит события матча к корректному виду: остаются только голы и карточки
     * игроков тех двух команд, которые играют в этом матче.
     */
    function normalizeMatchEvents(rawEvents, match) {
        if (rawEvents === undefined || rawEvents === null) {
            return { events: [], repaired: false };
        }

        if (!Array.isArray(rawEvents)) {
            return { events: [], repaired: true };
        }

        var events = [];
        var repaired = false;
        var teamA = toInt(match.teamA);
        var teamB = toInt(match.teamB);

        rawEvents.forEach(function (event) {
            if (!isPlainObject(event) || !isEventType(event.type)) {
                repaired = true;
                return;
            }

            var teamId = toInt(event.team);
            var player = cleanText(event.player, CONFIG.maxPlayerNameLength);

            if (!player || (teamId !== teamA && teamId !== teamB)) {
                repaired = true;
                return;
            }

            events.push({ team: teamId, player: player, type: event.type });
        });

        return { events: events, repaired: repaired };
    }

    /** События одной команды в матче (можно ограничить типом). */
    function teamEvents(events, teamId, type) {
        var id = toInt(teamId);

        return (Array.isArray(events) ? events : []).filter(function (event) {
            return toInt(event.team) === id && (!type || event.type === type);
        });
    }

    /** Сколько раз у игрока отмечено событие указанного типа — 0, если записей нет. */
    function playerEventCount(events, teamId, player, type) {
        var name = cleanText(player).toLowerCase();
        var count = 0;

        (Array.isArray(events) ? events : []).forEach(function (event) {
            if (toInt(event.team) === toInt(teamId) && (!type || event.type === type) &&
                cleanText(event.player).toLowerCase() === name) {
                count += 1;
            }
        });

        return count;
    }

    /** Сколько событий записано у команды (можно ограничить типом). */
    function countTeamEvents(events, teamId, type) {
        return teamEvents(events, teamId, type).length;
    }

    /** Добавляет событие в конец списка и возвращает новый список. */
    function addEvent(events, teamId, player, type) {
        var list = (Array.isArray(events) ? events : []).slice();
        var event = createEvent(teamId, player, type);

        if (!isEventType(event.type) || !event.player || event.team === null) {
            return list;
        }

        list.push(event);
        return list;
    }

    /** Убирает последнюю запись игрока (указанного типа, если он задан). */
    function removeLastEvent(events, teamId, player, type) {
        var list = (Array.isArray(events) ? events : []).slice();
        var name = cleanText(player).toLowerCase();
        var index = -1;

        for (var i = list.length - 1; i >= 0; i--) {
            var event = list[i];

            if (toInt(event.team) === toInt(teamId) && (!type || event.type === type) &&
                cleanText(event.player).toLowerCase() === name) {
                index = i;
                break;
            }
        }

        if (index !== -1) {
            list.splice(index, 1);
        }

        return list;
    }

    /**
     * Игроки команды для карточки матча: текущий состав плюс те, у кого уже есть
     * записи в этом матче (например, игрока потом убрали из состава).
     */
    function matchSquad(team, events, teamId) {
        var players = (team && Array.isArray(team.players)) ? team.players.slice() : [];
        var seen = {};

        players.forEach(function (player) {
            seen[cleanText(player).toLowerCase()] = true;
        });

        teamEvents(events, teamId).forEach(function (event) {
            var key = cleanText(event.player).toLowerCase();

            if (!seen[key]) {
                seen[key] = true;
                players.push(event.player);
            }
        });

        return players;
    }

    /** Переносит записи игрока на новое имя (при переименовании в составе). */
    function renamePlayerEvents(events, teamId, oldName, newName) {
        var from = cleanText(oldName).toLowerCase();
        var to = cleanText(newName, CONFIG.maxPlayerNameLength);

        if (!to) {
            return (Array.isArray(events) ? events : []).slice();
        }

        return (Array.isArray(events) ? events : []).map(function (event) {
            var copy = { team: toInt(event.team), player: event.player, type: event.type };

            if (toInt(event.team) === toInt(teamId) && cleanText(event.player).toLowerCase() === from) {
                copy.player = to;
            }

            return copy;
        });
    }

    /**
     * Матчи для админки: сначала прошедшие (от новых к старым), затем предстоящие
     * (от ближайших к дальним) — в таком порядке удобно вводить результаты.
     */
    function groupMatchesForAdmin(matches) {
        var finished = sortMatches((matches || []).filter(isFinished), 'desc');
        var upcoming = sortMatches((matches || []).filter(function (match) {
            return !isFinished(match);
        }), 'asc');

        return { finished: finished, upcoming: upcoming, all: finished.concat(upcoming) };
    }

    /* ------------------------------------------------------------------ */
    /* Фото игроков                                                        */
    /* ------------------------------------------------------------------ */

    /**
     * Фото хранятся файлами в самом репозитории сайта (папка assets/photos/),
     * а в данных лежит только путь к файлу. Так документ остаётся маленьким
     * (важно: localStorage ограничен), картинки раздаёт сам сайт, а история
     * загрузок остаётся в коммитах репозитория.
     *
     * Ключ карты — команда и имя игрока в нижнем регистре: «3|иванов а.».
     */

    /** Ключ фото в карте data.photos. */
    function photoKey(teamId, player) {
        var id = toInt(teamId);
        var name = cleanText(player).toLowerCase();

        return (id === null ? '' : String(id)) + '|' + name;
    }

    /** Путь к фото должен вести внутрь папки сайта с фотографиями. */
    function isValidPhotoPath(value) {
        if (typeof value !== 'string') {
            return false;
        }

        var path = value.trim();

        // Только относительный путь внутрь папки: без схем, «../» и пробелов
        return path.length > 0 && path.length <= CONFIG.maxPhotoPathLength &&
            path.indexOf(CONFIG.photoPathPrefix) === 0 &&
            path.indexOf('..') === -1 &&
            /^[A-Za-z0-9._\/-]+$/.test(path);
    }

    /** Путь к фото игрока ('' — фото нет). */
    function getPhoto(data, teamId, player) {
        var photos = (data && isPlainObject(data.photos)) ? data.photos : {};
        var value = photos[photoKey(teamId, player)];

        return isValidPhotoPath(value) ? value.trim() : '';
    }

    /** Есть ли у игрока фото. */
    function hasPhoto(data, teamId, player) {
        return getPhoto(data, teamId, player) !== '';
    }

    /** Записывает фото игрока; пустой путь удаляет запись. */
    function setPhoto(data, teamId, player, path) {
        if (!isPlainObject(data)) {
            return data;
        }

        if (!isPlainObject(data.photos)) {
            data.photos = {};
        }

        var key = photoKey(teamId, player);
        var value = typeof path === 'string' ? path.trim() : '';

        if (value && isValidPhotoPath(value)) {
            data.photos[key] = value;
        } else {
            delete data.photos[key];
        }

        return data;
    }

    /** Убирает фото игрока. */
    function removePhoto(data, teamId, player) {
        return setPhoto(data, teamId, player, '');
    }

    /** Переносит фото на новое имя игрока (при переименовании в составе). */
    function renamePlayerPhoto(data, teamId, oldName, newName) {
        var path = getPhoto(data, teamId, oldName);

        if (!path) {
            return data;
        }

        removePhoto(data, teamId, oldName);

        return setPhoto(data, teamId, newName, path);
    }

    /** Убирает фото всех игроков команды (при удалении команды). */
    function removeTeamPhotos(data, teamId) {
        var photos = (data && isPlainObject(data.photos)) ? data.photos : {};
        var prefix = photoKey(teamId, '');

        Object.keys(photos).forEach(function (key) {
            if (key.indexOf(prefix) === 0) {
                delete photos[key];
            }
        });

        return data;
    }

    /* --- Эмблема (фото) команды: отдельная карта teamPhotos, ключ — id команды --- */

    /** Ключ эмблемы команды. */
    function teamPhotoKey(teamId) {
        var id = toInt(teamId);

        return id === null ? '' : String(id);
    }

    /** Эмблема команды ('' — фото нет). */
    function getTeamPhoto(data, teamId) {
        var photos = (data && isPlainObject(data.teamPhotos)) ? data.teamPhotos : {};
        var value = photos[teamPhotoKey(teamId)];

        return isValidPhotoPath(value) ? value.trim() : '';
    }

    /** Есть ли у команды эмблема. */
    function hasTeamPhoto(data, teamId) {
        return getTeamPhoto(data, teamId) !== '';
    }

    /** Записывает эмблему команды; пустой путь удаляет запись. */
    function setTeamPhoto(data, teamId, path) {
        if (!isPlainObject(data)) {
            return data;
        }

        if (!isPlainObject(data.teamPhotos)) {
            data.teamPhotos = {};
        }

        var key = teamPhotoKey(teamId);
        var value = typeof path === 'string' ? path.trim() : '';

        if (!key) {
            return data;
        }

        if (value && isValidPhotoPath(value)) {
            data.teamPhotos[key] = value;
        } else {
            delete data.teamPhotos[key];
        }

        return data;
    }

    /** Убирает эмблему команды. */
    function removeTeamPhoto(data, teamId) {
        return setTeamPhoto(data, teamId, '');
    }

    /**
     * Приводит карту эмблем к корректному виду: остаются только пути внутрь папки
     * фотографий у команд, которые есть в турнире.
     */
    function normalizeTeamPhotos(rawPhotos, teams) {
        var photos = {};

        if (rawPhotos === undefined || rawPhotos === null) {
            return { photos: photos, repaired: false };
        }

        if (!isPlainObject(rawPhotos)) {
            return { photos: photos, repaired: true };
        }

        var repaired = false;

        Object.keys(rawPhotos).forEach(function (key) {
            var value = rawPhotos[key];
            var team = findTeam(teams, key);

            if (!isValidPhotoPath(value) || !team) {
                repaired = true;
                return;
            }

            photos[teamPhotoKey(team.id)] = value.trim();
        });

        return { photos: photos, repaired: repaired };
    }

    /* --- Фотографии команды (галерея): карта teamImages, ключ — id команды --- */

    /**
     * Значение — список путей внутрь папки фото: `["assets/photos/team-photo-…-1a2b3c.jpg"]`.
     * Фотографии видны на странице команды; нажатие открывает фото на весь экран.
     * Имя файла считается по содержимому, поэтому разные фото команды не перезаписывают
     * друг друга, а повторная загрузка того же снимка использует тот же файл.
     */

    /** Список фотографий команды (только корректные пути, без пустых значений). */
    function getTeamImages(data, teamId) {
        var images = (data && isPlainObject(data.teamImages)) ? data.teamImages[teamPhotoKey(teamId)] : null;

        if (!Array.isArray(images)) {
            return [];
        }

        return images.filter(function (path) {
            return isValidPhotoPath(path);
        }).map(function (path) {
            return path.trim();
        });
    }

    /** Сколько фотографий ещё можно добавить команде. */
    function teamImagesLeft(data, teamId) {
        return Math.max(0, CONFIG.maxTeamImages - getTeamImages(data, teamId).length);
    }

    /** Добавляет фотографию команде: { ok: true } или { ok: false, error }. */
    function addTeamImage(data, teamId, path) {
        if (!isPlainObject(data)) {
            return { ok: false, error: 'Данные недоступны' };
        }

        if (!isValidPhotoPath(path)) {
            return { ok: false, error: 'Некорректный путь к фотографии' };
        }

        var key = teamPhotoKey(teamId);

        if (!key) {
            return { ok: false, error: 'Команда не найдена' };
        }

        if (!isPlainObject(data.teamImages)) {
            data.teamImages = {};
        }

        var images = getTeamImages(data, teamId);
        var value = path.trim();

        if (images.indexOf(value) !== -1) {
            return { ok: false, error: 'Такая фотография у команды уже есть' };
        }

        if (images.length >= CONFIG.maxTeamImages) {
            return {
                ok: false,
                error: 'У команды уже ' + CONFIG.maxTeamImages + ' фотографий — сначала уберите лишние'
            };
        }

        images.push(value);
        data.teamImages[key] = images;

        return { ok: true };
    }

    /** Убирает фотографию команды из данных (сам файл остаётся в истории репозитория). */
    function removeTeamImage(data, teamId, path) {
        if (!isPlainObject(data) || !isPlainObject(data.teamImages)) {
            return data;
        }

        var key = teamPhotoKey(teamId);
        var value = typeof path === 'string' ? path.trim() : '';
        var images = getTeamImages(data, teamId).filter(function (item) {
            return item !== value;
        });

        if (images.length) {
            data.teamImages[key] = images;
        } else {
            delete data.teamImages[key];
        }

        return data;
    }

    /** Убирает все фотографии команды (при удалении команды). */
    function removeTeamImages(data, teamId) {
        if (isPlainObject(data) && isPlainObject(data.teamImages)) {
            delete data.teamImages[teamPhotoKey(teamId)];
        }

        return data;
    }

    /**
     * Приводит карту фотографий к корректному виду: остаются пути внутрь папки фото
     * у команд, которые есть в турнире, без повторов и не больше CONFIG.maxTeamImages.
     */
    function normalizeTeamImages(rawImages, teams) {
        var images = {};

        if (rawImages === undefined || rawImages === null) {
            return { images: images, repaired: false };
        }

        if (!isPlainObject(rawImages)) {
            return { images: images, repaired: true };
        }

        var repaired = false;

        Object.keys(rawImages).forEach(function (key) {
            var value = rawImages[key];
            var team = findTeam(teams, key);

            if (!team || !Array.isArray(value)) {
                repaired = true;
                return;
            }

            var list = [];

            value.forEach(function (path) {
                if (!isValidPhotoPath(path)) {
                    repaired = true;
                    return;
                }

                var item = path.trim();

                if (list.indexOf(item) === -1 && list.length < CONFIG.maxTeamImages) {
                    list.push(item);
                } else {
                    repaired = true;
                }
            });

            if (list.length) {
                images[teamPhotoKey(team.id)] = list;
            } else {
                repaired = true;
            }
        });

        return { images: images, repaired: repaired };
    }

    /* ------------------------------------------------------------------ */
    /* Данные игрока: игровой номер и принадлежность                        */
    /* ------------------------------------------------------------------ */

    /**
     * Данные игрока — два необязательных поля: игровой номер (целое число от 0 до
     * CONFIG.maxPlayerNumber, '' — номер не задан) и принадлежность — свободный текст:
     * школа, клуб, тренер. Длина текста ограничена (CONFIG.maxPlayerNoteLength, примерно
     * 3–4 коротких предложения), чтобы карточка игрока оставалась аккуратной.
     *
     * Даты рождения в карточках нет намеренно: для турнирной таблицы она не нужна,
     * а это лишние персональные данные. Прежнее поле birthDate (версия данных 10)
     * отбрасывается при загрузке данных — см. normalizePlayerInfo.
     *
     * Записи живут в отдельной карте playerInfo с тем же ключом, что и фото: «3|иванов а.».
     * Номер — необязательное поле: если он не задан, ключа number в данных нет.
     */

    /**
     * Игровой номер: целое 0…CONFIG.maxPlayerNumber ('' — номер не задан или записан
     * неверно). Принимает число, строку с цифрами и запись вида «№10» — в данных
     * и в поле админки номер всегда выглядит одинаково.
     */
    function normalizePlayerNumber(value) {
        var text = String(value === null || value === undefined ? '' : value)
            .replace(/[№#]/g, '')
            .trim();

        if (!/^\d{1,2}$/.test(text)) {
            return '';
        }

        var number = Number(text);

        return number <= CONFIG.maxPlayerNumber ? number : '';
    }

    /** Принадлежность игрока: строки сохраняются, лишние пробелы и пустые строки — нет. */
    function cleanNote(value, maxLength) {
        var text = String(value === null || value === undefined ? '' : value)
            .replace(/\r\n?/g, '\n')
            .split('\n')
            .map(function (line) {
                return line.replace(/[ \t\f\v]+/g, ' ').trim();
            })
            .join('\n')
            .replace(/\n{2,}/g, '\n')
            .trim();
        var limit = toInt(maxLength) || CONFIG.maxPlayerNoteLength;

        return text.length > limit ? text.slice(0, limit).trim() : text;
    }

    /** Пустая запись игрока. */
    function emptyPlayerInfo() {
        return { number: '', note: '' };
    }

    /** Данные игрока ('' — не заполнено). */
    function getPlayerInfo(data, teamId, player) {
        var card = (data && isPlainObject(data.playerInfo)) ? data.playerInfo[photoKey(teamId, player)] : null;

        if (!isPlainObject(card)) {
            return emptyPlayerInfo();
        }

        return {
            number: normalizePlayerNumber(card.number),
            note: cleanNote(card.note)
        };
    }

    /** Заполнена ли у игрока хотя бы одна из карточек данных. */
    function hasPlayerInfo(data, teamId, player) {
        var info = getPlayerInfo(data, teamId, player);

        return info.number !== '' || info.note !== '';
    }

    /** Записывает данные игрока; пустые значения убирают запись целиком. */
    function setPlayerInfo(data, teamId, player, info) {
        if (!isPlainObject(data)) {
            return data;
        }

        if (!isPlainObject(data.playerInfo)) {
            data.playerInfo = {};
        }

        var key = photoKey(teamId, player);

        if (!key || key.charAt(key.length - 1) === '|') {
            return data;
        }

        var number = normalizePlayerNumber(info && info.number);
        var value = { note: cleanNote(info && info.note) };

        // Номер не задан — ключа в данных нет (так записи остаются компактными)
        if (number !== '') {
            value.number = number;
        }

        if (number !== '' || value.note) {
            data.playerInfo[key] = value;
        } else {
            delete data.playerInfo[key];
        }

        return data;
    }

    /** Убирает данные игрока. */
    function removePlayerInfo(data, teamId, player) {
        return setPlayerInfo(data, teamId, player, emptyPlayerInfo());
    }

    /** Убирает данные всех игроков команды (при удалении команды). */
    function removeTeamPlayerInfo(data, teamId) {
        var cards = (data && isPlainObject(data.playerInfo)) ? data.playerInfo : {};
        var prefix = photoKey(teamId, '');

        Object.keys(cards).forEach(function (key) {
            if (key.indexOf(prefix) === 0) {
                delete cards[key];
            }
        });

        return data;
    }

    /** Переносит данные игрока на новое имя (при переименовании в составе). */
    function renamePlayerInfo(data, teamId, oldName, newName) {
        var info = getPlayerInfo(data, teamId, oldName);

        // Номер 0 — допустимый номер, поэтому сравниваем с пустой строкой, а не «на ложность»
        if (info.number === '' && !info.note) {
            return data;
        }

        removePlayerInfo(data, teamId, oldName);

        return setPlayerInfo(data, teamId, newName, info);
    }

    /**
     * Проверяет данные игрока из формы администратора.
     * Возвращает { ok: true, value } или { ok: false, error }.
     */
    function validatePlayerInfo(input) {
        var source = input || {};
        var rawNote = source.note === undefined || source.note === null ? '' : String(source.note);
        var rawNumber = source.number === undefined || source.number === null ? '' : String(source.number).trim();
        var number = normalizePlayerNumber(rawNumber);

        if (rawNumber !== '' && number === '') {
            return {
                ok: false,
                error: 'Игровой номер — целое число от 0 до ' + CONFIG.maxPlayerNumber
            };
        }

        if (rawNote.trim().length > CONFIG.maxPlayerNoteLength) {
            return {
                ok: false,
                error: 'Принадлежность — не больше ' + CONFIG.maxPlayerNoteLength + ' символов'
            };
        }

        return { ok: true, value: { number: number, note: cleanNote(rawNote) } };
    }

    /**
     * Приводит карту данных игроков к корректному виду: остаются только записи
     * оставшихся в заявке игроков, номер проверяется, длина текста ограничивается.
     * Прежнее поле birthDate (дата рождения) отбрасывается — оно больше не хранится.
     */
    function normalizePlayerInfo(rawInfo, teams) {
        var cards = {};

        if (rawInfo === undefined || rawInfo === null) {
            return { info: cards, repaired: false };
        }

        if (!isPlainObject(rawInfo)) {
            return { info: cards, repaired: true };
        }

        var repaired = false;

        Object.keys(rawInfo).forEach(function (key) {
            var value = rawInfo[key];
            var parts = String(key).split('|');
            var name = cleanText(parts.slice(1).join('|')).toLowerCase();
            var team = findTeam(teams, parts[0]);
            var inSquad = Boolean(team && name) && (team.players || []).some(function (player) {
                return cleanText(player).toLowerCase() === name;
            });

            if (!isPlainObject(value) || !inSquad) {
                repaired = true;
                return;
            }

            var number = normalizePlayerNumber(value.number);
            var note = cleanNote(value.note);
            var rawNote = value.note === undefined || value.note === null ? '' : String(value.note);
            var rawNumber = value.number === undefined || value.number === null ? '' : String(value.number).trim();

            // Прежнее поле birthDate (дата рождения) в данных больше не хранится:
            // его наличие — тоже исправление, при загрузке оно просто отбрасывается
            if (Object.prototype.hasOwnProperty.call(value, 'birthDate') ||
                (rawNumber !== '' && number === '') ||
                rawNote.trim().length > CONFIG.maxPlayerNoteLength) {
                repaired = true;
            }

            if (number !== '' || note) {
                var card = { note: note };

                // Номер записывается, только если он задан
                if (number !== '') {
                    card.number = number;
                }

                cards[photoKey(team.id, name)] = card;
            } else {
                // Запись без данных не нужна — это тоже исправление
                repaired = true;
            }
        });

        return { info: cards, repaired: repaired };
    }

    /**
     * Приводит карту фото к корректному виду: остаются только пути внутрь папки
     * фотографий у игроков, которые есть в заявке своей команды.
     */
    function normalizePhotos(rawPhotos, teams) {
        var photos = {};

        if (rawPhotos === undefined || rawPhotos === null) {
            return { photos: photos, repaired: false };
        }

        if (!isPlainObject(rawPhotos)) {
            return { photos: photos, repaired: true };
        }

        var repaired = false;

        Object.keys(rawPhotos).forEach(function (key) {
            var value = rawPhotos[key];

            if (!isValidPhotoPath(value)) {
                repaired = true;
                return;
            }

            var parts = String(key).split('|');
            var team = findTeam(teams, parts[0]);
            var name = cleanText(parts.slice(1).join('|')).toLowerCase();

            if (!team || !name) {
                repaired = true;
                return;
            }

            var inSquad = (team.players || []).some(function (player) {
                return cleanText(player).toLowerCase() === name;
            });

            if (!inSquad) {
                repaired = true;
                return;
            }

            photos[photoKey(team.id, name)] = value.trim();
        });

        return { photos: photos, repaired: repaired };
    }

    /* ------------------------------------------------------------------ */
    /* Дисциплина игроков: жёлтые карточки → красная, пропуск матча        */
    /* ------------------------------------------------------------------ */

    /**
     * Правила задаёт администратор в блоке «Настройки»:
     *   • yellowLimit — при получении какой по счёту жёлтой карточки игрок
     *     получает красную (жёлтые «превращаются» в неё);
     *   • yellowPeriodDays — за какой период считаются жёлтые (0 — весь турнир).
     * Красная карточка (прямая или полученная из жёлтых) означает пропуск
     * следующего матча команды.
     */

    /** Настройки дисциплины, приведённые к допустимому виду. */
    function normalizeDisciplineSettings(raw) {
        var source = isPlainObject(raw) ? raw : {};
        var limit = toInt(source.yellowLimit);
        var days = toInt(source.yellowPeriodDays);

        return {
            yellowLimit: (limit === null || limit < 1 || limit > CONFIG.maxYellowLimit)
                ? DEFAULT_DISCIPLINE.yellowLimit
                : limit,
            yellowPeriodDays: (days === null || days < 0 || days > CONFIG.maxYellowPeriodDays)
                ? DEFAULT_DISCIPLINE.yellowPeriodDays
                : days
        };
    }

    /** Правила дисциплины из данных (если их нет — значения по умолчанию). */
    function getDisciplineSettings(data) {
        return normalizeDisciplineSettings(data && data.settings);
    }

    /* --- Оформление сайта: второй стиль «Афиша матча» --- */

    /** Стиль оформления, приведённый к допустимому значению. */
    function normalizeTheme(value) {
        var id = String(value === undefined || value === null ? '' : value).trim().toLowerCase();

        return Object.prototype.hasOwnProperty.call(THEMES, id) ? id : DEFAULT_THEME;
    }

    /**
     * Полные настройки турнира: правила дисциплины и выбранное оформление.
     * Читать и записывать настройки нужно этой функцией: она не теряет ни один
     * раздел настроек, когда администратор меняет другой.
     */
    function normalizeSettings(raw) {
        var discipline = normalizeDisciplineSettings(raw);
        var source = isPlainObject(raw) ? raw : {};

        return {
            yellowLimit: discipline.yellowLimit,
            yellowPeriodDays: discipline.yellowPeriodDays,
            theme: normalizeTheme(source.theme)
        };
    }

    /** Все настройки из данных. */
    function getSettings(data) {
        return normalizeSettings(data && data.settings);
    }

    /** Выбранное оформление сайта. */
    function getTheme(data) {
        return getSettings(data).theme;
    }

    /** Записывает оформление сайта, не задевая остальные настройки. */
    function setTheme(data, theme) {
        if (!isPlainObject(data)) {
            return data;
        }

        data.settings = normalizeSettings({
            yellowLimit: getSettings(data).yellowLimit,
            yellowPeriodDays: getSettings(data).yellowPeriodDays,
            theme: normalizeTheme(theme)
        });

        return data;
    }

    /** Название оформления для интерфейса: «Классическое» или «Афиша матча». */
    function themeLabel(theme) {
        return THEMES[normalizeTheme(theme)];
    }

    /** Все доступные оформления по порядку: [{ id, label }]. */
    function themeList() {
        return Object.keys(THEMES).map(function (id) {
            return { id: id, label: THEMES[id] };
        });
    }

    /** Записывает правила дисциплины в данные (оформление сайта сохраняется). */
    function setDisciplineSettings(data, settings) {
        if (!isPlainObject(data)) {
            return data;
        }

        data.settings = normalizeSettings({
            yellowLimit: (settings || {}).yellowLimit,
            yellowPeriodDays: (settings || {}).yellowPeriodDays,
            theme: getSettings(data).theme
        });

        return data;
    }

    /** Проверяет правила дисциплины из формы администратора. */
    function validateDisciplineSettings(input) {
        var source = input || {};
        var limit = toInt(source.yellowLimit);
        var days = toInt(source.yellowPeriodDays);

        if (limit === null || limit < 1 || limit > CONFIG.maxYellowLimit) {
            return {
                ok: false,
                error: 'Сколько жёлтых карточек приводит к красной — целое число от 1 до ' + CONFIG.maxYellowLimit
            };
        }

        if (days === null || days < 0 || days > CONFIG.maxYellowPeriodDays) {
            return {
                ok: false,
                error: 'Период действия жёлтых — целое число дней от 0 до ' + CONFIG.maxYellowPeriodDays +
                    ' (0 — весь турнир)'
            };
        }

        return { ok: true, value: { yellowLimit: limit, yellowPeriodDays: days } };
    }

    /**
     * Русское окончание по числу: 1 день, 2 дня, 5 дней.
     * Исключение — 11…14: у них всегда третья форма (11 дней, 12 часов).
     */
    function pluralWord(count, one, few, many) {
        var value = Math.abs(toInt(count) || 0) % 100;
        var last = value % 10;

        if (value > 10 && value < 20) {
            return many;
        }

        if (last === 1) {
            return one;
        }

        return (last >= 2 && last <= 4) ? few : many;
    }

    /** «день», «дня» или «дней» — для периода действия карточек. */
    function daysWord(count) {
        return pluralWord(count, 'день', 'дня', 'дней');
    }

    /** Период словами: «за весь турнир» или «за 30 дней». */
    function disciplinePeriodText(settings) {
        var rules = normalizeDisciplineSettings(settings);

        return rules.yellowPeriodDays > 0
            ? 'за ' + rules.yellowPeriodDays + ' ' + daysWord(rules.yellowPeriodDays)
            : 'за весь турнир';
    }

    /** Правило дисквалификаций словами (подсказка в админке и на странице матча). */
    function disciplineRuleText(settings) {
        var rules = normalizeDisciplineSettings(settings);

        return rules.yellowLimit + '-я жёлтая карточка ' + disciplinePeriodText(rules) + ' превращается ' +
            'в красную, а любая красная карточка — пропуск следующего матча команды.';
    }

    /** Дата «ГГГГ-ММ-ДД», сдвинутая на days дней ('' — дата неизвестна). */
    function shiftISODate(value, days) {
        var date = parseISODate(value);

        if (!date) {
            return '';
        }

        date.setDate(date.getDate() + (toInt(days) || 0));

        return toISODate(date);
    }

    /**
     * Дисквалификации на каждый матч турнира.
     *
     * Матчи разбираются в календарном порядке, поэтому результат не зависит от того,
     * как записи лежат в данных: если администратор поправит дату, дисквалификация
     * сама «переедет» на другой матч. Пропущенный матч считается отбытым — дальше
     * игрок снова может играть, а счёт жёлтых после превращения в красную
     * начинается заново.
     *
     * Возвращает { settings, bans }: bans — «id матча» → список игроков,
     * которые этот матч пропускают (с причиной и матчем, где получена карточка).
     */
    function computeSuspensions(data) {
        var settings = getDisciplineSettings(data);
        var teams = (data && Array.isArray(data.teams)) ? data.teams : [];
        var matches = (data && Array.isArray(data.matches)) ? data.matches : [];
        var order = sortMatches(matches, 'asc');
        var bans = {};
        var state = {};

        var nameOf = function (player) {
            return cleanText(player, CONFIG.maxPlayerNameLength);
        };

        var keyOf = function (teamId, player) {
            return toInt(teamId) + '|' + nameOf(player).toLowerCase();
        };

        var stateOf = function (teamId, player) {
            var key = keyOf(teamId, player);

            if (!state[key]) {
                state[key] = { yellows: [], ban: null };
            }

            return state[key];
        };

        /** Жёлтые карточки, которые ещё действуют на дату матча (период из настроек). */
        var activeYellows = function (yellows, date) {
            var boundary = (settings.yellowPeriodDays > 0 && date)
                ? shiftISODate(date, -settings.yellowPeriodDays)
                : '';

            if (!boundary) {
                return yellows.slice();
            }

            return yellows.filter(function (item) {
                // Карточка без известной даты из периода не выпадает
                return !item || item >= boundary;
            });
        };

        /** Ближайший матч команды после матча с индексом index (null — матчей больше нет). */
        var nextMatchOf = function (teamId, index) {
            for (var i = index + 1; i < order.length; i++) {
                if (toInt(order[i].teamA) === toInt(teamId) || toInt(order[i].teamB) === toInt(teamId)) {
                    return toInt(order[i].id);
                }
            }

            return null;
        };

        /** Записывает дисквалификацию игрока на ближайший матч его команды. */
        var banPlayer = function (teamId, player, targetId, details) {
            var current = stateOf(teamId, player);

            if (toInt(targetId) === null) {
                // Матчей у команды больше нет — отбывать дисквалификацию не в чем
                current.ban = null;
                return;
            }

            var team = findTeam(teams, teamId);
            var entry = {
                teamId: toInt(teamId),
                teamName: team ? team.name : 'Неизвестная команда',
                player: nameOf(player),
                number: getPlayerInfo(data, teamId, player).number,
                reason: details.reason === 'yellow' ? 'yellow' : 'red',
                reasonText: details.reason === 'yellow'
                    ? settings.yellowLimit + '-я жёлтая карточка'
                    : 'красная карточка',
                yellowLimit: settings.yellowLimit,
                yellows: toInt(details.yellows) || 0,
                date: details.date || '',
                sourceMatchId: toInt(details.matchId),
                matchId: toInt(targetId)
            };

            if (!bans[entry.matchId]) {
                bans[entry.matchId] = [];
            }

            bans[entry.matchId].push(entry);
            current.ban = { matchId: entry.matchId };
        };

        order.forEach(function (match, index) {
            var matchId = toInt(match.id);
            var date = cleanText(match.date, 10);

            [toInt(match.teamA), toInt(match.teamB)].forEach(function (teamId) {
                var team = findTeam(teams, teamId);
                // Дисквалификация — только для игроков заявки: удалённого игрока
                // (его карточки остались в истории) пропускать некому
                var squad = (team && Array.isArray(team.players)) ? team.players : [];
                var squadNames = {};

                squad.forEach(function (player) {
                    var current = stateOf(teamId, player);

                    squadNames[nameOf(player).toLowerCase()] = true;

                    // Дисквалификация отбыта: этот матч игрок пропускал
                    if (current.ban && current.ban.matchId === matchId) {
                        current.ban = null;
                    }
                });

                // События матча — в том порядке, в каком их внёс администратор
                (Array.isArray(match.events) ? match.events : []).forEach(function (event) {
                    var player = nameOf(event.player);

                    if (toInt(event.team) !== teamId || !player || !squadNames[player.toLowerCase()]) {
                        return;
                    }

                    var current = stateOf(teamId, player);

                    if (event.type === 'yellow') {
                        current.yellows = activeYellows(current.yellows, date);
                        current.yellows.push(date);

                        if (current.yellows.length >= settings.yellowLimit) {
                            // Жёлтые превращаются в красную — пропуск следующего матча,
                            // а счёт жёлтых начинается заново
                            banPlayer(teamId, player, nextMatchOf(teamId, index), {
                                reason: 'yellow',
                                yellows: current.yellows.length,
                                date: date,
                                matchId: matchId
                            });
                            current.yellows = [];
                        }

                        return;
                    }

                    if (event.type === 'red') {
                        banPlayer(teamId, player, nextMatchOf(teamId, index), {
                            reason: 'red',
                            yellows: current.yellows.length,
                            date: date,
                            matchId: matchId
                        });
                    }
                });
            });
        });

        return { settings: settings, bans: bans };
    }

    /** Игроки, которые пропускают указанный матч (пустой список — никто). */
    function matchSuspensions(data, matchId) {
        var id = toInt(matchId);

        if (id === null) {
            return [];
        }

        return computeSuspensions(data).bans[id] || [];
    }

    /* ------------------------------------------------------------------ */
    /* Нормализация данных и хранилище                                     */
    /* ------------------------------------------------------------------ */

    /**
     * Приводит произвольные (в том числе повреждённые или устаревшие) данные
     * к корректной структуре. Возвращает { data, repaired, reason }.
     */
    function normalizeData(raw) {
        if (!isPlainObject(raw) || !Array.isArray(raw.teams) || !Array.isArray(raw.matches)) {
            return {
                data: createDefaultData(),
                repaired: true,
                reason: 'Данные не найдены или повреждены — загружены демонстрационные'
            };
        }

        var updatedAt = (typeof raw.updatedAt === 'string' && !Number.isNaN(Date.parse(raw.updatedAt)))
            ? raw.updatedAt
            : new Date().toISOString();
        var revision = toInt(raw.revision);

        if (revision === null || revision < 1) {
            revision = 1;
        }

        var repaired = false;
        var usedTeamIds = [];
        var usedTeamNames = [];
        var teams = [];

        raw.teams.forEach(function (team) {
            if (!isPlainObject(team)) {
                repaired = true;
                return;
            }

            var name = cleanText(team.name, CONFIG.maxTeamNameLength);

            if (!name || usedTeamNames.indexOf(name.toLowerCase()) !== -1) {
                repaired = true;
                return;
            }

            var id = toInt(team.id);

            if (id === null || id <= 0 || usedTeamIds.indexOf(id) !== -1) {
                id = nextFreeId(teams);
                repaired = true;
            }

            var players = [];
            var usedPlayerNames = [];

            (Array.isArray(team.players) ? team.players : []).forEach(function (player) {
                var playerName = cleanText(player, CONFIG.maxPlayerNameLength);

                if (!playerName || usedPlayerNames.indexOf(playerName.toLowerCase()) !== -1) {
                    repaired = true;
                    return;
                }

                usedPlayerNames.push(playerName.toLowerCase());
                players.push(playerName);
            });

            usedTeamIds.push(id);
            usedTeamNames.push(name.toLowerCase());
            teams.push({ id: id, name: name, players: players });
        });

        if (!teams.length) {
            // Пустой турнир — допустимое состояние (например, все команды удалили)
            return {
                data: {
                    version: CONFIG.dataVersion,
                    revision: revision,
                    updatedAt: updatedAt,
                    teams: [],
                    matches: [],
                    photos: {},
                    teamPhotos: {},
                    teamImages: {},
                    playerInfo: {},
                    settings: normalizeSettings(raw.settings)
                },
                repaired: repaired,
                reason: repaired ? 'Часть данных была исправлена автоматически' : ''
            };
        }

        var usedMatchIds = [];
        var matches = [];

        raw.matches.forEach(function (match) {
            if (!isPlainObject(match)) {
                repaired = true;
                return;
            }

            var teamA = toInt(match.teamA);
            var teamB = toInt(match.teamB);

            // Матч без существующих команд или «сам с собой» удаляем
            if (teamA === null || teamB === null || teamA === teamB ||
                usedTeamIds.indexOf(teamA) === -1 || usedTeamIds.indexOf(teamB) === -1) {
                repaired = true;
                return;
            }

            var id = toInt(match.id);

            if (id === null || id <= 0 || usedMatchIds.indexOf(id) !== -1) {
                id = nextFreeId(matches);
                repaired = true;
            }

            var date = typeof match.date === 'string' && parseISODate(match.date) ? match.date.trim() : '';
            if (!date) {
                repaired = true;
            }

            // Время необязательно; непонятную строку теряем и помечаем как исправление
            var time = normalizeMatchTime(match.time);
            if (!time && match.time !== undefined && match.time !== null && String(match.time).trim() !== '') {
                repaired = true;
            }

            var scoreA = normalizeScore(match.scoreA);
            var scoreB = normalizeScore(match.scoreB);
            var bothScoresValid = Number.isInteger(scoreA) && Number.isInteger(scoreB);

            if (!bothScoresValid) {
                if (scoreA !== null || scoreB !== null) {
                    // Раньше такой матч сохранялся с одним счётом и значение терялось
                    repaired = true;
                }

                scoreA = null;
                scoreB = null;
            }

            usedMatchIds.push(id);

            var events = normalizeMatchEvents(match.events, { teamA: teamA, teamB: teamB });

            if (events.repaired) {
                repaired = true;
            }

            matches.push({
                id: id,
                teamA: teamA,
                teamB: teamB,
                scoreA: scoreA,
                scoreB: scoreB,
                date: date,
                time: time,
                finished: bothScoresValid,
                events: events.events
            });
        });

        var normalizedPhotos = normalizePhotos(raw.photos, teams);
        var normalizedTeamPhotos = normalizeTeamPhotos(raw.teamPhotos, teams);
        var normalizedPlayerInfo = normalizePlayerInfo(raw.playerInfo, teams);
        var normalizedTeamImages = normalizeTeamImages(raw.teamImages, teams);
        var normalizedSettings = normalizeSettings(raw.settings);
        var rawSettings = isPlainObject(raw.settings) ? raw.settings : null;

        // Правила дисциплины записаны с ошибкой — молча исправляем и предупреждаем
        if (rawSettings) {
            var rawLimit = toInt(rawSettings.yellowLimit);
            var rawDays = toInt(rawSettings.yellowPeriodDays);

            if ((rawLimit !== null && rawLimit !== normalizedSettings.yellowLimit) ||
                (rawDays !== null && rawDays !== normalizedSettings.yellowPeriodDays)) {
                repaired = true;
            }

            // Оформление сайта: неизвестное значение (старые или испорченные данные)
            // заменяется обычным стилем — страница не должна «поехать» из-за настроек.
            if (rawSettings.theme !== undefined && rawSettings.theme !== null &&
                normalizeTheme(rawSettings.theme) !== String(rawSettings.theme)) {
                repaired = true;
            }
        }

        if (normalizedPhotos.repaired || normalizedTeamPhotos.repaired ||
            normalizedPlayerInfo.repaired || normalizedTeamImages.repaired) {
            repaired = true;
        }

        return {
            data: {
                version: CONFIG.dataVersion,
                revision: revision,
                updatedAt: updatedAt,
                teams: teams,
                matches: matches,
                photos: normalizedPhotos.photos,
                teamPhotos: normalizedTeamPhotos.photos,
                teamImages: normalizedTeamImages.images,
                playerInfo: normalizedPlayerInfo.info,
                settings: normalizedSettings
            },
            repaired: repaired,
            reason: repaired ? 'Часть данных была исправлена автоматически' : ''
        };
    }

    /**
     * Помечает данные как изменённые: увеличивает revision и обновляет updatedAt.
     * Вызывается при каждом сохранении — синхронизация по этим полям понимает,
     * какая версия документа новее (локальная, в репозитории или у другого устройства).
     */
    function touchData(data, now) {
        if (!isPlainObject(data)) {
            return data;
        }

        data.revision = (toInt(data.revision) || 0) + 1;
        data.updatedAt = (now instanceof Date ? now : new Date()).toISOString();

        return data;
    }

    /** Чтение данных из localStorage. Всегда возвращает корректную структуру (даже при сбое). */
    function loadFromStorage(storage) {

        if (!storage) {
            return {
                data: createDefaultData(),
                repaired: true,
                reason: 'Локальное хранилище недоступно — изменения не сохранятся',
                fresh: false,
                error: 'storage-unavailable'
            };
        }

        var raw = null;

        try {
            raw = storage.getItem(CONFIG.storageKey);
        } catch (error) {
            return {
                data: createDefaultData(),
                repaired: true,
                reason: 'Нет доступа к локальному хранилищу — изменения не сохранятся',
                fresh: false,
                error: 'storage-denied'
            };
        }

        // Первый запуск: данных ещё нет — тихо показываем демонстрационный набор
        if (raw === null || raw === '') {
            return {
                data: createDefaultData(),
                repaired: false,
                reason: '',
                fresh: true,
                error: ''
            };
        }

        var parsed = null;

        try {
            parsed = JSON.parse(raw);
        } catch (error) {
            // Раньше здесь падал весь скрипт, и страница оставалась пустой
            return {
                data: createDefaultData(),
                repaired: true,
                reason: 'Сохранённые данные повреждены — загружены демонстрационные',
                fresh: false,
                error: 'invalid-json'
            };
        }

        var normalized = normalizeData(parsed);

        return {
            data: normalized.data,
            repaired: normalized.repaired,
            reason: normalized.reason,
            fresh: false,
            error: ''
        };
    }

    /** Запись данных в localStorage. */
    function saveToStorage(storage, data) {
        if (!storage) {
            return { ok: false, error: 'Локальное хранилище недоступно — изменения не сохранятся' };
        }

        try {
            storage.setItem(CONFIG.storageKey, JSON.stringify(data));
            return { ok: true };
        } catch (error) {
            return { ok: false, error: 'Не удалось сохранить данные (хранилище недоступно или переполнено)' };
        }
    }

    /** Данные → текст JSON для экспорта. */
    function serializeData(data) {
        return JSON.stringify({
            version: CONFIG.dataVersion,
            exportedAt: new Date().toISOString(),
            teams: (data && data.teams) || [],
            matches: (data && data.matches) || [],
            photos: (data && data.photos) || {},
            teamPhotos: (data && data.teamPhotos) || {},
            teamImages: (data && data.teamImages) || {},
            playerInfo: (data && data.playerInfo) || {},
            settings: normalizeSettings(data && data.settings)
        }, null, 2);
    }

    /** Проверка и разбор импортируемого JSON. */
    function parseImport(text) {
        var parsed = null;

        try {
            parsed = JSON.parse(String(text));
        } catch (error) {
            return { ok: false, error: 'Файл не является корректным JSON' };
        }

        if (!isPlainObject(parsed) || !Array.isArray(parsed.teams) || !Array.isArray(parsed.matches)) {
            return { ok: false, error: 'В файле нет списков команд и матчей' };
        }

        var normalized = normalizeData(parsed);

        return { ok: true, data: normalized.data, repaired: normalized.repaired };
    }

    /* ------------------------------------------------------------------ */

    return {
        CONFIG: CONFIG,
        BADGE_COLORS: BADGE_COLORS,
        createDefaultData: createDefaultData,
        deepCopy: deepCopy,
        escapeHtml: escapeHtml,
        cleanText: cleanText,
        toInt: toInt,
        nextFreeId: nextFreeId,
        parseISODate: parseISODate,
        toISODate: toISODate,
        todayISO: todayISO,
        formatDate: formatDate,
        formatDateTime: formatDateTime,
        dateKey: dateKey,
        findTeam: findTeam,
        getTeamName: getTeamName,
        getTeamInitials: getTeamInitials,
        badgeColorForTeam: badgeColorForTeam,
        photoKey: photoKey,
        isValidPhotoPath: isValidPhotoPath,
        getPhoto: getPhoto,
        hasPhoto: hasPhoto,
        setPhoto: setPhoto,
        removePhoto: removePhoto,
        renamePlayerPhoto: renamePlayerPhoto,
        removeTeamPhotos: removeTeamPhotos,
        normalizePhotos: normalizePhotos,
        teamPhotoKey: teamPhotoKey,
        getTeamPhoto: getTeamPhoto,
        hasTeamPhoto: hasTeamPhoto,
        setTeamPhoto: setTeamPhoto,
        removeTeamPhoto: removeTeamPhoto,
        normalizeTeamPhotos: normalizeTeamPhotos,
        getTeamImages: getTeamImages,
        teamImagesLeft: teamImagesLeft,
        addTeamImage: addTeamImage,
        removeTeamImage: removeTeamImage,
        removeTeamImages: removeTeamImages,
        normalizeTeamImages: normalizeTeamImages,
        playerIndex: playerIndex,
        normalizePlayerNumber: normalizePlayerNumber,
        playerStats: playerStats,
        computeAllPlayers: computeAllPlayers,
        sortRows: sortRows,
        defaultSortDirection: defaultSortDirection,
        getPlayerInfo: getPlayerInfo,
        hasPlayerInfo: hasPlayerInfo,
        setPlayerInfo: setPlayerInfo,
        removePlayerInfo: removePlayerInfo,
        removeTeamPlayerInfo: removeTeamPlayerInfo,
        renamePlayerInfo: renamePlayerInfo,
        validatePlayerInfo: validatePlayerInfo,
        normalizePlayerInfo: normalizePlayerInfo,
        getDisciplineSettings: getDisciplineSettings,
        setDisciplineSettings: setDisciplineSettings,
        normalizeDisciplineSettings: normalizeDisciplineSettings,
        validateDisciplineSettings: validateDisciplineSettings,
        disciplinePeriodText: disciplinePeriodText,
        disciplineRuleText: disciplineRuleText,
        getSettings: getSettings,
        normalizeSettings: normalizeSettings,
        getTheme: getTheme,
        setTheme: setTheme,
        normalizeTheme: normalizeTheme,
        themeLabel: themeLabel,
        themeList: themeList,
        computeSuspensions: computeSuspensions,
        matchSuspensions: matchSuspensions,
        validateTeamName: validateTeamName,
        validatePlayerName: validatePlayerName,
        normalizeScore: normalizeScore,
        normalizeMatchTime: normalizeMatchTime,
        matchStart: matchStart,
        countdownLabel: countdownLabel,
        countdownParts: countdownParts,
        formatMatchWhen: formatMatchWhen,
        pluralWord: pluralWord,
        validateMatchInput: validateMatchInput,
        sha256Hex: sha256Hex,
        passwordMatches: passwordMatches,
        adminPasswordMatches: adminPasswordMatches,
        isFinished: isFinished,
        sortMatches: sortMatches,
        selectMatches: selectMatches,
        searchMatches: searchMatches,
        teamMatches: teamMatches,
        groupMatchesForAdmin: groupMatchesForAdmin,
        isEventType: isEventType,
        eventLabel: eventLabel,
        normalizeMatchEvents: normalizeMatchEvents,
        teamEvents: teamEvents,
        playerEventCount: playerEventCount,
        countTeamEvents: countTeamEvents,
        addEvent: addEvent,
        removeLastEvent: removeLastEvent,
        matchSquad: matchSquad,
        renamePlayerEvents: renamePlayerEvents,
        computeStandings: computeStandings,
        getStats: getStats,
        computePlayerStats: computePlayerStats,
        touchData: touchData,
        normalizeData: normalizeData,
        loadFromStorage: loadFromStorage,
        saveToStorage: saveToStorage,
        serializeData: serializeData,
        parseImport: parseImport
    };
});
