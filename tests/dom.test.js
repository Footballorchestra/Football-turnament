/**
 * DOM-тесты приложения: все страницы и админ-панель в среде jsdom.
 * Запуск: npm test
 *
 * Проверяется реальная разметка index.html + оба скрипта из assets/js.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const ROOT = path.resolve(__dirname, '..');
const DATA_KEY = 'footballTournamentData';
const EDITS_KEY = 'ft.localEdits';

const L = require('../assets/js/logic.js');
const { createMockRepository } = require('./helpers/mock-github.js');
// Настоящий пароль администратора в репозитории не хранится:
// тесты входят в панель своим паролем-образцом (см. helpers/admin-credentials.js)
const ADMIN = require('./helpers/admin-credentials.js');

function readSource(relativePath) {
    return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

/**
 * Поднимает страницу index.html в jsdom, выполняет скрипты приложения
 * и возвращает удобные помощники для проверок.
 *
 * options.mock — макет GitHub (tests/helpers/mock-github.js); без него сеть считается недоступной.
 */
function boot(options) {
    const settings = options || {};
    const mock = settings.mock || null;
    const html = readSource('index.html');

    const dom = new JSDOM(html, {
        url: settings.url || 'https://tournament.test/',
        runScripts: 'outside-only',
        pretendToBeVisual: true,
        beforeParse(window) {
            window.scrollTo = () => {};
            window.confirm = () => settings.confirm !== false;

            // Настройки и «сеть» задаются до запуска приложения
            window.FT_CONFIG = {
                github: {
                    owner: 'test',
                    repo: 'test',
                    branch: 'main',
                    path: 'data.json',
                    apiBase: '/mock-api',
                    rawBase: '/mock-raw'
                },
                // Вход в панель: сайт сверяет пароль по солёному отпечатку,
                // поэтому тесты подставляют свои соль и отпечаток.
                admin: ADMIN.config(),
                // В тестах фоновые таймеры обычно не нужны (0 — автообновление выключено)
                refreshIntervalMs: settings.refreshIntervalMs === undefined ? 0 : settings.refreshIntervalMs,
                // Заставка в тестах по умолчанию выключена; свой тест задаёт её время сам
                splashMs: settings.splashMs === undefined ? 0 : settings.splashMs,
                autoPublishDelayMs: settings.autoPublishDelayMs === undefined ? 10 : settings.autoPublishDelayMs
            };

            window.fetch = mock
                ? mock.fetch
                : () => Promise.reject(new Error('сеть недоступна'));

            if (settings.seed) {
                Object.keys(settings.seed).forEach((key) => {
                    window.localStorage.setItem(key, settings.seed[key]);
                });
            }

            // Отметки на время сессии (например, «заставка уже показана»)
            if (settings.sessionSeed) {
                Object.keys(settings.sessionSeed).forEach((key) => {
                    window.sessionStorage.setItem(key, settings.sessionSeed[key]);
                });
            }
        }
    });

    const { window } = dom;
    const document = window.document;

    window.eval(readSource('assets/js/config.js'));
    window.eval(readSource('assets/js/splash.js'));
    window.eval(readSource('assets/js/logic.js'));
    window.eval(readSource('assets/js/sync.js'));
    window.eval(readSource('assets/js/photo.js'));
    window.eval(readSource('assets/js/app.js'));

    if (document.readyState === 'loading') {
        document.dispatchEvent(new window.Event('DOMContentLoaded'));
    }

    function fire(type, target, init) {
        target.dispatchEvent(new window.Event(type, Object.assign({ bubbles: true, cancelable: true }, init || {})));
    }

    return {
        dom,
        window,
        document,
        mock,
        $: (selector) => document.querySelector(selector),
        $$: (selector) => Array.from(document.querySelectorAll(selector)),
        id: (elementId) => document.getElementById(elementId),
        click: (target) => fire('click', target),
        submit: (form) => fire('submit', form),
        change: (target) => fire('change', target),
        type: (input, value) => {
            input.value = value;
            fire('input', input);
        },
        /** Даёт завершиться промисам синхронизации */
        settle: () => new Promise((resolve) => window.setTimeout(resolve, 0)),
        wait: (ms) => new Promise((resolve) => window.setTimeout(resolve, ms)),
        /** Активная секция страницы */
        activeSection: () => {
            const active = document.querySelector('.page-section.active');
            return active ? active.id : null;
        },
        storedData: () => JSON.parse(window.localStorage.getItem(DATA_KEY)),
        navigate: (page) => {
            fire('click', document.querySelector('[data-nav="' + page + '"]'));
        },
        /** Кнопка действия (внутри контейнера или на всей странице) */
        actionButton: (action, container) => {
            const scope = container || document;
            return scope.querySelector('[data-action="' + action + '"]');
        },
        /** Вход в админку «как в жизни» — через форму */
        login: (password) => {
            fire('click', document.querySelector('[data-nav="admin"]'));
            const input = document.getElementById('admin-password');
            input.value = password === undefined ? ADMIN.password : password;
            fire('submit', document.querySelector('[data-form="login"]'));
        },
        /** Открывает команду по названию — кликом по строке списка команд */
        openTeam: (name) => {
            const row = Array.from(document.querySelectorAll('#admin-teams-list [data-action="team-open"]'))
                .find((button) => button.textContent.includes(name));
            fire('click', row);
            return row;
        },
        /** Открывает карточку матча — кликом по строке списка матчей */
        openMatch: (matchId) => {
            fire('click', document.querySelector(
                '#admin-matches-list [data-action="match-open"][data-id="' + matchId + '"]'
            ));
        },
        /** Кнопка отметки игрока в карточке матча: type = 'goal' | 'yellow' | 'red' */
        markButton: (teamId, player, type) => document.querySelector(
            '.event-btn[data-action="match-event"][data-team="' + teamId + '"][data-player="' + player +
            '"][data-type="' + type + '"]'
        ),
        /** Кнопка во flex-блоке действий (без опоры на таблицу) */
        button: (action) => document.querySelector('[data-action="' + action + '"]'),
        /** Сохраняет токен GitHub через поле в блоке «Публикация» */
        saveToken: (token) => {
            const input = document.getElementById('github-token');
            input.value = token === undefined ? 'test-token' : token;
            fire('click', document.querySelector('[data-action="github-save-token"]'));
        },
        syncStatus: () => (document.getElementById('sync-status') || { textContent: '' }).textContent,
        freshness: () => (document.getElementById('data-freshness') || { textContent: '' }).textContent,
        /** Останавливает автообновление: иначе таймер jsdom держит процесс теста */
        stopAutoRefresh: () => {
            const timer = window.FTApp && window.FTApp.sync && window.FTApp.sync.state
                ? window.FTApp.sync.state.refreshTimer
                : null;

            if (timer !== null && timer !== undefined) {
                window.clearInterval(timer);
            }
        }
    };
}

test('главная страница: активна только она, статистика и афиша ближайшего матча заполнены', () => {
    const app = boot();

    assert.equal(app.activeSection(), 'page-home');
    assert.equal(app.id('stat-teams').textContent, '4');
    assert.equal(app.id('stat-matches').textContent, '4');
    assert.equal(app.id('stat-players').textContent, '9');
    assert.equal(app.id('stat-finished').textContent, '2');

    // Ближайший из предстоящих матчей — отдельным блоком выше расписания:
    // команды, дата с временем и посекундное табло до начала
    const featured = app.id('next-match').querySelector('.match-card.next-match-card');

    assert.ok(featured, 'афиша ближайшего матча показана');
    assert.equal(featured.getAttribute('data-id'), '3', 'выбран самый близкий по дате матч');
    assert.equal(app.id('next-match-title').textContent, 'Ближайший матч');
    assert.match(featured.textContent, /Спартак/, 'команды видны');
    assert.match(featured.querySelector('.next-match-when').textContent, /19:30/, 'время начала показано');

    const match = app.storedData().matches.find((item) => item.id === 3);
    const countdown = featured.querySelector('.next-match-countdown');
    const parts = L.countdownParts(match, new Date());

    assert.ok(parts, 'до матча со временем начала идёт посекундный отсчёт');
    assert.ok(countdown.classList.contains('is-parts'), 'отсчёт показан плитками, а не строкой');
    assert.equal(countdown.classList.contains('is-empty'), false, 'отсчёт не пустой');

    const tiles = Array.from(countdown.querySelectorAll('.countdown-part'));

    // Дни показываются, только пока сутки остались; часы, минуты и секунды — всегда
    assert.ok(tiles.length === 4 || tiles.length === 3, 'плиток отсчёта: ' + tiles.length);
    assert.deepEqual(tiles.slice(-3).map((tile) => tile.getAttribute('data-part')),
        ['hours', 'minutes', 'seconds'], 'часы, минуты и секунды — отдельными плитками');
    assert.equal(tiles[0].getAttribute('data-part'), tiles.length === 4 ? 'days' : 'hours',
        'дни идут отдельной плиткой и исчезают, когда остались только часы');
    tiles.forEach((tile) => {
        assert.match(tile.querySelector('.countdown-value').textContent, /^\d{1,2}$/,
            'значение плитки — число: ' + tile.textContent);
        assert.match(tile.querySelector('.countdown-unit').textContent, /^(день|дня|дней|часов|минут|секунд)$/,
            'у плитки есть подпись: ' + tile.textContent);
    });

    // Ниже — остальные предстоящие матчи: афиша не повторяется
    const upcoming = app.id('upcoming-matches').querySelectorAll('.match-card');

    assert.equal(upcoming.length, 1, 'в списке только следующий матч');
    assert.equal(upcoming[0].getAttribute('data-id'), '4');
    assert.equal(app.id('upcoming-title').textContent, 'Предстоящие матчи');

    // Последние результаты отдельным блоком не выводятся: они в один клик
    // по плитке «Завершено» над этим блоком
    assert.equal(app.id('latest-results'), null, 'блока «Последние результаты» на главной больше нет');

    assert.equal(app.storedData().teams.length, 4, 'демо-данные сразу попадают в хранилище');
});

test('главная: когда все матчи сыграны, блоки переключаются на итоги', () => {
    const seeded = remoteData();

    seeded.matches.forEach((match) => {
        match.finished = true;
        match.scoreA = 1;
        match.scoreB = 1;
    });

    const app = boot({ seed: { [DATA_KEY]: JSON.stringify(seeded) } });

    assert.equal(app.id('next-match-title').textContent, 'Последний матч', 'заголовок афиши переключился');
    assert.equal(app.id('upcoming-title').textContent, 'Последние результаты');
    assert.equal(app.id('next-match-link').textContent, 'Все матчи');

    const featured = app.id('next-match').querySelector('.match-card');

    assert.equal(featured.getAttribute('data-id'), '4', 'показан самый поздний матч');
    assert.match(featured.textContent, /1 : 1/, 'счёт последнего матча виден');

    const countdown = featured.querySelector('.next-match-countdown');

    assert.equal(countdown.classList.contains('is-empty'), true, 'у сыгранного матча отсчёта нет');
    assert.equal(countdown.querySelectorAll('.countdown-part').length, 0, 'плиток отсчёта тоже нет');

    // В списке ниже — остальные результаты (сам последний матч уже показан выше)
    const results = app.id('upcoming-matches').querySelectorAll('.match-card');

    assert.deepEqual(Array.from(results).map((card) => card.getAttribute('data-id')), ['3', '2', '1']);
    assert.equal(app.id('stat-finished').textContent, '4');
});

test('главная: без времени начала табло уступает место отсчёту словами', () => {
    const seeded = remoteData();
    const next = seeded.matches.filter((match) => !match.finished)[0];

    // Времени начала нет — посекундный счёт считал бы секунды до полуночи,
    // то есть выдумывал бы точность, которой в данных нет
    next.time = '';

    const app = boot({ seed: { [DATA_KEY]: JSON.stringify(seeded) } });
    const countdown = app.id('next-match').querySelector('.next-match-countdown');

    assert.equal(countdown.classList.contains('is-parts'), false, 'плиток посекундного счёта нет');
    assert.equal(countdown.classList.contains('is-empty'), false, 'отсчёт словами показан');
    assert.equal(countdown.textContent, L.countdownLabel(next, new Date()), 'отсчёт совпадает с датой матча');
    assert.match(countdown.textContent, /^через \d+ (день|дня|дней)$/);
});

test('навигация: переключение страниц, подсветка меню и хэш-адреса', () => {
    const app = boot();

    ['standings', 'teams', 'matches', 'admin', 'home'].forEach((page) => {
        app.navigate(page);

        const expected = page === 'admin' ? 'page-admin-login' : 'page-' + page;
        assert.equal(app.activeSection(), expected, 'страница ' + page);

        const buttons = app.$$('[data-nav="' + page + '"]');
        assert.equal(buttons.length, 2, 'пункт есть и в десктопном, и в мобильном меню');
        buttons.forEach((button) => {
            assert.ok(button.classList.contains('active'), 'подсвечен активный пункт меню');
            assert.equal(button.getAttribute('aria-current'), 'page');
        });

        assert.equal(app.window.location.hash, '#/' + page);
    });

    // Прямая ссылка с хэшем открывает нужную страницу
    const direct = boot();
    direct.window.location.hash = '#/teams';
    direct.window.dispatchEvent(new direct.window.Event('hashchange'));
    assert.equal(direct.activeSection(), 'page-teams');

    assert.equal(app.id('mobile-menu').classList.contains('hidden'), true, 'меню закрывается после перехода');
});

test('турнирная таблица: места, очки и разница мячей (без столбца «Форма»)', () => {
    const app = boot();

    app.navigate('standings');

    const rows = Array.from(app.id('standings-body').querySelectorAll('tr'));
    assert.equal(rows.length, 4);

    const cells = (row) => Array.from(row.querySelectorAll('td')).map((cell) => cell.textContent.trim());
    const teamOf = (row) => {
        const badge = row.querySelector('.team-badge');
        return { badge: badge.textContent.trim(), name: badge.nextElementSibling.textContent.trim() };
    };

    assert.equal(cells(rows[0])[0], '1', 'место в первом столбце');
    assert.deepEqual(teamOf(rows[0]), { badge: 'СП', name: 'Спартак' });
    assert.deepEqual(cells(rows[0]).slice(2, 8), ['1', '1', '0', '0', '2–1', '+1'], 'И, В, Н, П, мячи, РМ');
    assert.equal(cells(rows[0])[8], '3', 'очки лидера');

    assert.equal(teamOf(rows[1]).name, 'Динамо');
    assert.equal(cells(rows[1])[8], '1');
    assert.equal(teamOf(rows[3]).name, 'Локомотив');
    assert.equal(cells(rows[3])[8], '0');

    // «Формы» в таблице больше нет: последний столбец — очки, точек формы нет
    assert.equal(rows[0].querySelectorAll('td').length, 9, 'место, команда, И, В, Н, П, мячи, РМ, очки');
    assert.equal(rows[0].querySelectorAll('.form-dot').length, 0, 'форма команды не показывается');

    // Сначала эмблема команды (или бейдж с инициалами), потом название
    const firstLink = rows[0].querySelector('.team-link');

    assert.ok(firstLink.firstElementChild.classList.contains('team-badge'), 'эмблема стоит перед названием');
    assert.equal(firstLink.firstElementChild.nextElementSibling.classList.contains('team-name'), true,
        'после эмблемы идёт название команды');

    // Подсветка призовой тройки: лидер — зелёный, 2 и 3 место — светло-жёлтый
    assert.equal(rows[0].classList.contains('bg-primary-50'), true, 'лидер подсвечен зелёным');
    assert.equal(rows[0].classList.contains('bg-amber-50'), false, 'у лидера нет жёлтой подсветки');
    assert.equal(rows[1].classList.contains('bg-amber-50'), true, 'второе место — светло-жёлтое');
    assert.equal(rows[2].classList.contains('bg-amber-50'), true, 'третье место — светло-жёлтое');
    assert.equal(rows[1].classList.contains('bg-primary-50'), false, 'второе место без зелёной подсветки');
    assert.equal(rows[3].className.trim(), '', 'четвёртое место без подсветки');
});

test('команды: карточки, поиск и состав', () => {
    const app = boot();

    app.navigate('teams');
    assert.equal(app.$$('#teams-grid article').length, 4);
    assert.match(app.id('teams-grid').textContent, /Иванов А\./);
    assert.match(app.id('teams-grid').textContent, /Место: 1/);

    app.type(app.id('team-search'), 'спар');
    assert.equal(app.$$('#teams-grid article').length, 1);
    assert.match(app.id('teams-grid').textContent, /Спартак/);

    app.type(app.id('team-search'), 'такой команды нет');
    assert.match(app.id('teams-grid').textContent, /Команды не найдены/);

    app.type(app.id('team-search'), '');
    assert.equal(app.$$('#teams-grid article').length, 4);
});

test('страница команды: открывается из турнирной таблицы и из списка команд', () => {
    const app = boot();

    // Строка турнирной таблицы ведёт на страницу команды
    app.navigate('standings');
    const row = app.id('standings-body').querySelector('tr[data-action="team-public-open"][data-id="1"]');
    assert.ok(row, 'строка команды кликабельна');
    assert.ok(row.querySelector('.team-link'), 'название команды — кнопка');
    assert.ok(row.querySelector('.team-name'), 'имя команды на месте');

    app.click(row);

    assert.equal(app.activeSection(), 'page-teams', 'открылась страница «Команды»');
    assert.equal(app.id('team-list-view').hidden, true, 'список команд скрылся');
    assert.equal(app.id('team-detail-view').hidden, false, 'показана страница команды');
    assert.equal(app.window.location.hash, '#/team/1', 'у команды свой адрес');

    const detail = app.id('team-detail');

    assert.match(detail.textContent, /Спартак/);
    assert.match(detail.textContent, /Игроков в заявке: 3/);
    assert.equal(detail.querySelectorAll('.stat-box').length, 5, 'место, очки, игры, ГЗ и ГП');

    // Забитые и пропущенные мячи — отдельными плитками, а не счётом «забитые–пропущенные»
    const tiles = Array.from(detail.querySelectorAll('.stat-label'))
        .map((element) => element.firstChild.textContent.trim());

    assert.deepEqual(tiles, ['Место', 'Очки', 'Игры', 'ГЗ', 'ГП']);

    const values = Array.from(detail.querySelectorAll('.stat-value')).map((element) => element.textContent.trim());

    assert.deepEqual(values, ['1', '3', '1', '2', '1'], 'Спартак: место, очки, игры, забитые, пропущенные');
    assert.equal(detail.querySelectorAll('.stat-box[title="Голов забито"]').length, 1);
    assert.equal(detail.querySelectorAll('.stat-box[title="Голов пропущено"]').length, 1);
    assert.equal(detail.textContent.includes('Мячи'), false, 'плитки «Мячи» со счётом больше нет');

    assert.match(detail.textContent, /Победы: 1 · Ничьи: 0 · Поражения: 0/);

    // Состав — один кликабельный блок «Состав»: список скрыт, пока его не открыли
    const squadToggle = detail.querySelector('.squad-toggle');

    assert.ok(squadToggle, 'состав свёрнут в кнопку «Состав»');
    assert.equal(squadToggle.getAttribute('aria-expanded'), 'false');
    assert.equal(detail.querySelectorAll('.chip-player').length, 0, 'чипов игроков на странице больше нет');
    assert.equal(detail.querySelector('#team-squad').hidden, true, 'список состава скрыт');
    assert.equal(detail.querySelectorAll('.squad-table tbody tr').length, 3, 'все игроки в списке состава');
    assert.equal(detail.querySelectorAll('.match-card').length, 2, 'только матчи этой команды');

    // Возврат к списку команд
    app.click(app.button('team-public-back'));
    assert.equal(app.id('team-list-view').hidden, false);
    assert.equal(app.id('team-detail-view').hidden, true);
    assert.equal(app.window.location.hash, '#/teams');

    // Из списка команд тоже можно провалиться в команду
    app.click(app.id('teams-grid').querySelector('[data-action="team-public-open"][data-id="2"]'));
    assert.equal(app.id('team-detail-view').hidden, false);
    assert.match(app.id('team-detail').textContent, /Локомотив/);
    assert.equal(app.window.location.hash, '#/team/2');

    // А из страницы команды — в детальный результат её матча
    const matchLink = app.id('team-detail').querySelector('[data-action="match-public-open"]');
    assert.ok(matchLink, 'матчи команды ведут в детальный результат');

    app.click(matchLink);

    assert.equal(app.activeSection(), 'page-matches');
    assert.equal(app.id('match-detail-view').hidden, false, 'открылся детальный результат матча');
});

