/**
 * Слой представления: роутинг, отрисовка страниц и админ-панель.
 *
 * Вся «чистая» логика (расчёты, валидация, хранилище) находится в assets/js/logic.js
 * и доступна как window.FTLogic. Здесь — только DOM и события.
 *
 * Принципы:
 *   • никаких inline-скриптов и inline-стилей — это позволяет включить строгую CSP;
 *   • пользовательский ввод всегда экранируется (защита от XSS и «сломанной» вёрстки);
 *   • все изменения данных проходят через saveData() → localStorage + перерисовка.
 */
(function () {
    'use strict';

    var L = window.FTLogic;
    var S = window.FTSync;
    var P = window.FTPhoto;
    var CONFIG = L.CONFIG;
    var SETTINGS = window.FT_CONFIG || {};
    var PHOTO = SETTINGS.photo || {};
    var KEYS = SETTINGS.storageKeys || {
        token: 'ft.githubToken',
        autoPublish: 'ft.autoPublish',
        publishedAt: 'ft.publishedAt',
        localBackup: 'ft.localBackup',
        localEdits: 'ft.localEdits'
    };

    /** Состояние приложения (в хранилище попадает только state.data). */
    var state = {
        data: L.createDefaultData(),
        dataFromStorage: false,
        initialized: false,
        settingsOpen: false,
        storage: null,
        storageAvailable: true,
        admin: false,
        route: 'home',
        matchesFilter: 'all',
        /** Открытый матч на публичной странице матчей (null — показывается список). */
        publicMatchId: null,
        /** Открытая команда на публичной странице команд (null — показывается список). */
        publicTeamId: null,
        /** Открытый игрок: команда и номер в заявке (null — карточка игрока не открыта). */
        publicPlayerTeamId: null,
        publicPlayerIndex: null,
        /** Стек посещённых страниц для кнопки «Назад» (в памяти, до перезагрузки). */
        history: [],
        /** Предпросмотр только что загруженных фото: путь → data-URL (до появления файла на сайте). */
        photoPreviews: {},
        /** Сколько раз пытались догрузить картинку: путь → число попыток. */
        photoRetries: {},
        /** Игрок, чьё фото сейчас загружается: { teamId, index } (null — никто). */
        photoBusy: null,
        /* Турнирная таблица: компактный вид (без горизонтальной прокрутки).
           Влияет только на телефонах — остальные размеры экрана показывают все столбцы. */
        standingsCompact: true,
        editingTeamId: null,
        editingMatchId: null,
        editingPlayer: null,
        /** Игрок, чью дату рождения и принадлежность заполняет администратор: { teamId, index }. */
        editingPlayerInfo: null,
        /** Открытая команда в разделе «Команды» (null — показывается список команд). */
        selectedTeamId: null,
        /** Открытый матч в разделе «Матчи» (null — показывается список матчей). */
        openMatchId: null,
        /** Открытый раздел админки: «Команды» или «Матчи» (см. ADMIN_TABS). */
        adminTab: 'teams'
    };

    /**
     * Состояние синхронизации с репозиторием GitHub.
     * Токен и метка последней публикации живут только в localStorage этого устройства.
     */
    /** Состояние синхронизации с репозиторием GitHub. */
    var sync = {
        client: null,
        token: '',
        sha: null,
        publishedAt: '',
        autoPublish: false,
        publishing: false,
        pullCompleted: false,
        lastAction: '',
        lastError: '',
        lastPullError: '',
        lastCommitUrl: '',
        timer: null,
        refreshTimer: null
    };

    /* ================================================================== */
    /* Настройки синхронизации и токен (локально на устройстве)           */
    /* ================================================================== */

    function readStoredValue(key) {
        try {
            return state.storage ? state.storage.getItem(key) : null;
        } catch (error) {
            return null;
        }
    }

    function writeStoredValue(key, value) {
        try {
            if (!state.storage) {
                return;
            }

            if (value === null || value === undefined) {
                state.storage.removeItem(key);
            } else {
                state.storage.setItem(key, String(value));
            }
        } catch (error) {
            // приватный режим браузера — просто игнорируем
        }
    }

    function readSyncSettings() {
        sync.token = readStoredValue(KEYS.token) || '';
        sync.publishedAt = readStoredValue(KEYS.publishedAt) || '';

        var storedAuto = readStoredValue(KEYS.autoPublish);
        sync.autoPublish = storedAuto === null ? Boolean(sync.token) : storedAuto === '1';
    }

    function createSyncClient() {
        if (!S || typeof S.createClient !== 'function') {
            return null;
        }

        return S.createClient({
            github: SETTINGS.github,
            getToken: function () { return sync.token; },
            fetch: (typeof window.fetch === 'function') ? window.fetch.bind(window) : undefined
        });
    }

    /**
     * Есть ли на устройстве правки, которые ещё не попали в репозиторий.
     * Отметка ставится при каждом изменении и снимается после публикации
     * или после загрузки версии из репозитория.
     */
    function hasUnpublishedEdits() {
        return Boolean(readStoredValue(KEYS.localEdits));
    }

    function markUnpublishedEdits() {
        writeStoredValue(KEYS.localEdits, state.data.updatedAt || new Date().toISOString());
    }

    function clearUnpublishedEdits() {
        writeStoredValue(KEYS.localEdits, null);
    }

    function isDirty() {
        return Boolean(state.admin && hasUnpublishedEdits());
    }

    function schedulePublish() {
        if (!sync.autoPublish || !sync.token || !sync.client) {
            return;
        }

        if (sync.timer) {
            window.clearTimeout(sync.timer);
        }

        var delay = Number(SETTINGS.autoPublishDelayMs);
        if (!Number.isFinite(delay) || delay < 0) {
            delay = 12000;
        }

        sync.timer = window.setTimeout(function () {
            sync.timer = null;
            publishNow({ silent: true });
        }, delay);
    }

    /* ================================================================== */
    /* Небольшие помощники DOM                                            */
    /* ================================================================== */

    function $(id) {
        return document.getElementById(id);
    }

    function qsa(selector) {
        return Array.prototype.slice.call(document.querySelectorAll(selector));
    }

    function esc(value) {
        return L.escapeHtml(value);
    }

    /** Иконка из инлайнового SVG-спрайта (см. index.html). */
    function icon(name, extraClass) {
        return '<svg class="icon' + (extraClass ? ' ' + extraClass : '') + '" aria-hidden="true"><use href="#i-' +
            esc(name) + '"></use></svg>';
    }

    function teamBadge(team, small) {
        if (!team) {
            return '';
        }

        return '<span class="team-badge ' + L.badgeColorForTeam(team.id) + (small ? ' team-badge-sm' : '') +
            '" aria-hidden="true">' + esc(L.getTeamInitials(team.name)) + '</span>';
    }

    function statusPill(match) {
        return match.finished
            ? '<span class="status-pill finished">' + icon('check') + 'Завершён</span>'
            : '<span class="status-pill upcoming">' + icon('clock') + 'Предстоит</span>';
    }

    /* ================================================================== */
    /* Фото игроков                                                       */
    /* ================================================================== */

    /** Настройки подготовки фото: значения по умолчанию — в assets/js/photo.js. */
    function photoSettings() {
        return {
            folder: PHOTO.folder,
            maxSize: PHOTO.maxSize,
            quality: PHOTO.quality,
            maxSourceBytes: PHOTO.maxSourceBytes,
            maxResultBytes: PHOTO.maxResultBytes
        };
    }

    /**
     * Адрес фото игрока для <img>. Только что загруженное фото появляется на сайте
     * не сразу (публикация занимает около минуты), поэтому до перезагрузки страницы
     * показываем локальный предпросмотр из памяти.
     */
    function photoUrl(teamId, player) {
        var path = L.getPhoto(state.data, teamId, player);

        if (!path) {
            return '';
        }

        return state.photoPreviews[path] || path;
    }

    /** Есть ли у игрока фото (учитывая только что загруженное). */
    function hasPlayerPhoto(teamId, player) {
        return photoUrl(teamId, player) !== '';
    }

    /** Адрес эмблемы команды (или только что загруженной — из памяти). */
    function teamPhotoUrl(teamId) {
        var path = L.getTeamPhoto(state.data, teamId);

        if (!path) {
            return '';
        }

        return state.photoPreviews[path] || path;
    }

    /** Есть ли у команды эмблема. */
    function hasTeamPhoto(teamId) {
        return teamPhotoUrl(teamId) !== '';
    }

    /**
     * Эмблема команды, а если её нет — бейдж с инициалами.
     * options: { small } — 32 px, { big } — 56 px, иначе 40 px.
     */
    function teamAvatar(team, options) {
        if (!team) {
            return '';
        }

        var opts = options || {};
        var side = opts.big ? 56 : (opts.small ? 32 : 40);
        var className = 'team-photo' + (opts.big ? ' team-photo-lg' : (opts.small ? ' team-photo-sm' : ''));
        var url = teamPhotoUrl(team.id);

        if (url) {
            return photoImage(url, {
                className: className,
                side: side,
                path: L.getTeamPhoto(state.data, team.id),
                fallbackClass: 'team-badge ' + L.badgeColorForTeam(team.id) +
                    (opts.big ? ' team-badge-lg' : (opts.small ? ' team-badge-sm' : '')),
                fallbackText: L.getTeamInitials(team.name)
            });
        }

        return teamBadge(team, opts.small);
    }

    /**
     * Паузы перед повторной попыткой догрузить картинку, миллисекунды.
     * Публикация файла на сайте занимает около минуты: за это время фото успевает
     * появиться, а без повторов браузер запомнил бы ответ 404 и показал «сломанную»
     * картинку ещё долго после публикации.
     */
    function photoRetryDelays() {
        var delays = PHOTO.retryDelays;

        return Array.isArray(delays) && delays.length ? delays : [4000, 15000, 45000];
    }

    /**
     * Картинка аватара. Для файлов из репозитория добавляем служебные атрибуты:
     * путь (для повторной попытки) и запасной бейдж с инициалами.
     */
    function photoImage(url, options) {
        var opts = options || {};
        var size = ' alt="" loading="lazy" width="' + opts.side + '" height="' + opts.side + '"';
        var local = String(url).indexOf('data:') === 0;

        // Предпросмотр из памяти (data:…) всегда на месте — повторять нечего
        if (local) {
            return '<img class="' + opts.className + '" src="' + esc(url) + '"' + size + '>';
        }

        return '<img class="' + opts.className + ' photo-retry" src="' + esc(url) + '"' + size +
            ' data-photo-path="' + esc(opts.path) + '"' +
            ' data-fallback-class="' + esc(opts.fallbackClass) + '"' +
            ' data-fallback-text="' + esc(opts.fallbackText) + '">';
    }

    /** Картинка не загрузилась: пробуем ещё раз (с обходом кэша), затем показываем инициалы. */
    function handlePhotoError(image) {
        var path = image.getAttribute('data-photo-path') || '';
        var delays = photoRetryDelays();
        var attempt = (state.photoRetries[path] || 0) + 1;
        var delay = attempt <= delays.length ? delays[attempt - 1] : 0;

        state.photoRetries[path] = attempt;

        if (delay && image.isConnected) {
            window.setTimeout(function () {
                if (image.isConnected) {
                    // ?t= — обход кэша: 404 запомнился бы браузером на 10 минут
                    image.setAttribute('src', path + '?t=' + Date.now());
                }
            }, delay);

            return;
        }

        // Файл так и не появился — вместо «сломанной» картинки показываем инициалы
        if (image.parentNode) {
            var fallback = document.createElement('span');

            fallback.className = image.getAttribute('data-fallback-class') || '';
            fallback.setAttribute('aria-hidden', 'true');
            fallback.textContent = image.getAttribute('data-fallback-text') || '';

            image.parentNode.replaceChild(fallback, image);
        }
    }

    /** Подписка на ошибки загрузки картинок (событие error не всплывает — слушаем перехват). */
    function bindPhotoRetries() {
        document.addEventListener('error', function (event) {
            var image = event.target;

            if (!image || image.tagName !== 'IMG' || !image.classList || !image.classList.contains('photo-retry')) {
                return;
            }

            handlePhotoError(image);
        }, true);
    }

    /**
     * Аватар игрока: фото, а если его нет — кружок с инициалами.
     * options: { small } — 24 px (списки), без флага — 36 px, { big } — 48 px,
     * { detail } — 144 px (крупное фото в карточке игрока).
     */
    function playerAvatar(teamId, player, options) {
        var opts = options || {};
        var side = opts.detail ? 144 : (opts.big ? 48 : (opts.small ? 24 : 36));
        var className = 'player-avatar' + (opts.detail
            ? ' player-avatar-xl'
            : (opts.big ? ' player-avatar-lg' : (opts.small ? ' player-avatar-sm' : '')));
        var url = photoUrl(teamId, player);

        if (url) {
            return photoImage(url, {
                className: className,
                side: side,
                path: L.getPhoto(state.data, teamId, player),
                fallbackClass: className + ' player-avatar-empty',
                fallbackText: L.getTeamInitials(player)
            });
        }

        return '<span class="' + className + ' player-avatar-empty" aria-hidden="true">' +
            esc(L.getTeamInitials(player)) + '</span>';
    }

    /**
     * Игрок ссылкой на свою карточку: фото и имя открывают карточку игрока.
     * options.innerHTML — готовое содержимое (аватар и имя), options.className —
     * дополнительные классы ссылки («chip chip-player», «squad-player» и т. п.).
     * Если игрока нет в заявке (например, его удалили, а записи в матчах остались),
     * выводится просто текст: открывать нечего.
     */
    function playerLink(team, player, options) {
        var opts = options || {};
        var index = L.playerIndex(team, player);
        var inner = opts.innerHTML === undefined ? esc(player) : opts.innerHTML;

        if (!team || index < 0) {
            return opts.className
                ? '<span class="' + opts.className + '">' + inner + '</span>'
                : inner;
        }

        return '<a class="player-link' + (opts.className ? ' ' + opts.className : '') + '" href="' +
            playerHash(team.id, index) + '" data-action="player-public-open" data-team="' + L.toInt(team.id) +
            '" data-index="' + index + '" title="Открыть карточку игрока: ' + esc(player) + '">' + inner + '</a>';
    }

    /** Кнопка выбора файла: label + скрытый input (без inline-скриптов, CSP не нарушается). */
    function photoInput(teamId, index, player, hasPhoto) {
        var label = hasPhoto ? 'Заменить фото' : 'Загрузить фото';

        return '<label class="btn btn-sm btn-ghost" title="' + esc(label) + '">' +
            icon('photo') +
            '<input type="file" class="sr-only" accept="image/*" data-photo-team="' + L.toInt(teamId) +
                '" data-photo-index="' + index + '" aria-label="' + esc(label + ': ' + player) + '">' +
        '</label>';
    }

    /**
     * Общая загрузка фото (игрока или эмблемы команды): сжатие в браузере →
     * файл в репозиторий → путь в данных. Это два отдельных коммита: сначала
     * картинка, потом ссылка на неё в data.json (публикуется как обычно, saveData).
     *
     * options: { kind, teamId, index, name, prefix, action, done, apply }
     *   kind   — 'player' или 'team' (для индикатора «Загружаю…»),
     *   name   — имя для файла и текстов, prefix — префикс имени файла (team-),
     *   action — текст коммита файла, done — сообщение после загрузки,
     *   apply  — записывает готовый путь в данные.
     */
    function uploadPhoto(file, options) {
        var opts = options || {};
        var team = L.findTeam(state.data.teams, opts.teamId);

        if (!team || !file) {
            return;
        }

        if (!sync.client) {
            toast('Синхронизация с репозиторием недоступна', 'error');
            return;
        }

        if (!String(sync.token || '').trim()) {
            toast('Сначала сохраните токен GitHub в «Настройках» — без него фото не попадут в репозиторий', 'error');
            return;
        }

        if (!P || typeof P.prepare !== 'function') {
            toast('Браузер не поддерживает подготовку фотографий', 'error');
            return;
        }

        state.photoBusy = {
            kind: opts.kind || 'player',
            teamId: L.toInt(team.id),
            index: opts.index === undefined ? null : opts.index
        };
        renderAdmin();

        var settings = photoSettings();

        settings.teamId = L.toInt(team.id);
        settings.player = opts.name || team.name;
        settings.prefix = opts.prefix || '';

        P.prepare(file, settings)
            .then(function (prepared) {
                if (!prepared.ok) {
                    return { ok: false, error: prepared.error };
                }

                return sync.client.uploadFile(prepared.path, prepared.base64, opts.action).then(function (result) {
                    if (result.ok) {
                        result.path = prepared.path;
                        result.bytes = prepared.bytes;
                        result.preview = 'data:' + (prepared.mime || 'image/jpeg') + ';base64,' + prepared.base64;
                    }

                    return result;
                });
            })
            .then(function (result) {
                state.photoBusy = null;

                if (!result || !result.ok) {
                    renderAdmin();
                    toast((result && result.error) || 'Не удалось загрузить фото', 'error');
                    return;
                }

                // Файл на сайте появится через минуту: до перезагрузки показываем его из памяти
                state.photoPreviews[result.path] = result.preview;

                opts.apply(result.path);

                if (result.htmlUrl) {
                    sync.lastCommitUrl = result.htmlUrl;
                }

                saveData(opts.done + ' (' + P.formatBytes(result.bytes) +
                    ') — файл появится на сайте через ~минуту');
            });
    }

    /** Загрузка фото игрока. */
    function uploadPlayerPhoto(teamId, index, file) {
        var team = L.findTeam(state.data.teams, teamId);
        var player = (team && team.players[index] !== undefined) ? team.players[index] : '';

        if (!team || !player) {
            toast('Игрок не найден', 'error');
            return;
        }

        uploadPhoto(file, {
            kind: 'player',
            teamId: team.id,
            index: index,
            name: player,
            prefix: '',
            action: 'Фото игрока «' + player + '» (' + team.name + ')',
            done: 'Фото игрока «' + player + '» загружено',
            apply: function (path) {
                L.setPhoto(state.data, team.id, player, path);
            }
        });
    }

    /** Загрузка эмблемы (фото) команды. */
    function uploadTeamPhoto(teamId, file) {
        var team = L.findTeam(state.data.teams, teamId);

        if (!team) {
            toast('Команда не найдена', 'error');
            return;
        }

        uploadPhoto(file, {
            kind: 'team',
            teamId: team.id,
            index: null,
            name: team.name,
            prefix: 'team-',
            action: 'Эмблема команды «' + team.name + '»',
            done: 'Эмблема команды «' + team.name + '» загружена',
            apply: function (path) {
                L.setTeamPhoto(state.data, team.id, path);
            }
        });
    }

    /** Убирает фото игрока из данных (сам файл остаётся в истории репозитория). */
    function removePlayerPhoto(teamId, index) {
        var team = L.findTeam(state.data.teams, teamId);
        var player = (team && team.players[index] !== undefined) ? team.players[index] : '';

        if (!team || !player) {
            return;
        }

        if (!L.hasPhoto(state.data, team.id, player)) {
            toast('У игрока «' + player + '» нет фото');
            return;
        }

        if (!askConfirm('Убрать фото игрока «' + player + '»?\n\n' +
            'Сам файл останется в истории репозитория — при необходимости его можно вернуть.')) {
            return;
        }

        var path = L.getPhoto(state.data, team.id, player);

        delete state.photoPreviews[path];
        L.removePhoto(state.data, team.id, player);

        saveData('Фото игрока «' + player + '» убрано');
    }

    /** Убирает эмблему команды из данных (сам файл остаётся в истории репозитория). */
    function removeTeamPhoto(teamId) {
        var team = L.findTeam(state.data.teams, teamId);

        if (!team) {
            return;
        }

        if (!L.hasTeamPhoto(state.data, team.id)) {
            toast('У команды «' + team.name + '» нет эмблемы');
            return;
        }

        if (!askConfirm('Убрать эмблему команды «' + team.name + '»?\n\n' +
            'Сам файл останется в истории репозитория — при необходимости его можно вернуть.')) {
            return;
        }

        var path = L.getTeamPhoto(state.data, team.id);

        delete state.photoPreviews[path];
        L.removeTeamPhoto(state.data, team.id);

        saveData('Эмблема команды «' + team.name + '» убрана');
    }

    /* ================================================================== */
    /* Уведомления и сообщения об ошибках                                 */
    /* ================================================================== */

    function toast(message, type) {
        var container = $('toast-container');

        if (!container) {
            return;
        }

        var kind = type || 'info';
        var icons = { success: 'check', error: 'alert', info: 'info' };
        var element = document.createElement('div');

        element.className = 'toast toast-' + kind;
        element.setAttribute('role', kind === 'error' ? 'alert' : 'status');
        element.innerHTML = icon(icons[kind] || 'info') + '<span>' + esc(message) + '</span>';
        container.appendChild(element);

        window.setTimeout(function () {
            if (element.parentNode) {
                element.parentNode.removeChild(element);
            }
        }, 5000);
    }

    function setFieldError(elementId, message) {
        var element = $(elementId);

        if (element) {
            element.textContent = message || '';
        }
    }

    function showDataBanner(reason) {
        var banner = $('data-warning');

        if (!banner || !reason) {
            return;
        }

        banner.className = 'banner banner-warning mb-6';
        banner.hidden = false;
        banner.innerHTML = icon('alert') +
            '<span class="flex-1">' + esc(reason) + '</span>' +
            '<button type="button" class="btn btn-sm btn-secondary" data-action="hide-banner">Понятно</button>';
    }

    /* ================================================================== */
    /* Работа с хранилищем                                                */
    /* ================================================================== */

    function getStorage(kind) {
        try {
            return kind === 'session' ? window.sessionStorage : window.localStorage;
        } catch (error) {
            return null;
        }
    }

    /**
     * Сохранение данных + полная перерисовка + необязательное уведомление.
     * options.publish === false — данные пришли из репозитория, публиковать их не нужно.
     */
    function saveData(message, options) {
        var opts = options || {};
        var isLocalChange = opts.publish !== false;

        if (isLocalChange) {
            L.touchData(state.data);
            sync.lastAction = message || sync.lastAction;
            markUnpublishedEdits();
        }

        var result = L.saveToStorage(state.storage, state.data);
        state.storageAvailable = result.ok;
        state.dataFromStorage = true;

        if (!result.ok && result.error) {
            toast(result.error, 'error');
        }

        renderAll();
        renderSyncStatus();

        if (isLocalChange) {
            schedulePublish();
        }

        if (message) {
            toast(message, 'success');
        }

        return result.ok;
    }

    /* ================================================================== */
    /* Синхронизация с репозиторием: статус и чтение                      */
    /* ================================================================== */

    /**
     * Показывает или скрывает блок настроек публикации.
     * Блок живёт в шапке админки за кнопкой «Настройки», а короткий статус
     * публикации всегда виден рядом с ней (см. renderSyncIndicator).
     */
    function renderAdminSettings() {
        var panel = $('admin-settings');
        var button = $('admin-settings-button');

        if (panel) {
            panel.hidden = !state.settingsOpen;
        }

        if (button) {
            button.setAttribute('aria-expanded', state.settingsOpen ? 'true' : 'false');
            button.classList.toggle('btn-primary', state.settingsOpen);
            button.classList.toggle('btn-ghost', !state.settingsOpen);
        }

        if (state.settingsOpen) {
            fillSyncInputs();
        }

        // Обновляет содержимое панели и короткий статус в шапке
        renderSyncStatus();
    }

    function toggleAdminSettings() {
        state.settingsOpen = !state.settingsOpen;
        renderAdminSettings();
    }

    function openAdminSettings() {
        if (!state.settingsOpen) {
            state.settingsOpen = true;
        }

        renderAdminSettings();
    }

    /** Короткая строка о публикации в шапке админки: видна даже с закрытыми настройками. */
    function renderSyncIndicator() {
        var indicator = $('sync-indicator');

        if (!indicator) {
            return;
        }

        var text;
        var iconName = 'info';

        if (!sync.token) {
            text = 'Публикация не настроена';
            iconName = 'alert';
        } else if (sync.publishing) {
            text = 'Публикуем…';
            iconName = 'upload';
        } else if (sync.lastError) {
            text = 'Ошибка публикации';
            iconName = 'alert';
        } else if (isDirty()) {
            text = 'Есть неопубликованные изменения';
            iconName = 'alert';
        } else if (sync.publishedAt) {
            var published = new Date(sync.publishedAt);
            text = 'Опубликовано в ' + String(published.getHours()).padStart(2, '0') + ':' +
                String(published.getMinutes()).padStart(2, '0');
            iconName = 'check';
        } else {
            text = 'Готово к публикации';
        }

        indicator.innerHTML = icon(iconName) + '<span>' + esc(text) + '</span>';
        indicator.setAttribute('title', text + ' — открыть настройки публикации');
    }

    /** Строка состояния синхронизации в админке и подпись «данные обновлены» в подвале. */
    function renderSyncStatus() {
        var freshness = $('data-freshness');
        var statusElement = $('sync-status');
        var restoreButton = $('github-restore');
        var updatedLabel = state.data.updatedAt ? L.formatDateTime(state.data.updatedAt) : '';

        if (freshness) {
            freshness.textContent = updatedLabel
                ? 'Данные обновлены: ' + updatedLabel + (sync.lastPullError ? ' (нет связи с репозиторием)' : '')
                : '';
        }

        if (restoreButton) {
            restoreButton.hidden = !hasLocalBackup();
        }

        if (!statusElement) {
            return;
        }

        var parts = [];

        if (!sync.token) {
            parts.push('Токен не задан — изменения видны только на этом устройстве.');
        } else if (sync.publishing) {
            parts.push('Публикуем изменения…');
        } else if (sync.lastError) {
            parts.push('Не удалось опубликовать: ' + sync.lastError + '.');
        } else if (isDirty()) {
            parts.push(sync.autoPublish
                ? 'Есть неопубликованные изменения: публикация произойдёт автоматически.'
                : 'Есть неопубликованные изменения — нажмите «Опубликовать сейчас».');
        } else if (sync.publishedAt) {
            parts.push('Опубликовано: ' + L.formatDateTime(sync.publishedAt) + '.');
        } else {
            parts.push('Всё готово к публикации.');
        }

        if (!sync.lastError && updatedLabel) {
            parts.push('Версия данных: ' + updatedLabel + '.');
        }

        if (sync.lastPullError) {
            parts.push('Чтение из репозитория: ' + sync.lastPullError + '.');
        }

        statusElement.innerHTML = esc(parts.join(' ')) +
            (sync.lastCommitUrl
                ? ' <a class="underline hover:text-white" href="' + esc(sync.lastCommitUrl) +
                    '" target="_blank" rel="noopener noreferrer">Открыть коммит</a>'
                : '');

        renderSyncIndicator();
    }

    /** Заполняет поля блока «Публикация» текущими настройками (токен в разметку не подставляем). */
    function fillSyncInputs() {
        var checkbox = $('github-auto');
        var tokenInput = $('github-token');

        if (checkbox) {
            checkbox.checked = sync.autoPublish;
        }

        if (tokenInput) {
            tokenInput.value = '';
            tokenInput.placeholder = sync.token
                ? 'Токен сохранён — введите новый, чтобы заменить'
                : 'github_pat_…';
        }
    }

    /* --- Резервная копия перед заменой данных версией из репозитория --- */

    function saveLocalBackup(data) {
        try {
            writeStoredValue(KEYS.localBackup, JSON.stringify(data));
            return true;
        } catch (error) {
            return false;
        }
    }

    function hasLocalBackup() {
        return Boolean(readStoredValue(KEYS.localBackup));
    }

    /** Возвращает данные из резервной копии (если она есть) как локальные изменения. */
    function restoreLocalBackup() {
        var raw = readStoredValue(KEYS.localBackup);

        if (!raw) {
            toast('Резервной копии нет', 'error');
            return;
        }

        var parsed = L.parseImport(raw);

        if (!parsed.ok) {
            toast('Не удалось прочитать резервную копию: ' + parsed.error, 'error');
            return;
        }

        if (!askConfirm('Вернуть данные из резервной копии (' + L.formatDateTime(parsed.data.updatedAt) + ')?\n' +
                'Текущие данные будут заменены. После проверки нажмите «Опубликовать сейчас».')) {
            return;
        }

        state.data = parsed.data;
        L.touchData(state.data); // чтобы копия считалась новым изменением и её можно было опубликовать
        saveData('Данные восстановлены из резервной копии');
    }

    /**
     * Чтение данных из репозитория и обновление страницы.
     *
     * Данные репозитория считаются главными, но если на устройстве администратора есть
     * отличающиеся данные, приложение сначала спросит и сохранит копию — потерять правки нельзя.
     */
    function pullFromRepository(options) {
        var opts = options || {};

        if (!sync.client) {
            return Promise.resolve({ ok: false, error: 'Синхронизация недоступна' });
        }

        return sync.client.pull(Date.now()).then(function (result) {
            if (!result.ok) {
                sync.lastPullError = result.error;
                sync.pullCompleted = true;
                renderSyncStatus();

                if (opts.verbose) {
                    toast('Не удалось получить данные из репозитория: ' + result.error, 'error');
                }

                return result;
            }

            sync.lastPullError = '';
            sync.pullCompleted = true;

            // Данные уже совпадают — ничего не меняем
            if (S.documentsEqual(state.data, result.data)) {
                sync.publishedAt = result.data.updatedAt || sync.publishedAt;
                sync.lastError = '';
                clearUnpublishedEdits();
                writeStoredValue(KEYS.publishedAt, sync.publishedAt);
                renderSyncStatus();

                if (opts.verbose) {
                    toast('Данные уже совпадают с версией в репозитории', 'info');
                }

                return result;
            }

            // Фоновые обновления не трогают неопубликованные правки
            var localTime = S.timestampOf(state.data);
            var remoteTime = S.timestampOf(result.data);

            // Данные считаются «работой пользователя», если на устройстве есть отметка
            // о неопубликованных правках либо из хранилища загружена версия новее репозитория.
            // Только что созданные демонстрационные данные к таким не относятся.
            var localNewer = localTime > remoteTime;
            var localIsWork = hasUnpublishedEdits() || (state.dataFromStorage && localNewer);

            // 1. На устройстве есть неопубликованная работа — фоновая синхронизация её не трогает
            if (localIsWork && !opts.force) {
                renderSyncStatus();
                return result;
            }

            // 2. Пользователь сам просит «забрать из репозитория»: если есть работа,
            //    сначала спрашиваем и сохраняем копию
            if (localIsWork && !opts.confirmed &&
                !askConfirm('На этом устройстве есть данные, которых нет в репозитории' +
                    (hasUnpublishedEdits() ? ' (похоже, они ещё не опубликованы)' : '') + '.\n' +
                    'Заменить их версией из репозитория (от ' + L.formatDateTime(result.data.updatedAt) + ')?\n' +
                    'Копия текущих данных будет сохранена: её можно вернуть кнопкой «Восстановить копию».')) {
                renderSyncStatus();

                if (opts.verbose) {
                    toast('Данные оставлены без изменений — их можно опубликовать кнопкой «Опубликовать сейчас»', 'info');
                }

                return result;
            }

            // 3. Остальные случаи (устаревшая копия, первый визит) — спокойно заменяем
            var backupSaved = state.admin && localIsWork ? saveLocalBackup(state.data) : false;

            state.data = result.data;
            state.dataFromStorage = true;
            clearUnpublishedEdits();
            sync.publishedAt = result.data.updatedAt || '';
            sync.lastError = '';
            writeStoredValue(KEYS.publishedAt, sync.publishedAt);
            saveData('', { publish: false });

            if (opts.verbose) {
                toast('Данные загружены из репозитория (версия от ' + L.formatDateTime(result.data.updatedAt) + ')' +
                    (backupSaved ? '. Копия прежних данных сохранена' : ''), 'success');
            }

            return result;
        });
    }

    /** Публикация данных в репозиторий. */
    function publishNow(options) {
        var opts = options || {};

        if (!sync.client) {
            return Promise.resolve({ ok: false, error: 'Синхронизация недоступна' });
        }

        if (sync.publishing) {
            return Promise.resolve({ ok: false, error: 'Публикация уже выполняется' });
        }

        if (!sync.token) {
            toast('Сначала введите и сохраните токен GitHub', 'error');
            return Promise.resolve({ ok: false, error: 'Не задан токен' });
        }

        sync.publishing = true;
        sync.lastError = '';
        renderSyncStatus();

        return sync.client.checkAccess()
            .then(function (access) {
                if (!access.ok) {
                    return { ok: false, error: access.error };
                }

                sync.sha = access.sha;

                // Файла в репозитории ещё нет — просто создаём его
                if (!access.exists || !access.data) {
                    return sync.client.publish(state.data, sync.sha, S.commitMessage(sync.lastAction));
                }

                // Данные уже совпадают с репозиторием — публиковать нечего (частая ситуация
                // после авто-публикации или повторного нажатия кнопки, и это не ошибка)
                if (S.documentsEqual(state.data, access.data)) {
                    return { ok: true, unchanged: true, sha: access.sha };
                }

                var localTime = S.timestampOf(state.data);
                var remoteTime = S.timestampOf(access.data);

                // С этого устройства ещё не публиковали: нет базовой версии для сравнения
                if (!sync.publishedAt) {
                    return {
                        ok: false,
                        stale: true,
                        error: 'с этого устройства данные ещё не публиковались. ' +
                            'Нажмите «Забрать из репозитория», чтобы получить текущую версию, ' +
                            'и повторите изменения'
                    };
                }

                // В репозитории более новая версия — публикация остановлена
                if (localTime < remoteTime) {
                    return {
                        ok: false,
                        stale: true,
                        error: 'в репозитории версия новее вашей (от ' + L.formatDateTime(access.data.updatedAt) +
                            '). Нажмите «Забрать из репозитория», проверьте данные и повторите публикацию'
                    };
                }

                // Одинаковое время, но разное содержимое: спрашиваем, что важнее
                if (localTime === remoteTime &&
                    !askConfirm('В репозитории версия с тем же временем, но другим содержимым.\n' +
                        'Опубликовать вашу версию поверх?')) {
                    return {
                        ok: false,
                        error: 'публикация отменена: сначала проверьте данные кнопкой «Забрать из репозитория»'
                    };
                }

                return sync.client.publish(state.data, sync.sha, S.commitMessage(sync.lastAction));
            })
            .then(function (result) {
                sync.publishing = false;

                if (result && result.ok) {
                    // Публикация прошла (или публиковать было нечего): отложенная
                    // авто-публикация больше не нужна
                    if (sync.timer) {
                        window.clearTimeout(sync.timer);
                        sync.timer = null;
                    }

                    sync.sha = result.sha || sync.sha;
                    sync.publishedAt = state.data.updatedAt;
                    sync.lastError = '';
                    clearUnpublishedEdits();
                    writeStoredValue(KEYS.publishedAt, sync.publishedAt);

                    if (result.unchanged) {
                        renderSyncStatus();

                        if (!opts.silent) {
                            toast('Изменений нет: данные в репозитории уже совпадают', 'info');
                        }
                    } else {
                        sync.lastCommitUrl = result.htmlUrl || sync.lastCommitUrl;
                        renderSyncStatus();

                        if (!opts.silent) {
                            toast('Результаты опубликованы — их увидят все устройства', 'success');
                        }
                    }
                } else {
                    sync.lastError = (result && result.error) || 'не удалось опубликовать данные';
                    renderSyncStatus();
                    toast('Публикация не выполнена: ' + sync.lastError, 'error');
                }

                return result;
            });
    }

    /** Автообновление данных у зрителей (и у админа, если нет неопубликованных правок). */
    function startRefreshTimer() {
        var interval = Number(SETTINGS.refreshIntervalMs);

        if (!Number.isFinite(interval) || interval <= 0) {
            return;
        }

        sync.refreshTimer = window.setInterval(function () {
            if (document.visibilityState === 'hidden') {
                return; // не тратим запросы, пока вкладка не видна
            }

            pullFromRepository();
        }, interval);

        document.addEventListener('visibilitychange', function () {
            if (document.visibilityState === 'visible' && !sync.timer) {
                pullFromRepository();
            }
        });
    }

    /* ================================================================== */
    /* Действия администратора в блоке «Публикация»                       */
    /* ================================================================== */

    function saveTokenFromInput() {
        var input = $('github-token');
        var value = input ? String(input.value).trim() : '';

        if (!value) {
            toast('Вставьте токен GitHub в поле и нажмите «Сохранить токен»', 'error');
            return;
        }

        sync.token = value;
        writeStoredValue(KEYS.token, value);

        if (input) {
            input.value = '';
        }

        // При первом сохранении токена включаем авто-публикацию
        if (readStoredValue(KEYS.autoPublish) === null) {
            sync.autoPublish = true;
            writeStoredValue(KEYS.autoPublish, '1');
        }

        fillSyncInputs();
        renderSyncStatus();
        toast('Токен сохранён на этом устройстве', 'success');

        sync.client.checkAccess().then(function (access) {
            if (!access.ok) {
                sync.lastError = access.error;
                renderSyncStatus();
                toast(access.error, 'error');
                return;
            }

            sync.sha = access.sha;
            sync.lastError = '';
            renderSyncStatus();
            toast(access.exists
                ? 'Доступ к репозиторию есть'
                : 'Доступ есть: файл данных появится при первой публикации', 'success');
        });
    }

    function forgetToken() {
        sync.token = '';
        sync.sha = null;
        sync.lastError = '';
        sync.publishedAt = '';
        writeStoredValue(KEYS.token, null);
        writeStoredValue(KEYS.publishedAt, null);
        fillSyncInputs();
        renderSyncStatus();
        toast('Токен удалён с этого устройства', 'info');
    }

    function checkRepositoryAccess() {
        if (!sync.client) {
            return;
        }

        if (!sync.token) {
            toast('Сначала сохраните токен GitHub', 'error');
            return;
        }

        sync.client.checkAccess().then(function (access) {
            if (!access.ok) {
                sync.lastError = access.error;
                renderSyncStatus();
                toast(access.error, 'error');
                return;
            }

            sync.sha = access.sha;
            sync.lastError = '';
            renderSyncStatus();
            toast(access.exists
                ? 'Доступ к репозиторию есть, файл данных найден'
                : 'Доступ есть: файл данных будет создан при первой публикации', 'success');
        });
    }

    /** Ручное обновление данных из репозитория (кнопки «Обновить данные» и «Забрать из репозитория»). */
    function refreshDataFromRepository() {
        // Если данные отличаются, приложение само спросит подтверждение и сохранит копию
        pullFromRepository({ verbose: true, force: true });
    }

    /* ================================================================== */
    /* Публичные страницы                                                 */
    /* ================================================================== */

    function renderHome() {
        var stats = L.getStats(state.data);
        var finished = L.sortMatches(state.data.matches.filter(L.isFinished), 'desc');
        var upcoming = L.sortMatches(state.data.matches.filter(function (match) {
            return !L.isFinished(match);
        }), 'asc');

        $('stat-teams').textContent = stats.teams;
        $('stat-matches').textContent = stats.matches;
        $('stat-players').textContent = stats.players;
        $('stat-finished').textContent = stats.finished;

        $('latest-results').innerHTML = finished.slice(0, CONFIG.recentMatches).map(matchCard).join('') ||
            '<p class="empty-state">Завершённых матчей пока нет</p>';

        $('upcoming-matches').innerHTML = upcoming.slice(0, CONFIG.recentMatches).map(matchCard).join('') ||
            '<p class="empty-state">Предстоящих матчей нет</p>';
    }

    /**
     * Название команды ссылкой на её страницу (для карточек матчей и списков).
     * team — команда (null, если она удалена: тогда выводится просто текст).
     * reverse — бейдж справа, small — уменьшенный бейдж.
     */
    function teamLink(team, name, reverse, small) {
        var badge = team ? teamAvatar(team, { small: !!small }) : '';
        var label = '<span class="team-name font-medium">' + esc(name) + '</span>';
        var content = reverse ? label + badge : badge + label;

        if (!team) {
            return '<span class="flex items-center gap-2 min-w-0">' + content + '</span>';
        }

        return '<a class="team-link' + (reverse ? ' justify-end' : '') + '" href="' + teamHash(team.id) +
            '" data-action="team-public-open" data-id="' + L.toInt(team.id) + '" title="Открыть страницу команды">' +
            content +
        '</a>';
    }

    /**
     * Карточка матча для публичных списков. Названия команд ведут на их страницы,
     * счёт — в детальный результат матча; клик по остальной части карточки тоже
     * открывает матч (data-action стоит и на самой карточке).
     */
    function matchCard(match) {
        var teamA = L.findTeam(state.data.teams, match.teamA);
        var teamB = L.findTeam(state.data.teams, match.teamB);
        var score = match.finished
            ? '<span class="score-display">' + match.scoreA + ' : ' + match.scoreB + '</span>'
            : '<span class="text-dark-500 text-sm">против</span>';

        return '' +
            '<article class="match-card ' + (match.finished ? 'finished' : 'upcoming') + '"' +
                ' data-action="match-public-open" data-id="' + match.id + '" title="Подробности матча">' +
                '<div class="flex items-center gap-2 sm:gap-3">' +
                    '<div class="flex items-center gap-2 flex-1 min-w-0">' +
                        teamLink(teamA, teamA ? teamA.name : 'Команда удалена', false, true) +
                    '</div>' +
                    '<a class="match-card-score" href="' + matchHash(match.id) + '"' +
                        ' data-action="match-public-open" data-id="' + match.id + '" title="Открыть матч">' + score + '</a>' +
                    '<div class="flex items-center gap-2 flex-1 min-w-0 justify-end">' +
                        teamLink(teamB, teamB ? teamB.name : 'Команда удалена', true, true) +
                    '</div>' +
                '</div>' +
                '<div class="mt-2 text-xs text-dark-600 flex flex-wrap items-center gap-3">' +
                    '<span class="inline-flex items-center gap-1">' + icon('calendar') + esc(L.formatDate(match.date, 'long')) + '</span>' +
                    statusPill(match) +
                    matchSummary(match) +
                '</div>' +
            '</article>';
    }

    /**
     * Короткая сводка событий матча: голы, жёлтые и красные карточки (иконка и число).
     * markClass — набор классов: на публичных страницах .match-mark,
     * в списке админки — .admin-row-count.
     */
    function matchSummary(match, markClass) {
        return summaryMarks(Array.isArray(match.events) ? match.events : [], markClass);
    }

    /**
     * Имена классов отметок перечислены явно: Tailwind собирает только те классы,
     * которые целиком встречаются в исходниках, поэтому части имён не склеиваются.
     */
    var SUMMARY_CLASSES = {
        'match-mark': {
            goal: 'match-mark match-mark-goal',
            yellow: 'match-mark match-mark-yellow',
            red: 'match-mark match-mark-red'
        },
        'admin-row-count': {
            goal: 'admin-row-count admin-row-count-goal',
            yellow: 'admin-row-count admin-row-count-yellow',
            red: 'admin-row-count admin-row-count-red'
        }
    };

    /** Отметки событий матча: иконка и количество (нулевые не показываются). */
    function summaryMarks(events, markClass) {
        var classes = SUMMARY_CLASSES[markClass] || SUMMARY_CLASSES['match-mark'];
        var types = [
            { type: 'goal', icon: 'ball' },
            { type: 'yellow', icon: 'card-yellow' },
            { type: 'red', icon: 'card-red' }
        ];

        return types.map(function (item) {
            var count = events.filter(function (event) {
                return event.type === item.type;
            }).length;

            return count
                ? '<span class="' + classes[item.type] + '">' + icon(item.icon) + count + '</span>'
                : '';
        }).join('');
    }

    function renderStandings() {
        var standings = L.computeStandings(state.data.teams, state.data.matches);
        var table = $('standings-table');
        var toggle = document.querySelector('[data-action="toggle-standings-columns"]');

        /* Компактный вид (телефон): только место, команда, игры, разница мячей и очки.
           Остальные показатели выводятся строкой под названием команды. */
        if (table) {
            table.classList.toggle('is-compact', state.standingsCompact);
        }

        if (toggle) {
            toggle.textContent = state.standingsCompact ? 'Все столбцы' : 'Основное';
        }

        $('standings-body').innerHTML = standings.map(function (row) {
            var rowClass = row.place === 1 ? 'bg-amber-50' : (row.place <= 3 ? 'bg-primary-50' : '');
            var diffClass = row.goalDiff > 0 ? 'text-green-700' : (row.goalDiff < 0 ? 'text-red-700' : '');
            var detail = 'В ' + row.wins + ' · Н ' + row.draws + ' · П ' + row.losses +
                ' · Мячи ' + row.goalsFor + '–' + row.goalsAgainst;

            return '' +
                '<tr class="' + rowClass + '" data-action="team-public-open" data-id="' + row.id + '">' +
                    '<td class="num font-medium text-dark-600">' + row.place + '</td>' +
                    '<td class="cell-team">' +
                        '<button type="button" class="team-link" data-action="team-public-open" data-id="' + row.id +
                                '" title="Открыть страницу команды">' +
                            teamAvatar({ id: row.id, name: row.name }, { small: true }) +
                            '<span class="team-name font-medium">' + esc(row.name) + '</span>' +
                        '</button>' +
                        '<span class="row-detail">' + detail + '</span>' +
                    '</td>' +
                    '<td class="num">' + row.played + '</td>' +
                    '<td class="num text-green-700 col-optional">' + row.wins + '</td>' +
                    '<td class="num col-optional">' + row.draws + '</td>' +
                    '<td class="num text-red-700 col-optional">' + row.losses + '</td>' +
                    '<td class="num col-optional">' + row.goalsFor + '–' + row.goalsAgainst + '</td>' +
                    '<td class="num font-medium ' + diffClass + '">' + (row.goalDiff > 0 ? '+' : '') + row.goalDiff + '</td>' +
                    '<td class="num font-bold text-primary-900">' + row.points + '</td>' +
                '</tr>';
        }).join('');
    }

    function renderTeams() {
        var listView = $('team-list-view');
        var detailView = $('team-detail-view');
        var opened = L.findTeam(state.data.teams, state.publicTeamId);

        if (!opened) {
            state.publicTeamId = null;
        }

        if (listView) {
            listView.hidden = Boolean(opened);
        }

        if (detailView) {
            detailView.hidden = !opened;
        }

        // Открыта конкретная команда — показываем её страницу вместо списка
        if (opened) {
            renderPublicTeam(opened);
            return;
        }

        var searchInput = $('team-search');
        var query = (searchInput ? searchInput.value : '').trim().toLowerCase();
        var standings = L.computeStandings(state.data.teams, state.data.matches);
        var byId = {};

        standings.forEach(function (row) {
            byId[row.id] = row;
        });

        var teams = state.data.teams.filter(function (team) {
            return !query || String(team.name).toLowerCase().indexOf(query) !== -1;
        });

        if (!teams.length) {
            $('teams-grid').innerHTML = '<p class="empty-state card md:col-span-2 lg:col-span-3">' +
                (state.data.teams.length ? 'Команды не найдены' : 'Команды ещё не добавлены') + '</p>';
            return;
        }

        $('teams-grid').innerHTML = teams.map(function (team) {
            var row = byId[team.id] || { points: 0, played: 0, place: '—' };
            var players = (team.players || []).length
                ? team.players.map(function (player) {
                    return playerLink(team, player, {
                        className: 'chip chip-player',
                        innerHTML: playerAvatar(team.id, player, { small: true }) + esc(player)
                    });
                }).join('')
                : '<span class="text-dark-500 text-xs">Состав не заполнен</span>';

            return '' +
                '<article class="card p-4" data-action="team-public-open" data-id="' + team.id + '">' +
                    '<div class="flex items-center gap-3 mb-3">' +
                        teamAvatar(team) +
                        '<div class="min-w-0 flex-1">' +
                            '<button type="button" class="team-link" data-action="team-public-open" data-id="' + team.id +
                                    '" title="Открыть страницу команды">' +
                                '<span class="team-name text-lg font-bold truncate">' + esc(team.name) + '</span>' +
                            '</button>' +
                            '<p class="text-xs text-dark-600">Место: ' + row.place + ' · Очки: ' + row.points +
                                ' · Игры: ' + row.played + '</p>' +
                        '</div>' +
                    '</div>' +
                    '<div class="border-t border-dark-200 pt-3">' +
                        '<p class="text-xs text-dark-500 uppercase mb-2">Игроки (' + (team.players || []).length + ')</p>' +
                        '<div class="flex flex-wrap gap-2">' + players + '</div>' +
                    '</div>' +
                '</article>';
        }).join('');
    }

    /**
     * Лучшие бомбардиры: голы и карточки по всем матчам турнира.
     * Сортировка — по голам, затем по карточкам (см. computePlayerStats).
     */
    function renderPlayers() {
        var body = $('players-body');

        if (!body) {
            return;
        }

        var rows = L.computePlayerStats(state.data);

        if (!rows.length) {
            body.innerHTML = '<tr><td colspan="4" class="empty-state">' +
                (state.data.matches.length
                    ? 'Голы ещё не отмечены — их вносит администратор в карточке матча'
                    : 'Матчи ещё не добавлены') +
            '</td></tr>';
            return;
        }

        body.innerHTML = rows.map(function (row) {
            return '<tr>' +
                '<td class="num font-medium text-dark-600">' + row.place + '</td>' +
                '<td class="cell-player">' +
                    playerLink(L.findTeam(state.data.teams, row.teamId), row.player, {
                        innerHTML: '<span class="player-line">' + playerAvatar(row.teamId, row.player, { small: true }) +
                            '<span class="player-name">' + esc(row.player) + '</span></span>'
                    }) +
                    // На телефоне столбец «Команда» скрыт, и название выводится под именем
                    '<span class="row-detail">' +
                        teamLink(L.findTeam(state.data.teams, row.teamId), row.teamName, false, false) +
                    '</span>' +
                '</td>' +
                '<td class="col-optional">' +
                    teamLink(L.findTeam(state.data.teams, row.teamId), row.teamName, false, true) +
                '</td>' +
                '<td class="num player-goals">' + row.goals + '</td>' +
            '</tr>';
        }).join('');
    }

    function renderMatches() {
        var listView = $('match-list-view');
        var detailView = $('match-detail-view');
        var match = findMatch(state.publicMatchId);

        if (!match) {
            state.publicMatchId = null;
        }

        if (listView) {
            listView.hidden = Boolean(match);
        }

        if (detailView) {
            detailView.hidden = !match;
        }

        // Открыт конкретный матч — показываем детальный результат вместо списка
        if (match) {
            renderPublicMatch(match);
            return;
        }

        var searchInput = $('match-search');
        var query = (searchInput ? searchInput.value : '').trim();
        var list = L.searchMatches(
            L.selectMatches(state.data.matches, state.matchesFilter),
            state.data.teams,
            query
        );

        qsa('[data-filter]').forEach(function (button) {
            button.classList.toggle('is-active', button.getAttribute('data-filter') === state.matchesFilter);
        });

        // Сколько матчей нашлось по запросу
        var found = $('matches-found');

        if (found) {
            found.textContent = query
                ? 'Найдено матчей: ' + list.length + ' из ' + state.data.matches.length + '.'
                : '';
        }

        $('matches-list').innerHTML = list.map(matchCard).join('') ||
            '<p class="empty-state card">' +
                (state.data.matches.length
                    ? (query
                        ? 'По запросу «' + esc(query) + '» матчей не найдено'
                        : 'По этому фильтру матчей нет')
                    : 'Матчи ещё не добавлены') +
            '</p>';
    }

    /** Хэш-адрес детального результата матча. */
    function matchHash(matchId) {
        return '#/match/' + L.toInt(matchId);
    }

    /** Открывает детальный результат матча: составы, голы и карточки. */
    function openPublicMatch(matchId) {
        var match = findMatch(matchId);

        if (!match) {
            return;
        }

        state.publicMatchId = L.toInt(match.id);
        applyRoute('matches', { matchId: state.publicMatchId, hash: matchHash(state.publicMatchId) });
    }

    /** Возвращает список матчей (закрывает детальный результат). */
    function closePublicMatch() {
        state.publicMatchId = null;
        applyRoute('matches', { matchId: null, hash: '#/matches' });
    }

    /** Хэш-адрес страницы команды. */
    function teamHash(teamId) {
        return '#/team/' + L.toInt(teamId);
    }

    /** Открывает страницу команды: статистика, состав с фото и матчи. */
    function openPublicTeam(teamId) {
        var team = L.findTeam(state.data.teams, teamId);

        if (!team) {
            return;
        }

        applyRoute('teams', { teamId: L.toInt(team.id), hash: teamHash(team.id) });
    }

    /** Возвращает список команд (закрывает страницу команды). */
    function closePublicTeam() {
        state.publicTeamId = null;
        applyRoute('teams', { teamId: null, hash: '#/teams' });
    }

    /** Плитка со значением для страницы команды; hint — расшифровка (подсказка и озвучка). */
    function statBox(label, value, hint) {
        return '<div class="stat-box"' + (hint ? ' title="' + esc(hint) + '"' : '') + '>' +
            '<div class="stat-value">' + esc(String(value)) + '</div>' +
            '<p class="stat-label">' + esc(label) +
                (hint ? '<span class="sr-only"> — ' + esc(hint.toLowerCase()) + '</span>' : '') +
            '</p>' +
        '</div>';
    }

    /** Страница команды: статистика в турнире, состав и все её матчи. */
    function renderPublicTeam(team) {
        var box = $('team-detail');

        if (!box) {
            return;
        }

        var row = null;

        L.computeStandings(state.data.teams, state.data.matches).forEach(function (item) {
            if (item.id === L.toInt(team.id)) {
                row = item;
            }
        });

        var players = (team.players || []).length
            ? team.players.map(function (player) {
                return playerLink(team, player, {
                    className: 'chip chip-player',
                    innerHTML: playerAvatar(team.id, player, { small: true }) + esc(player)
                });
            }).join('')
            : '<p class="text-dark-500 text-sm">Состав не заполнен</p>';

        var matches = L.teamMatches(state.data.matches, team.id);
        var diff = row ? (row.goalDiff > 0 ? '+' : '') + row.goalDiff : '0';

        box.innerHTML =
            '<div class="flex items-center gap-3 mb-4">' +
                teamAvatar(team, { big: true }) +
                '<div class="min-w-0">' +
                    '<h2 class="font-bold text-lg sm:text-xl truncate">' + esc(team.name) + '</h2>' +
                    '<p class="text-xs text-dark-600">Игроков в заявке: ' + (team.players || []).length + '</p>' +
                '</div>' +
            '</div>' +
            '<div class="grid grid-cols-3 sm:grid-cols-5 gap-3 mb-3">' +
                statBox('Место', row ? row.place : '—', 'Место в турнирной таблице') +
                statBox('Очки', row ? row.points : 0, 'Набранные очки') +
                statBox('Игры', row ? row.played : 0, 'Сыгранные матчи') +
                statBox('ГЗ', row ? row.goalsFor : 0, 'Голов забито') +
                statBox('ГП', row ? row.goalsAgainst : 0, 'Голов пропущено') +
            '</div>' +
            '<p class="text-xs text-dark-600 mb-5">' +
                (row
                    ? 'Победы: ' + row.wins + ' · Ничьи: ' + row.draws + ' · Поражения: ' + row.losses +
                        ' · Разница мячей: ' + diff
                    : 'Команда ещё не играла') +
            '</p>' +
            '<h3 class="text-xs font-bold uppercase tracking-wide text-dark-600 mb-2">Состав</h3>' +
            '<div class="flex flex-wrap gap-2 mb-6">' + players + '</div>' +
            '<h3 class="text-xs font-bold uppercase tracking-wide text-dark-600 mb-2">Матчи команды</h3>' +
            '<div class="space-y-3">' + (matches.length
                ? matches.map(matchCard).join('')
                : '<p class="empty-state">Матчей ещё не было</p>') + '</div>';
    }

    /* ------------------------------------------------------------------ */
    /* Карточка игрока: фото, дата рождения и принадлежность               */
    /* ------------------------------------------------------------------ */

    /** Хэш-адрес карточки игрока: команда и номер в заявке. */
    function playerHash(teamId, index) {
        return '#/player/' + L.toInt(teamId) + '/' + L.toInt(index);
    }

    /** Открытый игрок: команда и номер в заявке (null — карточка не открыта). */
    function openedPlayer() {
        var team = L.findTeam(state.data.teams, state.publicPlayerTeamId);
        var index = L.toInt(state.publicPlayerIndex);

        if (!team || index === null) {
            return null;
        }

        var player = (team.players || [])[index];

        return player ? { team: team, index: index, player: player } : null;
    }

    /** Открывает карточку игрока (со своим адресом, ссылкой можно поделиться). */
    function openPublicPlayer(teamId, index) {
        var team = L.findTeam(state.data.teams, teamId);
        var number = L.toInt(index);

        if (!team || number === null || !(team.players || [])[number]) {
            return;
        }

        applyRoute('player', {
            playerTeamId: L.toInt(team.id),
            playerIndex: number,
            hash: playerHash(team.id, number)
        });
    }

    /** «18 апреля 2011 · 15 лет» ('' — дата не указана). */
    function playerBirthLine(birthDate) {
        if (!birthDate) {
            return '';
        }

        var age = L.formatAge(L.playerAge(birthDate));

        return esc(L.formatDate(birthDate, 'long')) + (age ? ' · ' + esc(age) : '');
    }

    /** Карточка игрока: крупное фото, команда, дата рождения, принадлежность и статистика. */
    function renderPlayerCard() {
        var box = $('player-card');

        if (!box) {
            return;
        }

        var opened = openedPlayer();

        if (!opened) {
            box.innerHTML =
                '<p class="empty-state">Игрок не найден — возможно, состав команды изменился.</p>' +
                '<button type="button" class="btn btn-sm btn-ghost mt-3" data-action="team-public-back">' +
                    icon('back') + 'К списку команд</button>';
            return;
        }

        var info = L.getPlayerInfo(state.data, opened.team.id, opened.player);
        var stats = L.playerStats(state.data, opened.team.id, opened.player);
        var birth = playerBirthLine(info.birthDate);
        var hasInfo = Boolean(info.birthDate || info.note);
        // Администратор может заполнить данные прямо с карточки — откроется форма в админке
        var edit = state.admin
            ? '<div class="mt-3"><button type="button" class="btn btn-sm btn-ghost"' +
                ' data-action="admin-player-info-open" data-team="' + L.toInt(opened.team.id) +
                '" data-index="' + opened.index + '">' + icon('pencil') +
                (hasInfo ? 'Изменить данные игрока' : 'Заполнить данные игрока') + '</button></div>'
            : '';

        box.innerHTML =
            '<div class="player-card-head">' +
                playerAvatar(opened.team.id, opened.player, { detail: true }) +
                '<div class="min-w-0 flex-1">' +
                    '<h2 class="font-bold text-xl mb-1">' + esc(opened.player) + '</h2>' +
                    '<div class="player-card-team mb-2">' +
                        teamLink(opened.team, opened.team.name, false, true) + '</div>' +
                    '<p class="text-sm text-dark-600">Дата рождения: ' +
                        (birth
                            ? '<span class="font-medium text-dark-800">' + birth + '</span>'
                            : '<span class="text-dark-500">не указана</span>') + '</p>' +
                    '<p class="text-sm text-dark-600">В турнире: голы — ' +
                        '<span class="font-medium text-dark-800">' + stats.goals + '</span>, жёлтые — ' +
                        '<span class="font-medium text-dark-800">' + stats.yellow + '</span>, красные — ' +
                        '<span class="font-medium text-dark-800">' + stats.red + '</span></p>' +
                '</div>' +
            '</div>' +
            '<div class="player-note">' +
                '<p class="player-card-label">Принадлежность</p>' +
                '<p class="player-note-text">' +
                    (info.note ? esc(info.note) : '<span class="text-dark-500">не указана</span>') + '</p>' +
            '</div>' +
            edit;
    }

    /** Строка игрока в публичном составе: голы, жёлтая и красная карточки. */
    function squadRow(match, teamId, player) {
        var goals = L.playerEventCount(match.events, teamId, player, 'goal');
        var yellow = L.playerEventCount(match.events, teamId, player, 'yellow');
        var red = L.playerEventCount(match.events, teamId, player, 'red');
        var marks = '';

        if (goals) {
            marks += '<span class="squad-mark squad-mark-goal">' + icon('ball') + goals + '</span>';
        }

        if (yellow) {
            marks += '<span class="squad-mark squad-mark-yellow">' + icon('card-yellow') + yellow + '</span>';
        }

        if (red) {
            marks += '<span class="squad-mark squad-mark-red">' + icon('card-red') + red + '</span>';
        }

        return '<div class="squad-row">' +
            playerLink(L.findTeam(state.data.teams, L.toInt(teamId)), player, {
                className: 'squad-player',
                innerHTML: playerAvatar(teamId, player, { small: true }) +
                    '<span class="squad-name">' + esc(player) + '</span>'
            }) +
            (marks ? '<span class="squad-marks">' + marks + '</span>' : '') +
        '</div>';
    }

    /** Колонка команды в детальном результате: кто играл, кто забил, у кого карточки. */
    function squadColumn(match, team, teamId, teamName) {
        var players = L.matchSquad(team, match.events, teamId);
        var rows = players.length
            ? players.map(function (player) {
                return squadRow(match, teamId, player);
            }).join('')
            : '<p class="text-dark-500 text-sm">Состав не заполнен</p>';

        return '<section class="squad-column">' +
            '<h3 class="squad-team">' +
                (team
                    ? '<a class="team-name" href="' + teamHash(team.id) + '" data-action="team-public-open" data-id="' +
                        L.toInt(team.id) + '" title="Открыть страницу команды">' + esc(teamName) + '</a>'
                    : esc(teamName)) +
            '</h3>' +
            rows +
        '</section>';
    }

    /** Название команды в детальном результате: ссылка на страницу команды. */
    function matchDetailTeam(team, name, reverse) {
        var badge = team ? teamAvatar(team, { small: true }) : '';
        var label = '<span class="match-detail-name">' + esc(name) + '</span>';
        var content = reverse ? label + badge : badge + label;

        if (!team) {
            return '<span class="match-detail-team">' + content + '</span>';
        }

        return '<a class="match-detail-team" href="' + teamHash(team.id) + '" data-action="team-public-open" data-id="' +
            L.toInt(team.id) + '" title="Открыть страницу команды">' + content + '</a>';
    }

    /** Детальный результат матча для посетителей сайта. */
    function renderPublicMatch(match) {
        var box = $('match-detail');

        if (!box) {
            return;
        }

        var teamA = L.findTeam(state.data.teams, match.teamA);
        var teamB = L.findTeam(state.data.teams, match.teamB);
        var nameA = teamA ? teamA.name : 'Команда удалена';
        var nameB = teamB ? teamB.name : 'Команда удалена';
        var events = Array.isArray(match.events) ? match.events : [];
        var hint = L.isFinished(match)
            ? 'Записано голов: ' + (L.countTeamEvents(match.events, match.teamA, 'goal') +
                L.countTeamEvents(match.events, match.teamB, 'goal')) + ' из ' + (match.scoreA + match.scoreB) +
                ' — мяч отмечает гол, прямоугольники — жёлтую и красную карточки.'
            : (events.length
                ? 'Счёт ещё не сохранён — отметки внесены заранее.'
                : 'Матч ещё не сыгран: счёт, голы и карточки появятся после матча.');

        box.innerHTML =
            '<div class="flex flex-wrap items-center justify-between gap-2 mb-3">' +
                '<span class="inline-flex items-center gap-1 text-xs text-dark-600">' + icon('calendar') +
                    esc(L.formatDate(match.date, 'long')) + '</span>' +
                statusPill(match) +
            '</div>' +
            '<div class="match-detail-score">' +
                matchDetailTeam(teamA, nameA, false) +
                (match.finished
                    ? '<span class="score-display">' + match.scoreA + ' : ' + match.scoreB + '</span>'
                    : '<span class="text-dark-500 text-sm">против</span>') +
                matchDetailTeam(teamB, nameB, true) +
            '</div>' +
            '<p class="match-detail-hint">' + esc(hint) + '</p>' +
            '<div class="match-detail-squads">' +
                squadColumn(match, teamA, match.teamA, nameA) +
                squadColumn(match, teamB, match.teamB, nameB) +
            '</div>';
    }

    /** Полная перерисовка всех страниц (публичных и админских). */
    function renderAll() {
        renderHome();
        renderStandings();
        renderTeams();
        renderMatches();
        renderPlayers();
        renderPlayerCard();
        renderAdmin();
    }

    /* ================================================================== */
    /* Админ-панель: сводка, команды, матчи, игроки                       */
    /* ================================================================== */

    function renderAdmin() {
        renderAdminSummary();
        renderAdminTabs();
        renderAdminTeams();
        renderAdminMatches();
        renderAdminPlayers();
        renderAdminPlayerInfo();
        fillAdminSelects();
    }

    /* ================================================================== */
    /* Разделы админ-панели «Команды» и «Матчи»                           */
    /* ================================================================== */

    /** Доступные разделы админки (кнопки-вкладки в шапке панели). */
    var ADMIN_TABS = { teams: true, matches: true };
    var DEFAULT_ADMIN_TAB = 'teams';

    /**
     * Показывает выбранный раздел и подсвечивает его кнопку:
     * неактивные разделы скрываются, у активной кнопки появляется aria-selected.
     */
    function renderAdminTabs() {
        qsa('[data-admin-tab]').forEach(function (button) {
            var isActive = button.getAttribute('data-admin-tab') === state.adminTab;

            button.setAttribute('aria-selected', isActive ? 'true' : 'false');
            button.tabIndex = isActive ? 0 : -1;
            button.classList.toggle('btn-primary', isActive);
            button.classList.toggle('btn-ghost', !isActive);
        });

        qsa('[data-admin-tabpanel]').forEach(function (panel) {
            panel.hidden = panel.getAttribute('data-admin-tabpanel') !== state.adminTab;
        });
    }

    /**
     * Переключение раздела админки.
     * options.focus — перевести фокус на кнопку раздела (навигация стрелками).
     */
    function showAdminTab(tab, options) {
        var opts = options || {};

        state.adminTab = ADMIN_TABS[tab] ? tab : DEFAULT_ADMIN_TAB;
        renderAdminTabs();

        if (opts.focus) {
            var active = qsa('[data-admin-tab]').filter(function (button) {
                return button.getAttribute('data-admin-tab') === state.adminTab;
            })[0];

            if (active && typeof active.focus === 'function') {
                active.focus();
            }
        }

        if (opts.scroll !== false && typeof window.scrollTo === 'function') {
            window.scrollTo(0, 0);
        }
    }

    /** Сводные карточки админки. */
    function renderAdminSummary() {
        var container = $('admin-summary');

        if (!container) {
            return;
        }

        var stats = L.getStats(state.data);

        container.innerHTML = [
            { label: 'Команд', value: stats.teams },
            { label: 'Матчей', value: stats.matches },
            { label: 'Игроков', value: stats.players },
            { label: 'Завершено', value: stats.finished },
            { label: 'Голов', value: stats.goals }
        ].map(function (item) {
            return '<div class="admin-card text-center">' +
                '<div class="text-2xl font-bold text-white">' + item.value + '</div>' +
                '<div class="admin-hint uppercase tracking-wide mt-1">' + esc(item.label) + '</div>' +
            '</div>';
        }).join('');
    }

    /**
     * Раздел «Команды»: список кликабельных команд либо карточка выбранной команды
     * (состав, добавление игрока, переименование и удаление команды).
     */
    function renderAdminTeams() {
        var listView = $('admin-team-list-view');
        var teamView = $('admin-team-view');
        var list = $('admin-teams-list');
        var team = L.findTeam(state.data.teams, state.selectedTeamId);

        if (!team) {
            state.selectedTeamId = null;
        }

        if (listView) {
            listView.hidden = Boolean(team);
        }

        if (teamView) {
            teamView.hidden = !team;
        }

        if (!list) {
            return;
        }

        if (!state.data.teams.length) {
            list.innerHTML = '<p class="admin-hint py-4">Команды ещё не добавлены — добавьте первую ниже.</p>';
            return;
        }

        list.innerHTML = state.data.teams.map(function (item) {
            var playersCount = (item.players || []).length;
            var matchesCount = state.data.matches.filter(function (match) {
                return L.toInt(match.teamA) === item.id || L.toInt(match.teamB) === item.id;
            }).length;

            return '<button type="button" class="admin-row" data-action="team-open" data-id="' + item.id + '">' +
                '<span class="flex items-center gap-3 min-w-0">' + teamAvatar(item, { small: true }) +
                    '<span class="font-medium truncate">' + esc(item.name) + '</span>' +
                '</span>' +
                '<span class="admin-row-meta">' +
                    '<span class="admin-row-count">' + icon('users') + playersCount + '</span>' +
                    '<span class="admin-row-count">' + icon('calendar') + matchesCount + '</span>' +
                    icon('back', 'admin-row-arrow') +
                '</span>' +
            '</button>';
        }).join('');

        renderAdminTeamCard(team);
    }

    /**
     * Эмблема команды в админке: превью, загрузка файла и удаление.
     * Фото сжимается в браузере и уходит файлом в репозиторий (см. uploadTeamPhoto).
     */
    function renderAdminTeamPhoto(team) {
        var box = $('admin-team-photo');

        if (!box || !team) {
            return;
        }

        var busy = !!state.photoBusy && state.photoBusy.kind === 'team' &&
            state.photoBusy.teamId === L.toInt(team.id);
        var photo = hasTeamPhoto(team.id);
        var label = photo ? 'Заменить эмблему' : 'Загрузить эмблему';

        box.innerHTML =
            teamAvatar(team, { big: true }) +
            (busy
                ? '<span class="admin-hint">Загружаю эмблему…</span>'
                : '<label class="btn btn-sm btn-ghost" title="' + esc(label) + '">' +
                    icon('photo') + esc(label) +
                    '<input type="file" class="sr-only" accept="image/*" data-photo-kind="team"' +
                        ' data-photo-team="' + L.toInt(team.id) + '" aria-label="' + esc(label + ': ' + team.name) + '">' +
                '</label>') +
            (photo && !busy
                ? '<button type="button" class="btn btn-sm btn-ghost" data-action="team-photo-remove" data-id="' +
                    L.toInt(team.id) + '" title="Убрать эмблему">' + icon('photo-off') + 'Убрать фото</button>'
                : '') +
            '<span class="admin-hint">Эмблема видна в таблице, в списках и на странице команды</span>';
    }

    /** Шапка карточки команды: название и действия «переименовать» / «удалить». */
    function renderAdminTeamCard(team) {
        var title = $('admin-team-title');
        var actions = $('admin-team-actions');

        if (!team) {
            return;
        }

        if (title) {
            title.textContent = team.name;
        }

        renderAdminTeamPhoto(team);

        if (!actions) {
            return;
        }

        if (state.editingTeamId === team.id) {
            actions.innerHTML =
                '<input type="text" id="team-rename-input" class="admin-input team-rename" maxlength="' +
                    CONFIG.maxTeamNameLength + '" value="' + esc(team.name) + '" aria-label="Новое название команды">' +
                '<button type="button" class="btn btn-primary" data-action="team-save" data-id="' + team.id + '">' +
                    icon('check') + 'Сохранить</button>' +
                '<button type="button" class="btn btn-ghost" data-action="team-cancel-edit" data-id="' + team.id + '">Отмена</button>';
            return;
        }

        actions.innerHTML =
            '<button type="button" class="btn btn-ghost" data-action="team-rename" data-id="' + team.id + '">' +
                icon('pencil') + 'Переименовать</button>' +
            '<button type="button" class="btn btn-danger" data-action="team-delete" data-id="' + team.id + '">' +
                icon('trash') + 'Удалить команду</button>';
    }

    /* --- Открытие команды и возврат к списку --- */

    function openTeam(teamId) {
        state.selectedTeamId = L.toInt(teamId);
        state.editingTeamId = null;
        state.editingPlayer = null;
        state.editingPlayerInfo = null;

        // Карточка команды живёт в разделе «Команды»: открываем его,
        // даже если нажали на название команды из раздела «Матчи»
        showAdminTab('teams');

        renderAdminTeams();
        renderAdminPlayers();

        if (typeof window.scrollTo === 'function') {
            window.scrollTo(0, 0);
        }
    }

    function closeTeam() {
        state.selectedTeamId = null;
        state.editingTeamId = null;
        state.editingPlayer = null;
        state.editingPlayerInfo = null;
        renderAdminTeams();
        renderAdminPlayers();
    }

    /**
     * Раздел «Матчи»: список матчей (сначала прошедшие, затем предстоящие)
     * либо карточка выбранного матча со счётом, голами и карточками.
     */
    function renderAdminMatches() {
        var listView = $('admin-match-list-view');
        var matchView = $('admin-match-view');
        var list = $('admin-matches-list');
        var match = findMatch(state.openMatchId);

        if (!match) {
            state.openMatchId = null;
        }

        if (listView) {
            listView.hidden = Boolean(match);
        }

        if (matchView) {
            matchView.hidden = !match;
        }

        if (match && list) {
            renderAdminMatchCard(match);
            return;
        }

        if (!list) {
            return;
        }

        var groups = L.groupMatchesForAdmin(state.data.matches);
        var searchInput = $('admin-match-search');
        var query = (searchInput ? searchInput.value : '').trim();

        if (query) {
            groups = {
                finished: L.searchMatches(groups.finished, state.data.teams, query),
                upcoming: L.searchMatches(groups.upcoming, state.data.teams, query)
            };
            groups.all = groups.finished.concat(groups.upcoming);
        }

        if (!groups.all.length) {
            list.innerHTML = '<p class="admin-hint py-4">' +
                (query
                    ? 'По запросу «' + esc(query) + '» матчей не найдено'
                    : 'Матчи ещё не добавлены — добавьте первый ниже.') +
            '</p>';
            return;
        }

        var parts = [];

        var appendGroup = function (title, matches) {
            if (!matches.length) {
                return;
            }

            parts.push('<p class="admin-hint uppercase tracking-wide mt-2 mb-1">' + esc(title) + '</p>');
            matches.forEach(function (item) {
                parts.push(matchListRow(item));
            });
        };

        appendGroup('Прошедшие', groups.finished);
        appendGroup('Предстоящие', groups.upcoming);

        list.innerHTML = parts.join('');
    }

    /** Строка матча в списке: дата, «Добрик 2 : 1 Оля», статус, голы и карточки. */
    function matchListRow(match) {
        var teamA = L.getTeamName(state.data.teams, match.teamA);
        var teamB = L.getTeamName(state.data.teams, match.teamB);
        var score = L.isFinished(match)
            ? '<span class="admin-row-score">' + match.scoreA + ' : ' + match.scoreB + '</span>'
            : '<span class="admin-row-score admin-muted">—</span>';

        return '<button type="button" class="admin-row" data-action="match-open" data-id="' + match.id + '">' +
            '<span class="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-3 min-w-0">' +
                '<span class="admin-hint whitespace-nowrap">' + esc(L.formatDate(match.date, 'numeric')) + '</span>' +
                '<span class="truncate font-medium">' + esc(teamA) + ' ' + score + ' ' + esc(teamB) + '</span>' +
            '</span>' +
            '<span class="admin-row-meta">' +
                statusPill(match) +
                matchSummary(match, 'admin-row-count') +
                icon('back', 'admin-row-arrow') +
            '</span>' +
        '</button>';
    }

    /** Название команды в карточке матча админки: нажатие открывает её карточку в разделе «Команды». */
    function adminTeamLink(teamId, name) {
        return '<button type="button" class="admin-score-team admin-score-link" data-action="team-open" data-id="' +
            L.toInt(teamId) + '" title="Открыть команду в разделе «Команды»">' + esc(name) + '</button>';
    }

    /** Карточка матча: счёт, состав обеих команд и отметки голов и карточек. */
    function renderAdminMatchCard(match) {
        var scoreBox = $('admin-match-score');
        var eventsBox = $('admin-match-events');
        var actionsBox = $('admin-match-actions');

        if (!scoreBox || !eventsBox || !actionsBox) {
            return;
        }

        var teamA = L.findTeam(state.data.teams, match.teamA);
        var teamB = L.findTeam(state.data.teams, match.teamB);
        var nameA = teamA ? teamA.name : 'Неизвестная команда';
        var nameB = teamB ? teamB.name : 'Неизвестная команда';
        var goalsA = L.countTeamEvents(match.events, match.teamA, 'goal');
        var goalsB = L.countTeamEvents(match.events, match.teamB, 'goal');
        var hint = L.isFinished(match)
            ? 'Записано голов: ' + (goalsA + goalsB) + ' из ' + (match.scoreA + match.scoreB) +
                '. Мяч — гол, прямоугольник — карточка, кнопка «Убрать» снимает последнюю запись игрока'
            : 'Счёт ещё не введён, но голы и карточки можно отметить уже сейчас. ' +
                'Кнопка «Убрать» снимает последнюю запись игрока.';

        scoreBox.innerHTML =
            '<div class="flex flex-wrap items-center justify-between gap-2 mb-3">' +
                '<span class="admin-hint">' + esc(L.formatDate(match.date, 'long')) + '</span>' +
                statusPill(match) +
            '</div>' +
            '<div class="admin-score-line">' +
                adminTeamLink(match.teamA, nameA) +
                scoreInput(match, 'a', nameA) +
                '<span class="admin-muted">:</span>' +
                scoreInput(match, 'b', nameB) +
                adminTeamLink(match.teamB, nameB) +
            '</div>' +
            '<div class="flex flex-wrap items-center gap-3 mt-3">' +
                '<button type="button" class="btn btn-primary" data-action="match-save-score" data-id="' + match.id + '">' +
                    icon('check') + 'Сохранить счёт</button>' +
                '<span class="admin-hint">' + hint + '</span>' +
            '</div>';

        eventsBox.innerHTML = matchTeamColumn(match, teamA, match.teamA, nameA) +
            matchTeamColumn(match, teamB, match.teamB, nameB);

        actionsBox.innerHTML =
            (L.isFinished(match)
                ? '<button type="button" class="btn btn-ghost" data-action="match-reopen" data-id="' + match.id + '">' +
                    icon('undo') + 'Переоткрыть матч</button>'
                : '') +
            '<button type="button" class="btn btn-ghost" data-action="match-edit" data-id="' + match.id + '">' +
                icon('pencil') + 'Изменить команды и дату</button>' +
            '<button type="button" class="btn btn-danger" data-action="match-delete" data-id="' + match.id + '">' +
                icon('trash') + 'Удалить матч</button>';
    }

    /** Поле счёта одной команды в карточке матча. */
    function scoreInput(match, side, teamName) {
        var value = side === 'a' ? match.scoreA : match.scoreB;

        return '<input type="number" min="0" max="' + CONFIG.maxScore + '" step="1" class="admin-score" id="score-' +
            side + '-' + match.id + '" value="' + (value === null ? '' : value) +
            '" aria-label="Счёт команды ' + esc(teamName) + '">';
    }

    /** Колонка одной команды в карточке матча: игроки, гол и две карточки. */
    function matchTeamColumn(match, team, teamId, teamName) {
        var players = L.matchSquad(team, match.events, teamId);
        var rows = players.length
            ? players.map(function (player) {
                return matchPlayerRow(match, teamId, player);
            }).join('')
            : '<p class="admin-hint py-1">Состав пуст — добавьте игроков в разделе «Команды».</p>';

        return '<div>' +
            '<p class="admin-hint uppercase tracking-wide mb-2">' + esc(teamName) + '</p>' +
            rows +
        '</div>';
    }

    /** Строка игрока: имя и три отметки — гол, жёлтая и красная карточки. */
    function matchPlayerRow(match, teamId, player) {
        var goals = L.playerEventCount(match.events, teamId, player, 'goal');
        var yellow = L.playerEventCount(match.events, teamId, player, 'yellow');
        var red = L.playerEventCount(match.events, teamId, player, 'red');
        var last = lastPlayerEvent(match.events, teamId, player);
        var undoLabel = last
            ? 'Убрать последнюю запись: ' + L.eventLabel(last.type)
            : 'Записей ещё нет — убирать нечего';

        return '<div class="event-row">' +
            '<span class="truncate">' + esc(player) + '</span>' +
            '<span class="event-actions">' +
                eventButton(match.id, teamId, player, 'goal', goals) +
                eventButton(match.id, teamId, player, 'yellow', yellow) +
                eventButton(match.id, teamId, player, 'red', red) +
                /* Кнопка видна всегда: пока записей нет — она приглушена,
                   после отметки снимает последнюю запись игрока */
                '<button type="button" class="event-btn event-btn-undo' + (last ? '' : ' is-empty') + '"' +
                    ' data-action="match-event-undo" data-id="' + match.id + '" data-team="' + teamId +
                    '" data-player="' + esc(player) + '"' +
                    ' title="' + esc(undoLabel) + '" aria-label="' + esc(undoLabel) + ': ' + esc(player) + '">' +
                    icon('undo') + '<span class="event-btn-text">Убрать</span>' +
                '</button>' +
            '</span>' +
        '</div>';
    }

    /** Последняя запись игрока в матче (нужна, чтобы показать, что именно уберётся). */
    function lastPlayerEvent(events, teamId, player) {
        var list = Array.isArray(events) ? events : [];
        var name = L.cleanText(player).toLowerCase();

        for (var i = list.length - 1; i >= 0; i--) {
            var event = list[i];

            if (L.toInt(event.team) === L.toInt(teamId) && L.cleanText(event.player).toLowerCase() === name) {
                return event;
            }
        }

        return null;
    }

    /**
     * Вид кнопок отметок. Имена классов перечислены явно: Tailwind собирает только
     * те классы, которые целиком встречаются в исходниках.
     */
    var EVENT_BUTTONS = {
        goal: { icon: 'ball', cls: 'event-btn-goal' },
        yellow: { icon: 'card-yellow', cls: 'event-btn-yellow' },
        red: { icon: 'card-red', cls: 'event-btn-red' }
    };

    /** Кнопка отметки: неактивная — записи нет, активная — показывает количество. */
    function eventButton(matchId, teamId, player, type, count) {
        var label = L.eventLabel(type);
        var view = EVENT_BUTTONS[type] || EVENT_BUTTONS.goal;

        return '<button type="button" class="event-btn ' + view.cls + (count ? ' is-active' : '') + '"' +
            ' data-action="match-event" data-id="' + matchId + '" data-team="' + teamId +
            '" data-player="' + esc(player) + '" data-type="' + type + '"' +
            ' aria-pressed="' + (count ? 'true' : 'false') + '" title="' + esc(label) + '"' +
            ' aria-label="' + esc(label) + ': ' + esc(player) + '">' +
            icon(view.icon) +
            (count ? '<span class="event-count">' + count + '</span>' : '') +
        '</button>';
    }

    /* --- Открытие матча и возврат к списку --- */

    function openMatch(matchId) {
        state.openMatchId = L.toInt(matchId);
        renderAdminMatches();

        if (typeof window.scrollTo === 'function') {
            window.scrollTo(0, 0);
        }
    }

    function closeMatch() {
        state.openMatchId = null;
        renderAdminMatches();
    }

    /** Состав выбранной команды: игроки, переименование и удаление. */
    function renderAdminPlayers() {
        var container = $('admin-players-list');

        if (!container) {
            return;
        }

        var team = L.findTeam(state.data.teams, state.selectedTeamId);

        if (!team) {
            container.innerHTML = '<p class="admin-hint py-2">Откройте команду в списке выше, чтобы работать с составом.</p>';
            return;
        }

        if (!team.players.length) {
            container.innerHTML = '<p class="admin-hint py-2">В команде «' + esc(team.name) + '» пока нет игроков</p>';
            return;
        }

        container.innerHTML = team.players.map(function (player, index) {
            var isEditing = !!state.editingPlayer &&
                state.editingPlayer.teamId === team.id &&
                state.editingPlayer.index === index;
            var hasPhoto = hasPlayerPhoto(team.id, player);
            var hasInfo = L.hasPlayerInfo(state.data, team.id, player);
            var isBusy = !!state.photoBusy && state.photoBusy.kind === 'player' &&
                state.photoBusy.teamId === L.toInt(team.id) && state.photoBusy.index === index;

            if (isEditing) {
                return '<div class="admin-card flex items-center gap-2">' +
                    '<input type="text" id="player-rename-input" class="admin-input" maxlength="' + CONFIG.maxPlayerNameLength +
                        '" value="' + esc(player) + '" aria-label="Новое имя игрока">' +
                    '<button type="button" class="btn btn-sm btn-primary" data-action="player-save" data-team="' + team.id +
                        '" data-index="' + index + '" title="Сохранить">' + icon('check') + '</button>' +
                    '<button type="button" class="btn btn-sm btn-ghost" data-action="player-cancel-edit" title="Отмена">Отмена</button>' +
                '</div>';
            }

            return '<div class="admin-card flex items-center justify-between gap-2">' +
                '<span class="flex items-center gap-2 min-w-0">' +
                    playerAvatar(team.id, player, { small: true }) +
                    '<span class="truncate"><span class="admin-muted mr-2">' + (index + 1) + '.</span>' + esc(player) + '</span>' +
                '</span>' +
                '<span class="flex items-center gap-1 flex-none">' +
                    (isBusy
                        ? '<span class="admin-hint whitespace-nowrap">Загружаю…</span>'
                        : photoInput(team.id, index, player, hasPhoto)) +
                    (hasPhoto && !isBusy
                        ? '<button type="button" class="btn btn-sm btn-ghost" data-action="player-photo-remove" data-team="' +
                            team.id + '" data-index="' + index + '" title="Убрать фото игрока">' + icon('photo-off') + '</button>'
                        : '') +
                    '<button type="button" class="btn btn-sm btn-ghost" data-action="player-info-open" data-team="' + team.id +
                        '" data-index="' + index + '" title="' + esc(hasInfo
                            ? 'Дата рождения и принадлежность заполнены — изменить'
                            : 'Заполнить дату рождения и принадлежность') + '">' + icon('info') + '</button>' +
                    '<button type="button" class="btn btn-sm btn-ghost" data-action="player-rename" data-team="' + team.id +
                        '" data-index="' + index + '" title="Переименовать">' + icon('pencil') + '</button>' +
                    '<button type="button" class="btn btn-sm btn-danger" data-action="player-delete" data-team="' + team.id +
                        '" data-index="' + index + '" title="Удалить">' + icon('trash') + '</button>' +
                '</span>' +
            '</div>';
        }).join('');
    }

    /* --- Данные игрока: дата рождения и принадлежность (форма администратора) --- */

    /** Открывает форму данных игрока. */
    function startPlayerInfoEdit(teamId, index) {
        state.editingPlayerInfo = { teamId: L.toInt(teamId), index: L.toInt(index) };
        renderAdminPlayerInfo();

        var box = $('admin-player-info');
        var input = $('player-birth-date');

        if (box && typeof box.scrollIntoView === 'function') {
            box.scrollIntoView({ block: 'nearest' });
        }

        if (input && typeof input.focus === 'function') {
            input.focus();
        }
    }

    function cancelPlayerInfoEdit() {
        state.editingPlayerInfo = null;
        renderAdminPlayerInfo();
    }

    /** Убирает дату рождения и принадлежность игрока. */
    function clearPlayerInfo(teamId, index) {
        var team = L.findTeam(state.data.teams, teamId);
        var player = (team && index !== null) ? team.players[index] : '';

        if (!team || !player) {
            return;
        }

        if (!askConfirm('Убрать дату рождения и принадлежность игрока «' + player + '»?')) {
            return;
        }

        L.removePlayerInfo(state.data, team.id, player);
        state.editingPlayerInfo = null;
        saveData('Данные игрока убраны');
    }

    /** Сохраняет дату рождения и принадлежность из формы. */
    function handlePlayerInfoSubmit(event) {
        event.preventDefault();

        var team = L.findTeam(state.data.teams, state.editingPlayerInfo ? state.editingPlayerInfo.teamId : null);
        var index = state.editingPlayerInfo ? state.editingPlayerInfo.index : null;
        var player = (team && index !== null) ? team.players[index] : '';
        var date = $('player-birth-date');
        var note = $('player-note');

        if (!team || !player) {
            setFieldError('player-info-error', 'Игрок не найден — откройте команду заново');
            return;
        }

        var check = L.validatePlayerInfo({
            birthDate: date ? date.value : '',
            note: note ? note.value : ''
        });

        if (!check.ok) {
            setFieldError('player-info-error', check.error);
            return;
        }

        L.setPlayerInfo(state.data, team.id, player, check.value);
        state.editingPlayerInfo = null;
        setFieldError('player-info-error', '');
        saveData('Данные игрока «' + player + '» сохранены');
    }

    /** С карточки игрока открывает админку сразу с формой данных этого игрока. */
    function openAdminPlayerInfo(teamId, index) {
        if (!state.admin) {
            return;
        }

        openTeam(teamId);

        state.editingPlayerInfo = { teamId: L.toInt(teamId), index: L.toInt(index) };
        renderAdminPlayerInfo();
        applyRoute('admin', { hash: '#/admin' });

        var box = $('admin-player-info');

        if (box && typeof box.scrollIntoView === 'function') {
            box.scrollIntoView({ block: 'center' });
        }
    }

    /**
     * Форма данных игрока: дата рождения и принадлежность.
     * Открывается кнопкой у игрока в карточке команды; пока игрок не выбран — скрыта.
     */
    function renderAdminPlayerInfo() {
        var box = $('admin-player-info');

        if (!box) {
            return;
        }

        var team = L.findTeam(state.data.teams, state.editingPlayerInfo ? state.editingPlayerInfo.teamId : null);
        var index = state.editingPlayerInfo ? state.editingPlayerInfo.index : null;
        var player = (team && index !== null) ? team.players[index] : '';

        if (!team || !player) {
            state.editingPlayerInfo = null;
            box.hidden = true;
            box.innerHTML = '';
            return;
        }

        var info = L.getPlayerInfo(state.data, team.id, player);

        box.hidden = false;
        box.innerHTML =
            '<h3 class="admin-title">' + icon('info') + 'Данные игрока: ' + esc(player) + '</h3>' +
            '<p class="admin-hint mb-3">Команда «' + esc(team.name) + '». Дата рождения и принадлежность видны ' +
                'на карточке игрока — она открывается нажатием на имя игрока в составе.</p>' +
            '<form data-form="player-info" class="grid grid-cols-1 md:grid-cols-3 gap-3" novalidate>' +
                '<div>' +
                    '<label class="field-label text-dark-200" for="player-birth-date">Дата рождения</label>' +
                    '<input type="date" id="player-birth-date" class="admin-input" min="1900-01-01" max="' +
                        L.todayISO() + '" value="' + esc(info.birthDate) + '">' +
                '</div>' +
                '<div class="md:col-span-2">' +
                    '<label class="field-label text-dark-200" for="player-note">Принадлежность</label>' +
                    '<textarea id="player-note" class="admin-input" rows="3" maxlength="' +
                        CONFIG.maxPlayerNoteLength + '" placeholder="Например: школа №5, тренер Петров. ' +
                        'Играл за «Динамо» до 2023 года.">' + esc(info.note) + '</textarea>' +
                    '<p class="admin-hint">Заполнено <span id="player-note-count">' + String(info.note.length) +
                        '</span> из ' + CONFIG.maxPlayerNoteLength +
                        ' символов — примерно 3–4 коротких предложения.</p>' +
                '</div>' +
                '<div class="md:col-span-3 flex flex-wrap gap-2">' +
                    '<button type="submit" class="btn btn-primary">' + icon('check') + 'Сохранить данные</button>' +
                    '<button type="button" class="btn btn-ghost" data-action="player-info-cancel">Отмена</button>' +
                    (L.hasPlayerInfo(state.data, team.id, player)
                        ? '<button type="button" class="btn btn-danger" data-action="player-info-clear" data-team="' +
                            L.toInt(team.id) + '" data-index="' + index + '">' + icon('trash') +
                            'Убрать данные</button>'
                        : '') +
                '</div>' +
                '<p id="player-info-error" class="field-error md:col-span-3" role="alert"></p>' +
            '</form>';
    }

    /**
     * Заполняет выпадающие списки команд в форме матча.
     * Текущий выбор сохраняется, если команда ещё существует
     * (раньше список пересоздавался и выделение сбрасывалось).
     */
    function fillAdminSelects() {
        var options = state.data.teams.map(function (team) {
            return '<option value="' + team.id + '">' + esc(team.name) + '</option>';
        }).join('');

        ['match-team-a', 'match-team-b'].forEach(function (selectId) {
            var select = $(selectId);

            if (!select) {
                return;
            }

            var previous = select.value;

            select.innerHTML = options || '<option value="">Нет команд</option>';
            select.disabled = !state.data.teams.length;

            if (previous && L.findTeam(state.data.teams, previous)) {
                select.value = previous;
            }
        });
    }

    /* ================================================================== */
    /* Роутинг и сессия администратора (хэш-адреса: #/standings и т.п.)   */
    /* ================================================================== */

    var ROUTES = { home: true, standings: true, teams: true, matches: true, players: true, admin: true, player: true };

    /**
     * Какой пункт меню подсвечивать на странице. Карточка игрока — часть раздела
     * «Команды»: в меню нет своего пункта, поэтому подсвечиваем команды.
     */
    var NAV_FOR_ROUTE = { player: 'teams' };

    /**
     * Разбор хэша. Обычные адреса («#/matches») открывают страницу, «#/match/5» —
     * страницу матчей с детальным результатом матча №5, «#/team/3» — страницу
     * команды №3, «#/player/3/1» — карточку игрока №1 из заявки команды №3.
     */
    function parseHash() {
        var raw = String(window.location.hash || '')
            .replace(/^#\/?/, '')
            .replace(/\/+$/, '')
            .toLowerCase();
        var parts = raw.split('/');

        if (parts[0] === 'match') {
            return { route: 'matches', matchId: L.toInt(parts[1]), teamId: null, playerTeamId: null, playerIndex: null };
        }

        if (parts[0] === 'team') {
            return { route: 'teams', matchId: null, teamId: L.toInt(parts[1]), playerTeamId: null, playerIndex: null };
        }

        if (parts[0] === 'player') {
            return {
                route: 'player',
                matchId: null,
                teamId: null,
                playerTeamId: L.toInt(parts[1]),
                playerIndex: L.toInt(parts[2])
            };
        }

        return {
            route: ROUTES[raw] ? raw : 'home',
            matchId: null,
            teamId: null,
            playerTeamId: null,
            playerIndex: null
        };
    }

    function askConfirm(question) {
        if (typeof window.confirm !== 'function') {
            return true;
        }

        return window.confirm(question);
    }

    function findMatch(matchId) {
        var id = L.toInt(matchId);

        for (var i = 0; i < state.data.matches.length; i++) {
            if (L.toInt(state.data.matches[i].id) === id) {
                return state.data.matches[i];
            }
        }

        return null;
    }

    function readAdminSession() {
        var storage = getStorage('session');

        try {
            return !!storage && storage.getItem(CONFIG.sessionKey) === '1';
        } catch (error) {
            return false;
        }
    }

    function writeAdminSession(isAdmin) {
        var storage = getStorage('session');

        try {
            if (!storage) {
                return;
            }

            if (isAdmin) {
                storage.setItem(CONFIG.sessionKey, '1');
            } else {
                storage.removeItem(CONFIG.sessionKey);
            }
        } catch (error) {
            // приватный режим браузера — просто игнорируем
        }
    }

    function sectionForRoute(route) {
        if (route === 'admin') {
            return state.admin ? 'page-admin-dashboard' : 'page-admin-login';
        }

        return 'page-' + route;
    }

    /* --- Кнопка «Назад»: возвращает на предыдущую страницу --- */

    /** Сколько страниц помним, чтобы стек не рос бесконечно. */
    var HISTORY_LIMIT = 20;

    /** Названия страниц для кнопки «Назад». */
    var PAGE_TITLES = {
        home: 'Главная',
        standings: 'Таблица',
        teams: 'Команды',
        matches: 'Матчи',
        players: 'Лучшие бомбардиры',
        player: 'Игрок',
        admin: 'Админ-панель'
    };

    /** Текущая страница как запись истории: маршрут и открытая детальная страница. */
    function currentPage() {
        return {
            route: state.route,
            matchId: state.publicMatchId,
            teamId: state.publicTeamId,
            playerTeamId: state.publicPlayerTeamId,
            playerIndex: state.publicPlayerIndex
        };
    }

    /** Это одна и та же страница? */
    function samePage(a, b) {
        return a.route === b.route &&
            L.toInt(a.matchId) === L.toInt(b.matchId) &&
            L.toInt(a.teamId) === L.toInt(b.teamId) &&
            L.toInt(a.playerTeamId) === L.toInt(b.playerTeamId) &&
            L.toInt(a.playerIndex) === L.toInt(b.playerIndex);
    }

    /** Название страницы для подписи у кнопки «Назад». */
    function pageTitle(page) {
        return PAGE_TITLES[page.route] || PAGE_TITLES.home;
    }

    /** Хэш-адрес страницы (с учётом открытого матча, команды или игрока). */
    function hashForPage(page) {
        if (page.route === 'matches' && page.matchId) {
            return matchHash(page.matchId);
        }

        if (page.route === 'teams' && page.teamId) {
            return teamHash(page.teamId);
        }

        if (page.route === 'player' && page.playerTeamId) {
            return playerHash(page.playerTeamId, page.playerIndex === null ? 0 : page.playerIndex);
        }

        return '#/' + page.route;
    }

    /** Показывает кнопку «Назад», если есть куда возвращаться. */
    function renderBackButton() {
        var row = $('back-row');
        var label = $('back-target');

        if (!row) {
            return;
        }

        var previous = state.history.length ? state.history[state.history.length - 1] : null;

        row.hidden = !previous;

        if (label) {
            label.textContent = previous ? '— вернуться на «' + pageTitle(previous) + '»' : '';
        }

        var button = row.querySelector('[data-action="go-back"]');

        if (button) {
            var title = previous ? 'Вернуться на страницу «' + pageTitle(previous) + '»' : 'Нечего возвращать';

            button.setAttribute('title', title);
            button.setAttribute('aria-label', title);
        }
    }

    /** Запоминает страницу, с которой уходим (детальные страницы внутри раздела не считаются). */
    function rememberPage(page, target) {
        if (page.route === target.route || !page.route) {
            return;
        }

        state.history.push(page);

        if (state.history.length > HISTORY_LIMIT) {
            state.history.shift();
        }
    }

    /** Возвращает на предыдущую страницу. */
    function goBack() {
        var previous = state.history.pop();

        if (!previous) {
            return;
        }

        applyRoute(previous.route, {
            back: true,
            scroll: false,
            matchId: previous.matchId === undefined ? null : previous.matchId,
            teamId: previous.teamId === undefined ? null : previous.teamId,
            playerTeamId: previous.playerTeamId === undefined ? null : previous.playerTeamId,
            playerIndex: previous.playerIndex === undefined ? null : previous.playerIndex,
            hash: hashForPage(previous)
        });

        if (typeof window.scrollTo === 'function') {
            window.scrollTo(0, 0);
        }
    }

    /** Переключение страницы: активная секция, подсветка меню (в т.ч. мобильного), хэш. */
    function applyRoute(route, options) {
        var opts = options || {};
        var target = ROUTES[route] ? route : 'home';
        var sectionId = sectionForRoute(target);
        var previous = currentPage();

        /* Какая страница открыта: список или детальная страница (матч, команда, игрок).
           opts.matchId / opts.teamId / opts.playerTeamId === null — показать список,
           число — открыть детальную страницу, undefined — оставить как есть
           (внутренняя перерисовка). */
        if (target === 'matches' && opts.matchId !== undefined) {
            state.publicMatchId = L.toInt(opts.matchId);
        } else if (target !== 'matches') {
            state.publicMatchId = null;
        }

        if (target === 'teams' && opts.teamId !== undefined) {
            state.publicTeamId = L.toInt(opts.teamId);
        } else if (target !== 'teams') {
            state.publicTeamId = null;
        }

        if (target === 'player' && opts.playerTeamId !== undefined) {
            state.publicPlayerTeamId = L.toInt(opts.playerTeamId);
            state.publicPlayerIndex = L.toInt(opts.playerIndex);
        } else if (target !== 'player') {
            state.publicPlayerTeamId = null;
            state.publicPlayerIndex = null;
        }

        /* Кнопка «Назад»: запоминаем страницу, с которой уходим. Переходы внутри
           раздела (список ⇄ матч, список ⇄ команда) новой страницей не считаются,
           возврат по кнопке и стартовый переход тоже не записываются. */
        if (!opts.back && !opts.replace) {
            rememberPage(previous, { route: target });
        }

        state.route = target;

        qsa('.page-section').forEach(function (section) {
            section.classList.toggle('active', section.id === sectionId);
        });

        // Страницы без своего пункта меню (карточка игрока) подсвечивают раздел, к которому относятся
        var navTarget = NAV_FOR_ROUTE[target] || target;

        qsa('[data-nav]').forEach(function (element) {
            var isActive = element.getAttribute('data-nav') === navTarget;

            element.classList.toggle('active', isActive);

            if (isActive) {
                element.setAttribute('aria-current', 'page');
            } else {
                element.removeAttribute('aria-current');
            }
        });

        var menu = $('mobile-menu');

        if (menu) {
            menu.classList.add('hidden');
        }

        if (opts.updateHash !== false) {
            var hash = opts.hash || ('#/' + target);

            if (window.location.hash !== hash) {
                window.location.hash = hash;
            }
        }

        if (opts.scroll !== false && typeof window.scrollTo === 'function') {
            window.scrollTo(0, 0);
        }

        if (target === 'admin') {
            prepareAdminPage();
        } else if (target === 'home') {
            renderHome();
        } else if (target === 'standings') {
            renderStandings();
        } else if (target === 'teams') {
            renderTeams();
        } else if (target === 'matches') {
            renderMatches();
        } else if (target === 'players') {
            renderPlayers();
        } else if (target === 'player') {
            renderPlayerCard();
        }

        renderBackButton();
    }

    function prepareAdminPage() {
        if (!state.admin) {
            var password = $('admin-password');

            if (password) {
                password.value = '';
            }

            setFieldError('login-error', '');
            return;
        }

        renderAdmin();
        resetMatchForm();
        resetPlayerForm();
        renderAdminSettings();
    }

    function handleAdminLogin(event) {
        event.preventDefault();

        var input = $('admin-password');

        if (!L.adminPasswordMatches(input ? input.value : '')) {
            setFieldError('login-error', 'Неверный пароль');
            toast('Неверный пароль', 'error');
            return;
        }

        state.admin = true;
        writeAdminSession(true);
        setFieldError('login-error', '');

        if (input) {
            input.value = '';
        }

        applyRoute('admin');
        toast('Вы вошли в режим администратора', 'success');
    }

    function handleLogout() {
        state.admin = false;
        state.settingsOpen = false;
        state.editingTeamId = null;
        state.editingMatchId = null;
        state.editingPlayer = null;
        state.selectedTeamId = null;
        state.openMatchId = null;
        // Следующий вход начинается с раздела «Команды»
        state.adminTab = DEFAULT_ADMIN_TAB;
        writeAdminSession(false);
        applyRoute('home');
        toast('Вы вышли из админ-панели', 'info');
    }

    /* ================================================================== */
    /* Формы админки: подготовка и сброс                                  */
    /* ================================================================== */

    function resetMatchForm() {
        state.editingMatchId = null;

        var title = $('match-form-title');
        var submit = $('match-submit');
        var cancel = $('match-cancel');
        var date = $('match-date');

        if (title) {
            title.textContent = 'Добавить матч';
        }

        if (submit) {
            submit.innerHTML = icon('plus') + 'Сохранить матч';
        }

        if (cancel) {
            cancel.hidden = true;
        }

        ['match-score-a', 'match-score-b'].forEach(function (id) {
            var input = $(id);

            if (input) {
                input.value = '';
            }
        });

        if (date) {
            date.value = L.todayISO();
        }

        setFieldError('match-form-error', '');
    }

    function resetPlayerForm() {
        state.editingPlayer = null;

        var input = $('new-player-name');

        if (input) {
            input.value = '';
        }

        setFieldError('player-form-error', '');
    }

    function readMatchForm() {
        var read = function (id) {
            var element = $(id);
            return element ? element.value : '';
        };

        return {
            teamA: read('match-team-a'),
            teamB: read('match-team-b'),
            scoreA: read('match-score-a'),
            scoreB: read('match-score-b'),
            date: read('match-date')
        };
    }

    /** Загружает матч в форму (режим редактирования). */
    function startMatchEdit(matchId) {
        var match = findMatch(matchId);

        if (!match) {
            toast('Матч не найден', 'error');
            return;
        }

        state.editingMatchId = match.id;

        var setValue = function (id, value) {
            var element = $(id);

            if (element) {
                element.value = value;
            }
        };

        setValue('match-team-a', String(match.teamA));
        setValue('match-team-b', String(match.teamB));
        setValue('match-date', match.date || L.todayISO());
        setValue('match-score-a', match.scoreA === null ? '' : String(match.scoreA));
        setValue('match-score-b', match.scoreB === null ? '' : String(match.scoreB));

        var title = $('match-form-title');
        var submit = $('match-submit');
        var cancel = $('match-cancel');

        if (title) {
            title.textContent = 'Изменить матч';
        }

        if (submit) {
            submit.innerHTML = icon('check') + 'Сохранить изменения';
        }

        if (cancel) {
            cancel.hidden = false;
        }

        setFieldError('match-form-error', '');

        // Форма живёт в списке матчей: закрываем карточку, чтобы она была видна
        state.openMatchId = null;
        renderAdminMatches();

        if (typeof window.scrollTo === 'function') {
            window.scrollTo(0, 0);
        }
    }

    /* ================================================================== */
    /* Команды: добавление, переименование, удаление                      */
    /* ================================================================== */

    function handleAddTeam(event) {
        event.preventDefault();

        var input = $('new-team-name');
        var check = L.validateTeamName(input ? input.value : '', state.data.teams);

        if (!check.ok) {
            setFieldError('team-form-error', check.error);
            return;
        }

        state.data.teams.push({
            id: L.nextFreeId(state.data.teams),
            name: check.value,
            players: []
        });

        if (input) {
            input.value = '';
        }

        setFieldError('team-form-error', '');
        saveData('Команда «' + check.value + '» добавлена');
    }

    function startTeamRename(teamId) {
        state.editingTeamId = L.toInt(teamId);
        renderAdminTeams();

        var input = $('team-rename-input');

        if (input) {
            input.focus();
        }
    }

    function cancelTeamRename() {
        state.editingTeamId = null;
        renderAdminTeams();
    }

    function saveTeamRename(teamId) {
        var team = L.findTeam(state.data.teams, teamId);
        var input = $('team-rename-input');

        if (!team || !input) {
            return;
        }

        var check = L.validateTeamName(input.value, state.data.teams, { ignoreId: team.id });

        if (!check.ok) {
            toast(check.error, 'error');
            input.focus();
            return;
        }

        team.name = check.value;
        state.editingTeamId = null;
        saveData('Команда переименована');
    }

    function deleteTeam(teamId) {
        var team = L.findTeam(state.data.teams, teamId);

        if (!team) {
            return;
        }

        var related = state.data.matches.filter(function (match) {
            return match.teamA === team.id || match.teamB === team.id;
        }).length;

        var question = 'Удалить команду «' + team.name + '»?' +
            (related ? '\nВместе с ней будут удалены матчи: ' + related + '.' : '');

        if (!askConfirm(question)) {
            return;
        }

        state.data.teams = state.data.teams.filter(function (item) {
            return item.id !== team.id;
        });

        state.data.matches = state.data.matches.filter(function (match) {
            return match.teamA !== team.id && match.teamB !== team.id;
        });

        if (state.editingPlayer && state.editingPlayer.teamId === team.id) {
            state.editingPlayer = null;
        }

        if (state.editingPlayerInfo && state.editingPlayerInfo.teamId === team.id) {
            state.editingPlayerInfo = null;
        }

        if (state.editingTeamId === team.id) {
            state.editingTeamId = null;
        }

        if (state.selectedTeamId === team.id) {
            state.selectedTeamId = null;
        }

        // Фото игроков и эмблема удалённой команды больше не нужны (файлы остаются в истории)
        L.removeTeamPhotos(state.data, team.id);
        L.removeTeamPhoto(state.data, team.id);

        // Дата рождения и принадлежность игроков удалённой команды — тоже
        L.removeTeamPlayerInfo(state.data, team.id);

        saveData('Команда «' + team.name + '» удалена');
    }

    /* ================================================================== */
    /* Матчи: добавление, правка, счёт, переоткрытие, удаление            */
    /* ================================================================== */

    function handleMatchSubmit(event) {
        event.preventDefault();

        var check = L.validateMatchInput(readMatchForm(), state.data.teams);

        if (!check.ok) {
            setFieldError('match-form-error', check.error);
            return;
        }

        setFieldError('match-form-error', '');

        if (state.editingMatchId !== null) {
            var match = findMatch(state.editingMatchId);

            if (!match) {
                toast('Матч не найден', 'error');
                resetMatchForm();
                return;
            }

            match.teamA = check.match.teamA;
            match.teamB = check.match.teamB;
            match.date = check.match.date;
            match.scoreA = check.match.scoreA;
            match.scoreB = check.match.scoreB;
            match.finished = check.match.finished;

            resetMatchForm();
            saveData('Матч обновлён');
            return;
        }

        state.data.matches.push({
            id: L.nextFreeId(state.data.matches),
            teamA: check.match.teamA,
            teamB: check.match.teamB,
            date: check.match.date,
            scoreA: check.match.scoreA,
            scoreB: check.match.scoreB,
            finished: check.match.finished
        });

        resetMatchForm();
        saveData('Матч добавлен');
    }

    /**
     * Отметка в карточке матча: игрок забил гол или получил карточку.
     * Повторное нажатие добавляет ещё одну такую же запись (дубль, вторая карточка).
     */
    function recordMatchEvent(matchId, teamId, player, type) {
        var match = findMatch(matchId);

        if (!match) {
            toast('Матч не найден', 'error');
            return;
        }

        if (!L.isEventType(type) || !player) {
            return;
        }

        var team = L.findTeam(state.data.teams, teamId);

        match.events = L.addEvent(match.events, teamId, player, type);

        saveData(L.eventLabel(type) + ': ' + player + (team ? ' (' + team.name + ')' : ''));
    }

    /** Убирает последнюю запись игрока в матче (гол или карточку). */
    function undoMatchEvent(matchId, teamId, player) {
        var match = findMatch(matchId);

        if (!match || !player) {
            return;
        }

        var last = lastPlayerEvent(match.events, teamId, player);

        if (!last) {
            toast('У игрока «' + player + '» пока нет записей');
            return;
        }

        match.events = L.removeLastEvent(match.events, teamId, player);
        saveData('Запись игрока «' + player + '» убрана (' + L.eventLabel(last.type) + ')');
    }

    /**
     * Сохранение счёта в карточке матча.
     * Пустые поля переводят матч в статус «предстоит» (счёт стирается).
     */
    function saveMatchScore(matchId) {
        var match = findMatch(matchId);

        if (!match) {
            toast('Матч не найден', 'error');
            return;
        }

        var scoreA = $('score-a-' + match.id);
        var scoreB = $('score-b-' + match.id);

        var check = L.validateMatchInput({
            teamA: match.teamA,
            teamB: match.teamB,
            date: match.date,
            scoreA: scoreA ? scoreA.value : '',
            scoreB: scoreB ? scoreB.value : ''
        }, state.data.teams);

        if (!check.ok) {
            toast(check.error, 'error');
            return;
        }

        match.scoreA = check.match.scoreA;
        match.scoreB = check.match.scoreB;
        match.finished = check.match.finished;

        saveData(check.match.finished
            ? 'Счёт матча сохранён'
            : 'Счёт очищен — матч снова предстоящий');
    }

    function reopenMatch(matchId) {
        var match = findMatch(matchId);

        if (!match) {
            return;
        }

        match.scoreA = null;
        match.scoreB = null;
        match.finished = false;

        saveData('Матч переоткрыт');
    }

    function deleteMatch(matchId) {
        var match = findMatch(matchId);

        if (!match) {
            return;
        }

        var question = 'Удалить матч ' + L.getTeamName(state.data.teams, match.teamA) + ' — ' +
            L.getTeamName(state.data.teams, match.teamB) + ' от ' + L.formatDate(match.date, 'numeric') + '?';

        if (!askConfirm(question)) {
            return;
        }

        state.data.matches = state.data.matches.filter(function (item) {
            return item.id !== match.id;
        });

        if (state.editingMatchId === match.id) {
            resetMatchForm();
        }

        if (state.openMatchId === match.id) {
            state.openMatchId = null;
        }

        saveData('Матч удалён');
    }

    /* ================================================================== */
    /* Игроки: добавление, переименование, удаление                       */
    /* ================================================================== */

    function handleAddPlayer(event) {
        event.preventDefault();

        var input = $('new-player-name');
        var team = L.findTeam(state.data.teams, state.selectedTeamId);

        if (!team) {
            setFieldError('player-form-error', 'Сначала откройте команду в списке');
            return;
        }

        var check = L.validatePlayerName(input ? input.value : '', team);

        if (!check.ok) {
            setFieldError('player-form-error', check.error);
            return;
        }

        team.players.push(check.value);

        if (input) {
            input.value = '';
        }

        setFieldError('player-form-error', '');
        saveData('Игрок добавлен в «' + team.name + '»');
    }

    function startPlayerRename(teamId, index) {
        state.editingPlayer = { teamId: L.toInt(teamId), index: L.toInt(index) };
        renderAdminPlayers();

        var input = $('player-rename-input');

        if (input) {
            input.focus();
        }
    }

    function cancelPlayerRename() {
        state.editingPlayer = null;
        renderAdminPlayers();
    }

    function savePlayerRename(teamId, index) {
        var team = L.findTeam(state.data.teams, teamId);
        var input = $('player-rename-input');

        if (!team || !input || index === null) {
            return;
        }

        var check = L.validatePlayerName(input.value, team, { ignoreIndex: index });

        if (!check.ok) {
            toast(check.error, 'error');
            input.focus();
            return;
        }

        var oldName = team.players[index];
        team.players[index] = check.value;

        // Записи игрока в матчах (голы и карточки) переносим на новое имя,
        // иначе в карточке матча появился бы «старый» игрок
        state.data.matches.forEach(function (match) {
            if (L.toInt(match.teamA) === team.id || L.toInt(match.teamB) === team.id) {
                match.events = L.renamePlayerEvents(match.events, team.id, oldName, check.value);
            }
        });

        // Фото игрока тоже переезжает на новое имя
        L.renamePlayerPhoto(state.data, team.id, oldName, check.value);

        // Дата рождения и принадлежность — тоже
        L.renamePlayerInfo(state.data, team.id, oldName, check.value);

        state.editingPlayer = null;
        saveData('Имя игрока изменено');
    }

    function deletePlayer(teamId, index) {
        var team = L.findTeam(state.data.teams, teamId);

        if (!team || index === null || !team.players[index]) {
            return;
        }

        if (!askConfirm('Удалить игрока «' + team.players[index] + '» из команды «' + team.name + '»?')) {
            return;
        }

        var removed = team.players[index];

        team.players.splice(index, 1);
        state.editingPlayer = null;
        state.editingPlayerInfo = null;

        // Фото удалённого игрока убираем из данных (файл остаётся в истории репозитория)
        if (removed) {
            delete state.photoPreviews[L.getPhoto(state.data, team.id, removed)];
            L.removePhoto(state.data, team.id, removed);
            L.removePlayerInfo(state.data, team.id, removed);
        }

        saveData('Игрок удалён');
    }

    /* ================================================================== */
    /* Сброс к демонстрационным данным                                    */
    /* ================================================================== */

    function resetData() {
        if (!askConfirm('Вернуть демонстрационные данные?\nВсе текущие команды, матчи и игроки будут заменены.')) {
            return;
        }

        state.data = L.createDefaultData();
        state.editingTeamId = null;
        state.editingMatchId = null;
        state.editingPlayer = null;
        state.editingPlayerInfo = null;
        state.selectedTeamId = null;
        state.openMatchId = null;
        state.photoPreviews = {};

        saveData('Загружены демонстрационные данные');
    }

    /**
     * Применяет данные из JSON-строки.
     * Публичного экспорта/импорта файлов в интерфейсе нет: резервные копии — это история
     * коммитов в репозитории, а копия перед заменой сохраняется кнопкой «Восстановить копию».
     * Функция остаётся как аварийный путь восстановления (FTApp.importData в консоли браузера).
     */
    function applyImport(text) {
        var result = L.parseImport(text);

        if (!result.ok) {
            toast(result.error, 'error');
            return false;
        }

        state.data = result.data;
        state.editingTeamId = null;
        state.editingMatchId = null;
        state.editingPlayer = null;
        state.editingPlayerInfo = null;
        state.selectedTeamId = null;
        state.openMatchId = null;
        state.photoPreviews = {};

        saveData('Данные загружены из файла');

        if (result.repaired) {
            toast('Часть данных была исправлена при загрузке', 'info');
        }

        return true;
    }

    /* ================================================================== */
    /* Обработчики событий (делегирование, без inline-скриптов)           */
    /* ================================================================== */

    function handleClick(event) {
        var element = event.target && event.target.closest ? event.target.closest('[data-action]') : null;

        if (!element) {
            return;
        }

        var action = element.getAttribute('data-action');
        var id = element.getAttribute('data-id');
        var teamId = element.getAttribute('data-team');
        var index = element.hasAttribute('data-index') ? L.toInt(element.getAttribute('data-index')) : null;

        if (action === 'navigate') {
            /* Переход по меню всегда закрывает открытый матч или команду и показывает список */
            applyRoute(element.getAttribute('data-page') || 'home', { matchId: null, teamId: null });
        } else if (action === 'go-back') {
            goBack();
        } else if (action === 'toggle-menu') {
            var menu = $('mobile-menu');

            if (menu) {
                menu.classList.toggle('hidden');
            }
        } else if (action === 'filter') {
            state.matchesFilter = element.getAttribute('data-filter') || 'all';
            renderMatches();
        } else if (action === 'toggle-standings-columns') {
            state.standingsCompact = !state.standingsCompact;
            renderStandings();
        } else if (action === 'hide-banner') {
            var banner = $('data-warning');

            if (banner) {
                banner.hidden = true;
            }
        } else if (action === 'logout') {
            handleLogout();
        } else if (action === 'admin-tab') {
            showAdminTab(element.getAttribute('data-admin-tab'));
        } else if (action === 'reset-data') {
            resetData();
        } else if (action === 'team-rename') {
            startTeamRename(id);
        } else if (action === 'team-open') {
            openTeam(id);
        } else if (action === 'team-back') {
            closeTeam();
        } else if (action === 'match-open') {
            openMatch(id);
        } else if (action === 'match-back') {
            closeMatch();
        } else if (action === 'match-public-open') {
            openPublicMatch(id);
        } else if (action === 'match-public-back') {
            closePublicMatch();
        } else if (action === 'team-public-open') {
            openPublicTeam(id);
        } else if (action === 'team-public-back') {
            closePublicTeam();
        } else if (action === 'player-public-open') {
            openPublicPlayer(teamId, index);
        } else if (action === 'player-info-open') {
            startPlayerInfoEdit(teamId, index);
        } else if (action === 'player-info-cancel') {
            cancelPlayerInfoEdit();
        } else if (action === 'player-info-clear') {
            clearPlayerInfo(teamId, index);
        } else if (action === 'admin-player-info-open') {
            openAdminPlayerInfo(teamId, index);
        } else if (action === 'match-event') {
            recordMatchEvent(id, teamId, element.getAttribute('data-player'), element.getAttribute('data-type'));
        } else if (action === 'match-event-undo') {
            undoMatchEvent(id, teamId, element.getAttribute('data-player'));
        } else if (action === 'team-save') {
            saveTeamRename(id);
        } else if (action === 'team-cancel-edit') {
            cancelTeamRename();
        } else if (action === 'team-delete') {
            deleteTeam(id);
        } else if (action === 'match-save-score') {
            saveMatchScore(id);
        } else if (action === 'match-reopen') {
            reopenMatch(id);
        } else if (action === 'match-edit') {
            startMatchEdit(id);
        } else if (action === 'match-cancel-edit') {
            resetMatchForm();
        } else if (action === 'match-delete') {
            deleteMatch(id);
        } else if (action === 'player-rename') {
            startPlayerRename(teamId, index);
        } else if (action === 'player-save') {
            savePlayerRename(teamId, index);
        } else if (action === 'player-cancel-edit') {
            cancelPlayerRename();
        } else if (action === 'player-delete') {
            deletePlayer(teamId, index);
        } else if (action === 'player-photo-remove') {
            removePlayerPhoto(teamId, index);
        } else if (action === 'team-photo-remove') {
            removeTeamPhoto(id);
        } else if (action === 'github-save-token') {
            saveTokenFromInput();
        } else if (action === 'github-forget-token') {
            forgetToken();
        } else if (action === 'github-check') {
            checkRepositoryAccess();
        } else if (action === 'github-publish') {
            publishNow();
        } else if (action === 'github-pull') {
            refreshDataFromRepository();
        } else if (action === 'github-restore-backup') {
            restoreLocalBackup();
        } else if (action === 'toggle-settings') {
            toggleAdminSettings();
        } else if (action === 'open-settings') {
            openAdminSettings();
        } else if (action === 'refresh-data') {
            refreshDataFromRepository();
        }
    }

    function handleSubmit(event) {
        var form = event.target;
        var name = form && form.getAttribute ? form.getAttribute('data-form') : null;

        if (name === 'login') {
            handleAdminLogin(event);
        } else if (name === 'add-team') {
            handleAddTeam(event);
        } else if (name === 'match') {
            handleMatchSubmit(event);
        } else if (name === 'add-player') {
            handleAddPlayer(event);
        } else if (name === 'player-info') {
            handlePlayerInfoSubmit(event);
        }
    }

    function handleChange(event) {
        var target = event.target;

        if (!target) {
            return;
        }

        // Выбор файла с фото игрока: <input type="file" data-photo-team data-photo-index>
        // или эмблемы команды: <input type="file" data-photo-kind="team" data-photo-team>
        if (typeof target.hasAttribute === 'function' && target.hasAttribute('data-photo-team')) {
            var files = target.files || [];
            var photoTeam = L.toInt(target.getAttribute('data-photo-team'));
            var photoFile = files.length ? files[0] : null;

            if (target.getAttribute('data-photo-kind') === 'team') {
                uploadTeamPhoto(photoTeam, photoFile);
            } else {
                uploadPlayerPhoto(photoTeam, L.toInt(target.getAttribute('data-photo-index')), photoFile);
            }

            return;
        }

        if (!target.id) {
            return;
        }

        if (target.id === 'github-auto') {
            sync.autoPublish = Boolean(target.checked);
            writeStoredValue(KEYS.autoPublish, sync.autoPublish ? '1' : '0');
            renderSyncStatus();

            if (sync.autoPublish && isDirty()) {
                schedulePublish();
            }
        }
    }

    function handleInput(event) {
        var target = event.target;

        if (!target || !target.id) {
            return;
        }

        if (target.id === 'team-search') {
            renderTeams();
        } else if (target.id === 'match-search') {
            renderMatches();
        } else if (target.id === 'admin-match-search') {
            renderAdminMatches();
        } else if (target.id === 'player-note') {
            // Счётчик символов у «принадлежности»: текст ограничен по длине
            var counter = $('player-note-count');

            if (counter) {
                counter.textContent = String(String(target.value || '').length);
            }
        }
    }

    /**
     * Стрелки ←/→ и клавиши Home/End переключают разделы админки, когда фокус
     * находится на кнопке раздела, — привычное поведение списка вкладок.
     */
    function handleKeydown(event) {
        var target = event.target && event.target.closest ? event.target.closest('[data-admin-tab]') : null;

        if (!target || event.altKey || event.ctrlKey || event.metaKey) {
            return;
        }

        var tabs = qsa('[data-admin-tab]');
        var index = tabs.indexOf(target);
        var next = null;

        if (event.key === 'ArrowRight') {
            next = tabs[(index + 1) % tabs.length];
        } else if (event.key === 'ArrowLeft') {
            next = tabs[(index - 1 + tabs.length) % tabs.length];
        } else if (event.key === 'Home') {
            next = tabs[0];
        } else if (event.key === 'End') {
            next = tabs[tabs.length - 1];
        }

        if (!next) {
            return;
        }

        event.preventDefault();
        showAdminTab(next.getAttribute('data-admin-tab'), { focus: true });
    }

    function bindEvents() {
        document.addEventListener('click', handleClick);
        document.addEventListener('submit', handleSubmit);
        document.addEventListener('change', handleChange);
        document.addEventListener('input', handleInput);
        document.addEventListener('keydown', handleKeydown);

        // Картинки, которые не догрузились, повторяем сами (см. bindPhotoRetries)
        bindPhotoRetries();

        window.addEventListener('hashchange', function () {
            var parsed = parseHash();

            applyRoute(parsed.route, {
                updateHash: false,
                scroll: false,
                matchId: parsed.matchId,
                teamId: parsed.teamId,
                playerTeamId: parsed.playerTeamId,
                playerIndex: parsed.playerIndex,
                replace: true
            });
        });
    }

    /* ================================================================== */
    /* Запуск приложения                                                  */
    /* ================================================================== */

    function init() {
        // Защита от повторного запуска: обработчики событий не должны дублироваться
        if (state.initialized) {
            return;
        }

        state.initialized = true;
        state.storage = getStorage('local');

        var loaded = L.loadFromStorage(state.storage);

        state.data = loaded.data;
        state.dataFromStorage = !loaded.fresh;
        state.admin = readAdminSession();
        state.storageAvailable = !!state.storage;

        readSyncSettings();
        sync.client = createSyncClient();

        // Первый запуск: сразу фиксируем демонстрационные данные в хранилище
        if (loaded.fresh) {
            L.saveToStorage(state.storage, state.data);
        }

        if (loaded.repaired) {
            showDataBanner(loaded.reason);
        }

        bindEvents();
        renderAll();

        var route = parseHash();

        applyRoute(route.route, {
            updateHash: false,
            matchId: route.matchId,
            teamId: route.teamId,
            replace: true
        });
        fillSyncInputs();
        renderSyncStatus();

        // Подтягиваем актуальные данные турнира из репозитория
        pullFromRepository();
        startRefreshTimer();

        /* Публичный API: нужен автотестам и удобен для отладки из консоли браузера */
        window.FTApp = {
            config: CONFIG,
            navigate: applyRoute,
            getData: function () {
                return state.data;
            },
            setData: function (data) {
                state.data = data;
                saveData();
            },
            getState: function () {
                return state;
            },
            isAdmin: function () {
                return state.admin;
            },
            login: function (password) {
                if (!L.adminPasswordMatches(password)) {
                    return false;
                }

                state.admin = true;
                writeAdminSession(true);
                applyRoute('admin');
                return true;
            },
            importData: applyImport,
            render: renderAll,
            /* Синхронизация с репозиторием: используется автотестами и для отладки */
            sync: {
                pull: pullFromRepository,
                publish: publishNow,
                check: checkRepositoryAccess,
                refresh: refreshDataFromRepository,
                isDirty: isDirty,
                status: renderSyncStatus,
                state: sync
            }
        };
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();

