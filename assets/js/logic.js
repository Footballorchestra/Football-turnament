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
        dataVersion: 8,
        // Пароль администратора. Внимание: это демонстрационная защита,
        // на статическом хостинге реальную авторизацию без сервера сделать нельзя
        // (подробности — в README.md).
        adminPassword: 'admin',
        maxTeamNameLength: 30,
        maxPlayerNameLength: 40,
        // Принадлежность игрока — свободный текст (школа, клуб, тренер):
        // примерно 3–4 коротких предложения
        maxPlayerNoteLength: 200,
        maxScore: 99,
        recentMatches: 3,
        // Фото игроков лежат файлами в репозитории сайта, а в данных хранится путь
        photoPathPrefix: 'assets/photos/',
        maxPhotoPathLength: 120,
        // Сколько фотографий можно добавить одной команде (галерея на её странице)
        maxTeamImages: 6
    };

    /** Палитра бейджей команд (классы описаны в src/input.css). */
    var BADGE_COLORS = [
        'badge-color-1', 'badge-color-2', 'badge-color-3', 'badge-color-4',
        'badge-color-5', 'badge-color-6', 'badge-color-7', 'badge-color-8'
    ];

    /** Демонстрационный набор данных (первый запуск и сброс). */
    function createDefaultData() {
        return {
            version: CONFIG.dataVersion,
            revision: 1,
            updatedAt: new Date().toISOString(),
            photos: {},
            teamPhotos: {},
            // Фотографии команд (галереи): «id команды» → список путей к файлам
            teamImages: {},
            // Дата рождения и принадлежность игроков: ключ «команда|имя в нижнем регистре»
            playerInfo: {
                '1|иванов а.': {
                    birthDate: '2011-04-18',
                    note: 'Школа №5, первый тренер — Петров И. До 2023 года играл за «Динамо».'
                }
            },
            teams: [
                { id: 1, name: 'Спартак', players: ['Иванов А.', 'Петров П.', 'Сидоров С.'] },
                { id: 2, name: 'Локомотив', players: ['Кузнецов К.', 'Попов П.'] },
                { id: 3, name: 'Динамо', players: ['Смирнов Д.', 'Волков В.'] },
                { id: 4, name: 'ЦСКА', players: ['Михайлов М.', 'Новиков Н.'] }
            ],
            matches: [
                { id: 1, teamA: 1, teamB: 2, scoreA: 2, scoreB: 1, date: '2026-09-10', finished: true },
                { id: 2, teamA: 3, teamB: 4, scoreA: 1, scoreB: 1, date: '2026-09-11', finished: true },
                { id: 3, teamA: 1, teamB: 3, scoreA: null, scoreB: null, date: '2026-09-20', finished: false },
                { id: 4, teamA: 2, teamB: 4, scoreA: null, scoreB: null, date: '2026-09-21', finished: false }
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
                scoreA: finished ? scoreA : null,
                scoreB: finished ? scoreB : null,
                finished: finished
            }
        };
    }

    /** Проверка пароля администратора. */
    function adminPasswordMatches(value) {
        return String(value === null || value === undefined ? '' : value) === CONFIG.adminPassword;
    }

    /* ------------------------------------------------------------------ */
    /* Турнирная таблица и статистика                                      */
    /* ------------------------------------------------------------------ */

    function isFinished(match) {
        return !!match && match.finished === true &&
            Number.isInteger(match.scoreA) && Number.isInteger(match.scoreB);
    }

    /** Сортировка матчей по дате. order: 'asc' | 'desc'; матчи без даты всегда в конце. */
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

            return toInt(a.id) - toInt(b.id);
        });
    }

    /** Фильтр матчей для публичного списка: 'all' | 'finished' | 'upcoming'. */
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

        return sortMatches(list, 'desc');
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
     * Все игроки турнира (по всем командам): имя, команда, дата рождения и статистика.
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
                    birthDate: info.birthDate,
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
     * Тип значения для сортировки: «число» — голы и карточки, «дата» — дата рождения
     * («ГГГГ-ММ-ДД»), «текст» — имена игроков и названия команд.
     */
    var SORT_TYPES = {
        player: 'text',
        teamName: 'text',
        name: 'text',
        birthDate: 'date',
        goals: 'number',
        yellow: 'number',
        red: 'number',
        place: 'number'
    };

    /** Направление сортировки по умолчанию: числа — от большего, остальное — по алфавиту. */
    function defaultSortDirection(key) {
        return (SORT_TYPES[key] === 'number') ? 'desc' : 'asc';
    }

    /** Пустое значение (нет даты, нет данных) — такие строки всегда идут в конец списка. */
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
     * birthDate, goals…), options — { key, dir, type }. Строки без значения всегда
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
    /* Данные игрока: дата рождения и принадлежность                       */
    /* ------------------------------------------------------------------ */

    /**
     * Дата рождения хранится строкой «ГГГГ-ММ-ДД» (как даты матчей), а принадлежность —
     * свободный текст: школа, клуб, тренер. Её длина ограничена (CONFIG.maxPlayerNoteLength,
     * примерно 3–4 коротких предложения), чтобы карточка игрока оставалась аккуратной.
     *
     * Записи живут в отдельной карте playerInfo с тем же ключом, что и фото: «3|иванов а.».
     */

    /** Самая ранняя разумная дата рождения. */
    var MIN_BIRTH_YEAR = 1900;

    /** Дата рождения: «ГГГГ-ММ-ДД», существующая, не в будущем и не раньше 1900 года. */
    function isValidBirthDate(value, now) {
        if (typeof value !== 'string') {
            return false;
        }

        var text = value.trim();
        var date = parseISODate(text);

        if (!date || date.getFullYear() < MIN_BIRTH_YEAR) {
            return false;
        }

        return toISODate(date) <= toISODate(now instanceof Date ? now : new Date());
    }

    /** Сколько лет игроку (null — дата не указана). Возраст считается на дату now. */
    function playerAge(birthDate, now) {
        if (!isValidBirthDate(birthDate, now)) {
            return null;
        }

        var date = parseISODate(birthDate.trim());
        var today = now instanceof Date ? now : new Date();
        var age = today.getFullYear() - date.getFullYear();
        var months = today.getMonth() - date.getMonth();

        // День рождения в этом году ещё не наступил — год ещё не прибавился
        if (months < 0 || (months === 0 && today.getDate() < date.getDate())) {
            age -= 1;
        }

        return age;
    }

    /** «год», «года» или «лет» — для возраста. */
    function yearsWord(age) {
        var value = Math.abs(toInt(age) || 0) % 100;
        var last = value % 10;

        if (value > 10 && value < 20) {
            return 'лет';
        }

        if (last === 1) {
            return 'год';
        }

        return (last >= 2 && last <= 4) ? 'года' : 'лет';
    }

    /** «15 лет» — возраст словами ('' — дата не указана). */
    function formatAge(age) {
        var value = toInt(age);

        if (value === null || value < 0) {
            return '';
        }

        return value + ' ' + yearsWord(value);
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
        return { birthDate: '', note: '' };
    }

    /** Данные игрока ('' — не заполнено). */
    function getPlayerInfo(data, teamId, player) {
        var card = (data && isPlainObject(data.playerInfo)) ? data.playerInfo[photoKey(teamId, player)] : null;

        if (!isPlainObject(card)) {
            return emptyPlayerInfo();
        }

        return {
            birthDate: isValidBirthDate(card.birthDate) ? card.birthDate.trim() : '',
            note: cleanNote(card.note)
        };
    }

    /** Заполнена ли у игрока хотя бы одна из карточек данных. */
    function hasPlayerInfo(data, teamId, player) {
        var info = getPlayerInfo(data, teamId, player);

        return info.birthDate !== '' || info.note !== '';
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

        var value = {
            birthDate: isValidBirthDate(info && info.birthDate) ? String(info.birthDate).trim() : '',
            note: cleanNote(info && info.note)
        };

        if (value.birthDate || value.note) {
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

        if (!info.birthDate && !info.note) {
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
        var birthDate = cleanText(source.birthDate, 10);

        if (birthDate && !isValidBirthDate(birthDate)) {
            return { ok: false, error: 'Дата рождения — «ДД.ММ.ГГГГ», не в будущем и не раньше 1900 года' };
        }

        if (rawNote.trim().length > CONFIG.maxPlayerNoteLength) {
            return {
                ok: false,
                error: 'Принадлежность — не больше ' + CONFIG.maxPlayerNoteLength + ' символов'
            };
        }

        return { ok: true, value: { birthDate: birthDate, note: cleanNote(rawNote) } };
    }

    /**
     * Приводит карту данных игроков к корректному виду: остаются только записи
     * оставшихся в заявке игроков, дата проверяется, длина текста ограничивается.
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

            var birthDate = isValidBirthDate(value.birthDate) ? value.birthDate.trim() : '';
            var note = cleanNote(value.note);
            var rawNote = value.note === undefined || value.note === null ? '' : String(value.note);

            if ((value.birthDate && !birthDate) || rawNote.trim().length > CONFIG.maxPlayerNoteLength) {
                repaired = true;
            }

            if (birthDate || note) {
                cards[photoKey(team.id, name)] = { birthDate: birthDate, note: note };
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
                    playerInfo: {}
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
                finished: bothScoresValid,
                events: events.events
            });
        });

        var normalizedPhotos = normalizePhotos(raw.photos, teams);
        var normalizedTeamPhotos = normalizeTeamPhotos(raw.teamPhotos, teams);
        var normalizedPlayerInfo = normalizePlayerInfo(raw.playerInfo, teams);
        var normalizedTeamImages = normalizeTeamImages(raw.teamImages, teams);

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
                playerInfo: normalizedPlayerInfo.info
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
            playerInfo: (data && data.playerInfo) || {}
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
        isValidBirthDate: isValidBirthDate,
        playerAge: playerAge,
        yearsWord: yearsWord,
        formatAge: formatAge,
        playerIndex: playerIndex,
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
        validateTeamName: validateTeamName,
        validatePlayerName: validatePlayerName,
        normalizeScore: normalizeScore,
        validateMatchInput: validateMatchInput,
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