test('лучшие бомбардиры: таблица показывает только забитые мячи, без колонок карточек', () => {
    const app = boot();

    // Пока записей нет — понятная подсказка вместо пустой таблицы
    app.navigate('players');
    assert.equal(app.activeSection(), 'page-players');
    assert.match(app.id('players-body').textContent, /ещё не отмечены/);

    // Администратор отмечает в карточке матча два гола, жёлтую карточку и гол соперника
    app.login();
    app.openMatch(1);
    app.click(app.markButton(1, 'Иванов А.', 'goal'));
    app.click(app.markButton(1, 'Иванов А.', 'goal'));
    app.click(app.markButton(1, 'Петров П.', 'yellow'));
    app.click(app.markButton(2, 'Кузнецов К.', 'goal'));

    // В таблице — только бомбардиры, отсортированные по голам
    app.navigate('players');
    const rows = Array.from(app.id('players-body').querySelectorAll('tr'));
    const numbers = (row) => Array.from(row.querySelectorAll('td.num')).map((cell) => cell.textContent.trim());

    assert.equal(rows.length, 2, 'игрок только с карточкой в таблицу бомбардиров не попадает');
    assert.deepEqual(rows.map((row) => row.querySelector('.player-name').textContent),
        ['Иванов А.', 'Кузнецов К.']);
    assert.deepEqual(numbers(rows[0]), ['1', '2'], 'место и голы');
    assert.match(rows[0].querySelector('.col-optional').textContent, /Спартак/, 'команда игрока показана');
    assert.deepEqual(numbers(rows[1]), ['2', '1']);

    // Колонок жёлтых и красных карточек в таблице больше нет
    // Стрелку сортировки (↕) в подписях столбцов не учитываем
    const headers = Array.from(app.id('players-body').closest('table').querySelectorAll('thead th'))
        .map((cell) => cell.textContent.replace(/[↕↑↓]/g, '').trim());

    assert.deepEqual(headers, ['#', 'Игрок', 'Команда', 'Голы']);
    assert.equal(rows[0].querySelectorAll('td').length, 4, 'место, игрок, команда, голы');

    // Кнопка в меню ведёт на страницу
    app.click(app.$('[data-nav="players"]'));
    assert.equal(app.activeSection(), 'page-players');
});

test('матчи: фильтры «все», «завершённые», «предстоящие»', () => {
    const app = boot();

    app.navigate('matches');
    assert.equal(app.$$('#matches-list .match-card').length, 4);

    const finishedButton = app.$('[data-action="filter"][data-filter="finished"]');
    app.click(finishedButton);
    assert.equal(app.$$('#matches-list .match-card').length, 2);
    assert.ok(finishedButton.classList.contains('is-active'));
    assert.equal(app.id('matches-list').querySelectorAll('.status-pill.finished').length, 2);

    app.click(app.$('[data-action="filter"][data-filter="upcoming"]'));
    assert.equal(app.$$('#matches-list .match-card').length, 2);
    assert.equal(app.id('matches-list').querySelectorAll('.status-pill.upcoming').length, 2);

    app.click(app.$('[data-action="filter"][data-filter="all"]'));
    assert.equal(app.$$('#matches-list .match-card').length, 4);
});

test('матчи для посетителей: поиск по команде фильтрует список', () => {
    const app = boot();

    app.navigate('matches');
    const search = app.id('match-search');
    assert.ok(search, 'на странице матчей есть строка поиска');
    assert.equal(app.$$('#matches-list .match-card').length, 4);

    // Часть названия — и в списке остаются только матчи этой команды
    app.type(search, 'спар');
    assert.equal(app.$$('#matches-list .match-card').length, 2, 'остались матчи Спартака');
    assert.equal(app.id('matches-list').textContent.match(/Спартак/g).length, 2);
    assert.match(app.id('matches-found').textContent, /Найдено матчей: 2 из 4/);

    // Поиск работает вместе с фильтром «завершённые / предстоящие»
    app.click(app.$('[data-action="filter"][data-filter="finished"]'));
    assert.equal(app.$$('#matches-list .match-card').length, 1, 'из матчей Спартака остался завершённый');

    app.click(app.$('[data-action="filter"][data-filter="all"]'));
    app.type(search, 'динамо');
    assert.equal(app.$$('#matches-list .match-card').length, 2, 'найдены матчи Динамо');

    // Ничего не нашлось — понятная подсказка вместо пустого экрана
    app.type(search, 'зенит');
    assert.equal(app.$$('#matches-list .match-card').length, 0);
    assert.match(app.id('matches-list').textContent, /По запросу «зенит» матчей не найдено/);
    assert.match(app.id('matches-found').textContent, /0 из 4/);

    // Очистка строки поиска возвращает весь список
    app.type(search, '');
    assert.equal(app.$$('#matches-list .match-card').length, 4);
    assert.equal(app.id('matches-found').textContent, '');
});

test('админка: поиск в разделе «Матчи» фильтрует список', () => {
    const app = boot();
    app.login();

    app.click(app.$('[data-admin-tab="matches"]'));
    const search = app.id('admin-match-search');
    assert.ok(search, 'в разделе «Матчи» есть строка поиска');
    assert.equal(app.$$('#admin-matches-list [data-action="match-open"]').length, 4);

    app.type(search, 'локомотив');
    assert.equal(app.$$('#admin-matches-list [data-action="match-open"]').length, 2, 'остались матчи Локомотива');

    app.type(search, 'зенит');
    assert.equal(app.$$('#admin-matches-list [data-action="match-open"]').length, 0);
    assert.match(app.id('admin-matches-list').textContent, /По запросу «зенит» матчей не найдено/);

    app.type(search, '');
    assert.equal(app.$$('#admin-matches-list [data-action="match-open"]').length, 4, 'поиск очищен — список вернулся');
});

test('матч для посетителей: клик по карточке открывает детальный результат с составами и событиями', () => {
    const app = boot();

    // Сначала на странице матчей виден список
    app.navigate('matches');
    assert.equal(app.id('match-list-view').hidden, false, 'показан список матчей');
    assert.equal(app.id('match-detail-view').hidden, true, 'детальный результат скрыт');
    assert.equal(app.$$('#matches-list .match-card').length, 4, 'карточки матчей кликабельны');
    assert.equal(app.$$('#matches-list .match-card .team-link').length, 8, 'названия команд в карточках — ссылки');

    // Клик по матчу открывает детальный результат: счёт, кто играл, голы и карточки
    app.click(app.$('#matches-list [data-action="match-public-open"][data-id="1"]'));

    assert.equal(app.id('match-list-view').hidden, true, 'список матчей скрылся');
    assert.equal(app.id('match-detail-view').hidden, false, 'показан детальный результат');
    assert.equal(app.activeSection(), 'page-matches');
    assert.equal(app.window.location.hash, '#/match/1', 'у матча свой адрес');
    assert.match(app.id('match-detail').textContent, /Спартак/);
    assert.match(app.id('match-detail').textContent, /Локомотив/);
    assert.equal(app.id('match-detail').querySelectorAll('.score-display').length, 1, 'счёт матча показан');

    // Составы обеих команд: три игрока Спартака и два Локомотива
    const squadRows = Array.from(app.id('match-detail').querySelectorAll('.squad-row'));
    assert.deepEqual(squadRows.map((row) => row.querySelector('.squad-name').textContent),
        ['Иванов А.', 'Петров П.', 'Сидоров С.', 'Кузнецов К.', 'Попов П.']);
    assert.deepEqual(app.id('match-detail').querySelectorAll('.match-detail-team').length, 2);

    // Администратор отмечает гол и жёлтую карточку — они видны в детальном результате
    app.login();
    app.openMatch(1);
    app.click(app.markButton(1, 'Иванов А.', 'goal'));
    app.click(app.markButton(1, 'Петров П.', 'yellow'));

    app.navigate('matches');
    app.click(app.$('#matches-list [data-action="match-public-open"][data-id="1"]'));

    const marks = Array.from(app.id('match-detail').querySelectorAll('.squad-mark'));
    assert.deepEqual(marks.map((mark) => mark.className.replace('squad-mark ', '') + ':' + mark.textContent.trim()),
        ['squad-mark-goal:1', 'squad-mark-yellow:1'], 'видны гол и жёлтая карточка');

    // Кнопка «Все матчи» возвращает список
    app.click(app.button('match-public-back'));
    assert.equal(app.id('match-list-view').hidden, false);
    assert.equal(app.id('match-detail-view').hidden, true);
    assert.equal(app.window.location.hash, '#/matches');
});

test('названия команд кликабельны везде, где они встречаются', () => {
    const app = boot();

    // Главная: в карточках матчей обе команды — ссылки
    const homeCards = app.$$('#next-match .match-card').length + app.$$('#upcoming-matches .match-card').length;

    assert.ok(homeCards > 0, 'на главной есть карточки матчей');
    assert.equal(app.$$('#next-match .team-link, #upcoming-matches .team-link').length, homeCards * 2,
        'на главной у каждой команды в карточке матча — ссылка');

    // Страница матчей: то же самое
    app.navigate('matches');
    assert.equal(app.$$('#matches-list .team-link').length, app.$$('#matches-list .match-card').length * 2);

    // Детальный результат: названия у счёта и заголовки составов
    app.click(app.$('#matches-list .match-card[data-id="1"]'));

    assert.equal(app.$$('#match-detail a.match-detail-team').length, 2, 'названия команд у счёта — ссылки');
    assert.equal(app.$$('#match-detail .squad-team a').length, 2, 'заголовки составов — ссылки на команды');

    // Переход по названию команды прямо из детального результата
    app.click(app.$('#match-detail a.match-detail-team'));

    assert.equal(app.id('team-detail-view').hidden, false, 'открылась страница команды');
    assert.match(app.id('team-detail').textContent, /Спартак/);
    assert.equal(app.window.location.hash, '#/team/1');

    // Турнирная таблица: и вся строка, и название команды
    app.navigate('standings');
    assert.equal(app.$$('#standings-body tr[data-action="team-public-open"]').length, 4, 'строки таблицы кликабельны');
    assert.equal(app.$$('#standings-body .team-link').length, 4, 'названия команд в таблице — ссылки');

    // Лучшие бомбардиры: команда в столбце — ссылка
    app.login();
    app.openMatch(1);
    app.click(app.markButton(1, 'Иванов А.', 'goal'));

    app.navigate('players');
    const teamCell = app.id('players-body').querySelector('.col-optional .team-link');

    assert.ok(teamCell, 'в бомбардирах команда — ссылка');
    assert.equal(teamCell.getAttribute('href'), '#/team/1');

    app.click(teamCell);
    assert.equal(app.id('team-detail-view').hidden, false, 'из бомбардиров тоже открывается команда');
    assert.match(app.id('team-detail').textContent, /Спартак/);
});

test('кнопка «Назад» возвращает на предыдущую страницу', () => {
    const app = boot();

    // На старте возвращаться некуда — кнопки не видно
    assert.equal(app.id('back-button').hidden, true, 'кнопка скрыта, пока история пуста');

    // Главная → Таблица: кнопка появилась и ведёт на «Главную»
    app.navigate('standings');
    assert.equal(app.id('back-button').hidden, false, 'кнопка показана');
    assert.match(app.id('back-button').getAttribute('aria-label'), /Главная/);

    app.click(app.button('go-back'));
    assert.equal(app.activeSection(), 'page-home');
    assert.equal(app.window.location.hash, '#/home');
    assert.equal(app.id('back-button').hidden, true, 'вернулись к началу — история пуста');

    // Таблица → команда: «Назад» возвращает в таблицу, а не в список команд
    app.navigate('standings');
    app.click(app.id('standings-body').querySelector('tr[data-action="team-public-open"][data-id="1"]'));

    assert.equal(app.id('team-detail-view').hidden, false, 'открылась страница команды');
    assert.match(app.id('back-button').getAttribute('aria-label'), /Таблица/);

    app.click(app.button('go-back'));

    assert.equal(app.activeSection(), 'page-standings', 'вернулись в турнирную таблицу');
    assert.equal(app.window.location.hash, '#/standings');

    // Главная → матч → команда: назад сначала к матчу, затем на главную
    app.navigate('home');
    app.click(app.id('next-match').querySelector('.match-card'));
    assert.equal(app.id('match-detail-view').hidden, false, 'открылся детальный результат матча');

    app.click(app.id('match-detail').querySelector('a.match-detail-team'));
    assert.equal(app.id('team-detail-view').hidden, false, 'открылась страница команды');
    assert.match(app.id('back-button').getAttribute('aria-label'), /Матчи/);

    app.click(app.button('go-back'));
    assert.equal(app.id('match-detail-view').hidden, false, 'вернулись к матчу');
    assert.equal(app.window.location.hash, '#/match/3', 'вернулись к тому же матчу');

    app.click(app.button('go-back'));
    assert.equal(app.activeSection(), 'page-home', 'а затем на главную');

    // Переходы внутри раздела (список ⇄ деталь) новую страницу не создают
    app.navigate('matches');
    assert.match(app.id('back-button').getAttribute('aria-label'), /Главная/);

    app.click(app.id('matches-list').querySelector('.match-card[data-id="1"]'));
    assert.equal(app.id('match-detail-view').hidden, false);
    assert.match(app.id('back-button').getAttribute('aria-label'), /Главная/, 'детальный результат — не новая страница');

    app.click(app.button('go-back'));
    assert.equal(app.activeSection(), 'page-home', 'и возвращает на главную');
});

test('админка: вход только по паролю, сессия сохраняется, выход работает', () => {
    const app = boot();

    app.navigate('admin');
    assert.equal(app.activeSection(), 'page-admin-login', 'без пароля видна форма входа');

    app.login('неверный');
    assert.equal(app.id('login-error').textContent, 'Неверный пароль');
    assert.equal(app.activeSection(), 'page-admin-login');
    assert.equal(app.window.FTApp.isAdmin(), false);

    app.login('admin');
    assert.equal(app.id('login-error').textContent, 'Неверный пароль');

    app.login();
    assert.equal(app.id('login-error').textContent, '');
    assert.equal(app.activeSection(), 'page-admin-dashboard');
    assert.equal(app.window.FTApp.isAdmin(), true);
    assert.equal(app.id('admin-password').value, '', 'пароль не остаётся в поле');

    app.navigate('home');
    app.navigate('admin');
    assert.equal(app.activeSection(), 'page-admin-dashboard', 'повторный вход не требуется');
    assert.equal(app.window.sessionStorage.getItem('footballTournamentAdmin'), '1');

    app.click(app.actionButton('logout'));
    assert.equal(app.activeSection(), 'page-home');
    assert.equal(app.window.FTApp.isAdmin(), false);

    app.navigate('admin');
    assert.equal(app.activeSection(), 'page-admin-login', 'после выхода нужен пароль снова');
});

test('админка: разделы «Команды» и «Матчи» переключаются, блоки не путаются', () => {
    const app = boot();
    app.login();

    const teamsTab = app.$('[data-admin-tab="teams"]');
    const matchesTab = app.$('[data-admin-tab="matches"]');
    const teamsPanel = app.id('admin-panel-teams');
    const matchesPanel = app.id('admin-panel-matches');

    // По умолчанию открыт раздел «Команды»
    assert.equal(teamsTab.getAttribute('aria-selected'), 'true');
    assert.equal(matchesTab.getAttribute('aria-selected'), 'false');
    assert.equal(teamsPanel.hidden, false);
    assert.equal(matchesPanel.hidden, true);

    // В разделе «Команды» — список команд, создание команды и состав
    assert.ok(teamsPanel.contains(app.id('new-team-name')));
    assert.ok(teamsPanel.contains(app.id('admin-teams-list')));
    assert.ok(teamsPanel.contains(app.id('admin-players-list')));
    assert.equal(teamsPanel.contains(app.id('match-submit')), false, 'форма матча — в другом разделе');

    // В разделе «Матчи» — только матчи: форма, список, карточка
    assert.ok(matchesPanel.contains(app.id('match-submit')));
    assert.ok(matchesPanel.contains(app.id('admin-matches-list')));
    assert.ok(matchesPanel.contains(app.id('admin-match-view')));
    assert.equal(matchesPanel.contains(app.id('new-team-name')), false, 'форма команды — в другом разделе');

    // Кнопка раздела открывает свою панель и снимает подсветку с соседней
    app.click(matchesTab);
    assert.equal(app.$('[data-admin-tab="teams"]').getAttribute('aria-selected'), 'false');
    assert.equal(app.$('[data-admin-tab="matches"]').getAttribute('aria-selected'), 'true');
    assert.equal(teamsPanel.hidden, true);
    assert.equal(matchesPanel.hidden, false);

    // В открытом разделе работают свои действия: добавляем матч
    app.id('match-team-a').value = '1';
    app.id('match-team-b').value = '2';
    app.id('match-date').value = '2026-10-05';
    app.submit(app.$('[data-form="match"]'));
    assert.equal(app.storedData().matches.length, 5, 'матч добавлен из раздела «Матчи»');

    // Клавиши ←/→ и Home/End переключают разделы, когда фокус на их кнопке
    const press = (target, key) => target.dispatchEvent(
        new app.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
    );

    press(app.$('[data-admin-tab="matches"]'), 'ArrowLeft');
    assert.equal(teamsPanel.hidden, false, 'стрелка влево вернула раздел «Команды»');
    press(app.$('[data-admin-tab="teams"]'), 'End');
    assert.equal(matchesPanel.hidden, false, 'End открыл последний раздел');

    // Выход и повторный вход начинаются с раздела «Команды»
    app.click(app.actionButton('logout'));
    app.login();
    assert.equal(app.id('admin-panel-teams').hidden, false);
    assert.equal(app.id('admin-panel-matches').hidden, true);
});

test('админка: добавление, переименование и удаление команд', () => {
    const app = boot();
    app.login();

    assert.equal(app.id('admin-teams-list').querySelectorAll('[data-action="team-open"]').length, 4);

    // Добавление (пробелы лишние убираются)
    app.type(app.id('new-team-name'), '  Зенит  ');
    app.submit(app.$('[data-form="add-team"]'));
    assert.equal(app.storedData().teams.length, 5);
    assert.equal(app.id('admin-teams-list').querySelectorAll('[data-action="team-open"]').length, 5);
    assert.match(app.id('admin-teams-list').textContent, /Зенит/);
    assert.equal(app.id('new-team-name').value, '');
    assert.equal(app.id('team-form-error').textContent, '');
    assert.equal(app.id('stat-teams').textContent, '5', 'публичная статистика обновилась');

    // Дубликат в другом регистре
    app.type(app.id('new-team-name'), 'зенит');
    app.submit(app.$('[data-form="add-team"]'));
    assert.match(app.id('team-form-error').textContent, /уже есть/);
    assert.equal(app.storedData().teams.length, 5);

    // Пустое название
    app.type(app.id('new-team-name'), '   ');
    app.submit(app.$('[data-form="add-team"]'));
    assert.match(app.id('team-form-error').textContent, /Введите название/);

    // Клик по названию открывает карточку команды, список остаётся в стороне
    app.openTeam('Зенит');
    assert.equal(app.id('admin-team-list-view').hidden, true, 'список команд скрылся');
    assert.equal(app.id('admin-team-view').hidden, false, 'открылась карточка команды');
    assert.match(app.id('admin-team-title').textContent, /Зенит/);

    // Переименование
    app.click(app.button('team-rename'));
    assert.ok(app.id('team-rename-input'), 'появилось поле переименования');
    app.type(app.id('team-rename-input'), 'Зенит СПб');
    app.click(app.button('team-save'));
    assert.equal(app.id('team-rename-input'), null, 'режим правки закрылся');
    assert.ok(app.storedData().teams.some((team) => team.name === 'Зенит СПб'));
    assert.match(app.id('admin-team-title').textContent, /Зенит СПб/, 'название в карточке обновилось');

    // Отмена переименования ничего не меняет
    app.click(app.button('team-rename'));
    app.id('team-rename-input').value = 'Не должно сохраниться';
    app.click(app.button('team-cancel-edit'));
    assert.equal(app.storedData().teams.filter((team) => team.name === 'Не должно сохраниться').length, 0);

    // Кнопка «Все команды» возвращает список
    app.click(app.button('team-back'));
    assert.equal(app.id('admin-team-list-view').hidden, false);
    assert.equal(app.id('admin-team-view').hidden, true);
    assert.equal(app.id('admin-teams-list').querySelectorAll('[data-action="team-open"]').length, 5);

    // Удаление: команда удаляется вместе со своими матчами
    const before = app.storedData();
    assert.equal(before.matches.length, 4);
    app.openTeam('Спартак');
    app.click(app.button('team-delete'));

    const after = app.storedData();
    assert.equal(after.teams.length, 4);
    assert.equal(after.teams.some((team) => team.name === 'Спартак'), false);
    assert.equal(after.matches.length, 2, 'матчи удалённой команды тоже удалены');
    assert.ok(after.matches.every((match) => match.teamA !== 1 && match.teamB !== 1));
    assert.equal(app.id('admin-team-view').hidden, true, 'карточка удалённой команды закрылась');
    assert.equal(app.id('admin-team-list-view').hidden, false);
});

test('админка: отказ от подтверждения отменяет удаление', () => {
    const app = boot({ confirm: false });
    app.login();

    app.openTeam('Спартак');
    app.click(app.button('team-delete'));
    assert.equal(app.storedData().teams.length, 4, 'данные не изменились');

    app.click(app.button('team-back'));
    app.openMatch(1);
    app.click(app.button('match-delete'));
    assert.equal(app.storedData().matches.length, 4);
});

test('админка: добавление матча и понятные проверки формы', () => {
    const app = boot();
    app.login();

    const form = app.$('[data-form="match"]');
    assert.match(app.id('match-date').value, /^\d{4}-\d{2}-\d{2}$/, 'дата подставляется автоматически');

    // Пустая дата
    app.id('match-team-a').value = '1';
    app.id('match-team-b').value = '2';
    app.id('match-date').value = '';
    app.submit(form);
    assert.match(app.id('match-form-error').textContent, /Укажите дату/);

    // Одинаковые команды
    app.id('match-date').value = '2026-10-01';
    app.id('match-team-b').value = '1';
    app.submit(form);
    assert.match(app.id('match-form-error').textContent, /должны быть разными/);

    // Заполнен только один счёт — данные не должны молча теряться
    app.id('match-team-b').value = '2';
    app.id('match-score-a').value = '1';
    app.submit(form);
    assert.match(app.id('match-form-error').textContent, /счёт обеих команд/);
    assert.equal(app.storedData().matches.length, 4, 'ничего не сохранено');

    // Корректный предстоящий матч — со временем начала
    app.id('match-score-a').value = '';
    app.id('match-time').value = '19:30';
    app.submit(form);
    assert.equal(app.storedData().matches.length, 5);
    assert.equal(app.id('match-form-error').textContent, '');
    assert.equal(app.id('match-score-a').value, '', 'форма очищена');
    assert.equal(app.id('match-score-b').value, '');
    assert.equal(app.id('match-time').value, '', 'время тоже очищено (поле необязательное)');

    const added = app.storedData().matches[4];
    assert.deepEqual(
        { teamA: added.teamA, teamB: added.teamB, date: added.date, time: added.time, finished: added.finished },
        { teamA: 1, teamB: 2, date: '2026-10-01', time: '19:30', finished: false }
    );
    assert.equal(app.id('stat-matches').textContent, '5');

    // Время видно в списке матчей админки и подставляется в форму редактирования
    assert.match(app.id('admin-matches-list').textContent, /01\.10\.2026, 19:30/);

    app.openMatch(added.id);
    assert.match(app.id('admin-match-score').textContent, /1 октября 2026, 19:30/, 'время видно в карточке матча');
    app.click(app.button('match-edit'));
    assert.equal(app.id('match-time').value, '19:30', 'время подставляется в форму редактирования');
    app.click(app.id('match-cancel'));

    // Матч без времени — обычное дело: сохраняется и выглядит как раньше
    app.id('match-team-a').value = '1';
    app.id('match-team-b').value = '2';
    app.id('match-date').value = '2026-10-02';
    app.submit(form);
    assert.equal(app.storedData().matches[5].time, '', 'время необязательно');
});

test('админка: ввод счёта, переоткрытие, правка и удаление матча влияют на таблицу', () => {
    const app = boot();
    app.login();

    assert.equal(app.storedData().matches.find((match) => match.id === 3).finished, false);

    // Матч открывается кликом по строке списка: счёт вводится в его карточке
    app.openMatch(3);
    assert.equal(app.id('admin-match-list-view').hidden, true, 'список матчей скрылся');
    assert.equal(app.id('admin-match-view').hidden, false, 'открылась карточка матча');

    // Победный счёт Спартака над Динамо
    app.id('score-a-3').value = '4';
    app.id('score-b-3').value = '0';
    app.click(app.button('match-save-score'));

    const saved = app.storedData().matches.find((match) => match.id === 3);
    assert.deepEqual([saved.scoreA, saved.scoreB, saved.finished], [4, 0, true]);
    assert.equal(app.id('stat-finished').textContent, '3');

    // Матч сыгран — на главной его место занял следующий по расписанию,
    // а сам результат смотрится по плитке «Завершено»
    assert.equal(app.id('next-match').querySelector('.match-card').getAttribute('data-id'), '4');
    assert.equal(app.id('next-match-title').textContent, 'Ближайший матч');

    app.navigate('standings');
    const spartakCells = Array.from(app.id('standings-body').querySelector('tr').querySelectorAll('td'))
        .map((cell) => cell.textContent.trim());
    assert.equal(spartakCells[8], '6', 'Спартак: 3 + 3 очка');
    assert.equal(spartakCells[2], '2', 'сыграно два матча');

    // Переоткрытие матча убирает его из зачёта
    app.navigate('admin');
    app.openMatch(3);
    app.click(app.button('match-reopen'));
    assert.equal(app.storedData().matches.find((match) => match.id === 3).finished, false);

    app.navigate('standings');
    const afterReopen = Array.from(app.id('standings-body').querySelector('tr').querySelectorAll('td'))
        .map((cell) => cell.textContent.trim());
    assert.equal(afterReopen[8], '3');

    // Редактирование матча через форму
    app.navigate('admin');
    app.openMatch(3);
    app.click(app.button('match-edit'));
    assert.equal(app.id('match-form-title').textContent, 'Изменить матч');
    assert.equal(app.id('match-date').value, app.storedData().matches.find((match) => match.id === 3).date);
    assert.equal(app.id('match-cancel').hidden, false, 'появилась кнопка отмены');
    assert.equal(app.id('match-score-a').value, '', 'у переоткрытого матча счёта ещё нет');
    assert.equal(app.id('admin-match-view').hidden, true, 'форма открылась в списке матчей');

    // Форма подставляет данные уже завершённого матча
    app.openMatch(1);
    app.click(app.button('match-edit'));
    assert.deepEqual(
        [app.id('match-score-a').value, app.id('match-score-b').value, app.id('match-date').value],
        ['2', '1', app.storedData().matches.find((match) => match.id === 1).date]
    );

    // Сохраняем изменения переоткрытого матча №3
    app.openMatch(3);
    app.click(app.button('match-edit'));
    app.id('match-date').value = '2026-11-11';
    app.id('match-score-a').value = '1';
    app.id('match-score-b').value = '1';
    app.submit(app.$('[data-form="match"]'));

    const edited = app.storedData().matches.find((match) => match.id === 3);
    assert.deepEqual([edited.date, edited.scoreA, edited.scoreB, edited.finished], ['2026-11-11', 1, 1, true]);
    assert.equal(app.id('match-form-title').textContent, 'Добавить матч', 'форма вернулась в режим добавления');
    assert.equal(app.id('match-cancel').hidden, true);

    // Отмена правки возвращает форму в исходное состояние
    app.openMatch(3);
    app.click(app.button('match-edit'));
    app.click(app.id('match-cancel'));
    assert.equal(app.id('match-form-title').textContent, 'Добавить матч');
    assert.equal(app.id('match-score-a').value, '');

    // Удаление матча
    app.openMatch(3);
    app.click(app.button('match-delete'));
    assert.equal(app.storedData().matches.length, 3);
    assert.equal(app.id('stat-matches').textContent, '3');
    assert.equal(app.id('admin-match-view').hidden, true, 'карточка закрылась после удаления');
    assert.equal(app.id('admin-match-list-view').hidden, false);
});

test('админка: в карточке матча отмечаются голы и карточки', () => {
    const app = boot();
    app.login();

    app.openMatch(1);
    assert.match(app.id('admin-match-score').textContent, /Спартак/);
    assert.match(app.id('admin-match-score').textContent, /Локомотив/);

    // Состав обеих команд: три отметки (гол и две карточки) и кнопка «Убрать» у каждого игрока
    assert.equal(app.id('admin-match-events').querySelectorAll('.event-row').length, 5);
    assert.equal(app.id('admin-match-events').querySelectorAll('[data-action="match-event"]').length, 15);
    assert.equal(app.id('admin-match-events').querySelectorAll('[data-action="match-event-undo"]').length, 5);
    assert.equal(app.id('admin-match-events').querySelectorAll('.event-btn.is-active').length, 0, 'записей ещё нет');

    const undoButtonFor = (player) => app.id('admin-match-events')
        .querySelector('[data-action="match-event-undo"][data-player="' + player + '"]');
    const matchOneEvents = () => app.storedData().matches.find((match) => match.id === 1).events || [];

    // Кнопка «Убрать» всегда на виду: пока записей нет — приглушена и данные не меняет
    assert.equal(undoButtonFor('Иванов А.').classList.contains('is-empty'), true);
    assert.match(undoButtonFor('Иванов А.').textContent, /Убрать/, 'у кнопки есть подпись');
    app.click(undoButtonFor('Иванов А.'));
    assert.equal(matchOneEvents().length, 0, 'убирать нечего — данные не меняются');
    assert.match(app.id('toast-container').textContent, /пока нет записей/);

    // Нажатие на мяч записывает гол, иконка становится активной
    app.click(app.markButton(1, 'Иванов А.', 'goal'));
    assert.deepEqual(app.storedData().matches[0].events, [{ team: 1, player: 'Иванов А.', type: 'goal' }]);
    assert.equal(app.markButton(1, 'Иванов А.', 'goal').classList.contains('is-active'), true);
    assert.equal(app.markButton(1, 'Иванов А.', 'goal').getAttribute('aria-pressed'), 'true');
    assert.equal(app.markButton(1, 'Иванов А.', 'goal').querySelector('.event-count').textContent, '1');

    // Кнопка «Убрать» знает, что именно снимет (последняя запись игрока)
    assert.equal(undoButtonFor('Иванов А.').classList.contains('is-empty'), false, 'появилась запись');
    assert.equal(undoButtonFor('Иванов А.').getAttribute('title'), 'Убрать последнюю запись: Гол');

    // Второй гол того же игрока — счётчик растёт
    app.click(app.markButton(1, 'Иванов А.', 'goal'));
    assert.equal(app.markButton(1, 'Иванов А.', 'goal').querySelector('.event-count').textContent, '2');

    // Жёлтая карточка — отдельная отметка, гол при этом не засчитан
    app.click(app.markButton(1, 'Петров П.', 'yellow'));
    assert.deepEqual(app.storedData().matches[0].events[2], { team: 1, player: 'Петров П.', type: 'yellow' });
    assert.equal(app.markButton(1, 'Петров П.', 'goal').classList.contains('is-active'), false, 'гол не засчитан');
    assert.equal(app.markButton(1, 'Петров П.', 'yellow').classList.contains('is-active'), true);
    assert.equal(app.markButton(1, 'Петров П.', 'yellow').getAttribute('title'), 'Жёлтая карточка');

    // У Петрова кнопка «Убрать» подсказывает, что снимет именно жёлтую карточку
    assert.equal(undoButtonFor('Петров П.').getAttribute('title'), 'Убрать последнюю запись: Жёлтая карточка');

    // Красная карточка и гол игрока второй команды
    app.click(app.markButton(2, 'Кузнецов К.', 'red'));
    assert.equal(app.markButton(2, 'Кузнецов К.', 'red').getAttribute('title'), 'Красная карточка');
    app.click(app.markButton(2, 'Кузнецов К.', 'goal'));
    assert.equal(app.markButton(2, 'Кузнецов К.', 'goal').classList.contains('is-active'), true);

    // Подсказка сверяет записанные голы со счётом матча (2:1)
    assert.match(app.id('admin-match-score').textContent, /Записано голов: 3 из 3/);

    // «Убрать» снимает последнюю запись первого игрока (случайное нажатие отменяется)
    app.click(undoButtonFor('Иванов А.'));
    assert.equal(app.markButton(1, 'Иванов А.', 'goal').querySelector('.event-count').textContent, '1');
    assert.equal(matchOneEvents().length, 4);

    // В списке матчей виден счёт, число записанных голов и карточек
    app.click(app.button('match-back'));
    const matchRow = app.id('admin-matches-list').querySelector('[data-action="match-open"][data-id="1"]');
    assert.match(matchRow.textContent, /Спартак 2 : 1 Локомотив/);
    assert.equal(matchRow.querySelector('.admin-row-count-goal').textContent.trim(), '2');
    assert.equal(matchRow.querySelector('.admin-row-count-yellow').textContent.trim(), '1');
    assert.equal(matchRow.querySelector('.admin-row-count-red').textContent.trim(), '1');

    // Случайную карточку тоже можно снять: у Петрова убираем жёлтую
    app.openMatch(1);
    app.click(undoButtonFor('Петров П.'));
    assert.equal(app.markButton(1, 'Петров П.', 'yellow').classList.contains('is-active'), false, 'жёлтая снята');
    assert.equal(matchOneEvents().length, 3);

    // Переименование игрока переносит его записи на новое имя
    app.openTeam('Спартак');
    app.click(app.id('admin-players-list').querySelector('[data-action="player-rename"]'));
    app.type(app.id('player-rename-input'), 'Иванов-старший');
    app.click(app.id('admin-players-list').querySelector('[data-action="player-save"]'));

    const renamed = app.storedData().matches.find((match) => match.id === 1);
    assert.equal(renamed.events.some((event) => event.player === 'Иванов-старший'), true, 'записи перешли на новое имя');
    assert.equal(renamed.events.some((event) => event.player === 'Иванов А.'), false);

    // Записи сохраняются в хранилище и видны снова после перезагрузки страницы
    const reloaded = boot({ seed: { [DATA_KEY]: JSON.stringify(app.storedData()) } });
    reloaded.login();
    reloaded.openMatch(1);
    assert.equal(reloaded.markButton(1, 'Иванов-старший', 'goal').querySelector('.event-count').textContent, '1');
    assert.equal(reloaded.markButton(2, 'Кузнецов К.', 'goal').classList.contains('is-active'), true);
});

test('дисциплина: лимит жёлтых карточек превращается в красную, игрок пропускает следующий матч', () => {
    const app = boot();
    app.login();

    // Четыре жёлтые карточки Иванова А. в первом матче (Спартак — Локомотив)
    app.openMatch(1);

    for (let i = 0; i < 4; i += 1) {
        app.click(app.markButton(1, 'Иванов А.', 'yellow'));
    }

    assert.equal(app.storedData().matches[0].events.filter((event) => event.type === 'yellow').length, 4);

    // Следующий матч Спартака (3-й) открыт в админке: игрок отмечен значком «пропуск»
    app.click(app.button('match-back'));
    app.openMatch(3);

    const adminBans = app.id('admin-match-bans');

    assert.match(adminBans.textContent, /Пропустят матч по карточкам/);
    assert.match(adminBans.textContent, /Иванов А\./);
    assert.ok(adminBans.textContent.includes('4-я жёлтая карточка, получена ' +
        L.formatDate(app.storedData().matches[0].date, 'numeric')), 'в админке видна дата получения карточки');
    assert.match(adminBans.textContent, /4-я жёлтая карточка за весь турнир превращается в красную/,
        'в админке видно само правило');
    assert.equal(adminBans.querySelectorAll('.admin-ban-item').length, 1);
    assert.equal(app.id('admin-match-events').querySelectorAll('.event-ban').length, 1,
        'значок «пропуск» стоит только у дисквалифицированного игрока');

    // Публичная страница матчей: строка «Пропустят матч»
    app.navigate('matches');

    const card = (matchId) => app.id('matches-list').querySelector('.match-card[data-id="' + matchId + '"]');

    assert.equal(card(1).querySelector('.match-bans'), null, 'в первом матче карточка получена — там запрета нет');
    assert.equal(card(2).querySelector('.match-bans'), null, 'матч других команд');
    assert.equal(card(4).querySelector('.match-bans'), null, 'матч Локомотива и ЦСКА ничего не пропускает');

    const line = card(3).querySelector('.match-bans');

    assert.ok(line, 'у предстоящего матча Спартака видна строка о дисквалификации');
    assert.match(line.textContent, /Пропустят матч:/);
    assert.match(line.textContent, /Иванов А\./);
    assert.match(line.textContent, /\(Спартак\)/);
    assert.equal(line.querySelector('.ban-name').getAttribute('title'),
        '4-я жёлтая карточка, получена ' + L.formatDate(app.storedData().matches[0].date, 'numeric'));

    // Главная: тот же игрок в табло ближайшего матча — под названием своей команды
    app.navigate('home');

    const afisha = app.id('next-match').querySelector('.match-card');

    assert.equal(afisha.getAttribute('data-id'), '3', 'в афише тот же ближайший матч');
    assert.equal(afisha.querySelectorAll('.next-match-bans').length, 1, 'строка дисквалификации одна');

    const lostA = afisha.querySelector('.next-match-side .next-match-bans');

    assert.ok(lostA, 'дисквалификация стоит под названием теряющей игрока команды');
    assert.match(lostA.textContent, /Иванов А\./);
    assert.equal(lostA.querySelectorAll('.next-match-ban').length, 1);
    assert.equal(lostA.querySelector('.next-match-ban').getAttribute('title'),
        'Пропустит матч: 4-я жёлтая карточка, получена ' + L.formatDate(app.storedData().matches[0].date, 'numeric'));
    assert.equal(afisha.querySelector('.next-match-side-away .next-match-bans'), null,
        'у второй команды потерь нет — строки нет');
    assert.equal(afisha.querySelector('.match-bans'), null, 'в афише нет второй, общей строки «Пропустят матч»');

    // Детальный результат: блок «Дисквалификации» с причиной и правилом
    app.click(card(3));

    const block = app.id('match-detail').querySelector('.match-bans-block');

    assert.ok(block, 'на странице матча появился блок дисквалификаций');
    assert.match(block.textContent, /Дисквалификации/);
    assert.match(block.textContent, /Иванов А\./);
    assert.ok(block.textContent.includes('4-я жёлтая карточка, получена ' +
        L.formatDate(app.storedData().matches[0].date, 'numeric')), 'в блоке видна дата получения карточки');
    assert.match(block.textContent, /превращается в красную/);

    // Матч сыгран — дисквалификация отбыта: новый матч Спартака без ограничений
    app.navigate('admin');
    app.openMatch(3);
    app.id('score-a-3').value = '1';
    app.id('score-b-3').value = '0';
    app.click(app.button('match-save-score'));
    app.click(app.button('match-back'));

    // Новый матч Спартака — после того, в котором отбыта дисквалификация
    const nextSpartak = L.matchStart(app.storedData().matches.find((match) => match.id === 3));

    nextSpartak.setDate(nextSpartak.getDate() + 7);
    app.id('match-team-a').value = '1';
    app.id('match-team-b').value = '4';
    app.id('match-date').value = L.toISODate(nextSpartak);
    app.submit(app.$('[data-form="match"]'));

    app.navigate('matches');
    assert.equal(app.id('matches-list').querySelector('.match-card[data-id="5"] .match-bans'), null,
        'после отбытого матча счёт жёлтых начинается заново');
});

test('дисциплина: правила задаются в админке, проверяются и применяются сразу', () => {
    const app = boot();
    app.login();

    const form = app.$('[data-form="discipline"]');

    assert.ok(form, 'в настройках есть блок «Дисциплина игроков»');
    assert.equal(app.id('discipline-yellow-limit').value, '4', 'подставляются текущие правила');
    assert.equal(app.id('discipline-period').value, '0');
    assert.match(app.id('discipline-rule').textContent, /^4-я жёлтая карточка за весь турнир/);
    assert.match(app.id('admin-matches-rule').textContent, /4-я жёлтая карточка за весь турнир/,
        'то же правило видно и в разделе «Матчи»');

    // Проверка ввода: при ошибке данные не меняются
    app.id('discipline-yellow-limit').value = '0';
    app.submit(form);

    assert.match(app.id('discipline-form-error').textContent, /от 1 до 12/);
    assert.deepEqual(app.storedData().settings, { yellowLimit: 4, yellowPeriodDays: 0, theme: 'classic' });

    app.id('discipline-yellow-limit').value = '2';
    app.id('discipline-period').value = '4000';
    app.submit(form);

    assert.match(app.id('discipline-form-error').textContent, /от 0 до 3650/);
    assert.deepEqual(app.storedData().settings, { yellowLimit: 4, yellowPeriodDays: 0, theme: 'classic' });

    // Рабочее правило: 2-я жёлтая за 30 дней превращается в красную
    app.id('discipline-yellow-limit').value = '2';
    app.id('discipline-period').value = '30';
    app.submit(form);

    assert.deepEqual(app.storedData().settings, { yellowLimit: 2, yellowPeriodDays: 30, theme: 'classic' });
    assert.equal(app.id('discipline-form-error').textContent, '');
    assert.match(app.id('toast-container').textContent, /Правила дисквалификаций сохранены/);
    assert.match(app.id('discipline-rule').textContent, /^2-я жёлтая карточка за 30 дней/);

    // Правило применяется сразу: две жёлтые — пропуск следующего матча
    app.openMatch(1);
    app.click(app.markButton(1, 'Иванов А.', 'yellow'));
    app.click(app.markButton(1, 'Иванов А.', 'yellow'));
    app.click(app.button('match-back'));

    app.navigate('matches');

    const line = app.id('matches-list').querySelector('.match-card[data-id="3"] .match-bans');

    assert.ok(line, 'после двух жёлтых игрок пропускает следующий матч команды');
    assert.match(line.textContent, /Иванов А\./);
    assert.match(line.querySelector('.ban-name').getAttribute('title'), /^2-я жёлтая карточка/);

    // Правила уезжают в данные вместе с остальными правками
    const stored = JSON.parse(app.window.localStorage.getItem(DATA_KEY));

    assert.deepEqual(stored.settings, { yellowLimit: 2, yellowPeriodDays: 30, theme: 'classic' });
});

test('оформление сайта: админка включает второй стиль, примерку видно только на своём устройстве', () => {
    const app = boot();
    app.login();

    const body = app.document.body;

    // В блоке настроек есть выбор оформления, по умолчанию — обычный вид
    assert.equal(app.$$('#theme-publish [data-action="theme-publish"]').length, 2,
        'два оформления: обычное и «Афиша матча»');
    assert.match(app.id('theme-status').textContent, /Классическое/, 'видно, что включено сейчас');
    assert.equal(body.classList.contains('theme-afisha'), false, 'без выбора стиля класс не появляется');

    const publishButton = (theme) => app.$('#theme-publish [data-action="theme-publish"][data-theme="' + theme + '"]');
    const previewButton = (theme) => app.$('#theme-preview [data-action="theme-preview"][data-theme="' + theme + '"]');

    assert.equal(publishButton('classic').getAttribute('aria-pressed'), 'true');
    assert.equal(publishButton('afisha').getAttribute('aria-pressed'), 'false');

    // 1. Примерка: вид меняется только у нас, общие данные не трогаются
    app.click(previewButton('afisha'));

    assert.equal(body.classList.contains('theme-afisha'), true, 'стиль «Афиша» применяется сразу');
    assert.equal(body.getAttribute('data-theme'), 'afisha');
    assert.deepEqual(app.storedData().settings, { yellowLimit: 4, yellowPeriodDays: 0, theme: 'classic' },
        'примерка не меняет то, что видят зрители');
    assert.match(app.id('theme-status').textContent, /примеряется/);
    assert.ok(app.button('theme-preview-off'), 'есть кнопка «Вернуть как у всех»');

    // 2. «Вернуть как у всех» — снова обычный вид
    app.click(app.button('theme-preview-off'));

    assert.equal(body.classList.contains('theme-afisha'), false);
    assert.equal(body.getAttribute('data-theme'), 'classic');
    assert.match(app.id('theme-status').textContent, /Классическое/);

    // 3. Публикация: выбор уезжает в данные турнира — его увидят все зрители
    app.click(publishButton('afisha'));

    assert.equal(body.classList.contains('theme-afisha'), true);
    assert.deepEqual(app.storedData().settings, { yellowLimit: 4, yellowPeriodDays: 0, theme: 'afisha' });
    assert.match(app.id('toast-container').textContent, /Оформление «Афиша матча» включено/);
    assert.equal(app.$$('#theme-publish [data-action="theme-publish"][aria-pressed="true"]')[0]
        .getAttribute('data-theme'), 'afisha', 'активная кнопка переключилась');

    // 4. Обычный вид возвращается одной кнопкой
    app.click(publishButton('classic'));

    assert.equal(body.classList.contains('theme-afisha'), false);
    assert.deepEqual(app.storedData().settings, { yellowLimit: 4, yellowPeriodDays: 0, theme: 'classic' });
    assert.match(app.id('toast-container').textContent, /Оформление «Классическое» включено/);

    // 5. Выбор оформления сохраняется вместе с данными и после перезапуска
    app.click(publishButton('afisha'));

    const restarted = boot({ seed: { [DATA_KEY]: app.window.localStorage.getItem(DATA_KEY) } });

    assert.equal(restarted.window.FTApp.theme.current(), 'afisha', 'оформление применилось при открытии');
    assert.equal(restarted.document.body.classList.contains('theme-afisha'), true);

    app.stopAutoRefresh();
    restarted.stopAutoRefresh();
});


test('админка: игроки — добавление, проверки, переименование и удаление', () => {
    const app = boot();
    app.login();

    // Состав открывается кликом по команде в списке
    app.openTeam('Спартак');
    assert.match(app.id('admin-team-title').textContent, /Спартак/);
    assert.equal(app.id('admin-players-list').querySelectorAll('.admin-card').length, 3);

    // Добавление
    app.type(app.id('new-player-name'), 'Новый Игрок');
    app.submit(app.$('[data-form="add-player"]'));
    assert.equal(app.storedData().teams[0].players.length, 4);
    assert.equal(app.id('stat-players').textContent, '10');
    assert.equal(app.id('new-player-name').value, '');

    // Дубликат в другом регистре
    app.type(app.id('new-player-name'), 'новый игрок');
    app.submit(app.$('[data-form="add-player"]'));
    assert.match(app.id('player-form-error').textContent, /уже есть/);
    assert.equal(app.storedData().teams[0].players.length, 4);

    // Пустое имя
    app.type(app.id('new-player-name'), '');
    app.submit(app.$('[data-form="add-player"]'));
    assert.match(app.id('player-form-error').textContent, /Введите имя/);

    // Открытая команда остаётся открытой после перерисовки
    assert.equal(app.id('admin-team-view').hidden, false);
    assert.match(app.id('admin-team-title').textContent, /Спартак/);

    // Переименование
    app.click(app.id('admin-players-list').querySelector('[data-action="player-rename"]'));
    assert.ok(app.id('player-rename-input'));
    app.type(app.id('player-rename-input'), 'Иванов-старший');
    app.click(app.id('admin-players-list').querySelector('[data-action="player-save"]'));
    assert.equal(app.storedData().teams[0].players[0], 'Иванов-старший');

    // Удаление
    app.click(app.id('admin-players-list').querySelector('[data-action="player-delete"]'));
    assert.equal(app.storedData().teams[0].players.length, 3);
    assert.equal(app.id('stat-players').textContent, '9');
});

test('админка: импорт JSON, понятные ошибки и сброс к демо-данным', () => {
    const app = boot();
    app.login();

    app.type(app.id('new-team-name'), 'Временная');
    app.submit(app.$('[data-form="add-team"]'));
    assert.equal(app.storedData().teams.length, 5);

    const valid = JSON.stringify({
        teams: [{ id: 7, name: 'Импорт', players: ['Игрок И.'] }],
        matches: [
            { id: 1, teamA: 7, teamB: 7, scoreA: 1, scoreB: 0, finished: true, date: '2026-01-01' },
            { id: 2, teamA: 7, teamB: 7, scoreA: null, scoreB: null, finished: false, date: '2026-02-02' }
        ]
    });

    assert.equal(app.window.FTApp.importData(valid), true);
    assert.equal(app.storedData().teams.length, 1);
    assert.match(app.id('admin-teams-list').textContent, /Импорт/);
    assert.equal(app.storedData().matches.length, 0, 'матчи «команда сама с собой» отброшены');
    assert.equal(app.id('teams-grid').querySelectorAll('article').length, 1);

    assert.equal(app.window.FTApp.importData('{ это не json'), false);
    assert.match(app.id('toast-container').textContent, /корректным JSON/);
    assert.equal(app.storedData().teams.length, 1, 'данные не изменились');

    assert.equal(app.window.FTApp.importData(JSON.stringify({ foo: 1 })), false);
    assert.match(app.id('toast-container').textContent, /нет списков команд/);

    // Сброс к демонстрационным данным
    app.click(app.actionButton('reset-data'));
    assert.equal(app.storedData().teams.length, 4);
    assert.equal(app.storedData().matches.length, 4);
    assert.equal(app.id('stat-teams').textContent, '4');
});

test('битые данные в хранилище: предупреждение и рабочий интерфейс', () => {
    const app = boot({ seed: { [DATA_KEY]: 'это не JSON' } });

    assert.equal(app.id('data-warning').hidden, false);
    assert.match(app.id('data-warning').textContent, /повреждены/);
    assert.equal(app.id('stat-teams').textContent, '4', 'показаны демонстрационные данные');
    assert.equal(app.id('standings-body').querySelectorAll('tr').length, 4);

    app.click(app.actionButton('hide-banner'));
    assert.equal(app.id('data-warning').hidden, true);
});

test('ввод пользователя экранируется: нет XSS и сломанной вёрстки', () => {
    const app = boot();
    app.login();

    app.type(app.id('new-team-name'), '<img src=x onerror=alert(1)>');
    app.submit(app.$('[data-form="add-team"]'));
    assert.equal(app.storedData().teams.length, 5);

    app.navigate('teams');
    assert.equal(app.id('teams-grid').querySelectorAll('img').length, 0, 'тег не стал элементом разметки');
    assert.match(app.id('teams-grid').textContent, /<img/);

    app.navigate('admin');
    assert.equal(app.id('admin-teams-list').querySelectorAll('img').length, 0);
    assert.match(app.id('admin-teams-list').textContent, /<img/);

    // Имя игрока с разметкой не ломает карточку матча и её кнопки-отметки
    app.openTeam('<img src=x onerror=alert(1)>');
    app.type(app.id('new-player-name'), '<b>Игрок</b>');
    app.submit(app.$('[data-form="add-player"]'));
    assert.equal(app.id('admin-players-list').querySelectorAll('b').length, 0);
    assert.match(app.id('admin-players-list').textContent, /<b>Игрок<\/b>/);

    app.navigate('standings');
    assert.equal(app.id('standings-body').querySelectorAll('img').length, 0);
});

test('данные сохраняются между загрузками страницы', () => {
    const first = boot();
    first.login();
    first.type(first.id('new-team-name'), 'Постоянная');
    first.submit(first.$('[data-form="add-team"]'));

    const saved = first.window.localStorage.getItem(DATA_KEY);
    assert.ok(saved.includes('Постоянная'));

    const second = boot({ seed: { [DATA_KEY]: saved } });
    assert.equal(second.storedData().teams.length, 5);
    assert.match(second.id('teams-grid').textContent, /Постоянная/);
});

test('разметка: уникальные id, существующие иконки и обработанные действия', () => {
    const html = readSource('index.html');
    const document = new JSDOM(html).window.document;
    const appSource = readSource('assets/js/app.js');

    // Все id уникальны
    const ids = Array.from(document.querySelectorAll('[id]')).map((element) => element.id);
    const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
    assert.deepEqual(duplicates, [], 'найдены дублирующиеся id');

    // Каждая иконка из разметки есть в SVG-спрайте
    const symbols = new Set(Array.from(document.querySelectorAll('symbol')).map((symbol) => symbol.id));
    const usedIcons = Array.from(document.querySelectorAll('use')).map((use) => use.getAttribute('href'));

    assert.ok(usedIcons.length > 10, 'иконок в разметке: ' + usedIcons.length);
    usedIcons.forEach((href) => {
        assert.match(href, /^#i-/, 'ссылка на спрайт должна быть вида #i-name: ' + href);
        assert.ok(symbols.has(href.slice(1)), 'в спрайте нет иконки ' + href);
    });

    // Иконки, которые добавляет JavaScript, тоже должны существовать в спрайте
    const dynamicIcons = Array.from(appSource.matchAll(/icon\('([a-z-]+)'/g)).map((match) => match[1]);
    assert.ok(dynamicIcons.length > 0, 'динамические иконки найдены');
    dynamicIcons.forEach((name) => {
        assert.ok(symbols.has('i-' + name), 'в спрайте нет иконки i-' + name);
    });

    // Каждое действие из разметки обрабатывается в app.js
    const actions = new Set(Array.from(document.querySelectorAll('[data-action]'))
        .map((element) => element.getAttribute('data-action')));

    actions.forEach((action) => {
        assert.ok(appSource.includes("'" + action + "'"), 'действие «' + action + '» не обрабатывается в app.js');
    });

    // Каждый пункт меню ведёт на существующую секцию
    const routes = new Set(Array.from(document.querySelectorAll('[data-nav]'))
        .map((element) => element.getAttribute('data-nav')));

    routes.forEach((route) => {
        const sectionId = route === 'admin' ? 'page-admin-login' : 'page-' + route;
        assert.ok(document.getElementById(sectionId), 'для пункта «' + route + '» нет секции ' + sectionId);
    });

    // Хэш-роутинг и CSP описаны в разметке
    assert.match(html, /Content-Security-Policy/);
    assert.match(html, /script-src 'self'/);
});

/* ====================================================================== */
/* Синхронизация с репозиторием GitHub                                   */
/* ====================================================================== */

/** Данные «из репозитория»: время в прошлом, чтобы локальные правки оказывались новее. */
function remoteData(extraTeam) {
    const data = L.createDefaultData();
    data.updatedAt = '2026-09-10T09:15:00.000Z';
    data.revision = 4;

    if (extraTeam) {
        data.teams.push({ id: 50, name: extraTeam, players: [] });
    }

    return data;
}

test('посетитель видит данные из репозитория, а не только локальную копию', async () => {
    const mock = createMockRepository({ data: remoteData('Клуб из репозитория') });
    const app = boot({ mock });

    await app.settle();

    assert.equal(app.id('stat-teams').textContent, '5', 'статистика построена по данным репозитория');
    assert.match(app.id('teams-grid').textContent, /Клуб из репозитория/);
    assert.match(app.id('standings-body').textContent, /Клуб из репозитория/);
    assert.match(app.freshness(), /Данные обновлены: 10 сентября 2026/, 'в подвале указана версия данных');
    assert.equal(app.storedData().teams.length, 5, 'копия сохранена локально (для офлайна)');

    // Посетитель только открыл страницу: данные приходят из самого свежего источника —
    // Contents API (у него кэш в минуту, у raw и файла сайта — 5–10 минут)
    assert.equal(mock.state.requests.some((request) =>
        request.url.includes('/mock-api/repos/') && request.url.includes('/contents/data.json')), true);
    assert.equal(app.window.FTApp.sync.state.lastSource, 'api', 'источник данных — Contents API');
});

test('офлайн: показывается сохранённая копия, сайт продолжает работать', async () => {
    const local = remoteData('Офлайн-клуб');
    const app = boot({ seed: { [DATA_KEY]: JSON.stringify(local) } }); // сеть недоступна

    await app.settle();

    assert.equal(app.id('stat-teams').textContent, '5');
    assert.match(app.id('teams-grid').textContent, /Офлайн-клуб/);
    assert.match(app.freshness(), /нет связи с репозиторием/);
    assert.match(app.syncStatus(), /Чтение из репозитория/);
});

test('публикация: токен на устройстве, отправка данных и ссылка на коммит', async () => {
    const mock = createMockRepository({ data: remoteData() });
    const app = boot({ mock, autoPublishDelayMs: 10000 });

    await app.settle();
    app.login();

    // Без токена публиковать нельзя
    app.click(app.actionButton('github-publish'));
    await app.settle();
    assert.match(app.id('toast-container').textContent, /токен/i);

    app.saveToken('test-token');
    await app.settle();

    assert.equal(app.window.localStorage.getItem('ft.githubToken'), 'test-token');
    assert.equal(app.id('github-token').value, '', 'токен не остаётся в поле ввода');

    // Меняем данные и публикуем
    app.type(app.id('new-team-name'), 'Публикуемый клуб');
    app.submit(app.$('[data-form="add-team"]'));
    await app.settle();

    assert.match(app.syncStatus(), /неопубликованные изменения/);

    app.click(app.actionButton('github-publish'));
    await app.settle();

    assert.equal(mock.state.commits.length, 1);
    assert.match(mock.state.commits[0].message, /Публикуемый клуб/);
    assert.equal(mock.state.commits[0].data.teams.some((team) => team.name === 'Публикуемый клуб'), true);
    assert.equal(
        mock.state.requests.find((request) => request.method === 'PUT').headers.authorization,
        'Bearer test-token'
    );
    assert.match(app.syncStatus(), /Опубликовано/);
    assert.match(app.id('sync-status').innerHTML, /github\.com\/test\/test\/commit\/2/);
});

test('авто-публикация: правка уходит в репозиторий без нажатия кнопки', async () => {
    const mock = createMockRepository({ data: remoteData() });
    const app = boot({ mock, autoPublishDelayMs: 20 });

    await app.settle();
    app.login();
    app.saveToken('test-token');
    await app.settle();

    app.type(app.id('new-team-name'), 'Авто-клуб');
    app.submit(app.$('[data-form="add-team"]'));

    await app.wait(80);

    assert.equal(mock.state.commits.length, 1, 'коммит создан автоматически');
    assert.equal(mock.state.data.teams.some((team) => team.name === 'Авто-клуб'), true);
    assert.match(app.syncStatus(), /Опубликовано/);
});

test('более свежая версия из репозитория не затирается устаревшей копией', async () => {
    const mock = createMockRepository({ data: remoteData() });
    const app = boot({ mock, autoPublishDelayMs: 10000 });

    await app.settle();
    app.login();
    app.saveToken('test-token');
    await app.settle();

    app.type(app.id('new-team-name'), 'Локальный клуб');
    app.submit(app.$('[data-form="add-team"]'));

    // «Другое устройство» опубликовало более новую версию
    const external = JSON.parse(JSON.stringify(mock.state.data));
    external.updatedAt = new Date(Date.now() + 60000).toISOString();
    external.teams.push({ id: 90, name: 'Клуб другого устройства', players: [] });
    mock.changeExternally(external);

    app.click(app.actionButton('github-publish'));
    await app.settle();

    assert.match(app.id('toast-container').textContent, /Забрать из репозитория/);
    assert.equal(mock.state.commits.length, 0, 'публикация остановлена');
    assert.equal(mock.state.data.teams.some((team) => team.name === 'Локальный клуб'), false, 'данные не затёрты');
    assert.equal(mock.state.data.teams.some((team) => team.name === 'Клуб другого устройства'), true);
});

test('публикация без базовой версии не затирает появившийся файл', async () => {
    const mock = createMockRepository({}); // файла в репозитории ещё нет
    const app = boot({ mock, autoPublishDelayMs: 10000 });

    await app.settle();
    app.login();
    app.saveToken('test-token');
    await app.settle();

    assert.equal(app.window.localStorage.getItem('ft.publishedAt'), null, 'публикаций с этого устройства не было');

    // Пока администратор правил, файл появился (например, с другого устройства)
    const external = remoteData('Клуб из репозитория');
    external.updatedAt = new Date(Date.now() + 60000).toISOString();
    mock.changeExternally(external);

    app.type(app.id('new-team-name'), 'Мой клуб');
    app.submit(app.$('[data-form="add-team"]'));
    app.click(app.actionButton('github-publish'));
    await app.settle();

    assert.match(app.id('toast-container').textContent, /Забрать из репозитория/);
    assert.equal(mock.state.data.teams.some((team) => team.name === 'Мой клуб'), false);
});

test('«Забрать из репозитория» обновляет данные на устройстве', async () => {
    const mock = createMockRepository({ data: remoteData() });
    const app = boot({ mock });

    await app.settle();
    app.login();

    const updated = remoteData('Новости с турнира');
    updated.updatedAt = new Date(Date.now() + 30000).toISOString();
    mock.changeExternally(updated);

    app.click(app.actionButton('github-pull'));
    await app.settle();

    assert.equal(app.id('stat-teams').textContent, '5');
    assert.match(app.id('teams-grid').textContent, /Новости с турнира/);
});

test('токен живёт только в браузере устройства и удаляется по кнопке', async () => {
    const app = boot({ mock: createMockRepository({ data: remoteData() }) });

    await app.settle();
    app.login();
    app.saveToken('секретный-токен-123');
    await app.settle();

    assert.equal(app.window.localStorage.getItem('ft.githubToken'), 'секретный-токен-123');
    assert.equal(readSource('index.html').includes('секретный-токен-123'), false, 'в разметке токена нет');
    assert.equal(readSource('assets/js/app.js').includes('секретный-токен-123'), false, 'в коде токена нет');
    assert.match(app.id('github-token').placeholder, /Токен сохранён/);

    app.click(app.actionButton('github-forget-token'));
    await app.settle();

    assert.equal(app.window.localStorage.getItem('ft.githubToken'), null);
    assert.equal(app.id('github-token').placeholder, 'github_pat_…');
});

test('страница просит верхнее окно не держать её в чужом iframe', () => {
    const html = readSource('index.html');
    const guard = readSource('assets/js/frame-guard.js');

    assert.ok(html.includes('assets/js/frame-guard.js'), 'скрипт защиты подключён в разметке');
    assert.match(guard, /window\.top === window\.self/, 'скрипт сравнивает верхнее окно со своим');
    assert.match(guard, /window\.top\.location = window\.self\.location\.href/, 'во фрейме страница уходит на свой адрес');
    assert.match(readSource('_headers'), /frame-ancestors 'none'/, 'жёсткий запрет остаётся в заголовках хостингов');
    assert.equal(html.includes('frame-ancestors'), false, 'в <meta> директива frame-ancestors не работает — её место в _headers');
});

test('в подвале сайта сказано, что фото и имена публикуются с согласия участников', async () => {
    const app = boot({ mock: createMockRepository({ data: remoteData() }) });

    await app.settle();

    assert.match(app.$('footer').textContent, /Фото и имена публикуются с согласия участников/);
});

test('админка: «Забрать из репозитория» подтягивает свежие результаты', async () => {
    const mock = createMockRepository({ data: remoteData() });
    const app = boot({ mock, autoPublishDelayMs: 10000 });

    await app.settle();

    // Кнопки обновления у зрителей нет — ручное обновление только в админке
    assert.equal(app.$('[data-action="refresh-data"]'), null, 'в подвале нет кнопки обновления');

    app.login();
    assert.ok(app.actionButton('github-pull'), 'в админке есть кнопка «Забрать из репозитория»');

    const updated = remoteData();
    updated.updatedAt = new Date(Date.now() + 30000).toISOString();
    updated.matches.push({ id: 99, teamA: 1, teamB: 2, scoreA: 3, scoreB: 3, date: '2026-09-25', finished: true });
    mock.changeExternally(updated);

    app.click(app.actionButton('github-pull'));
    await app.settle();

    assert.equal(app.id('stat-matches').textContent, '5');
    assert.equal(app.id('stat-finished').textContent, '3');
});

test('повторная публикация без изменений не показывает ошибку', async () => {
    const mock = createMockRepository({ data: remoteData() });
    const app = boot({ mock, autoPublishDelayMs: 10000 });

    await app.settle();
    app.login();
    app.saveToken('test-token');
    await app.settle();

    app.type(app.id('new-team-name'), 'Первый клуб');
    app.submit(app.$('[data-form="add-team"]'));
    await app.settle();

    app.click(app.actionButton('github-publish'));
    await app.settle();

    assert.equal(mock.state.commits.length, 1);
    assert.match(app.syncStatus(), /Опубликовано/);

    // Нажимаем «Опубликовать» ещё раз, ничего не меняя:
    // раньше это показывало тревожную ошибку про «версию из репозитория»
    app.click(app.actionButton('github-publish'));
    await app.settle();

    assert.equal(mock.state.commits.length, 1, 'лишний коммит не создаётся');
    assert.equal(app.syncStatus().includes('Не удалось опубликовать'), false, 'ошибки нет');
    assert.match(app.syncStatus(), /Опубликовано/);
    assert.match(app.id('toast-container').textContent, /Изменений нет/);
});

test('ручная публикация отменяет отложенную авто-публикацию', async () => {
    const mock = createMockRepository({ data: remoteData() });
    const app = boot({ mock, autoPublishDelayMs: 40 });

    await app.settle();
    app.login();
    app.saveToken('test-token');
    await app.settle();

    app.type(app.id('new-team-name'), 'Клуб');
    app.submit(app.$('[data-form="add-team"]'));

    app.click(app.actionButton('github-publish'));
    await app.settle();

    await app.wait(140); // дольше, чем задержка авто-публикации

    assert.equal(mock.state.commits.length, 1, 'второй коммит не появился');
    assert.equal(app.syncStatus().includes('Не удалось опубликовать'), false);
});

test('локально более новые данные защищены от замены (подтверждение и копия)', async () => {
    const local = remoteData();
    local.updatedAt = '2026-09-12T10:00:00.000Z';
    local.teams = []; // как будто команды удалили и не успели опубликовать

    const mock = createMockRepository({ data: remoteData('Клуб из репозитория') });
    const app = boot({
        mock,
        confirm: false,
        seed: { [DATA_KEY]: JSON.stringify(local), [EDITS_KEY]: local.updatedAt }
    });

    await app.settle();

    // Даже фоновая синхронизация при загрузке не затирает более новые данные устройства
    assert.equal(app.id('stat-teams').textContent, '0');
    assert.equal(app.id('teams-grid').textContent.includes('Клуб из репозитория'), false);

    app.login();
    app.click(app.actionButton('github-pull'));
    await app.settle();

    assert.equal(app.id('teams-grid').textContent.includes('Клуб из репозитория'), false, 'данные сохранены');
    assert.equal(app.window.localStorage.getItem('ft.localBackup'), null, 'копия не создавалась');
    assert.ok(app.window.localStorage.getItem(EDITS_KEY), 'правки по-прежнему помечены как неопубликованные');
});

test('подтверждённая замена сохраняет копию, и её можно вернуть', async () => {
    const local = remoteData();
    local.updatedAt = '2026-09-12T10:00:00.000Z';

    const mock = createMockRepository({ data: remoteData('Клуб из репозитория') });
    // подтверждение разрешено; отметка о неопубликованных правках — как после реального изменения
    const app = boot({ mock, seed: { [DATA_KEY]: JSON.stringify(local), [EDITS_KEY]: local.updatedAt } });

    await app.settle();
    app.login();

    app.click(app.actionButton('github-pull'));
    await app.settle();

    assert.match(app.id('teams-grid').textContent, /Клуб из репозитория/, 'пришла версия из репозитория');
    assert.ok(app.window.localStorage.getItem('ft.localBackup'), 'копия прежних данных сохранена');
    assert.equal(app.id('github-restore').hidden, false, 'кнопка восстановления показана');

    app.click(app.actionButton('github-restore-backup'));
    await app.settle();

    assert.equal(app.id('teams-grid').textContent.includes('Клуб из репозитория'), false, 'прежние данные вернулись');
    assert.ok(app.window.localStorage.getItem(EDITS_KEY), 'восстановленные данные помечены как неопубликованные');
});

test('админка: фото игрока уходит в репозиторий и видно сразу, не дожидаясь публикации', async () => {
    const mock = createMockRepository({ data: remoteData() });
    const app = boot({ mock, autoPublishDelayMs: 10000 });

    app.login();
    app.saveToken('test-token');
    app.openTeam('Спартак');

    const input = app.id('admin-players-list').querySelector('input[data-photo-team]');
    assert.ok(input, 'в карточке игрока есть выбор файла');
    assert.equal(app.id('admin-players-list').querySelectorAll('input[type="file"]').length, 3,
        'кнопка загрузки у каждого игрока команды');

    // Сжатие в браузере подменяем: canvas в jsdom нет, остальной путь проверяем целиком
    const prepared = {
        ok: true,
        base64: 'QUJD',
        bytes: 1024,
        mime: 'image/jpeg',
        size: 512,
        path: 'assets/photos/ivanov-a-abc123.jpg'
    };

    app.window.FTPhoto.prepare = () => Promise.resolve(prepared);

    Object.defineProperty(input, 'files', { value: [{ size: 2048, type: 'image/jpeg', name: 'photo.jpg' }] });
    app.change(input);
    await app.wait(20);

    // Файл ушёл в репозиторий отдельным коммитом с понятным сообщением
    assert.equal(mock.state.files[prepared.path].content, 'QUJD', 'файл сохранён в репозитории');
    assert.equal(mock.state.commits.some((commit) =>
        commit.message === 'Фото игрока «Иванов А.» (Спартак) — файл сайта'), true, 'коммит с фото');

    // Путь записан в данные (их публикует обычная авто-публикация)
    assert.equal(app.storedData().photos['1|иванов а.'], prepared.path);
    assert.match(app.id('toast-container').textContent, /загружено/);
    assert.match(app.id('toast-container').textContent, /файл появится на сайте через ~минуту/,
        'подсказка, что файл публикуется отдельно от данных');

    // Аватар показывается сразу — из памяти, хотя файл на сайте появится позже
    const avatar = app.id('admin-players-list').querySelector('img.player-avatar');
    assert.ok(avatar, 'аватар появился в составе');
    assert.equal(avatar.getAttribute('src'), 'data:image/jpeg;base64,QUJD');

    // И на публичной странице команд
    app.navigate('teams');
    assert.ok(app.id('teams-grid').querySelector('.chip-player img.player-avatar'), 'аватар виден в составе команды');

    // Ошибка загрузки (файл слишком большой) не портит данные
    mock.failNextUpload(413);
    app.navigate('admin');
    app.openTeam('Спартак');

    const second = app.id('admin-players-list').querySelector('input[data-photo-team]');
    Object.defineProperty(second, 'files', { value: [{ size: 2048, type: 'image/jpeg' }] });
    app.change(second);
    await app.wait(20);

    assert.match(app.id('toast-container').textContent, /слишком большой/, 'понятная ошибка вместо кода 413');
});

test('админка: эмблема команды загружается, видна везде и убирается', async () => {
    const mock = createMockRepository({ data: remoteData() });
    const app = boot({ mock, autoPublishDelayMs: 10000 });

    app.login();
    app.saveToken('test-token');
    app.openTeam('Спартак');

    const input = app.id('admin-team-photo').querySelector('input[data-photo-kind="team"]');
    assert.ok(input, 'в карточке команды есть загрузка эмблемы');
    assert.match(app.id('admin-team-photo').textContent, /Загрузить эмблему/);

    // Сжатие в браузере подменяем: canvas в jsdom нет, остальной путь проверяем целиком
    const prepared = {
        ok: true,
        base64: 'QUJD',
        bytes: 2048,
        mime: 'image/jpeg',
        size: 512,
        path: 'assets/photos/team-spartak-abc123.jpg'
    };

    app.window.FTPhoto.prepare = () => Promise.resolve(prepared);

    Object.defineProperty(input, 'files', { value: [{ size: 4096, type: 'image/png', name: 'logo.png' }] });
    app.change(input);
    await app.wait(20);

    // Файл ушёл в репозиторий своим коммитом, путь записан в данные
    assert.equal(mock.state.files[prepared.path].content, 'QUJD', 'файл эмблемы в репозитории');
    assert.equal(mock.state.commits.some((commit) =>
        commit.message === 'Эмблема команды «Спартак» — файл сайта'), true, 'коммит с эмблемой');
    assert.equal(app.storedData().teamPhotos['1'], prepared.path);
    assert.match(app.id('toast-container').textContent, /Эмблема команды «Спартак» загружена/);

    // Превью видно сразу — из памяти, не дожидаясь публикации файла
    const adminAvatar = app.id('admin-team-photo').querySelector('img.team-photo');

    assert.ok(adminAvatar, 'превью в карточке команды');
    assert.equal(adminAvatar.getAttribute('src'), 'data:image/jpeg;base64,QUJD');

    // Эмблема видна в турнирной таблице и в списке команд
    app.navigate('standings');
    assert.equal(app.id('standings-body').querySelector('tr[data-id="1"] img.team-photo').getAttribute('src'),
        'data:image/jpeg;base64,QUJD', 'эмблема в турнирной таблице');

    app.navigate('teams');
    assert.ok(app.id('teams-grid').querySelector('article[data-id="1"] img.team-photo'), 'эмблема в списке команд');

    // И на странице команды — крупно
    app.click(app.id('teams-grid').querySelector('[data-action="team-public-open"][data-id="1"]'));
    assert.ok(app.id('team-detail').querySelector('img.team-photo.team-photo-lg'), 'эмблема на странице команды');

    // Убираем эмблему: данные чистые, снова бейдж с инициалами
    app.navigate('admin');
    app.openTeam('Спартак');
    assert.match(app.id('admin-team-photo').textContent, /Заменить эмблему/);

    app.click(app.$('#admin-team-photo [data-action="team-photo-remove"]'));

    assert.deepEqual(app.storedData().teamPhotos, {}, 'эмблема убрана из данных');
    assert.match(app.id('toast-container').textContent, /Эмблема команды «Спартак» убрана/);
    assert.equal(app.id('admin-team-photo').querySelector('img.team-photo'), null, 'вернулся бейдж');
    assert.ok(app.id('admin-team-photo').querySelector('.team-badge'), 'бейдж на месте');
});

test('админка: без токена фото не уходит в репозиторий, а готовое фото можно убрать', async () => {
    // Токен не сохранён — загрузка даже не начинается
    const mock = createMockRepository({ data: remoteData() });
    const app = boot({ mock, autoPublishDelayMs: 10000 });

    app.login();
    app.openTeam('Спартак');

    app.window.FTPhoto.prepare = () => Promise.resolve({
        ok: true,
        base64: 'QQ==',
        bytes: 10,
        mime: 'image/jpeg',
        path: 'assets/photos/ivanov-a-abc123.jpg'
    });

    const input = app.id('admin-players-list').querySelector('input[data-photo-team]');
    Object.defineProperty(input, 'files', { value: [{ size: 10, type: 'image/jpeg' }] });
    app.change(input);
    await app.settle();

    assert.match(app.id('toast-container').textContent, /токен/i);
    assert.deepEqual(Object.keys(mock.state.files), [], 'в репозиторий ничего не ушло');

    // Фото уже есть: кнопка «Убрать фото» убирает запись из данных
    const seeded = remoteData();
    seeded.photos = { '1|иванов а.': 'assets/photos/ivanov-a-abc123.jpg' };

    const withPhoto = boot({ seed: { [DATA_KEY]: JSON.stringify(seeded) } });
    withPhoto.login();
    withPhoto.openTeam('Спартак');

    assert.ok(withPhoto.id('admin-players-list').querySelector('img.player-avatar'), 'фото показано в составе');
    assert.ok(withPhoto.$('[data-action="player-photo-remove"]'), 'есть кнопка «Убрать фото»');

    withPhoto.click(withPhoto.$('[data-action="player-photo-remove"]'));

    assert.deepEqual(withPhoto.storedData().photos, {}, 'фото убрано из данных');
    assert.match(withPhoto.id('toast-container').textContent, /убрано/);

    // Удаление игрока тоже убирает его фото
    const second = boot({ seed: { [DATA_KEY]: JSON.stringify(seeded) } });
    second.login();
    second.openTeam('Спартак');
    second.click(second.id('admin-players-list').querySelector('[data-action="player-delete"]'));

    assert.deepEqual(second.storedData().photos, {}, 'фото удалённого игрока убрано');
    assert.equal(second.storedData().teams[0].players.length, 2);
});

test('фото, которого ещё нет на сайте: повторные попытки и инициалы вместо сломанной картинки', async () => {
    // Так выглядит «другое устройство»: путь к фото уже пришёл из репозитория,
    // а сам файл сайт отдаст примерно через минуту после загрузки.
    const seeded = remoteData();

    seeded.photos = { '1|иванов а.': 'assets/photos/ivanov-a-abc123.jpg' };
    seeded.teamPhotos = { '1': 'assets/photos/team-spartak-abc123.jpg' };

    const app = boot({ seed: { [DATA_KEY]: JSON.stringify(seeded) } });
    const { window } = app;

    // Паузы повторной загрузки сокращаем: в жизни это 4, 15 и 45 секунд
    window.FT_CONFIG.photo.retryDelays = [5, 8, 10];

    // Картинка «не загрузилась»: в jsdom изображения не скачиваются, событие отправляем сами
    const fail = (image) => image.dispatchEvent(new window.Event('error'));

    const avatar = app.id('teams-grid').querySelector('.chip-player img.player-avatar');

    assert.ok(avatar, 'аватар игрока показан');
    assert.equal(avatar.getAttribute('src'), 'assets/photos/ivanov-a-abc123.jpg');
    assert.equal(avatar.getAttribute('data-photo-path'), 'assets/photos/ivanov-a-abc123.jpg');
    assert.equal(avatar.classList.contains('photo-retry'), true, 'картинку можно перезагрузить');

    fail(avatar);
    await app.wait(20);

    assert.match(avatar.getAttribute('src'), /^assets\/photos\/ivanov-a-abc123\.jpg\?t=\d+$/,
        'повторная попытка с обходом кэша');

    const firstRetry = avatar.getAttribute('src');

    fail(avatar);
    await app.wait(20);

    assert.notEqual(avatar.getAttribute('src'), firstRetry, 'и ещё одна попытка');

    for (let attempt = 0; attempt < 4 && avatar.isConnected; attempt += 1) {
        fail(avatar);
        await app.wait(20);
    }

    const chip = app.id('teams-grid').querySelector('.chip-player');

    assert.equal(chip.querySelector('img.player-avatar'), null, 'сломанная картинка убрана');
    assert.equal(chip.querySelector('.player-avatar-empty').textContent, 'ИА', 'видны инициалы');

    // У эмблемы команды та же защита: в турнирной таблице возвращается бейдж с инициалами
    const logo = app.id('standings-body').querySelector('tr[data-id="1"] img.team-photo');

    assert.ok(logo, 'эмблема в турнирной таблице');
    assert.equal(logo.getAttribute('data-fallback-text'), 'СП');
    assert.match(logo.getAttribute('data-fallback-class'), /team-badge/);

    for (let attempt = 0; attempt < 6 && logo.isConnected; attempt += 1) {
        fail(logo);
        await app.wait(20);
    }

    const row = app.id('standings-body').querySelector('tr[data-id="1"]');

    assert.equal(row.querySelector('img.team-photo'), null, 'сломанная эмблема убрана');
    assert.equal(row.querySelector('.team-badge').textContent, 'СП', 'бейдж с инициалами вернулся');
});

test('карточка игрока: имя кликабельно, видны фото, номер и принадлежность', () => {
    const app = boot();
    const card = () => app.id('player-card');

    // В списке команд игрок — ссылка на свою карточку
    app.navigate('teams');

    const chip = app.id('teams-grid').querySelector('.chip-player');

    assert.ok(chip, 'игроки видны в составе');
    assert.equal(chip.tagName, 'A', 'имя игрока — ссылка');
    assert.equal(chip.getAttribute('data-action'), 'player-public-open');
    assert.match(chip.getAttribute('title'), /Открыть карточку игрока/);

    app.click(chip);

    assert.equal(app.activeSection(), 'page-player', 'открылась карточка игрока');
    assert.equal(app.window.location.hash, '#/player/1/0', 'у карточки свой адрес');
    assert.equal(app.$('[data-nav="teams"]').classList.contains('active'), true,
        'в меню подсвечен раздел «Команды»');

    // Крупное фото, команда и принадлежность: даты рождения на карточке больше нет
    assert.ok(card().querySelector('.player-avatar-xl'), 'крупный аватар игрока');
    assert.match(card().textContent, /Иванов А\./);
    assert.equal(card().textContent.indexOf('Дата рождения'), -1, 'даты рождения на карточке нет');
    assert.match(card().textContent, /Школа №5/, 'принадлежность из данных');
    assert.match(card().textContent, /В турнире: голы — 0/, 'статистика игрока');
    assert.ok(card().querySelector('a.team-link'), 'название команды — ссылка на её страницу');

    // Кнопка «Назад» возвращает туда, откуда пришли
    assert.match(app.id('back-button').getAttribute('aria-label'), /Команды/);
    app.click(app.button('go-back'));
    assert.equal(app.activeSection(), 'page-teams');

    // Игрок без данных: подсказка вместо пустого поля
    app.click(app.id('teams-grid').querySelectorAll('.chip-player')[1]);

    assert.equal((card().textContent.match(/не указана/g) || []).length, 1, 'принадлежность не указана');

    // Состав на странице команды тоже кликабелен: раскрываем блок «Состав»
    app.navigate('teams');
    app.click(app.id('teams-grid').querySelector('[data-action="team-public-open"][data-id="1"]'));
    app.click(app.id('team-detail').querySelector('[data-action="squad-toggle"]'));

    const squadPlayer = app.id('team-squad').querySelector('a.player-link');

    assert.equal(squadPlayer.getAttribute('data-action'), 'player-public-open', 'имя в составе — ссылка');
    assert.match(app.id('team-squad').textContent, /Иванов А\./);

    app.click(squadPlayer);
    assert.match(card().textContent, /Иванов А\./, 'из состава открылась карточка игрока');
});

test('игровой номер: виден рядом с именем везде и заполняется в админке', async () => {
    const seeded = remoteData();

    // Иванов А. — уже с номером и забитым голом, у Петрова П. номера нет
    seeded.matches[0].events = [{ team: 1, player: 'Иванов А.', type: 'goal' }];
    seeded.playerInfo = { '1|иванов а.': { number: 9, note: '' } };

    const app = boot({ mock: createMockRepository({ data: seeded }), autoPublishDelayMs: 10000 });

    await app.settle();

    const badge = (container) => container.querySelector('.player-number');
    const badgeText = (container) => {
        const found = badge(container);

        return found ? found.textContent : null;
    };

    // 1. Список команд: плашка с номером рядом с именем игрока
    app.navigate('teams');

    const chips = Array.from(app.$$('#teams-grid .chip-player'));
    const chipFor = (name) => chips.find((chip) => chip.textContent.includes(name));

    assert.equal(badgeText(chipFor('Иванов А.')), '9', 'в чипе игрока виден игровой номер');
    assert.equal(badge(chipFor('Иванов А.')).getAttribute('title'), 'Игровой номер: 9');
    assert.equal(badge(chipFor('Петров П.')), null, 'без номера плашки нет');

    // 2. Состав команды: номер — отдельная плашка, имя не склеивается с номером
    app.click(app.id('teams-grid').querySelector('[data-action="team-public-open"][data-id="1"]'));
    app.click(app.id('team-detail').querySelector('[data-action="squad-toggle"]'));

    const squadRow = app.id('team-squad').querySelector('tbody tr');

    assert.equal(badgeText(squadRow), '9');
    assert.equal(squadRow.querySelector('.player-name').textContent, 'Иванов А.');

    // 3. Карточка игрока: номер рядом с именем в заголовке
    app.click(app.id('team-squad').querySelector('a.player-link'));
    assert.equal(badgeText(app.id('player-card')), '9');

    // 4. Бомбардиры и страница «Все игроки»
    app.navigate('players');
    assert.equal(badgeText(app.id('players-body')), '9');

    app.navigate('allplayers');
    assert.equal(badgeText(app.id('all-players-body')), '9');

    // 5. Детальный результат матча: номер в составе
    app.navigate('matches');
    app.click(app.$('#matches-list [data-action="match-public-open"][data-id="1"]'));
    assert.equal(badgeText(app.id('match-detail').querySelector('.squad-row')), '9');

    // 6. Админка: отметки голов в карточке матча
    app.login();
    app.openMatch(1);

    const eventRow = Array.from(app.id('admin-match-events').querySelectorAll('.event-row'))
        .find((row) => row.textContent.includes('Иванов А.'));

    assert.equal(badgeText(eventRow), '9', 'номер виден и в отметках матча');

    // 7. Админка: список игроков команды и форма данных игрока
    app.openTeam('Спартак');
    assert.equal(badgeText(app.id('admin-players-list')), '9');

    app.click(app.id('admin-players-list').querySelector('[data-action="player-info-open"][data-index="0"]'));

    const form = () => app.id('admin-player-info').querySelector('form');

    assert.match(app.id('admin-player-info').textContent, /Игровой номер/, 'поле номера есть в форме');
    assert.equal(app.id('player-number').value, '9', 'форма показывает сохранённый номер');
    assert.equal(app.id('player-number').getAttribute('max'), String(L.CONFIG.maxPlayerNumber));
    assert.equal(app.id('player-number').getAttribute('min'), '0');

    // «Мусорный» номер не сохраняется: данные остаются прежними
    app.type(app.id('player-number'), '100');
    app.submit(form());

    assert.match(app.id('player-info-error').textContent, /Игровой номер — целое число от 0 до 99/);
    assert.equal(app.storedData().playerInfo['1|иванов а.'].number, 9, 'номер не изменился');

    // Новый номер сохраняется и сразу виден в списке игроков
    app.type(app.id('player-number'), '5');
    app.submit(form());

    assert.deepEqual(app.storedData().playerInfo['1|иванов а.'], { note: '', number: 5 });
    assert.equal(badgeText(app.id('admin-players-list')), '5', 'номер обновился в списке игроков');

    // Номер можно заполнить и отдельно от принадлежности
    app.click(app.id('admin-players-list').querySelector('[data-action="player-info-open"][data-index="1"]'));
    app.type(app.id('player-number'), '2');
    app.submit(form());

    assert.deepEqual(app.storedData().playerInfo['1|петров п.'], { note: '', number: 2 });

    // «Убрать данные» убирает и номер
    app.click(app.id('admin-players-list').querySelector('[data-action="player-info-open"][data-index="1"]'));
    app.click(app.id('admin-player-info').querySelector('[data-action="player-info-clear"]'));

    assert.equal(app.storedData().playerInfo['1|петров п.'], undefined, 'номер убран вместе с данными');
    assert.equal(badgeText(app.id('admin-players-list')), '5', 'у Иванова номер остался');
});

test('карточка игрока: открывается из бомбардиров и из составов матча, несуществующий не ломает сайт', () => {
    const seeded = remoteData();

    // Гол Иванова А. — игрок попадает в таблицу бомбардиров
    seeded.matches[0].events = [
        { team: 1, player: 'Иванов А.', type: 'goal' },
        { team: 2, player: 'Кузнецов К.', type: 'yellow' }
    ];

    const app = boot({ seed: { [DATA_KEY]: JSON.stringify(seeded) } });

    // Из таблицы бомбардиров
    app.navigate('players');

    const scorer = app.id('players-body').querySelector('a.player-link');

    assert.ok(scorer, 'бомбардир — ссылка на карточку');
    assert.equal(scorer.getAttribute('data-action'), 'player-public-open');

    app.click(scorer);

    assert.equal(app.activeSection(), 'page-player');
    assert.match(app.id('player-card').textContent, /Иванов А\./);
    assert.match(app.id('player-card').textContent, /В турнире: голы — 1/, 'гол учтён в карточке');
    assert.equal(app.window.location.hash, '#/player/1/0');

    // Из детального результата матча
    app.navigate('matches');
    app.click(app.$('#matches-list [data-action="match-public-open"]'));

    const squadPlayer = app.id('match-detail').querySelector('.squad-player[data-action="player-public-open"]');

    assert.ok(squadPlayer, 'игрок в составе матча — ссылка');

    const squadTeam = squadPlayer.getAttribute('data-team');
    const squadIndex = squadPlayer.getAttribute('data-index');
    const squadName = squadPlayer.querySelector('.squad-name').textContent;

    app.click(squadPlayer);

    assert.equal(app.activeSection(), 'page-player');
    assert.equal(app.window.location.hash, '#/player/' + squadTeam + '/' + squadIndex, 'адрес игрока в составе');
    assert.equal(app.id('player-card').querySelector('h2').textContent, squadName, 'открылся тот же игрок');

    // Игрока из ссылки уже нет в заявке — показывается понятное сообщение
    seeded.teams[0].players = ['Петров П.'];

    const changed = boot({ seed: { [DATA_KEY]: JSON.stringify(seeded) } });

    changed.window.location.hash = '#/player/1/2';
    changed.window.dispatchEvent(new changed.window.Event('hashchange'));

    assert.match(changed.id('player-card').textContent, /Игрок не найден/);
    assert.ok(changed.$('#player-card [data-action="team-public-back"]'), 'есть кнопка «К списку команд»');

    changed.click(changed.$('#player-card [data-action="team-public-back"]'));
    assert.equal(changed.activeSection(), 'page-teams');
});


test('админка: игровой номер и принадлежность заполняются и видны на карточке игрока', async () => {
    const seeded = remoteData();

    // Начинаем с чистого листа: у игроков пока ничего не заполнено
    seeded.playerInfo = {};

    const mock = createMockRepository({ data: seeded });
    const app = boot({ mock, autoPublishDelayMs: 10000 });

    await app.settle();

    app.login();
    app.openTeam('Спартак');

    // У каждого игрока есть кнопка с формой данных
    const infoButtons = app.id('admin-players-list').querySelectorAll('[data-action="player-info-open"]');

    assert.equal(infoButtons.length, 3, 'кнопка «данные игрока» у каждого игрока состава');

    app.click(infoButtons[0]);

    const form = () => app.id('admin-player-info').querySelector('form');

    assert.equal(app.id('admin-player-info').hidden, false, 'форма открылась');
    assert.match(app.id('admin-player-info').textContent, /Данные игрока: Иванов А\./);
    assert.equal(app.id('player-birth-date'), null, 'поля «дата рождения» в форме больше нет');
    assert.equal(app.id('player-number').value, '', 'номер пока пустой');
    assert.equal(app.id('player-note').value, '', 'принадлежность пока пустая');
    assert.equal(app.id('player-note').getAttribute('maxlength'), String(L.CONFIG.maxPlayerNoteLength),
        'длина принадлежности ограничена');

    // Счётчик символов обновляется при вводе
    const note = 'Школа №5, первый тренер — Петров И.';

    app.type(app.id('player-note'), note);
    assert.equal(app.id('player-note-count').textContent, String(note.length));

    app.type(app.id('player-number'), '7');
    app.submit(form());

    assert.deepEqual(app.storedData().playerInfo['1|иванов а.'], { number: 7, note: note });
    assert.match(app.id('toast-container').textContent, /Данные игрока «Иванов А\.» сохранены/);
    assert.equal(app.id('admin-player-info').hidden, true, 'после сохранения форма закрывается');

    // Данные видны на публичной карточке игрока (открываем из состава команды)
    app.navigate('teams');
    app.click(app.id('teams-grid').querySelector('[data-action="team-public-open"][data-id="1"]'));
    app.click(app.id('team-detail').querySelector('[data-action="squad-toggle"]'));
    app.click(app.id('team-squad').querySelector('a.player-link'));

    const bigNumber = app.id('player-card').querySelector('.player-number-lg');

    assert.ok(bigNumber, 'на карточке виден игровой номер');
    assert.equal(bigNumber.textContent, '7', 'номер из формы');
    assert.match(app.id('player-card').textContent, /Школа №5, первый тренер/);
    assert.equal(app.id('player-card').textContent.indexOf('Дата рождения'), -1, 'даты рождения нет');

    // Карточка только для чтения: кнопок заполнения данных на ней нет даже у администратора
    assert.equal(app.id('player-card').querySelector('[data-action="admin-player-info-open"]'), null,
        'на карточке нет кнопки заполнения данных');
    assert.equal(app.id('player-card').querySelector('[data-action="player-info-open"]'), null,
        'и кнопки из админки на карточке тоже нет');
});

test('админка: длина принадлежности проверяется', async () => {
    const seeded = remoteData();

    seeded.playerInfo = { '1|иванов а.': { note: 'Школа №5' } };

    const mock = createMockRepository({ data: seeded });
    const app = boot({ mock, autoPublishDelayMs: 10000 });

    await app.settle();

    app.login();
    app.openTeam('Спартак');
    app.click(app.id('admin-players-list').querySelector('[data-action="player-info-open"]'));

    const form = () => app.id('admin-player-info').querySelector('form');

    // Слишком длинный текст не сохраняется — форма показывает понятную ошибку
    app.id('player-note').value = 'б'.repeat(L.CONFIG.maxPlayerNoteLength + 1);
    app.submit(form());

    assert.match(app.id('player-info-error').textContent, /не больше 200 символов/);
    assert.deepEqual(app.storedData().playerInfo, { '1|иванов а.': { note: 'Школа №5' } },
        'данные остались прежними');

    // Нормальный текст сохраняется
    app.id('player-note').value = 'Школа №6';
    app.submit(form());

    assert.deepEqual(app.storedData().playerInfo, { '1|иванов а.': { note: 'Школа №6' } });

    // «Убрать данные» очищает номер и принадлежность
    app.click(app.id('admin-players-list').querySelector('[data-action="player-info-open"]'));
    app.click(app.id('admin-player-info').querySelector('[data-action="player-info-clear"]'));

    assert.deepEqual(app.storedData().playerInfo, {});
    assert.match(app.id('toast-container').textContent, /Данные игрока убраны/);
    assert.equal(app.id('admin-player-info').hidden, true, 'форма закрыта');
});



test('админка: переименование и удаление игрока переносят данные карточки', async () => {
    const seeded = remoteData();

    seeded.playerInfo = { '1|иванов а.': { note: 'Школа №5', number: 9 } };

    const mock = createMockRepository({ data: seeded });
    const app = boot({ mock, autoPublishDelayMs: 10000 });

    await app.settle();

    app.login();
    app.openTeam('Спартак');

    // Форма открыта на игроке с заполненными данными
    app.click(app.id('admin-players-list').querySelector('[data-action="player-info-open"]'));
    assert.equal(app.id('player-number').value, '9');
    assert.equal(app.id('player-note').value, 'Школа №5');
    assert.ok(app.id('admin-player-info').querySelector('[data-action="player-info-clear"]'),
        'есть кнопка «убрать данные»');

    // «Отмена» просто закрывает форму, данные не меняются
    app.click(app.id('admin-player-info').querySelector('[data-action="player-info-cancel"]'));

    assert.equal(app.id('admin-player-info').hidden, true);
    assert.deepEqual(app.storedData().playerInfo, { '1|иванов а.': { note: 'Школа №5', number: 9 } });

    // Переименование переносит данные на новое имя
    app.click(app.id('admin-players-list').querySelector('[data-action="player-rename"]'));
    app.type(app.id('player-rename-input'), 'Иванов-старший');
    app.click(app.id('admin-players-list').querySelector('[data-action="player-save"]'));

    assert.deepEqual(app.storedData().playerInfo, {
        '1|иванов-старший': { note: 'Школа №5', number: 9 }
    });

    // Удаление игрока убирает и его данные
    app.click(app.id('admin-players-list').querySelector('[data-action="player-delete"]'));

    assert.deepEqual(app.storedData().playerInfo, {}, 'данные удалённого игрока убраны');
    assert.equal(app.storedData().teams[0].players.length, 2);
});

test('админка: удаление команды убирает данные её игроков', async () => {
    const seeded = remoteData();

    seeded.playerInfo = {
        '1|иванов а.': { note: 'Школа №5', number: 9 },
        '2|кузнецов к.': { note: 'Клуб', number: 3 }
    };

    const mock = createMockRepository({ data: seeded });
    const app = boot({ mock, autoPublishDelayMs: 10000 });

    await app.settle();

    app.login();
    app.openTeam('Спартак');
    app.click(app.button('team-delete'));

    assert.deepEqual(app.storedData().playerInfo, { '2|кузнецов к.': { note: 'Клуб', number: 3 } },
        'данные игроков удалённой команды убраны, чужие не задеты');
});


test('автообновление: зритель видит новые данные без нажатия «Обновить данные»', async () => {
    const mock = createMockRepository({ data: remoteData() });
    const app = boot({ mock, refreshIntervalMs: 40, autoPublishDelayMs: 10000 });

    await app.settle();

    assert.match(app.id('teams-grid').textContent, /Спартак/);

    // Администратор с другого устройства опубликовал новую команду
    const updated = remoteData('Клуб из автообновления');

    updated.revision = 99;
    updated.updatedAt = '2026-09-20T12:00:00.000Z';
    mock.changeExternally(updated);

    // Ничего не нажимаем: страница сама подтягивает свежую версию по таймеру
    await app.wait(140);

    assert.match(app.id('teams-grid').textContent, /Клуб из автообновления/, 'данные обновились сами');
    assert.equal(app.id('stat-teams').textContent, String(updated.teams.length));
    assert.match(app.id('toast-container').textContent, /Результаты обновлены автоматически/);
    assert.match(app.freshness(), /обновляется автоматически/);

    app.stopAutoRefresh();
});

/**
 * Свежий результат: если счёт матча изменился с прошлой отрисовки, карточка получает
 * класс is-fresh — в оформлении «Афиша матча» у такого счёта загорается «лампа».
 */
test('свежий результат: изменившийся счёт помечается «лампой»', async () => {
    const mock = createMockRepository({ data: remoteData() });
    const app = boot({ mock, refreshIntervalMs: 40, autoPublishDelayMs: 10000 });

    await app.settle();

    assert.equal(app.$$('.match-card.is-fresh').length, 0, 'при первой отрисовке лампы не горят');

    // Администратор с другого устройства поправил счёт уже сыгранного матча
    const updated = remoteData();
    const played = updated.matches.filter((match) => match.finished)[0];

    updated.revision = 42;
    updated.updatedAt = '2026-09-20T12:00:00.000Z';
    played.scoreA += 1;
    mock.changeExternally(updated);

    await app.wait(140);

    // Свежий счёт показывается в списке матчей: на главной результаты
    // не дублируются, за них отвечает плитка «Завершено»
    app.navigate('matches');

    const card = app.id('matches-list').querySelector('.match-card[data-id="' + played.id + '"]');

    assert.ok(card, 'матч с изменившимся счётом виден в списке матчей');
    assert.equal(card.classList.contains('is-fresh'), true, 'у свежего счёта горит «лампа»');
    assert.equal(app.$$('#matches-list .match-card.is-fresh').length, 1, 'лампа только у изменившегося матча');

    app.stopAutoRefresh();
});

test('автообновление: скрытая вкладка запросов не делает, а возвращение во вкладку обновляет сразу', async () => {
    const mock = createMockRepository({ data: remoteData() });
    const app = boot({ mock, refreshIntervalMs: 40, autoPublishDelayMs: 10000 });

    await app.settle();

    // Чтение данных из общего хранилища: и Contents API, и «сырой» адрес репозитория
    const pulls = () => mock.state.requests.filter((request) =>
        request.url.includes('/mock-raw/') || request.url.includes('/mock-api/repos/')).length;
    const before = pulls();

    // Вкладка скрыта: таймер срабатывает, но в репозиторий не ходим
    Object.defineProperty(app.document, 'visibilityState', { value: 'hidden', configurable: true });
    await app.wait(140);

    assert.equal(pulls(), before, 'скрытая вкладка не тратит запросы');

    // Возвращаемся во вкладку: данные проверяются сразу, не дожидаясь таймера
    const updated = remoteData('Клуб после возврата');

    updated.revision = 99;
    updated.updatedAt = '2026-09-20T13:00:00.000Z';
    mock.changeExternally(updated);

    Object.defineProperty(app.document, 'visibilityState', { value: 'visible', configurable: true });
    app.document.dispatchEvent(new app.window.Event('visibilitychange'));

    await app.wait(30);

    assert.match(app.id('teams-grid').textContent, /Клуб после возврата/, 'обновилось сразу после возврата');

    app.stopAutoRefresh();
});

/* ------------------------------------------------------------------ */
/* Новая версия сайта: страница обновляется сама                       */
/* ------------------------------------------------------------------ */

/** Версия файлов на открытой странице: берём из index.html, а не из числа в тесте. */
const RUNNING_BUILD = Number(/app\.js\?v=(\d+)/.exec(readSource('index.html'))[1]);

/** Так выглядит выложенная страница сайта с другим номером версии файлов. */
function pageWithBuild(version) {
    return '<!DOCTYPE html><html><head>' +
        '<link rel="stylesheet" href="assets/css/tailwind.css?v=' + version + '">' +
        '<script src="assets/js/app.js?v=' + version + '" defer></script>' +
        '</head><body></body></html>';
}

/** «Сеть» для проверки версии: страница сайта отвечает, данные — нет. */
function buildFetch(html) {
    return (url) => {
        if (String(url).indexOf('index.html') === 0) {
            return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(html) });
        }

        return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
    };
}

/** Запускает приложение с «выложенной» страницей сайта и подменённой перезагрузкой. */
function bootWithBuild(html, options) {
    const settings = options || {};
    const app = boot({
        mock: { fetch: buildFetch(html) },
        seed: settings.seed,
        sessionSeed: settings.sessionSeed
    });
    const reloads = [];

    // Подменяем перезагрузку до первой проверки: она идёт по микротаскам,
    // то есть уже после возврата из boot()
    app.window.FTApp.build.reload(() => reloads.push(1));

    app.reloads = reloads;
    return app;
}

test('новая версия сайта: открытая страница перезагружается сама', async () => {
    const app = bootWithBuild(pageWithBuild(RUNNING_BUILD + 1));

    assert.equal(app.window.FTApp.build.state.running, RUNNING_BUILD, 'версия открытой страницы известна');

    await app.settle();

    assert.equal(app.window.FTApp.build.state.found, RUNNING_BUILD + 1, 'на сайте найдена новая версия');
    assert.equal(app.window.FTApp.build.state.pending, RUNNING_BUILD + 1, 'перезагрузка решена');
    assert.match(app.id('toast-container').textContent, /новая версия сайта/i, 'посетитель предупреждён');
    assert.equal(app.reloads.length, 0, 'перезагрузка идёт с короткой паузой, а не мгновенно');

    await app.wait(1500);

    assert.equal(app.reloads.length, 1, 'страница перезагружена один раз');
    assert.equal(app.window.FTApp.build.state.pending, 0, 'ожидание перезагрузки снято');
    assert.equal(app.window.sessionStorage.getItem('ft.buildReloaded'), String(RUNNING_BUILD + 1),
        'отметка сессии не даёт перезагружаться по кругу');

    // Вторая проверка под ту же версию молчит: страница уже работает с новыми файлами
    assert.equal(await app.window.FTApp.build.check(), false, 'второй перезагрузки не будет');
    await app.wait(1500);
    assert.equal(app.reloads.length, 1);
});

test('новая версия сайта: когда выкладывать нечего, страница не дёргается', async () => {
    const app = bootWithBuild(pageWithBuild(RUNNING_BUILD));

    await app.settle();

    assert.equal(app.window.FTApp.build.state.found, RUNNING_BUILD, 'версия на сайте та же');
    assert.equal(app.window.FTApp.build.state.pending, 0);

    await app.wait(1500);

    assert.equal(app.reloads.length, 0, 'перезагрузки нет');
    assert.equal(app.id('toast-container').textContent.includes('новая версия'), false, 'и подсказки нет');
});

test('новая версия сайта: администратору и неопубликованным правкам перезагрузка не мешает', async () => {
    const edits = bootWithBuild(pageWithBuild(RUNNING_BUILD + 1), {
        seed: { [EDITS_KEY]: '2026-09-01T00:00:00.000Z' }
    });

    await edits.settle();
    await edits.wait(1500);

    assert.equal(edits.window.FTApp.build.state.pending, RUNNING_BUILD + 1, 'новая версия запомнена');
    assert.equal(edits.reloads.length, 0, 'правки на устройстве не теряются');

    // Правки опубликованы — перезагрузка сразу становится безопасной
    edits.window.localStorage.removeItem(EDITS_KEY);
    assert.equal(await edits.window.FTApp.build.check(), true, 'перезагрузка больше не откладывается');

    const panel = bootWithBuild(pageWithBuild(RUNNING_BUILD + 1));

    await panel.settle();
    panel.navigate('admin');
    panel.window.FTApp.build.state.pending = RUNNING_BUILD + 1;

    assert.equal(await panel.window.FTApp.build.check(), false, 'в админке страница не перезагружается');
    await panel.wait(1500);
    assert.equal(panel.reloads.length, 0);
});

test('прямая ссылка на карточку игрока открывается при загрузке страницы', () => {
    const seeded = remoteData();

    // Так открывается ссылка, которой поделились: страница сразу показывает карточку
    const app = boot({ seed: { [DATA_KEY]: JSON.stringify(seeded) }, url: 'https://tournament.test/#/player/2/1' });

    assert.equal(app.activeSection(), 'page-player', 'карточка игрока открыта сразу');
    assert.equal(app.id('player-card').querySelector('h2').textContent, 'Попов П.');
    assert.match(app.id('player-card').textContent, /Локомотив/);
});


test('страница команды: фотографии в блоке, нажатие открывает фото на весь экран', () => {
    const seeded = remoteData();

    seeded.teamImages = {
        '1': ['assets/photos/team-photo-a-111111.jpg', 'assets/photos/team-photo-b-222222.jpg']
    };

    const app = boot({ seed: { [DATA_KEY]: JSON.stringify(seeded) } });

    app.navigate('teams');

    // В списке команд блока фотографий нет — он только на странице команды
    assert.equal(app.id('teams-grid').querySelector('.team-gallery'), null, 'в списке команд фотографий нет');

    app.click(app.id('teams-grid').querySelector('[data-action="team-public-open"][data-id="1"]'));

    const items = () => app.id('team-detail').querySelectorAll('.team-gallery-item');

    assert.match(app.id('team-detail').textContent, /Фотографии \(2\)/, 'заголовок блока с числом фото');
    assert.equal(items().length, 2, 'обе фотографии видны');
    assert.equal(items()[0].getAttribute('data-action'), 'image-open', 'миниатюра кликабельна');
    assert.equal(items()[0].querySelector('img').getAttribute('src'), 'assets/photos/team-photo-a-111111.jpg');

    // Команда без фотографий: блока нет
    app.click(app.button('team-public-back'));
    app.click(app.id('teams-grid').querySelector('[data-action="team-public-open"][data-id="2"]'));

    assert.equal(app.id('team-detail').querySelector('.team-gallery'), null, 'у команды без фото блока нет');

    // Возвращаемся к команде с фотографиями и открываем снимок
    app.click(app.button('team-public-back'));
    app.click(app.id('teams-grid').querySelector('[data-action="team-public-open"][data-id="1"]'));

    const viewer = app.id('image-viewer');
    const photo = app.id('image-viewer-photo');

    assert.equal(viewer.hidden, true, 'просмотр закрыт');

    app.click(items()[1]);

    assert.equal(viewer.hidden, false, 'фотография открылась на весь экран');
    assert.equal(photo.getAttribute('src'), 'assets/photos/team-photo-b-222222.jpg', 'открылся выбранный снимок');
    assert.equal(photo.getAttribute('data-photo-path'), 'assets/photos/team-photo-b-222222.jpg');
    assert.equal(photo.classList.contains('photo-retry'), true, 'картинка умеет догрузиться');
    assert.equal(app.id('image-viewer-caption').textContent, 'Спартак · 2 из 2', 'подпись: команда и номер фото');
    assert.equal(app.document.body.classList.contains('viewer-open'), true, 'страница не прокручивается');

    // Стрелки листают по кругу
    app.click(app.button('image-next'));
    assert.equal(photo.getAttribute('src'), 'assets/photos/team-photo-a-111111.jpg');
    assert.equal(app.id('image-viewer-caption').textContent, 'Спартак · 1 из 2');

    app.click(app.button('image-prev'));
    assert.equal(photo.getAttribute('src'), 'assets/photos/team-photo-b-222222.jpg');

    // Esc закрывает просмотр
    app.document.dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    assert.equal(viewer.hidden, true, 'закрылось по Esc');
    assert.equal(app.document.body.classList.contains('viewer-open'), false, 'прокрутка страницы вернулась');

    // Кнопка-крестик и клик по затемнению тоже закрывают
    app.click(items()[0]);
    assert.equal(viewer.hidden, false);

    app.click(app.id('image-viewer').querySelector('.image-viewer-close'));
    assert.equal(viewer.hidden, true, 'закрылось крестиком');

    app.click(items()[0]);
    app.click(app.id('image-viewer').querySelector('.image-viewer-backdrop'));
    assert.equal(viewer.hidden, true, 'закрылось нажатием по затемнению');
});


test('админка: фотографии команды загружаются пачкой, видны на странице и убираются', async () => {
    const mock = createMockRepository({ data: remoteData() });
    const app = boot({ mock, autoPublishDelayMs: 10000 });

    await app.settle();

    app.login();
    app.saveToken('test-token');
    app.openTeam('Спартак');

    const box = () => app.id('admin-team-images');
    const input = box().querySelector('input[data-photo-kind="team-image"]');

    assert.ok(input, 'есть кнопка «Добавить фотографии»');
    assert.equal(input.multiple, true, 'можно выбрать сразу несколько файлов');
    assert.equal(box().querySelectorAll('.admin-gallery-item').length, 0, 'пока фотографий нет');

    // Сжатие в браузере подменяем: canvas в jsdom нет
    const prepared = [
        { ok: true, base64: 'QUJD', bytes: 1024, mime: 'image/jpeg', size: 1920, width: 1920, height: 1280,
            path: 'assets/photos/team-photo-a-111111.jpg' },
        { ok: true, base64: 'REVG', bytes: 2048, mime: 'image/jpeg', size: 1920, width: 1600, height: 1200,
            path: 'assets/photos/team-photo-b-222222.jpg' }
    ];
    const seen = [];
    let call = 0;

    app.window.FTPhoto.prepare = (file, settings) => {
        seen.push(settings);

        return Promise.resolve(prepared[call++] || { ok: false, error: 'файл не подготовлен' });
    };

    Object.defineProperty(input, 'files', { value: [
        { size: 2048, type: 'image/jpeg', name: 'one.jpg' },
        { size: 2048, type: 'image/jpeg', name: 'two.jpg' }
    ] });

    app.change(input);
    await app.wait(120);

    // Файлы ушли в репозиторий, пути записаны в данные
    assert.deepEqual(app.storedData().teamImages['1'],
        ['assets/photos/team-photo-a-111111.jpg', 'assets/photos/team-photo-b-222222.jpg']);
    assert.equal(mock.state.commits.filter((commit) => /Фотография команды/.test(commit.message || '')).length, 2,
        'каждая фотография — отдельный коммит');
    assert.match(app.id('toast-container').textContent, /Добавлено фотографий: 2/);
    assert.equal(box().querySelectorAll('.admin-gallery-item').length, 2, 'миниатюры видны в админке');

    // Настройки галереи: пропорции сохраняются, размер крупный, имя файла — по содержимому
    assert.equal(seen[0].fit, 'inside', 'пропорции фотографии сохраняются');
    assert.equal(seen[0].byContent, true, 'разные фото не перезаписывают друг друга');
    assert.equal(seen[0].prefix, 'team-photo-');
    assert.ok(seen[0].maxSize >= 1600, 'длинная сторона крупная: ' + seen[0].maxSize);
    assert.ok(seen[0].maxResultBytes > 400 * 1024, 'для фото команды допустим размер больше, чем у аватарки');

    // Публичная страница команды показывает те же фотографии
    app.navigate('teams');
    app.click(app.id('teams-grid').querySelector('[data-action="team-public-open"][data-id="1"]'));

    assert.equal(app.id('team-detail').querySelectorAll('.team-gallery-item').length, 2);

    // Убираем одну фотографию
    app.click(box().querySelector('[data-action="team-image-remove"]'));

    assert.deepEqual(app.storedData().teamImages['1'], ['assets/photos/team-photo-b-222222.jpg']);
    assert.match(app.id('toast-container').textContent, /Фотография убрана/);
    assert.equal(box().querySelectorAll('.admin-gallery-item').length, 1, 'миниатюра исчезла');

    // Дошли до предела: загрузка пропадает, появляется подсказка
    for (let i = 3; i <= L.CONFIG.maxTeamImages + 1; i += 1) {
        L.addTeamImage(app.window.FTApp.getData(), 1, 'assets/photos/team-photo-' + i + '-abcdef.jpg');
    }

    app.window.FTApp.render();

    const full = box();

    assert.equal(full.querySelectorAll('.admin-gallery-item').length, L.CONFIG.maxTeamImages);
    assert.equal(full.querySelector('input[data-photo-kind="team-image"]'), null, 'загрузка скрыта при пределе');
    assert.match(full.textContent, /Достигнут предел/);

    // Удаление команды убирает и её фотографии
    app.click(app.button('team-delete'));

    assert.deepEqual(app.storedData().teamImages, {}, 'фотографии удалённой команды убраны');
});


test('состав команды: блок «Состав», по нажатию — список со статистикой', () => {
    const seeded = remoteData();

    // Иванов А. забил дважды и получил жёлтую, Петров П. — красную
    seeded.matches[0].events = [
        { team: 1, player: 'Иванов А.', type: 'goal' },
        { team: 1, player: 'Иванов А.', type: 'goal' },
        { team: 1, player: 'Иванов А.', type: 'yellow' },
        { team: 1, player: 'Петров П.', type: 'red' }
    ];
    seeded.playerInfo = { '1|иванов а.': { number: 7, note: '' } };

    const app = boot({ seed: { [DATA_KEY]: JSON.stringify(seeded) } });

    app.navigate('teams');
    app.click(app.id('teams-grid').querySelector('[data-action="team-public-open"][data-id="1"]'));

    const detail = () => app.id('team-detail');
    const block = () => app.id('team-squad');

    assert.match(detail().querySelector('.squad-toggle').textContent, /Состав/, 'кнопка «Состав»');
    assert.match(detail().querySelector('.squad-toggle-action').textContent, /Показать/);
    assert.equal(block().hidden, true, 'список скрыт до нажатия');

    app.click(detail().querySelector('[data-action="squad-toggle"]'));

    assert.equal(block().hidden, false, 'список открылся');
    assert.equal(detail().querySelector('[data-action="squad-toggle"]').getAttribute('aria-expanded'), 'true');
    assert.match(detail().querySelector('.squad-toggle-action').textContent, /Скрыть/);

    const columns = Array.from(block().querySelectorAll('thead th'))
        .map((cell) => cell.textContent.replace(/[↕↑↓]/g, '').trim());

    assert.deepEqual(columns, ['Игрок', 'Г', 'Ж', 'К'], 'имя, голы, Ж и К');

    const rows = Array.from(block().querySelectorAll('tbody tr')).map((row) => ({
        name: row.querySelector('.player-name').textContent,
        goals: row.children[1].textContent,
        yellow: row.children[2].textContent,
        red: row.children[3].textContent,
        link: row.querySelector('a.player-link').getAttribute('href')
    }));

    assert.equal(rows.length, 3, 'все игроки команды — столбиком');
    assert.deepEqual(rows[0], {
        name: 'Иванов А.', goals: '2', yellow: '1', red: '0', link: '#/player/1/0'
    });
    assert.deepEqual(rows[1], {
        name: 'Петров П.', goals: '0', yellow: '0', red: '1', link: '#/player/1/1'
    });

    // Даты рождения в составе больше нет — ни столбца, ни подписи под именем
    assert.equal(block().textContent.indexOf('Дата рождения'), -1, 'в составе нет даты рождения');
    assert.equal(block().querySelector('.row-detail'), null, 'под именем игрока ничего лишнего');

    // Повторное нажатие сворачивает список
    app.click(detail().querySelector('[data-action="squad-toggle"]'));

    assert.equal(block().hidden, true, 'список снова скрыт');
    assert.match(detail().querySelector('.squad-toggle-action').textContent, /Показать/);

    // У команды без игроков — понятная подпись вместо кнопки
    const empty = remoteData();

    empty.teams.push({ id: 50, name: 'Пустая команда', players: [] });

    const other = boot({ seed: { [DATA_KEY]: JSON.stringify(empty) } });

    other.navigate('teams');
    other.click(other.id('teams-grid').querySelector('[data-action="team-public-open"][data-id="50"]'));

    assert.match(other.id('team-detail').textContent, /Состав не заполнен/);
    assert.equal(other.id('team-detail').querySelector('.squad-toggle'), null, 'для пустого состава кнопки нет');
});


test('карточка матча: голы и карточки показаны у той команды, которая их получила', () => {
    const seeded = remoteData();

    // «Спартак»: гол и жёлтая. «Локомотив»: гол, две жёлтые и красная
    seeded.matches[0].events = [
        { team: 1, player: 'Иванов А.', type: 'goal' },
        { team: 1, player: 'Иванов А.', type: 'yellow' },
        { team: 2, player: 'Кузнецов К.', type: 'goal' },
        { team: 2, player: 'Кузнецов К.', type: 'yellow' },
        { team: 2, player: 'Попов П.', type: 'yellow' },
        { team: 2, player: 'Попов П.', type: 'red' }
    ];

    const app = boot({ seed: { [DATA_KEY]: JSON.stringify(seeded) } });

    app.navigate('matches');

    const card = app.id('matches-list').querySelector('.match-card[data-id="1"]');
    const sides = card.querySelectorAll('.match-side-marks');

    assert.equal(sides.length, 2, 'у каждой команды свои отметки');
    assert.equal(sides[0].classList.contains('match-side-marks-away'), false, 'у хозяев — слева');
    assert.equal(sides[1].classList.contains('match-side-marks-away'), true, 'у гостей — справа');

    const marks = (side) => Array.from(side.querySelectorAll('.match-mark'))
        .map((mark) => mark.textContent.trim());

    assert.deepEqual(marks(sides[0]), ['1', '1'], 'Спартак: 1 гол и 1 жёлтая');
    assert.deepEqual(marks(sides[1]), ['1', '2', '1'], 'Локомотив: 1 гол, 2 жёлтые и красная');

    // Отметки стоят в блоке своей команды, а не в общей строке слева
    assert.match(sides[0].parentNode.textContent, /Спартак/);
    assert.match(sides[1].parentNode.textContent, /Локомотив/);
    assert.equal(card.querySelector('.mt-2 .match-mark'), null, 'в нижней строке карточки отметок больше нет');
    assert.match(card.textContent, /2 : 1/, 'счёт на месте');

    // Нижняя строка карточки: дата и статус матча
    assert.ok(card.querySelector('.mt-2').textContent.includes(L.formatDate(seeded.matches[0].date, 'long')),
        'дата матча видна');
    assert.ok(card.querySelector('.status-pill'), 'статус матча виден');

    // На главной странице афиша ближайшего матча — тот же билет матча
    app.navigate('home');

    const homeCard = app.id('next-match').querySelector('.match-card');

    assert.ok(homeCard.classList.contains('next-match-card'), 'на главной — афиша ближайшего матча');
    assert.equal(homeCard.querySelectorAll('.team-link').length, 2, 'обе команды — ссылки');
});


test('счётчики на главной кликабельны и открывают нужные страницы', () => {
    const seeded = remoteData();

    // Ещё один завершённый матч — чтобы отличить «все матчи» от «завершённые»
    seeded.matches.push({ id: 99, teamA: 1, teamB: 2, scoreA: 1, scoreB: 0, date: '2026-09-01', finished: true });

    const app = boot({ seed: { [DATA_KEY]: JSON.stringify(seeded) } });
    const tile = (id) => app.id(id).closest('.stat-box-link');

    assert.equal(tile('stat-teams').tagName, 'BUTTON', 'плитки — кнопки, работают и с клавиатуры');
    assert.equal(tile('stat-players').getAttribute('data-page'), 'allplayers');

    // Табло и плитки — только на главной: на других страницах контент начинается сверху
    assert.equal(app.id('site-head').hidden, false, 'на главной табло и счётчики видны');

    // «Команд» → список команд
    app.click(tile('stat-teams'));

    assert.equal(app.activeSection(), 'page-teams');
    assert.equal(app.window.location.hash, '#/teams');
    assert.equal(app.id('site-head').hidden, true, 'на внутренней странице табло скрыто');

    // «Матчей» → все матчи
    app.navigate('home');
    assert.equal(app.id('site-head').hidden, false, 'вернулись на главную — табло снова видно');
    app.click(tile('stat-matches'));

    assert.equal(app.activeSection(), 'page-matches');
    assert.equal(app.id('matches-list').querySelectorAll('.match-card').length, 5, 'показаны все матчи');

    // «Завершено» → матчи с фильтром «завершённые»
    app.navigate('home');
    app.click(tile('stat-finished'));

    assert.equal(app.activeSection(), 'page-matches');
    assert.equal(app.id('matches-list').querySelectorAll('.match-card').length, 3, 'только завершённые матчи');
    assert.equal(app.id('matches-list').querySelectorAll('.match-card.upcoming').length, 0, 'предстоящих нет');

    // «Игроков» → страница со всеми игроками
    app.navigate('home');
    app.click(tile('stat-players'));

    assert.equal(app.activeSection(), 'page-allplayers');
    assert.equal(app.window.location.hash, '#/allplayers');
    assert.match(app.id('all-players-body').textContent, /Иванов А\./);
});


test('страница «Все игроки»: краткая информация и сортировка по столбцам', () => {
    const seeded = remoteData();

    // Иванов А.: два гола и жёлтая. Кузнецов К.: гол. Остальные без событий
    seeded.matches[0].events = [
        { team: 1, player: 'Иванов А.', type: 'goal' },
        { team: 1, player: 'Иванов А.', type: 'goal' },
        { team: 1, player: 'Иванов А.', type: 'yellow' },
        { team: 2, player: 'Кузнецов К.', type: 'goal' }
    ];
    seeded.playerInfo = {
        '1|иванов а.': { number: 7, note: '' },
        '2|кузнецов к.': { number: 13, note: '' }
    };

    const app = boot({ seed: { [DATA_KEY]: JSON.stringify(seeded) } });

    app.navigate('allplayers');

    const body = () => app.id('all-players-body');
    const head = () => app.id('all-players-head');
    const names = () => Array.from(body().querySelectorAll('tr'))
        .map((row) => row.querySelector('.player-name').textContent);
    const column = (key) => head().querySelector('[data-key="' + key + '"]').closest('th');

    assert.equal(app.activeSection(), 'page-allplayers');
    assert.equal(body().querySelectorAll('tr').length, 9, 'все игроки турнира, а не только забивавшие');

    // Столбцы и кнопки сортировки: даты рождения среди них больше нет
    assert.deepEqual(
        Array.from(head().querySelectorAll('th')).map((cell) => cell.textContent.replace(/[↕↑↓]/g, '').trim()),
        ['Игрок', 'Команда', 'Г', 'Ж', 'К']
    );
    assert.equal(head().querySelector('[data-key="birthDate"]'), null, 'столбца с датой рождения нет');
    assert.equal(head().querySelectorAll('[data-action="sort"]').length, 5, 'сортировать можно по каждому столбцу');
    assert.equal(column('goals').getAttribute('aria-sort'), 'none', 'пока порядок исходный');

    // Краткая информация в строке
    const first = body().querySelector('tr');

    assert.equal(first.querySelector('.player-name').textContent, 'Иванов А.');
    assert.match(first.children[1].textContent, /Спартак/);
    assert.deepEqual(Array.from(first.children).slice(2).map((cell) => cell.textContent), ['2', '1', '0'],
        'голы, жёлтые и красные карточки');

    // Сортировка по голам: сначала от большего, повторное нажатие — от меньшего
    app.click(head().querySelector('[data-key="goals"]'));

    assert.equal(names()[0], 'Иванов А.', 'самый результативный — первым');
    assert.equal(column('goals').getAttribute('aria-sort'), 'descending');
    assert.match(column('goals').textContent, /↓/, 'в заголовке видно направление');

    app.click(head().querySelector('[data-key="goals"]'));

    assert.equal(names()[8], 'Иванов А.', 'при обратном порядке он последний');
    assert.equal(column('goals').getAttribute('aria-sort'), 'ascending');
    assert.match(column('goals').textContent, /↑/);

    // Сортировка по имени
    app.click(head().querySelector('[data-key="player"]'));

    assert.equal(names()[0], 'Волков В.', 'по имени — по алфавиту');
    assert.equal(names()[8], 'Смирнов Д.');
    assert.equal(column('player').getAttribute('aria-sort'), 'ascending');

    // Сортировка по карточкам
    app.click(head().querySelector('[data-key="yellow"]'));

    assert.equal(names()[0], 'Иванов А.', 'у него одна жёлтая карточка');
});


test('состав команды и бомбардиры тоже сортируются по столбцам', () => {
    const seeded = remoteData();

    seeded.matches[0].events = [
        { team: 1, player: 'Иванов А.', type: 'goal' },
        { team: 1, player: 'Иванов А.', type: 'goal' },
        { team: 1, player: 'Сидоров С.', type: 'goal' },
        { team: 2, player: 'Кузнецов К.', type: 'goal' }
    ];

    const app = boot({ seed: { [DATA_KEY]: JSON.stringify(seeded) } });

    // Состав команды: пока сортировка не выбрана — порядок заявки
    app.navigate('teams');
    app.click(app.id('teams-grid').querySelector('[data-action="team-public-open"][data-id="1"]'));
    app.click(app.id('team-detail').querySelector('[data-action="squad-toggle"]'));

    const squadNames = () => Array.from(app.id('team-squad').querySelectorAll('tbody tr .player-name'))
        .map((cell) => cell.textContent);

    assert.deepEqual(squadNames(), ['Иванов А.', 'Петров П.', 'Сидоров С.']);

    app.click(app.id('team-squad').querySelector('[data-key="goals"]'));

    assert.deepEqual(squadNames(), ['Иванов А.', 'Сидоров С.', 'Петров П.'], 'по голам: 2, 1 и 0');
    assert.deepEqual(
        Array.from(app.id('team-squad').querySelectorAll('tbody tr td:nth-child(2)')).map((cell) => cell.textContent),
        ['2', '1', '0'],
        'столбец голов'
    );

    // Лучшие бомбардиры: по умолчанию по голам, по нажатию на имя — по алфавиту
    app.navigate('players');

    const scorers = () => Array.from(app.id('players-body').querySelectorAll('tr .player-name'))
        .map((cell) => cell.textContent);

    assert.equal(app.id('players-head').querySelectorAll('[data-action="sort"]').length, 3, 'три сортируемых столбца');
    assert.deepEqual(scorers(), ['Иванов А.', 'Кузнецов К.', 'Сидоров С.'], 'по умолчанию — по голам');
    assert.deepEqual(
        Array.from(app.id('players-body').querySelectorAll('tr td:first-child')).map((cell) => cell.textContent),
        ['1', '2', '3'],
        'место считается по текущему порядку'
    );

    app.click(app.id('players-head').querySelector('[data-key="player"]'));
    assert.equal(app.id('players-head').querySelector('[data-key="player"]').closest('th').getAttribute('aria-sort'),
        'ascending');
    assert.deepEqual(scorers(), ['Иванов А.', 'Кузнецов К.', 'Сидоров С.'], 'по имени — тот же порядок');

    app.click(app.id('players-head').querySelector('[data-key="goals"]'));

    assert.equal(app.id('players-head').querySelector('[data-key="goals"]').closest('th').getAttribute('aria-sort'),
        'descending');
    assert.deepEqual(
        Array.from(app.id('players-body').querySelectorAll('tr td:last-child')).map((cell) => cell.textContent),
        ['2', '1', '1'],
        'голы по убыванию'
    );
});

test('заставка: при первом входе показан фон с названием, отсчёт идёт и сайт открывается сам', async () => {
    const app = boot({ splashMs: 400 });

    // Фон, логотип, название и отсчёт; кнопок нет — сайт открывается сам
    assert.equal(app.$('#splash .splash-badge').textContent, 'FT');
    assert.equal(app.$('.splash-title').textContent, 'Чемпионат среди Артистов по футболу');
    assert.match(app.$('.splash-subtitle').textContent, /Сезон 2026–2027/);
    assert.equal(app.id('splash-countdown').textContent, '1');
    assert.equal(app.$('#splash button'), null, 'на заставке нет кнопок');
    assert.equal(app.$('.splash-skip'), null, 'кнопки «Войти на сайт» больше нет');
    assert.equal(app.window.FTSplash.duration, 400);
    assert.equal(app.window.FTSplash.isVisible(), true);

    // Пока заставка видна, страница не прокручивается
    assert.ok(app.document.body.classList.contains('splash-open'), 'прокрутка заблокирована');

    // Заставка уходит сама: splashMs (400) + время плавного исчезновения (400).
    // Ждём с запасом и опросом: под нагрузкой таймеры срабатывают чуть позже.
    for (let attempt = 0; attempt < 40 && !app.id('splash').hidden; attempt += 1) {
        await app.wait(50);
    }

    assert.equal(app.id('splash').hidden, true, 'заставка скрылась сама');
    assert.equal(app.window.FTSplash.isVisible(), false);
    assert.ok(!app.document.body.classList.contains('splash-open'), 'прокрутка вернулась');
    assert.equal(app.window.FTSplash.isSeen(), true, 'отметка «заставка показана» сохранена');

    // Сайт под заставкой продолжал работать как обычно
    assert.equal(app.activeSection(), 'page-home');
    assert.ok(Number(app.id('stat-teams').textContent) > 0, 'счётчики на главной видны');
});

test('заставка: клик открывает сайт сразу, повторный вход в сессии — без заставки', () => {
    const app = boot({ splashMs: 6000 });

    // Клик по фону открывает сайт, не дожидаясь конца отсчёта
    app.click(app.id('splash'));

    assert.equal(app.window.FTSplash.isVisible(), false, 'заставка закрывается сразу');
    assert.ok(app.id('splash').classList.contains('is-closing'), 'закрывается плавно');
    assert.equal(app.window.FTSplash.isSeen(), true);
    assert.ok(!app.document.body.classList.contains('splash-open'), 'прокрутка вернулась');

    // Второе открытие в той же сессии: отметка есть — заставки нет вовсе
    const second = boot({ splashMs: 6000, sessionSeed: { 'ft.splashSeen': '1' } });

    assert.equal(second.id('splash').hidden, true);
    assert.equal(second.window.FTSplash.isVisible(), false);
    assert.ok(!second.document.body.classList.contains('splash-open'));
});

test('заставка: Esc пропускает её, а splashMs = 0 выключает совсем', () => {
    const app = boot({ splashMs: 6000 });

    app.window.document.dispatchEvent(new app.window.KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true
    }));

    assert.equal(app.window.FTSplash.isVisible(), false, 'Esc пропускает заставку');

    // splashMs = 0 — заставка не показывается (так работают остальные тесты и отладка)
    const off = boot({ splashMs: 0 });

    assert.equal(off.id('splash').hidden, true);
    assert.equal(off.window.FTSplash.duration, 0);
    assert.equal(off.window.FTSplash.isSeen(), false, 'отметка не ставится');
});

