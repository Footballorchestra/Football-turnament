/**
 * E2E-проверка в настоящем браузере (Chrome headless) через puppeteer-core.
 * Сайт отдаётся локальным сервером tools/serve.js — так же, как на хостинге (http, CSP, шрифты, 404).
 *
 * Запуск: npm run test:browser
 * Если Chrome не найден, тесты помечаются пропущенными (npm test их не затрагивает).
 */
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createServer } = require('../tools/serve.js');
const { createMockRepository, createMockServer } = require('./helpers/mock-github.js');
// Настоящий пароль администратора в репозитории не хранится:
// тесты входят в панель своим паролем-образцом (см. helpers/admin-credentials.js)
const ADMIN = require('./helpers/admin-credentials.js');

const ROOT = path.resolve(__dirname, '..');

/** Каталоги кэша puppeteer: переменная окружения, затем обычные места системы. */
function puppeteerCacheRoots() {
    const roots = [];

    if (process.env.PUPPETEER_CACHE_DIR) {
        roots.push(process.env.PUPPETEER_CACHE_DIR);
    }

    roots.push(path.join(os.homedir(), '.cache', 'puppeteer'));
    roots.push(path.join(os.homedir(), 'Library', 'Caches', 'puppeteer'));
    roots.push(path.join(os.homedir(), 'AppData', 'Local', 'puppeteer'));

    return roots;
}

/** Ищет исполняемый файл Chrome: переменная окружения, кэш puppeteer, системные пути. */
function findChrome() {
    const candidates = [];

    if (process.env.CHROME_PATH) {
        candidates.push(process.env.CHROME_PATH);
    }

    puppeteerCacheRoots().forEach((root) => {
        const builds = path.join(root, 'chrome-headless-shell');

        if (!fs.existsSync(builds)) {
            return;
        }

        fs.readdirSync(builds).forEach((version) => {
            const versionDir = path.join(builds, version);

            if (!fs.statSync(versionDir).isDirectory()) {
                return;
            }

            fs.readdirSync(versionDir)
                .filter((entry) => entry.indexOf('chrome-headless-shell-') === 0)
                .forEach((platform) => {
                    candidates.push(path.join(versionDir, platform, 'chrome-headless-shell'));
                    candidates.push(path.join(versionDir, platform, 'chrome-headless-shell.exe'));
                });
        });
    });

    candidates.push(
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    );

    return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

const CHROME = findChrome();
const skip = CHROME ? false : 'Chrome не найден — установите Chrome или задайте CHROME_PATH';

/** Настройки, при которых сайт обращается к локальному макету GitHub, а не к настоящему. */
const SITE_CONFIG = {
    github: {
        owner: 'test',
        repo: 'test',
        branch: 'main',
        path: 'data.json',
        apiBase: '/mock-api',
        rawBase: '/mock-raw'
    },
    refreshIntervalMs: 0,
    autoPublishDelayMs: 50,
    // Вход в панель: сайт сверяет пароль по солёному отпечатку, поэтому
    // тесты подставляют свои соль и отпечаток вместо настоящих
    admin: ADMIN.config(),
    // Заставку в обычных тестах выключаем, чтобы она не перекрывала страницу;
    // отдельный тест заставки задаёт своё время
    splashMs: 0
};

let puppeteer = null;
let browser = null;
let mockServer = null;
let mockRepository = null;
let baseUrl = '';
let mockBaseUrl = '';

before(async () => {
    if (!CHROME) {
        return;
    }

    puppeteer = require('puppeteer-core');

    // Сервер-макет отдаёт сайт и одновременно играет роль GitHub (пути /mock-raw и /mock-api),
    // поэтому тесты автономны: интернет не нужен, настоящий GitHub не затрагивается.
    // В «репозитории» изначально лежит тот же data.json, что и в проекте.
    const mock = createMockServer(ROOT, createMockRepository({
        data: JSON.parse(fs.readFileSync(path.join(ROOT, 'data.json'), 'utf8'))
    }));
    mockServer = mock.server;
    mockRepository = mock.repository;

    await new Promise((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
    mockBaseUrl = 'http://127.0.0.1:' + mockServer.address().port;
    baseUrl = mockBaseUrl;

    browser = await puppeteer.launch({
        executablePath: CHROME,
        headless: true,
        args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage']
    });
});

after(async () => {
    if (browser) {
        await browser.close();
    }

    if (mockServer) {
        await new Promise((resolve) => mockServer.close(resolve));
    }
});

/** Отдельный контекст браузера = «другое устройство»: своё хранилище localStorage. */
function createIsolatedContext() {
    return typeof browser.createBrowserContext === 'function'
        ? browser.createBrowserContext()
        : browser.createIncognitoBrowserContext();
}

/**
 * Клик по элементу с повтором: приложение перерисовывает части страницы,
 * и в редких случаях клик приходится на момент перерисовки.
 */
async function clickWhenReady(page, selector, attempts) {
    const tries = attempts || 6;

    for (let attempt = 1; attempt <= tries; attempt += 1) {
        try {
            await page.click(selector);
            return;
        } catch (error) {
            if (attempt === tries) {
                throw error;
            }

            await new Promise((resolve) => setTimeout(resolve, 150));
        }
    }
}

/**
 * Прокручивает элемент к центру экрана и кликает по нему.
 * Нужно для кнопок у самой границы окна: центр такой кнопки лежит вне вьюпорта,
 * и обычный клик по координатам не срабатывает. Прокрутка задаётся как «instant»,
 * а перед кликом проверяется, что под курсором именно эта кнопка (в проекте
 * включена плавная прокрутка, из-за неё координаты меняются не сразу).
 */
async function clickInView(page, selector) {
    await page.$eval(selector, (element) => {
        element.scrollIntoView({ block: 'center', behavior: 'instant' });
    });

    await page.waitForFunction((target) => {
        const element = document.querySelector(target);

        if (!element) {
            return false;
        }

        const box = element.getBoundingClientRect();
        const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);

        return Boolean(hit) && (hit === element || element.contains(hit));
    }, {}, selector);

    await clickWhenReady(page, selector);
}

/** Переходит по адресу и ждёт, пока приложение инициализируется и подтянет данные. */
async function gotoApp(page, url) {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => Boolean(window.FTApp));
    await page.waitForFunction(() => window.FTApp.sync.state.pullCompleted);
}

/** Перезагрузка страницы с ожиданием повторной инициализации приложения. */
async function reloadApp(page) {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => Boolean(window.FTApp));
    await page.waitForFunction(() => window.FTApp.sync.state.pullCompleted);
}

/** Открывает страницу и собирает ошибки консоли, сбои загрузки и нарушения CSP. */
async function openPage(options) {
    const settings = options || {};
    // isolated: true — своё хранилище localStorage (как на другом устройстве)
    const context = settings.isolated ? await createIsolatedContext() : null;
    const page = context ? await context.newPage() : await browser.newPage();
    const problems = [];

    await page.setViewport(settings.mobile
        ? { width: 390, height: 844, isMobile: true, hasTouch: true }
        : { width: 1280, height: 900 });

    await page.evaluateOnNewDocument(() => {
        window.__cspViolations = [];
        document.addEventListener('securitypolicyviolation', (event) => {
            window.__cspViolations.push(event.violatedDirective + ' → ' + event.blockedURI);
        });
    });

    // Настройки подставляются до запуска скриптов приложения.
    // По умолчанию используется макет GitHub, поэтому тесты не зависят от интернета.
    await page.evaluateOnNewDocument((config) => {
        window.FT_CONFIG = config;
    }, settings.config || SITE_CONFIG);

    page.on('pageerror', (error) => problems.push('Ошибка скрипта: ' + error.message));
    page.on('console', (message) => {
        if (message.type() === 'error') {
            problems.push('Консоль: ' + message.text());
        }
    });
    page.on('requestfailed', (request) => {
        const failure = request.failure() || {};

        // Прерванная загрузка (перезагрузка страницы, уход на другую страницу)
        // — нормальное поведение браузера, а не ошибка сайта: фото грузятся лениво,
        // и часть запросов обрывается вместе со старой страницей
        if (String(failure.errorText || '').indexOf('ERR_ABORTED') !== -1) {
            return;
        }

        problems.push('Не загрузилось: ' + request.url());
    });

    // Необработанное модальное окно блокирует страницу: любые запросы к ней «зависают».
    // Поэтому окна всегда закрываем, а сам факт их появления считаем проблемой теста.
    page.on('dialog', (dialog) => {
        problems.push('Диалог браузера (' + dialog.type() + '): ' + dialog.message());
        dialog.accept().catch(() => {});
    });

    await gotoApp(page, settings.url || baseUrl + '/');

    return {
        page,
        problems,
        /** Закрывает страницу вместе с её хранилищем */
        close: async () => {
            await page.close();

            if (context) {
                await context.close();
            }
        }
    };
}

/** Снимок данных страницы: сколько команд и матчей, очки команд в таблице. */
function dataSnapshot(page) {
    return page.evaluate(() => {
        const data = window.FTApp.getData();
        const rows = window.FTLogic.computeStandings(data.teams, data.matches);
        const points = {};

        rows.forEach((row) => {
            points[row.id] = row.points;
        });

        return {
            teams: data.teams.length,
            matches: data.matches.length,
            finished: data.matches.filter((match) => match.finished === true).length,
            points: points
        };
    });
}

/** Видима ли секция (учитывая display:none у неактивных страниц). */
function sectionVisible(page, sectionId) {
    return page.evaluate((id) => {
        const element = document.getElementById(id);
        return !!element && element.offsetParent !== null;
    }, sectionId);
}

function textOf(page, selector) {
    return page.$eval(selector, (element) => element.textContent.trim());
}

/**
 * Значение плитки-счётчика после того, как оно «успокоилось»: числа набираются
 * (причём начинаются после заставки), поэтому читаем не сразу, а когда значение
 * перестанет меняться.
 */
async function settledText(page, selector) {
    await new Promise((resolve) => setTimeout(resolve, 400));

    let previous = await textOf(page, selector);
    let stable = 0;

    for (let attempt = 0; attempt < 60; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 60));

        const value = await textOf(page, selector);

        if (value === previous) {
            stable += 1;

            if (stable >= 3) {
                return value;
            }
        } else {
            stable = 0;
            previous = value;
        }
    }

    return previous;
}

function clickAction(page, selector) {
    return page.click(selector);
}

/**
 * Оформление сайта выбирает владелец, и оно лежит в данных (`settings.theme`).
 * Поэтому цвета фона и подиума в тестах берём по фактически показанному оформлению,
 * а не по одному «зашитому» виду: иначе смена оформления ломает проверки.
 */
const THEME_LOOK = {
    classic: {
        body: 'rgb(248, 249, 250)',
        leader: 'rgb(232, 245, 233)',
        prize: 'rgb(255, 251, 235)',
        other: 'rgba(0, 0, 0, 0)',
        status: /Классическое/
    },
    afisha: {
        body: 'rgb(243, 239, 230)',
        leader: 'rgb(228, 243, 230)',
        prize: 'rgb(251, 243, 216)',
        other: 'rgba(22, 32, 47, 0.035)',
        status: /«Афиша матча»/
    }
};

/** Оформление открытой страницы и ожидаемые для него цвета. */
async function themeLook(page) {
    const theme = await page.evaluate(() => window.FTApp.theme.current());

    return Object.assign({ theme }, THEME_LOOK[theme]);
}

test('страница открывается без ошибок: стили, локальные шрифты и CSP', { skip }, async () => {
    const { page, problems } = await openPage();

    const data = await dataSnapshot(page);
    assert.equal(await settledText(page, '#stat-teams'), String(data.teams));
    assert.equal(await settledText(page, '#stat-matches'), String(data.matches));

    // Стили из собранного Tailwind применились (фон зависит от оформления сайта)
    const skin = await themeLook(page);
    const background = await page.$eval('body', (element) => getComputedStyle(element).backgroundColor);

    assert.equal(background, skin.body, 'фон страницы соответствует оформлению «' + skin.theme + '»');

    // Локальный шрифт Roboto подхватился (без Google Fonts)
    assert.equal(await page.evaluate(() => document.fonts.check('16px Roboto')), true);

    // Иконки из инлайнового спрайта отрисованы
    const icons = await page.$$eval('svg use', (list) => list.length);
    assert.ok(icons > 10, 'иконок на странице: ' + icons);

    assert.deepEqual(await page.evaluate(() => window.__cspViolations), [], 'CSP ничего не заблокировала');
    assert.deepEqual(problems, [], 'нет ошибок консоли и сбоев загрузки');

    await page.close();
});

test('все страницы открываются и по меню, и по прямой ссылке', { skip }, async () => {
    const { page, problems } = await openPage();

    // Ожидания считаются по данным сайта: содержимое data.json может меняться
    const data = await dataSnapshot(page);

    const routes = [
        ['standings', 'page-standings'],
        ['teams', 'page-teams'],
        ['matches', 'page-matches'],
        ['players', 'page-players'],
        ['home', 'page-home']
    ];

    for (const [route, sectionId] of routes) {
        await page.click('[data-nav="' + route + '"]');
        assert.equal(await sectionVisible(page, sectionId), true, 'страница ' + route);
        assert.equal(page.url(), baseUrl + '/#/' + route, 'адрес синхронизирован с хэшем');
    }

    // Админ без пароля показывает форму входа
    await page.click('[data-nav="admin"]');
    assert.equal(await sectionVisible(page, 'page-admin-login'), true);

    // Прямые ссылки работают так же, как навигация
    for (const [route, sectionId] of routes) {
        await gotoApp(page, baseUrl + '/#/' + route);
        assert.equal(await sectionVisible(page, sectionId), true, 'прямая ссылка #/' + route);
    }

    await gotoApp(page, baseUrl + '/#/standings');
    assert.equal(await page.$$eval('#standings-body tr', (rows) => rows.length), data.teams);

    // Первая строка таблицы — команда с наибольшим числом очков
    const leaderPoints = await page.$eval('#standings-body tr:first-child td:last-child', (cell) => Number(cell.textContent.trim()));
    assert.equal(leaderPoints, Math.max(...Object.values(data.points)), 'первая строка — лидер по очкам');

    await gotoApp(page, baseUrl + '/#/teams');
    assert.equal(await page.$$eval('#teams-grid article', (cards) => cards.length), data.teams);

    await gotoApp(page, baseUrl + '/#/matches');
    assert.equal(await page.$$eval('#matches-list .match-card', (cards) => cards.length), data.matches);
    await page.click('[data-action="filter"][data-filter="finished"]');
    assert.equal(await page.$$eval('#matches-list .match-card', (cards) => cards.length), data.finished);

    assert.deepEqual(problems, [], 'ошибок по пути не возникло');
    await page.close();
});

/**
 * Турнирная таблица: сначала эмблема команды, потом название, а призовая тройка
 * подсвечена (лидер — зелёным, 2 и 3 место — светло-жёлтым). Раньше стили прятали
 * эмблему в компактной таблице на всех экранах, а лидер подсвечивался жёлтым.
 */
test('турнирная таблица: эмблема перед названием и подсветка призовой тройки', { skip }, async () => {
    const { page, problems } = await openPage({ url: baseUrl + '/#/standings' });

    // Подиум размечается по-разному в зависимости от оформления сайта
    const skin = await themeLook(page);
    const LEADER = skin.leader;
    const PRIZE = skin.prize;
    const NONE = skin.other;

    const look = () => page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll('#standings-body tr'));

        return {
            emblems: document.querySelectorAll('#standings-body img.team-photo').length,
            rows: rows.map((row) => {
                const avatar = row.querySelector('.team-photo, .team-badge');
                const label = row.querySelector('.team-name');
                const box = avatar ? avatar.getBoundingClientRect() : null;

                return {
                    place: row.querySelector('td').textContent.trim(),
                    avatarFirst: Boolean(avatar) && avatar.parentNode.firstElementChild === avatar,
                    avatarFollowedByName: Boolean(avatar) && Boolean(label) && avatar.nextElementSibling === label,
                    avatarWidth: box ? Math.round(box.width) : 0,
                    avatarHeight: box ? Math.round(box.height) : 0,
                    bg: getComputedStyle(row).backgroundColor
                };
            }),
            overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth
        };
    });

    const desktop = await look();

    assert.ok(desktop.emblems > 0, 'в данных есть эмблемы команд');
    assert.ok(desktop.rows.length > 3, 'в таблице больше трёх строк: ' + desktop.rows.length);

    desktop.rows.forEach((row) => {
        assert.equal(row.avatarFirst, true, 'место ' + row.place + ': сначала эмблема');
        assert.equal(row.avatarFollowedByName, true, 'место ' + row.place + ': затем название команды');
        assert.ok(row.avatarWidth > 0 && row.avatarHeight > 0, 'место ' + row.place + ': эмблема видна стилями');
    });

    assert.equal(desktop.rows[0].bg, LEADER, 'лидер подсвечен зелёным');
    assert.equal(desktop.rows[1].bg, PRIZE, 'второе место — светло-жёлтое');
    assert.equal(desktop.rows[2].bg, PRIZE, 'третье место — светло-жёлтое');
    assert.equal(desktop.rows[3].bg, NONE, 'остальные строки без призовой подсветки');

    // Телефон: компактная таблица — эмблема меньше, но по-прежнему видна,
    // а горизонтальной прокрутки нет
    await page.setViewport({ width: 360, height: 640, isMobile: true, hasTouch: true });
    await new Promise((resolve) => setTimeout(resolve, 200));

    const phone = await look();

    assert.equal(phone.rows[0].avatarWidth > 0, true, 'на телефоне эмблема видна');
    assert.equal(phone.rows[0].avatarWidth < desktop.rows[0].avatarWidth, true, 'на телефоне эмблема меньше');
    assert.equal(phone.rows[0].bg, LEADER, 'на телефоне подсветка та же');
    assert.equal(phone.rows[1].bg, PRIZE, 'на телефоне второе место — светло-жёлтое');
    assert.equal(phone.overflow, 0, 'таблица не выходит за экран');

    assert.deepEqual(problems, [], 'нет ошибок консоли и сбоев загрузки');
    await page.close();
});

test('админ-панель целиком в браузере: вход, команда, матч, счёт и сохранение после перезагрузки', { skip }, async () => {
    const { page, problems } = await openPage();

    // Модальные окна (подтверждение удаления) закрывает общий обработчик из openPage

    // Начинаем с чистого хранилища
    await page.evaluate(() => window.localStorage.clear());
    await reloadApp(page);

    // Вход
    await page.click('[data-nav="admin"]');
    await page.type('#admin-password', ADMIN.password);
    await page.click('[data-form="login"] button[type="submit"]');
    assert.equal(await sectionVisible(page, 'page-admin-dashboard'), true);
    assert.equal(await sectionVisible(page, 'page-admin-login'), false);

    // Админка разделена на разделы: открыт «Команды», раздел «Матчи» скрыт
    assert.equal(await sectionVisible(page, 'admin-panel-teams'), true);
    assert.equal(await sectionVisible(page, 'admin-panel-matches'), false);

    // Сессия администратора сохраняется при переходах по сайту
    await page.click('[data-nav="teams"]');
    await page.click('[data-nav="admin"]');
    assert.equal(await sectionVisible(page, 'page-admin-dashboard'), true);
    assert.equal(await sectionVisible(page, 'admin-panel-teams'), true, 'раздел «Команды» открыт по умолчанию');

    // Состояние данных до правок: ожидания ниже считаются от него,
    // чтобы тест не зависел от содержимого data.json
    const before = await dataSnapshot(page);

    // Добавляем команду (раздел «Команды»: список команд и форма под ним)
    await page.type('#new-team-name', 'Зенит');
    await clickInView(page, '[data-form="add-team"] button[type="submit"]');
    await page.waitForFunction((expected) => {
        return document.querySelectorAll('#admin-teams-list [data-action="team-open"]').length === expected;
    }, {}, before.teams + 1);
    assert.equal(await settledText(page, '#stat-teams'), String(before.teams + 1));
    assert.equal(await settledText(page, '#stat-matches'), String(before.matches));

    // Дубликат отклоняется
    await page.type('#new-team-name', 'зенит');
    await clickInView(page, '[data-form="add-team"] button[type="submit"]');
    assert.match(await textOf(page, '#team-form-error'), /уже есть/);

    // Клик по названию открывает карточку команды: добавляем игрока
    const newTeamId = await page.evaluate(() => {
        const team = window.FTApp.getData().teams.find((item) => item.name === 'Зенит');
        return team ? team.id : 0;
    });

    await clickInView(page, '#admin-teams-list [data-action="team-open"][data-id="' + newTeamId + '"]');
    assert.equal(await sectionVisible(page, 'admin-team-view'), true, 'открылась карточка команды');
    assert.equal(await sectionVisible(page, 'admin-team-list-view'), false, 'список команд скрылся');

    await page.type('#new-player-name', 'Тестовый Игрок');
    await clickInView(page, '[data-form="add-player"] button[type="submit"]');
    await page.waitForFunction(() => document.querySelectorAll('#admin-players-list .admin-card').length === 1);

    await clickInView(page, '[data-action="team-back"]');
    assert.equal(await sectionVisible(page, 'admin-team-list-view'), true, 'кнопка «Все команды» вернула список');

    // Переходим в раздел «Матчи»: список матчей и форма добавления находятся там
    await page.click('[data-admin-tab="matches"]');
    assert.equal(await sectionVisible(page, 'admin-panel-matches'), true);
    assert.equal(await sectionVisible(page, 'admin-panel-teams'), false, 'раздел «Команды» скрылся');

    // Добавляем матч без счёта
    const firstTeamId = await page.evaluate(() => window.FTApp.getData().teams[0].id);

    await page.select('#match-team-a', String(firstTeamId));
    await page.select('#match-team-b', String(newTeamId));
    await page.$eval('#match-date', (element) => {
        element.value = '2026-12-01';
    });
    await clickInView(page, '#match-submit');
    await page.waitForFunction((expected) => {
        return document.querySelectorAll('#admin-matches-list [data-action="match-open"]').length === expected;
    }, {}, before.matches + 1);

    const newMatchId = await page.evaluate(() => {
        const stored = JSON.parse(window.localStorage.getItem('footballTournamentData'));
        return stored.matches[stored.matches.length - 1].id;
    });

    // Клик по матчу открывает его карточку: счёт, составы и отметки голов
    await clickWhenReady(page, '#admin-matches-list [data-action="match-open"][data-id="' + newMatchId + '"]');
    assert.equal(await sectionVisible(page, 'admin-match-view'), true, 'открылась карточка матча');
    assert.equal(await sectionVisible(page, 'admin-match-list-view'), false, 'список матчей скрылся');

    await page.$eval('#score-a-' + newMatchId, (element) => {
        element.value = '2';
    });
    await page.$eval('#score-b-' + newMatchId, (element) => {
        element.value = '2';
    });
    await clickInView(page, '[data-action="match-save-score"]');

    await page.waitForFunction((matchId) => {
        const stored = JSON.parse(window.localStorage.getItem('footballTournamentData'));
        return stored.matches.find((match) => match.id === matchId).finished === true;
    }, {}, newMatchId);

    // Отмечаем гол игрока новой команды: иконка мяча становится активной
    const goalButton = '.event-btn[data-action="match-event"][data-team="' + newTeamId +
        '"][data-player="Тестовый Игрок"][data-type="goal"]';
    await clickInView(page, goalButton);

    await page.waitForFunction((matchId) => {
        const stored = JSON.parse(window.localStorage.getItem('footballTournamentData'));
        return stored.matches.find((match) => match.id === matchId).events.length === 1;
    }, {}, newMatchId);

    assert.deepEqual(await page.$eval(goalButton, (element) => ({
        active: element.classList.contains('is-active'),
        count: element.textContent.trim(),
        pressed: element.getAttribute('aria-pressed')
    })), { active: true, count: '1', pressed: 'true' }, 'гол записан и виден на иконке');

    // Возврат к списку матчей кнопкой «Все матчи»
    await clickInView(page, '[data-action="match-back"]');
    assert.equal(await sectionVisible(page, 'admin-match-list-view'), true, 'список матчей вернулся');

    // Отмеченный гол сразу виден на публичной странице «Лучшие бомбардиры»
    await page.click('[data-nav="players"]');
    assert.equal(await sectionVisible(page, 'page-players'), true, 'открылась страница лучших бомбардиров');

    const bestPlayers = await page.evaluate(() => {
        const row = Array.from(document.querySelectorAll('#players-body tr'))
            .find((element) => element.textContent.includes('Тестовый Игрок'));

        return row ? Array.from(row.querySelectorAll('td')).map((cell) => cell.textContent.trim()) : [];
    });

    assert.ok(bestPlayers.length > 0, 'игрок с голом попал в список');
    assert.deepEqual(bestPlayers.slice(3), ['1'], 'в таблице бомбардиров только голы');

    // Ничья 2:2 приносит по одному очку каждой команде
    const after = await dataSnapshot(page);
    assert.equal(after.points[firstTeamId], before.points[firstTeamId] + 1, 'очко первой команде');
    assert.equal(after.points[newTeamId], 1, 'очко новой команде');

    await page.click('[data-nav="standings"]');
    const zenitPoints = await page.evaluate(() => {
        const row = Array.from(document.querySelectorAll('#standings-body tr'))
            .find((element) => element.textContent.includes('Зенит'));
        return row ? Number(row.querySelector('td:last-child').textContent.trim()) : null;
    });
    assert.equal(zenitPoints, after.points[newTeamId], 'очки новой команды видны в таблице');

    // Данные переживают перезагрузку страницы
    await reloadApp(page);
    assert.equal(await settledText(page, '#stat-teams'), String(before.teams + 1));
    assert.equal(await settledText(page, '#stat-finished'), String(before.finished + 1));

    // Выход из админки
    await page.click('[data-nav="admin"]');
    await page.click('[data-action="logout"]');
    await page.click('[data-nav="admin"]');
    assert.equal(await sectionVisible(page, 'page-admin-login'), true, 'после выхода нужен пароль снова');

    assert.deepEqual(problems, [], 'ошибок консоли нет');
    await page.close();
});

test('мобильное меню открывается и закрывается', { skip }, async () => {
    const { page, problems } = await openPage({ mobile: true });

    assert.equal(await page.$eval('#mobile-menu', (element) => element.classList.contains('hidden')), true);

    await page.click('[data-action="toggle-menu"]');
    assert.equal(await page.$eval('#mobile-menu', (element) => element.classList.contains('hidden')), false);
    assert.equal(await sectionVisible(page, 'page-home'), true, 'до перехода остаёмся на той же странице');

    await page.click('#mobile-menu [data-nav="teams"]');
    assert.equal(await sectionVisible(page, 'page-teams'), true);
    assert.equal(await page.$eval('#mobile-menu', (element) => element.classList.contains('hidden')), true, 'меню закрылось');

    const active = await page.$eval('#mobile-menu [data-nav="teams"]', (element) => element.classList.contains('active'));
    assert.equal(active, true, 'активный пункт подсвечен и в мобильном меню');

    assert.deepEqual(problems, []);
    await page.close();
});

/**
 * Телефон, страница «Все игроки»: столбец «Команда» скрыт целиком — и в шапке, и в ячейках, —
 * а команда выводится строкой под именем игрока. Освободившееся место отдано имени: раньше
 * заголовок «Команда» оставался в шапке без класса .col-optional, держал свои 86 пикселей и
 * сжимал имя до переноса каждого слова на отдельную строку — фамилия с именем вставали столбиком.
 */
test('телефон: в таблице «Все игроки» имя игрока читается в строку', { skip }, async () => {
    const { page, problems } = await openPage({ mobile: true, isolated: true });

    await page.evaluate(() => { window.location.hash = '#/allplayers'; });
    await page.waitForFunction(() => document.querySelectorAll('#all-players-body tr').length > 5);

    const view = await page.evaluate(() => {
        const table = document.querySelector('#page-allplayers table');
        const rows = Array.from(document.querySelectorAll('#all-players-body tr'));

        return {
            headers: Array.from(document.querySelectorAll('#all-players-head th')).map((cell) => ({
                title: cell.textContent.replace(/[↕↑↓]/g, '').trim(),
                width: Math.round(cell.getBoundingClientRect().width)
            })),
            names: rows.map((row) => {
                const name = row.querySelector('.player-name');
                const box = name.getBoundingClientRect();

                return name.textContent + ' — строк ' +
                    Math.round(box.height / parseFloat(getComputedStyle(name).lineHeight));
            }),
            teamsUnderNames: rows.filter((row) => row.querySelector('.row-detail').textContent.trim()).length,
            overflow: Math.round(table.getBoundingClientRect().width - table.parentElement.clientWidth)
        };
    });

    const team = view.headers.filter((cell) => cell.title === 'Команда')[0];

    assert.equal(team.width, 0, 'столбец «Команда» скрыт в шапке так же, как в ячейках');
    assert.deepEqual(view.headers.filter((cell) => cell.width > 0).map((cell) => cell.title),
        ['Игрок', 'Г', 'Ж', 'К'], 'на телефоне остаются имя игрока, голы и карточки');
    assert.ok(view.names.every((name) => name.endsWith('строк 1')), 'имена не переносятся: ' + view.names.join('; '));
    assert.equal(view.teamsUnderNames, view.names.length, 'команда выводится под именем игрока');
    assert.equal(view.overflow, 0, 'таблица не вылезает за край экрана');

    assert.deepEqual(problems.filter((item) => !item.includes('Failed to load resource')), []);
    await page.close();
});

test('сайт работает из подпапки — как на GitHub Pages для репозитория', { skip }, async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-pages-'));
    fs.symlinkSync(ROOT, path.join(tempRoot, 'repo'), 'dir');

    const subServer = createServer(tempRoot);

    await new Promise((resolve) => subServer.listen(0, '127.0.0.1', resolve));

    const subUrl = 'http://127.0.0.1:' + subServer.address().port + '/repo/';

    // Этот тест идёт в отдельном браузере: так он не зависит от состояния,
    // которое накопили предыдущие тесты (страницы, контексты, кэш).
    const ownBrowser = await puppeteer.launch({
        executablePath: CHROME,
        headless: true,
        args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage']
    });

    const sharedBrowser = browser;
    browser = ownBrowser;

    try {
        const { page, problems } = await openPage({ url: subUrl });
        const data = await dataSnapshot(page);
        const skin = await themeLook(page);

        assert.equal(await settledText(page, '#stat-teams'), String(data.teams), 'данные загрузились из подпапки');
        assert.equal(await page.$$eval('#standings-body tr', (rows) => rows.length), data.teams);
        assert.equal(await page.$eval('body', (element) => getComputedStyle(element).backgroundColor), skin.body,
            'стили применились и из подпапки');

        // Файла данных по адресу макета в этой подпапке нет — браузер сообщает об этом в консоли,
        // это ожидаемо: приложение берёт data.json от самого сайта. Проверяем отсутствие других проблем.
        const meaningful = problems.filter((item) => !item.includes('Failed to load resource'));
        assert.deepEqual(meaningful, [], 'все ресурсы сайта найдены по относительным путям');

        await page.close();
    } finally {
        browser = sharedBrowser;
        await ownBrowser.close();
        await new Promise((resolve) => subServer.close(resolve));
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('статические файлы отдаются с нужными типами, неизвестный адрес — 404.html', { skip }, async () => {
    const resources = [
        ['/assets/css/tailwind.css', 'text/css'],
        ['/assets/js/logic.js', 'text/javascript'],
        ['/assets/js/app.js', 'text/javascript'],
        ['/assets/fonts/roboto-cyrillic.woff2', 'font/woff2'],
        ['/assets/favicon.svg', 'image/svg+xml'],
        ['/assets/favicon.ico', 'image/x-icon'],
        ['/assets/apple-touch-icon.png', 'image/png'],
        ['/assets/og-image.png', 'image/png'],
        ['/Problem/fon.jpg', 'image/jpeg'],
        ['/Problem/fontel.jpg', 'image/jpeg'],
        ['/robots.txt', 'text/plain']
    ];

    for (const [url, expectedType] of resources) {
        const response = await fetch(baseUrl + url);
        const contentType = response.headers.get('content-type') || '';

        assert.equal(response.status, 200, 'код ответа для ' + url);
        assert.ok(contentType.includes(expectedType), 'тип для ' + url + ': получен ' + contentType);
    }

    // Фон сайта подключён в стилях и виден как отдельный слой под содержимым
    const css = await (await fetch(baseUrl + '/assets/css/tailwind.css')).text();

    assert.match(css, /url\([^)]*Problem\/fon\.jpg\)/, 'в стилях есть картинка фона');

    const checker = await openPage({ url: baseUrl + '/' });
    const layer = await checker.page.evaluate(() => getComputedStyle(document.body, '::before').backgroundImage);

    assert.match(layer, /Problem\/fon\.jpg/, 'фон применяется к странице: ' + layer);

    const backgroundProblems = checker.problems.filter((item) => !item.includes('Failed to load resource'));

    assert.deepEqual(backgroundProblems, [], 'фон не ломает загрузку страницы');
    await checker.close();

    const missing = await fetch(baseUrl + '/такой-страницы-нет/');
    assert.equal(missing.status, 404);
    assert.match(await missing.text(), /Страница не найдена/);

    const robots = await (await fetch(baseUrl + '/robots.txt')).text();
    assert.match(robots, /User-agent: \*/);
});

test('синхронизация: посетитель видит данные репозитория, администратор публикует для всех', { skip }, async () => {
    // Готовим «репозиторий»: данные турнира + один клуб из общего хранилища
    const remote = JSON.parse(fs.readFileSync(path.join(ROOT, 'data.json'), 'utf8'));
    remote.updatedAt = '2026-09-10T09:15:00.000Z';
    remote.revision = 4;
    remote.teams.push({ id: 42, name: 'Клуб из репозитория', players: [] });

    mockRepository.state.data = remote;
    mockRepository.state.sha = 'sha-1';
    mockRepository.state.commits.length = 0;

    // 1. Посетитель открывает сайт с другого устройства — данные приходят из репозитория
    const visitor = await openPage({ url: mockBaseUrl + '/', isolated: true });

    assert.equal(await settledText(visitor.page, '#stat-teams'), String(remote.teams.length));
    assert.match(await textOf(visitor.page, '#teams-grid'), /Клуб из репозитория/);
    assert.match(await textOf(visitor.page, '#data-freshness'), /Данные обновлены: 10 сентября 2026/);
    assert.equal(await visitor.page.evaluate(() => window.FTApp.sync.state.lastSource), 'api',
        'страница только открылась — данные берём из Contents API (кэш в минуту, а не 10 минут)');
    assert.equal(await visitor.page.evaluate(() => window.sessionStorage.getItem('ft.buildReloaded')), null,
        'версия файлов та же — перезагружать страницу незачем');
    assert.deepEqual(visitor.problems, []);
    assert.deepEqual(await visitor.page.evaluate(() => window.__cspViolations), []);
    await visitor.close();

    // 2. Администратор публикует новый клуб
    const admin = await openPage({ url: mockBaseUrl + '/', isolated: true });

    await clickWhenReady(admin.page, '[data-nav="admin"]');
    await admin.page.type('#admin-password', ADMIN.password);
    await clickWhenReady(admin.page, '[data-form="login"] button[type="submit"]');
    await admin.page.waitForFunction(() => window.FTApp && window.FTApp.isAdmin());

    // Блок «Настройки» скрыт по умолчанию — открываем его кнопкой в шапке панели
    await clickInView(admin.page, '[data-action="toggle-settings"]');
    await admin.page.type('#github-token', 'test-token');
    await clickInView(admin.page, '[data-action="github-save-token"]');
    await admin.page.waitForFunction(() => document.getElementById('github-token').placeholder.includes('сохранён'));

    await admin.page.type('#new-team-name', 'Опубликовано из админки');
    await clickInView(admin.page, '[data-form="add-team"] button[type="submit"]');
    await admin.page.waitForFunction((expected) => {
        return document.querySelectorAll('#admin-teams-list [data-action="team-open"]').length === expected;
    }, {}, remote.teams.length + 1);

    await clickInView(admin.page, '[data-action="github-publish"]');
    await admin.page.waitForFunction(() => document.getElementById('sync-status').textContent.includes('Опубликовано'));

    assert.equal(mockRepository.state.commits.length, 1, 'создан один коммит');
    assert.equal(mockRepository.state.data.teams.length, remote.teams.length + 1);
    assert.equal(mockRepository.state.data.teams.some((team) => team.name === 'Опубликовано из админки'), true);

    // Повторное нажатие «Опубликовать» без изменений не должно показывать ошибку
    // (раньше в такой ситуации появлялось тревожное сообщение про «версию из репозитория»)
    await clickInView(admin.page, '[data-action="github-publish"]');
    await admin.page.waitForFunction(
        () => !document.getElementById('sync-status').textContent.includes('Публикуем')
    );

    const repeatStatus = await textOf(admin.page, '#sync-status');
    assert.equal(repeatStatus.includes('Не удалось опубликовать'), false, 'ошибки нет');
    assert.match(repeatStatus, /Опубликовано/);
    assert.equal(mockRepository.state.commits.length, 1, 'лишний коммит не создан');

    assert.deepEqual(admin.problems, []);
    await admin.close();

    // 3. «Другое устройство»: чистое хранилище — данные должны прийти из репозитория
    const otherContext = await createIsolatedContext();
    const otherPage = await otherContext.newPage();

    await otherPage.evaluateOnNewDocument((config) => {
        window.FT_CONFIG = config;
    }, SITE_CONFIG);

    await gotoApp(otherPage, mockBaseUrl + '/');

    assert.equal(await settledText(otherPage, '#stat-teams'), String(remote.teams.length + 1), 'другое устройство получило опубликованные данные');
    assert.match(await textOf(otherPage, '#teams-grid'), /Опубликовано из админки/);

    // Время в подвале — это момент публикации из репозитория, а не «сейчас» на этом устройстве.
    // Сравниваем не с конкретной датой (иначе тест ломается в другой месяц), а с тем, что опубликовано.
    const publishedLabel = await otherPage.evaluate(
        (iso) => window.FTLogic.formatDateTime(iso),
        mockRepository.state.data.updatedAt
    );
    const freshness = await textOf(otherPage, '#data-freshness');

    assert.match(freshness, /^Данные обновлены: /, 'в подвале видно время обновления');
    assert.equal(freshness.indexOf(publishedLabel) > -1, true,
        'другое устройство видит время публикации из репозитория: ' + publishedLabel);

    await otherPage.close();
    await otherContext.close();
});

test('новая версия сайта: открытая страница обновляется сама, но не по кругу', { skip }, async () => {
    /*
     * Так выглядит телефон, у которого вкладка открыта со вчерашнего дня: файлы в
     * памяти старые, а на сайте уже выложены новые. Подменяем только ответ на
     * разметку страницы — остальная сеть работает как обычно.
     */
    const nextVersion = 999;
    const context = await createIsolatedContext();
    const page = await context.newPage();
    const problems = [];

    page.on('pageerror', (error) => problems.push('Ошибка скрипта: ' + error.message));
    page.on('console', (message) => {
        if (message.type() === 'error') {
            problems.push('Консоль: ' + message.text());
        }
    });

    await page.evaluateOnNewDocument((config, version) => {
        window.FT_CONFIG = config;

        // Счётчик загрузок документа живёт в sessionStorage: при перезагрузке
        // страница начинается заново, и обычная переменная сбросилась бы
        window.sessionStorage.setItem('ft.probeLoads',
            String(Number(window.sessionStorage.getItem('ft.probeLoads') || '0') + 1));

        const realFetch = window.fetch;

        window.fetch = (url, init) => {
            if (String(url).indexOf('index.html') === 0) {
                return Promise.resolve(new Response(
                    '<!DOCTYPE html><html><head>' +
                        '<script src="assets/js/app.js?v=' + version + '" defer></script>' +
                    '</head><body></body></html>',
                    { headers: { 'Content-Type': 'text/html' } }
                ));
            }

            return realFetch(url, init);
        };
    }, SITE_CONFIG, nextVersion);

    await gotoApp(page, mockBaseUrl + '/');

    // Решение принимается после первых данных, перезагрузке предшествует короткая пауза
    let view = null;

    for (let attempt = 0; attempt < 48; attempt += 1) {
        try {
            view = await page.evaluate(() => ({
                loads: Number(window.sessionStorage.getItem('ft.probeLoads') || '0'),
                mark: window.sessionStorage.getItem('ft.buildReloaded'),
                pending: window.FTApp.build.state.pending
            }));

            if (view.loads >= 2) {
                break;
            }
        } catch (error) {
            // Страница перезагружается прямо сейчас: следующая попытка — уже в новой
        }

        await new Promise((resolve) => setTimeout(resolve, 250));
    }

    assert.ok(view, 'после перезагрузки страница отвечает снова');
    assert.equal(view.loads, 2, 'перезагрузка ровно одна: подменённая версия не гонит страницу по кругу');
    assert.equal(view.mark, String(nextVersion), 'версия отмечена в сессии — второй перезагрузки не будет');
    assert.equal(view.pending, 0, 'ожидание перезагрузки снято');
    assert.deepEqual(problems, [], 'перезагрузка не сопровождается ошибками');

    await page.close();
    await context.close();
});

test('фото игрока: настоящее сжатие в браузере, загрузка в репозиторий и аватар в составе', { skip }, async () => {
    const { page, problems } = await openPage({ url: mockBaseUrl + '/', isolated: true });

    // Диагностика: какие адреса отвечают 404
    const notFound = [];

    page.on('response', (response) => {
        if (response.status() === 404) {
            notFound.push(response.url());
        }
    });

    // 1. Вход администратора и токен публикации
    await clickWhenReady(page, '[data-nav="admin"]');
    await page.type('#admin-password', ADMIN.password);
    await clickWhenReady(page, '[data-form="login"] button[type="submit"]');
    await page.waitForFunction(() => window.FTApp && window.FTApp.isAdmin());

    await clickInView(page, '[data-action="toggle-settings"]');
    await page.type('#github-token', 'test-token');
    await clickInView(page, '[data-action="github-save-token"]');
    await page.waitForFunction(() => document.getElementById('github-token').placeholder.includes('сохранён'));

    // 2. Открываем первую команду: у игроков есть кнопка загрузки фото.
    // Сколько фото уже есть в данных — считаем заранее: в репозитории могут быть фото других игроков.
    await clickWhenReady(page, '#admin-teams-list [data-action="team-open"]');
    await page.waitForFunction(() => !!document.querySelector('#admin-players-list input[data-photo-team]'));

    const photosBefore = await page.evaluate(() => Object.keys(window.FTApp.getData().photos || {}).length);

    // 3. Отдаём настоящее изображение (4×4 PNG рисуется прямо в браузере)
    await page.evaluate(() => new Promise((resolve) => {
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d');

        canvas.width = 4;
        canvas.height = 4;
        context.fillStyle = '#1b5e20';
        context.fillRect(0, 0, 4, 4);

        canvas.toBlob((blob) => {
            const input = document.querySelector('#admin-players-list input[data-photo-team]');
            const transfer = new DataTransfer();

            transfer.items.add(new File([blob], 'photo.png', { type: 'image/png' }));
            input.files = transfer.files;
            input.dispatchEvent(new Event('change', { bubbles: true }));
            resolve(true);
        }, 'image/png');
    }));

    // 4. Дожидаемся предпросмотра загруженного фото и проверяем, что получилось.
    // Ждём именно наш предпросмотр (data:…), а не первую картинку в составе: у других
    // игроков фото могло быть и раньше, и обычная проверка сработала бы слишком рано.
    await page.waitForFunction(() => {
        const image = document.querySelector('#admin-players-list img.player-avatar');

        return !!image && image.getAttribute('src').indexOf('data:image/jpeg;base64,') === 0 &&
            image.complete && image.naturalWidth > 0;
    });

    const result = await page.evaluate(() => {
        const data = window.FTApp.getData();
        const previews = Object.keys(window.FTApp.getState().photoPreviews);
        const image = document.querySelector('#admin-players-list img.player-avatar');

        return {
            count: Object.keys(data.photos || {}).length,
            stored: Object.values(data.photos || {}),
            path: previews.length ? previews[previews.length - 1] : '',
            previews: previews,
            preview: image ? image.getAttribute('src').indexOf('data:image/jpeg;base64,') === 0 : false,
            width: image ? image.naturalWidth : 0,
            height: image ? image.naturalHeight : 0
        };
    });

    assert.ok(result.stored.includes(result.path), 'путь нового фото записан в данные');
    assert.ok(result.count >= photosBefore, 'прежние фото не потерялись');
    assert.match(result.path, /^assets\/photos\/[a-z0-9-]+-[0-9a-f]{6}\.jpg$/, 'имя файла безопасное и уникальное');
    assert.equal(result.previews.length, 1, 'предпросмотр ровно у загруженного фото');
    assert.equal(result.preview, true, 'показан локальный предпросмотр (сжатый JPEG)');
    assert.equal(result.width, result.height, 'фото приведено к квадрату');
    assert.ok(result.width > 200, 'сторона квадрата близка к настройке 512 (получилось: ' + result.width + ')');

    // 5. Файл действительно лежит в «репозитории», и коммит подписан понятно
    const file = mockRepository.state.files[result.path];

    assert.ok(file, 'файл загружен в репозиторий');
    assert.ok(file.content.length > 100, 'в репозиторий ушёл настоящий JPEG, а не заглушка');
    assert.match(mockRepository.state.commits.map((commit) => commit.message || '').join('|'), /Фото игрока/);

    // 6. Аватар виден и в публичном составе команды
    await clickWhenReady(page, '[data-nav="teams"]');
    await page.waitForFunction(() => !!document.querySelector('#teams-grid .chip-player img.player-avatar'));

    // Проверка «есть ли уже такой файл» штатно отвечает 404 — браузер пишет об этом в консоль.
    // Это и есть ожидаемый единственный ответ 404: значит, файл новый и sha не нужен.
    assert.equal(notFound.length, 1, 'лишние 404: ' + notFound.join(', '));
    assert.match(notFound[0], /\/mock-api\/repos\/test\/test\/contents\/assets\/photos\/[a-z0-9-]+\.jpg\?ref=main$/);

    const meaningful = problems.filter((item) => !item.includes('Failed to load resource'));

    assert.deepEqual(meaningful, [], 'нет ошибок консоли и сбоев загрузки');
    await page.close();
});

test('страница команды: из турнирной таблицы видно состав, статистику и матчи', { skip }, async () => {
    const { page, problems } = await openPage();

    await page.click('[data-nav="standings"]');

    // Берём команду, у которой точно есть матчи: содержимое data.json может меняться
    const target = await page.evaluate(() => {
        const data = window.FTApp.getData();
        const rows = Array.from(document.querySelectorAll('#standings-body tr[data-action="team-public-open"]'));

        for (const row of rows) {
            const id = Number(row.getAttribute('data-id'));
            const matches = window.FTLogic.teamMatches(data.matches, id);

            if (matches.length > 0) {
                return {
                    id: id,
                    name: row.querySelector('.team-name').textContent.trim(),
                    matches: matches.length
                };
            }
        }

        return null;
    });

    assert.ok(target, 'в таблице есть команда с матчами');

    await clickInView(page, '#standings-body tr[data-action="team-public-open"][data-id="' + target.id + '"]');

    // Открылась страница команды вместо списка
    assert.equal(await sectionVisible(page, 'page-teams'), true);
    assert.equal(await sectionVisible(page, 'team-detail-view'), true, 'показана страница команды');
    assert.equal(await sectionVisible(page, 'team-list-view'), false, 'список команд скрыт');
    assert.equal(await page.evaluate(() => window.location.hash), '#/team/' + target.id, 'у команды свой адрес');

    // На странице: название, статистика, состав и матчи именно этой команды
    assert.match(await textOf(page, '#team-detail'), new RegExp(target.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.equal(await page.$$eval('#team-detail .stat-box', (boxes) => boxes.length), 5, 'пять плиток статистики');
    assert.deepEqual(
        await page.$$eval('#team-detail .stat-label', (labels) => labels.map((item) => item.firstChild.textContent.trim())),
        ['Место', 'Очки', 'Игры', 'ГЗ', 'ГП'],
        'забитые и пропущенные мячи — отдельными плитками'
    );
    assert.ok(await page.$$eval('#team-detail .squad-toggle', (buttons) => buttons.length) > 0, 'состав свёрнут в кнопку');

    // Кнопка «Состав» раскрывает список игроков столбиком: имя, голы, карточки
    assert.equal(await page.$eval('#team-squad', (block) => block.hidden), true, 'список состава скрыт');

    await clickInView(page, '#team-detail [data-action="squad-toggle"]');

    assert.equal(await page.$eval('#team-squad', (block) => block.hidden), false, 'состав раскрылся по нажатию');
    assert.deepEqual(
        await page.$$eval('#team-squad thead th', (cells) => cells.map(
            (cell) => cell.textContent.replace(/[↕↑↓]/g, '').trim())),
        ['Игрок', 'Г', 'Ж', 'К'],
        'столбцы состава (без даты рождения)'
    );
    assert.ok(await page.$$eval('#team-squad tbody tr', (rows) => rows.length) > 0, 'игроки видны столбиком');
    assert.equal(await page.$eval('#team-detail [data-action="squad-toggle"]', (button) => button.getAttribute('aria-expanded')),
        'true', 'кнопка сообщает, что список открыт');
    assert.equal(await page.$$eval('#team-detail .match-card', (cards) => cards.length), target.matches, 'только её матчи');
    assert.equal(
        await page.$$eval('#team-detail .match-card .team-link', (links) => links.length),
        target.matches * 2,
        'в матчах команды названия команд — ссылки'
    );

    // Из страницы команды открывается детальный результат матча
    await clickInView(page, '#team-detail [data-action="match-public-open"]');
    assert.equal(await sectionVisible(page, 'match-detail-view'), true, 'открылся детальный результат матча');

    // И обратно к списку команд
    await page.click('[data-nav="teams"]');
    assert.equal(await sectionVisible(page, 'team-list-view'), true, 'вернулись к списку команд');
    assert.equal(await sectionVisible(page, 'team-detail-view'), false);

    assert.deepEqual(problems, [], 'нет ошибок консоли и сбоев загрузки');
    await page.close();
});

test('кнопка «Назад» возвращает на предыдущую страницу', { skip }, async () => {
    const { page, problems } = await openPage();
    // На старте возвращаться некуда
    assert.equal(await sectionVisible(page, 'back-button'), false, 'кнопка скрыта');

    // Таблица → команда: кнопка знает, куда вернуться
    await page.click('[data-nav="standings"]');
    assert.equal(await sectionVisible(page, 'back-button'), true, 'кнопка появилась');
    assert.match(await page.$eval('#back-button', (el) => el.getAttribute('aria-label') || ''), /Главная/);

    const teamId = await page.$eval('#standings-body tr[data-action="team-public-open"]',
        (row) => row.getAttribute('data-id'));

    await clickInView(page, '#standings-body tr[data-action="team-public-open"][data-id="' + teamId + '"]');
    assert.equal(await sectionVisible(page, 'team-detail-view'), true, 'открылась страница команды');
    assert.match(await page.$eval('#back-button', (el) => el.getAttribute('aria-label') || ''), /Таблица/);

    await clickInView(page, '[data-action="go-back"]');
    assert.equal(await sectionVisible(page, 'page-standings'), true, 'вернулись в турнирную таблицу');
    assert.equal(await page.evaluate(() => window.location.hash), '#/standings');

    // И ещё раз — на главную: история пуста, кнопка снова скрыта
    await clickInView(page, '[data-action="go-back"]');
    assert.equal(await sectionVisible(page, 'page-home'), true, 'вернулись на главную');
    assert.equal(await sectionVisible(page, 'back-button'), false, 'история пуста — кнопки нет');

    assert.deepEqual(problems, [], 'нет ошибок консоли и сбоев загрузки');
    await page.close();
});

test('эмблема команды: загрузка из админки, сжатие и показ в турнирной таблице', { skip }, async () => {
    const { page, problems } = await openPage({ url: mockBaseUrl + '/', isolated: true });

    // Диагностика: какие адреса отвечают 404
    const notFound = [];

    page.on('response', (response) => {
        if (response.status() === 404) {
            notFound.push(response.url());
        }
    });

    // Вход и токен публикации
    await clickWhenReady(page, '[data-nav="admin"]');
    await page.type('#admin-password', ADMIN.password);
    await clickWhenReady(page, '[data-form="login"] button[type="submit"]');
    await page.waitForFunction(() => window.FTApp && window.FTApp.isAdmin());

    await clickInView(page, '[data-action="toggle-settings"]');
    await page.type('#github-token', 'test-token');
    await clickInView(page, '[data-action="github-save-token"]');
    await page.waitForFunction(() => document.getElementById('github-token').placeholder.includes('сохранён'));

    // Эмблемы есть уже у многих команд, поэтому берём команду без эмблемы:
    // тогда запись действительно добавляется, а не заменяет прежнюю
    const logosBefore = await page.evaluate(() => {
        const data = window.FTApp.getData();
        const photos = data.teamPhotos || {};
        const withoutLogo = data.teams.filter((team) => !photos[String(team.id)]);

        return {
            count: Object.keys(photos).length,
            teamId: (withoutLogo[0] || data.teams[0]).id,
            replaces: withoutLogo.length === 0
        };
    });

    // Открываем выбранную команду: в карточке есть загрузка эмблемы
    await clickInView(page, '#admin-teams-list [data-action="team-open"][data-id="' + logosBefore.teamId + '"]');
    await page.waitForFunction(() => !!document.querySelector('#admin-team-photo input[data-photo-kind="team"]'));

    // Отдаём настоящее изображение (6×6 PNG рисуется в браузере)
    await page.evaluate(() => new Promise((resolve) => {
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d');

        canvas.width = 6;
        canvas.height = 6;
        context.fillStyle = '#1b5e20';
        context.fillRect(0, 0, 6, 6);

        canvas.toBlob((blob) => {
            const input = document.querySelector('#admin-team-photo input[data-photo-kind="team"]');
            const transfer = new DataTransfer();

            transfer.items.add(new File([blob], 'logo.png', { type: 'image/png' }));
            input.files = transfer.files;
            input.dispatchEvent(new Event('change', { bubbles: true }));
            resolve(true);
        }, 'image/png');
    }));

    await page.waitForFunction(() => {
        const image = document.querySelector('#admin-team-photo img.team-photo');

        // Ждём предпросмотр из памяти: файл на сайте появится позже
        return !!image && image.getAttribute('src').indexOf('data:image/jpeg;base64,') === 0 &&
            image.complete && image.naturalWidth > 0;
    });

    const result = await page.evaluate((teamId) => {
        const data = window.FTApp.getData();
        const team = data.teams.filter((item) => String(item.id) === String(teamId))[0];
        const image = document.querySelector('#admin-team-photo img.team-photo');

        return {
            count: Object.keys(data.teamPhotos || {}).length,
            path: team ? (data.teamPhotos[String(team.id)] || '') : '',
            previews: Object.keys(window.FTApp.getState().photoPreviews).length,
            width: image ? image.naturalWidth : 0
        };
    }, logosBefore.teamId);

    assert.equal(result.count, logosBefore.replaces ? logosBefore.count : logosBefore.count + 1,
        'эмблема записана в данные');
    assert.match(result.path, /^assets\/photos\/team-[a-z0-9-]+-[0-9a-f]{6}\.jpg$/, 'имя файла эмблемы');
    assert.equal(result.previews, 1, 'предпросмотр эмблемы');
    assert.equal(result.width, 512, 'эмблема сжата до квадрата 512');
    assert.ok(mockRepository.state.files[result.path], 'файл эмблемы в репозитории');

    // Эмблема видна в турнирной таблице (из памяти, не дожидаясь публикации файла)
    await clickWhenReady(page, '[data-nav="standings"]');
    await page.waitForFunction(() => {
        const images = Array.from(document.querySelectorAll('#standings-body img.team-photo'));

        return images.some((image) => image.getAttribute('src').indexOf('data:image/jpeg;base64,') === 0);
    });

    // И она действительно отрисована, а не спрятана стилями: сначала эмблема, потом название
    const logoBox = await page.evaluate(() => {
        const images = Array.from(document.querySelectorAll('#standings-body img.team-photo'));
        const image = images.filter((item) => item.getAttribute('src').indexOf('data:image/jpeg;base64,') === 0)[0];
        const box = image ? image.getBoundingClientRect() : { width: 0, height: 0 };

        return {
            width: Math.round(box.width),
            height: Math.round(box.height),
            first: image ? image.parentNode.firstElementChild === image : false
        };
    });

    assert.ok(logoBox.width > 0 && logoBox.height > 0,
        'эмблема в турнирной таблице не скрыта стилями: ' + logoBox.width + 'x' + logoBox.height);
    assert.equal(logoBox.first, true, 'сначала эмблема, потом название команды');

    // Проверка «есть ли уже такой файл» штатно отвечает 404 — браузер пишет об этом в консоль.
    // В ответах 404 есть и запрос про файл эмблемы (значит, файл новый и sha не нужен).
    // Остальные 404 — фото из макетного репозитория: их «отдаёт» репозиторий, а на диске сайта
    // их нет (в жизни такие файлы лежат в репозитории рядом с сайтом и отдаются нормально).
    assert.equal(notFound.some((url) => /\/contents\/assets\/photos\/team-/.test(url)), true,
        'не было проверки файла эмблемы: ' + notFound.join(', '));

    const unexpected = notFound.filter((url) => url.indexOf('/assets/photos/') === -1);

    assert.deepEqual(unexpected, [], 'неожиданные 404: ' + unexpected.join(', '));

    const meaningful = problems.filter((item) => !item.includes('Failed to load resource'));

    assert.deepEqual(meaningful, [], 'нет других ошибок консоли и сбоев загрузки');
    await page.close();
});

/**
 * Так выглядит устройство, открывшее сайт раньше, чем GitHub Pages опубликовал файл:
 * путь к фото уже есть в данных, а сам файл ещё отвечает 404 (и этот ответ браузер
 * запоминает на 10 минут). Приложение должно само повторить загрузку картинки,
 * а если файл так и не появился — показать инициалы вместо «сломанной» картинки.
 */
test('фото, которого нет на сайте: повторные попытки загрузки и инициалы вместо сломанной картинки', { skip }, async () => {
    const before = mockRepository.state.data;
    const withPendingPhoto = JSON.parse(JSON.stringify(before));
    const team = withPendingPhoto.teams[0];
    const player = team.players[0];
    const pending = 'assets/photos/pending-abc123.jpg';

    withPendingPhoto.photos = {};
    withPendingPhoto.photos[team.id + '|' + player.toLowerCase()] = pending;
    mockRepository.changeExternally(withPendingPhoto);

    // Файла с таким именем на диске сайта нет — как и у ещё не опубликованного фото
    const { page, problems } = await openPage({
        url: mockBaseUrl + '/',
        isolated: true,
        config: Object.assign({}, SITE_CONFIG, { photo: { retryDelays: [900, 900, 900] } })
    });

    const failed = [];

    page.on('response', (response) => {
        if (response.status() === 404 && response.url().includes('pending-abc123.jpg')) {
            failed.push(response.url());
        }
    });

    assert.equal(await page.evaluate((path) => Object.values(window.FTApp.getData().photos || {}).includes(path),
        pending), true, 'путь к фото пришёл из репозитория');

    // Фото из заявки видно в списке команд
    await clickWhenReady(page, '[data-nav="teams"]');

    // Ждём, пока приложение исчерпает попытки и покажет инициалы
    await page.waitForFunction((name) => {
        const chip = Array.from(document.querySelectorAll('#teams-grid .chip-player'))
            .find((item) => item.textContent.includes(name));

        return !!chip && !!chip.querySelector('.player-avatar-empty');
    }, { timeout: 20000 }, player);

    const view = await page.evaluate((name) => {
        const chip = Array.from(document.querySelectorAll('#teams-grid .chip-player'))
            .find((item) => item.textContent.includes(name));

        return {
            broken: !!chip.querySelector('img.player-avatar'),
            initials: (chip.querySelector('.player-avatar-empty') || {}).textContent || ''
        };
    }, player);

    assert.equal(view.broken, false, 'сломанная картинка не осталась');
    assert.match(view.initials, /^[А-ЯЁA-Z]{1,3}$/, 'показаны инициалы игрока');
    assert.ok(failed.length >= 2, 'картинка запрашивалась повторно: ' + failed.join(', '));
    assert.equal(failed.some((url) => url.includes('?t=')), true, 'повтор с обходом кэша: ' + failed.join(', '));

    const meaningful = problems.filter((item) => !item.includes('Failed to load resource'));

    assert.deepEqual(meaningful, [], 'нет других ошибок консоли и сбоев загрузки');

    // Возвращаем данные макета для остальных тестов
    mockRepository.changeExternally(before);
    await page.close();
});
test('карточка игрока: имя ведёт на карточку, администратор заполняет номер и принадлежность', { skip }, async () => {
    const { page, problems } = await openPage({ url: mockBaseUrl + '/', isolated: true });

    // 1. В списке команд имя игрока — ссылка на его карточку
    await clickWhenReady(page, '[data-nav="teams"]');
    await page.waitForFunction(() => !!document.querySelector('#teams-grid .chip-player[data-action="player-public-open"]'));

    const link = await page.evaluate(() => {
        const element = document.querySelector('#teams-grid .chip-player[data-action="player-public-open"]');

        return {
            hash: element.getAttribute('href'),
            text: element.textContent.replace(/\s+/g, ' ').trim()
        };
    });

    assert.match(link.hash, /^#\/player\/\d+\/\d+$/, 'адрес карточки игрока');
    assert.match(link.text, /\S/, 'в ссылке видно имя игрока');

    await clickInView(page, '#teams-grid .chip-player[data-action="player-public-open"]');
    await page.waitForFunction(() => !!document.querySelector('#player-card .player-card-head'));

    const opened = await page.evaluate(() => {
        const box = document.getElementById('player-card');

        return {
            hash: window.location.hash,
            active: document.querySelector('.page-section.active').id,
            name: box.querySelector('h2').textContent,
            photo: !!box.querySelector('.player-avatar-xl'),
            team: box.querySelector('a.team-link .team-name').textContent,
            hasBirthLine: box.textContent.includes('Дата рождения'),
            hasNote: !!box.querySelector('.player-note-text'),
            stats: box.textContent.includes('В турнире: голы —')
        };
    });

    assert.equal(opened.hash, link.hash, 'страница игрока со своим адресом');
    assert.equal(opened.active, 'page-player', 'показана страница игрока');
    assert.match(opened.name, /\S/);
    assert.equal(opened.photo, true, 'крупное фото игрока');
    assert.match(opened.team, /\S/, 'видна команда игрока');
    assert.equal(opened.hasBirthLine, false, 'даты рождения на карточке больше нет');
    assert.equal(opened.hasNote, true, 'видна принадлежность');
    assert.equal(opened.stats, true, 'видна статистика игрока');

    // «Назад» возвращает в список команд
    await clickInView(page, '[data-action="go-back"]');
    assert.equal(await sectionVisible(page, 'page-teams'), true, 'вернулись в список команд');

    // 2. Администратор: вход, карточка игрока, заполнение данных.
    // Вход повторяем: клик по меню может попасть в момент перерисовки страницы
    for (let attempt = 1; attempt <= 3; attempt += 1) {
        if (await page.evaluate(() => window.FTApp.isAdmin())) {
            break;
        }

        await clickWhenReady(page, '[data-nav="admin"]');
        await page.waitForSelector('#admin-password', { visible: true });
        await page.$eval('#admin-password', (input) => {
            input.value = '';
        });
        await page.type('#admin-password', ADMIN.password);
        await clickWhenReady(page, '[data-form="login"] button[type="submit"]');
        await page.waitForFunction(() => window.FTApp.isAdmin(), { timeout: 5000 }).catch(() => {});
    }

    assert.equal(await page.evaluate(() => window.FTApp.isAdmin()), true, 'вход выполнен');

    await clickInView(page, '[data-action="toggle-settings"]');
    await page.type('#github-token', 'test-token');
    await clickInView(page, '[data-action="github-save-token"]');
    await page.waitForFunction(() => document.getElementById('github-token').placeholder.includes('сохранён'));

    // Открываем форму данных игрока в админке: раздел «Команды» → карточка команды → кнопка у игрока.
    // На самой карточке игрока кнопок редактирования нет — данные заполняет только администратор.
    const parts = link.hash.replace('#/player/', '').split('/');

    await page.waitForFunction(() => !!document.querySelector('#admin-teams-list [data-action="team-open"]'));
    await clickInView(page, '#admin-teams-list [data-action="team-open"][data-id="' + parts[0] + '"]');
    await page.waitForFunction(() => !!document.querySelector('#admin-players-list [data-action="player-info-open"]'));
    await clickInView(page, '#admin-players-list [data-action="player-info-open"][data-index="' + parts[1] + '"]');

    await page.waitForFunction(() => !!document.getElementById('player-note'));

    const cardActions = await page.evaluate(() => {
        const box = document.getElementById('player-card');

        return Array.from(box.querySelectorAll('[data-action]')).map((element) => element.getAttribute('data-action'));
    });

    assert.deepEqual(cardActions, ['team-public-open'], 'на карточке игрока только ссылка на команду');

    const limits = await page.evaluate(() => ({
        maxLength: document.getElementById('player-note').getAttribute('maxlength'),
        birthField: document.getElementById('player-birth-date'),
        maxNumber: document.getElementById('player-number').getAttribute('max'),
        minNumber: document.getElementById('player-number').getAttribute('min'),
        admin: document.querySelector('.page-section.active').id
    }));

    assert.equal(limits.admin, 'page-admin-dashboard', 'открылась админка с формой данных игрока');
    assert.equal(limits.maxLength, '200', 'длина принадлежности ограничена 200 символами');
    assert.equal(limits.birthField, null, 'поля «дата рождения» в форме больше нет');
    assert.equal(limits.maxNumber, '99', 'игровой номер ограничен 99');
    assert.equal(limits.minNumber, '0', 'и отрицательные номера не принимаются');

    const note = 'Школа №5, первый тренер — Петров И. С 2023 года играет за «Добрик».';

    await page.$eval('#player-number', (input) => {
        input.value = '';
    });
    await page.type('#player-number', '7');
    await page.type('#player-note', note);
    await page.click('[data-form="player-info"] button[type="submit"]');

    await page.waitForFunction(() => document.getElementById('toast-container').textContent.includes('сохранены'));

    const saved = await page.evaluate((hash) => {
        const parts = hash.replace('#/player/', '').split('/');
        const data = window.FTApp.getData();
        const team = data.teams.find((item) => String(item.id) === parts[0]);
        const player = team ? team.players[Number(parts[1])] : '';
        const key = parts[0] + '|' + String(player).toLowerCase();

        return { key: key, player: player, value: (data.playerInfo || {})[key] || null };
    }, link.hash);

    assert.deepEqual(saved.value, { note: note, number: 7 },
        'игровой номер и принадлежность сохранены (' + saved.key + ')');

    // 3. Данные и номер видны на публичной карточке игрока
    await page.evaluate((hash) => {
        window.location.hash = hash;
    }, link.hash);
    await page.waitForFunction(() => document.getElementById('player-card').textContent.includes('Школа №5'));

    const shown = await page.evaluate(() => document.getElementById('player-card').textContent);

    assert.match(shown, /Школа №5, первый тренер/, 'принадлежность видна на карточке');

    const cardNumber = await page.evaluate(() => {
        const badge = document.querySelector('#player-card .player-number');

        return badge ? { text: badge.textContent, title: badge.getAttribute('title') } : null;
    });

    assert.deepEqual(cardNumber, { text: '7', title: 'Игровой номер: 7' },
        'игровой номер виден рядом с именем на карточке игрока');

    // 4. Номер виден и в таблицах: страница «Все игроки» и состав на странице «Команды»
    await page.evaluate(() => {
        window.location.hash = '#/allplayers';
    });
    await page.waitForFunction((name) => Array.from(document.querySelectorAll('#all-players-body tr'))
        .some((row) => row.textContent.includes(name) && row.querySelector('.player-number')), {}, saved.player);

    const rowView = await page.evaluate((name) => {
        const row = Array.from(document.querySelectorAll('#all-players-body tr'))
            .find((item) => item.textContent.includes(name));
        const badge = row.querySelector('.player-number');
        const style = window.getComputedStyle(badge);

        return {
            text: badge.textContent,
            display: style.display,
            background: style.backgroundColor,
            width: badge.offsetWidth,
            height: badge.offsetHeight
        };
    }, saved.player);

    assert.equal(rowView.text, '7', 'номер виден в таблице «Все игроки»');
    // Плашка лежит внутри flex-строки, поэтому браузер «блокифицирует» inline-flex → flex
    assert.match(rowView.display, /^(inline-)?flex$/, 'плашка номера отрисована стилями сайта');
    assert.notEqual(rowView.background, 'rgba(0, 0, 0, 0)', 'у плашки есть фон — номер хорошо читается');
    assert.ok(rowView.width > 0 && rowView.height > 0, 'плашка занимает место на экране, а не скрыта');

    await page.evaluate(() => {
        window.location.hash = '#/teams';
    });
    await page.waitForFunction((name) => Array.from(document.querySelectorAll('#teams-grid .chip-player'))
        .some((chip) => chip.textContent.includes(name) && chip.querySelector('.player-number')), {}, saved.player);

    const chipNumber = await page.evaluate((name) => {
        const chip = Array.from(document.querySelectorAll('#teams-grid .chip-player'))
            .find((item) => item.textContent.includes(name));

        return chip.querySelector('.player-number').textContent;
    }, saved.player);

    assert.equal(chipNumber, '7', 'номер виден рядом с именем игрока в списке команд');

    const meaningful = problems.filter((item) => !item.includes('Failed to load resource'));

    assert.deepEqual(meaningful, [], 'нет ошибок консоли и сбоев загрузки');
    await page.close();
});


/**
 * Посетителю не нужно ничего нажимать: пока вкладка открыта, страница сама
 * подтягивает свежую версию из репозитория. Здесь это проверяется «как в жизни»:
 * другая вкладка (администратор) публикует новую команду, а эта страница ничего не нажимает.
 */
test('автообновление: страница зрителя сама подхватывает новые данные', { skip }, async () => {
    const remote = JSON.parse(fs.readFileSync(path.join(ROOT, 'data.json'), 'utf8'));

    remote.updatedAt = '2026-09-10T09:15:00.000Z';
    remote.revision = 4;
    mockRepository.changeExternally(remote);

    const { page, problems } = await openPage({
        url: mockBaseUrl + '/',
        isolated: true,
        // В жизни это минута; для теста — доли секунды
        config: Object.assign({}, SITE_CONFIG, { refreshIntervalMs: 600 })
    });

    assert.equal(await page.evaluate(() => window.FTApp.getData().teams.some(
        (team) => team.name === 'Клуб из автообновления')), false, 'пока новых данных нет');

    // «Другой администратор» нажал «Опубликовать сейчас»
    const updated = JSON.parse(JSON.stringify(remote));

    updated.teams.push({ id: 77, name: 'Клуб из автообновления', players: [] });
    updated.revision = remote.revision + 1;
    updated.updatedAt = '2026-09-21T12:00:00.000Z';
    mockRepository.changeExternally(updated);

    // Ни одного нажатия: ждём, пока страница обновится сама
    await page.waitForFunction(
        () => document.getElementById('teams-grid').textContent.includes('Клуб из автообновления'),
        { timeout: 20000 }
    );
    await page.waitForFunction(() => document.getElementById('toast-container').textContent.includes('автоматически'));

    const view = await page.evaluate(() => ({
        freshness: document.getElementById('data-freshness').textContent
    }));
    const teamsCounter = await settledText(page, '#stat-teams');

    assert.match(view.freshness, /Данные обновлены: 21 сентября 2026/);
    assert.match(view.freshness, /обновляется автоматически/, 'в подвале видно, что обновление автоматическое');
    assert.equal(teamsCounter, String(updated.teams.length), 'счётчики пересчитаны');

    // Возвращаем данные макета для других тестов
    mockRepository.changeExternally(remote);

    const meaningful = problems.filter((item) => !item.includes('Failed to load resource'));

    assert.deepEqual(meaningful, [], 'нет ошибок консоли и сбоев загрузки');
    await page.close();
});

/**
 * Фотографии команды: администратор загружает снимок в настройках команды, посетитель
 * видит его в блоке на странице команды и может открыть на весь экран без потери качества
 * (фото сохраняется с пропорциями и крупной длинной стороной, а в просмотре показывается
 * тот же файл целиком).
 */
test('фотографии команды: загрузка из админки, блок на странице и просмотр на весь экран', { skip }, async () => {
    // Данные макета сохраняем: тест добавляет фотографию и публикует её (макет общий для всех тестов)
    const before = JSON.parse(JSON.stringify(mockRepository.state.data));

    const { page, problems } = await openPage({ url: mockBaseUrl + '/', isolated: true });

    // 1. Вход и токен публикации
    await clickWhenReady(page, '[data-nav="admin"]');
    await page.type('#admin-password', ADMIN.password);
    await clickWhenReady(page, '[data-form="login"] button[type="submit"]');
    await page.waitForFunction(() => window.FTApp && window.FTApp.isAdmin());
    await clickInView(page, '[data-action="toggle-settings"]');
    await page.type('#github-token', 'test-token');
    await clickInView(page, '[data-action="github-save-token"]');
    await page.waitForFunction(() => document.getElementById('github-token').placeholder.includes('сохранён'));

    // 2. Открываем команду и отдаём настоящее широкое фото (1600×900 рисуем в браузере)
    await clickWhenReady(page, '#admin-teams-list [data-action="team-open"]');
    await page.waitForFunction(() => !!document.querySelector('#admin-team-images input[data-photo-kind="team-image"]'));

    await page.evaluate(() => new Promise((resolve) => {
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d');

        canvas.width = 1600;
        canvas.height = 900;
        context.fillStyle = '#1b5e20';
        context.fillRect(0, 0, 1600, 900);
        context.fillStyle = '#ffffff';
        context.font = '140px sans-serif';
        context.fillText('TEAM', 80, 520);

        canvas.toBlob((blob) => {
            const input = document.querySelector('#admin-team-images input[data-photo-kind="team-image"]');
            const transfer = new DataTransfer();

            transfer.items.add(new File([blob], 'team-photo.jpg', { type: 'image/jpeg' }));
            input.files = transfer.files;
            input.dispatchEvent(new Event('change', { bubbles: true }));
            resolve(true);
        }, 'image/jpeg', 0.95);
    }));

    await page.waitForFunction(() => document.getElementById('toast-container').textContent.includes('Добавлено фотографий'));
    // Ждём предпросмотр из памяти именно загруженной фотографии: у команды могли быть фото и раньше
    await page.waitForFunction(() => Array.from(document.querySelectorAll('#admin-team-images .admin-gallery-item img'))
        .some((image) => image.getAttribute('src').indexOf('data:image/jpeg;base64,') === 0 &&
            image.complete && image.naturalWidth > 0));

    const uploaded = await page.evaluate(() => {
        const data = window.FTApp.getData();
        const team = data.teams[0];
        const paths = (data.teamImages || {})[String(team.id)] || [];
        const previews = Object.keys(window.FTApp.getState().photoPreviews);
        const path = previews[previews.length - 1] || '';
        const image = Array.from(document.querySelectorAll('#admin-team-images .admin-gallery-item img'))
            .find((item) => item.getAttribute('data-photo-path') === path);

        return {
            teamId: String(team.id),
            count: paths.length,
            path: path,
            saved: paths.indexOf(path) !== -1,
            width: image ? image.naturalWidth : 0,
            height: image ? image.naturalHeight : 0
        };
    });

    assert.equal(uploaded.saved, true, 'путь новой фотографии записан в данные команды');
    assert.match(uploaded.path, /^assets\/photos\/team-photo-[a-z0-9-]+-[0-9a-f]{6}\.jpg$/, 'имя файла фотографии');
    assert.ok(mockRepository.state.files[uploaded.path], 'файл фотографии ушёл в репозиторий');
    assert.equal(uploaded.height, 900, 'пропорции сохранены (высота не сломана)');
    assert.ok(uploaded.width >= 1600, 'ширина сохранена, фото остаётся чётким: ' + uploaded.width);

    // 3. Публичная страница команды: фото в блоке «Фотографии»
    await clickWhenReady(page, '[data-nav="teams"]');
    await clickInView(page, '#teams-grid [data-action="team-public-open"][data-id="' + uploaded.teamId + '"] .team-name');
    await page.waitForFunction(() => !!document.querySelector('#team-detail .team-gallery-item'));

    const block = await page.evaluate((path) => {
        const items = Array.from(document.querySelectorAll('#team-detail .team-gallery-item'));
        // Только что загруженное фото показывается предпросмотром из памяти (файл на сайте появится позже)
        const preview = window.FTApp.getState().photoPreviews[path] || path;
        const sources = items.map((item) => {
            const image = item.querySelector('img');

            return image ? image.getAttribute('src') : 'нет картинки';
        });

        return {
            count: items.length,
            hasUploaded: sources.indexOf(preview) !== -1,
            index: sources.indexOf(preview),
            hasHeading: document.getElementById('team-detail').textContent.includes('Фотографии')
        };
    }, uploaded.path);

    assert.equal(block.hasUploaded, true, 'загруженная фотография видна в блоке на странице команды');
    assert.equal(block.hasHeading, true, 'у блока есть заголовок');

    // 4. Нажатие на фото — просмотр на весь экран
    await clickInView(page, '#team-detail .team-gallery-item:nth-child(' + (block.index + 1) + ')');
    await page.waitForFunction(() => {
        const viewer = document.getElementById('image-viewer');
        const image = document.getElementById('image-viewer-photo');

        return !viewer.hidden && !!image && image.complete && image.naturalWidth > 0;
    });

    // Зум из миниатюры закончился: меряем уже «осевшее» фото, а не увеличенное на ходу
    await page.waitForFunction(() => {
        const image = document.getElementById('image-viewer-photo');

        return typeof image.getAnimations === 'function' &&
            image.getAnimations().every((animation) => animation.playState === 'finished');
    });

    const viewer = await page.evaluate(() => {
        const image = document.getElementById('image-viewer-photo');
        const rect = image.getBoundingClientRect();

        return {
            width: image.naturalWidth,
            height: image.naturalHeight,
            shown: Math.round(rect.width),
            caption: document.getElementById('image-viewer-caption').textContent,
            scrollLocked: document.body.classList.contains('viewer-open')
        };
    });

    assert.ok(viewer.width >= 1600, 'в просмотре полный размер: ' + viewer.width + '×' + viewer.height);
    assert.ok(viewer.shown > 600, 'фото занимает почти весь экран: ' + viewer.shown + 'px в ширину');
    assert.match(viewer.caption, /\S/, 'видна подпись с командой');
    assert.equal(viewer.scrollLocked, true, 'страница не прокручивается, пока фото открыто');

    // 5. Esc закрывает просмотр
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.getElementById('image-viewer').hidden === true);

    assert.equal(await page.evaluate(() => document.body.classList.contains('viewer-open')), false,
        'прокрутка страницы вернулась');

    // Возвращаем данные макета: фотографии из этого теста в них оставаться не должны
    mockRepository.changeExternally(before);

    const meaningful = problems.filter((item) => !item.includes('Failed to load resource'));

    assert.deepEqual(meaningful, [], 'нет ошибок консоли и сбоев загрузки');
    await page.close();
});


/**
 * Счётчики на главной — кнопки: нажатие открывает соответствующую страницу.
 * На странице «Все игроки» столбцы сортируются нажатием на заголовок.
 */
test('счётчики на главной и сортировка таблиц работают в браузере', { skip }, async () => {
    const { page, problems } = await openPage({ url: mockBaseUrl + '/', isolated: true });

    // «Игроков» открывает страницу со всеми игроками
    await clickInView(page, '#stat-players');
    await page.waitForFunction(() => document.querySelector('.page-section.active').id === 'page-allplayers');

    // На внутренних страницах табло и плитки скрыты: контент начинается сразу сверху
    assert.equal(await page.$eval('#site-head', (el) => el.hidden), true, 'табло скрыто на внутренней странице');

    const view = await page.evaluate(() => ({
        hash: window.location.hash,
        title: document.querySelector('#page-allplayers .section-title').textContent.trim(),
        rows: document.querySelectorAll('#all-players-body tr').length,
        columns: Array.from(document.querySelectorAll('#all-players-head th'))
            .map((cell) => cell.textContent.replace(/[↕↑↓]/g, '').trim()),
        sortButtons: document.querySelectorAll('#all-players-head [data-action="sort"]').length,
        firstRow: Array.from(document.querySelectorAll('#all-players-body tr:first-child td'))
            .map((cell) => cell.textContent.replace(/\s+/g, ' ').trim())
    }));

    assert.equal(view.hash, '#/allplayers', 'у страницы свой адрес');
    assert.equal(view.title, 'Все игроки');
    assert.ok(view.rows > 0, 'игроки показаны: ' + view.rows);
    assert.deepEqual(view.columns, ['Игрок', 'Команда', 'Г', 'Ж', 'К']);
    assert.equal(view.sortButtons, 5, 'сортировка по каждому столбцу');
    assert.ok(view.firstRow[0].length > 0, 'в строке видно имя игрока');

    // Нажатие на «Г» сортирует по забитым голам (от большего), повторное — наоборот
    await clickInView(page, '#all-players-head [data-key="goals"]');

    const goals = () => page.$$eval('#all-players-body tr td:nth-child(3)', (cells) => cells.map((cell) => Number(cell.textContent)));

    const descending = await goals();
    const ariaDown = await page.$eval('#all-players-head [data-key="goals"]',
        (button) => button.closest('th').getAttribute('aria-sort'));

    assert.equal(ariaDown, 'descending');
    assert.deepEqual(descending, descending.slice().sort((a, b) => b - a), 'голы по убыванию: ' + descending.join(','));

    await clickInView(page, '#all-players-head [data-key="goals"]');

    const ascending = await goals();
    const ariaUp = await page.$eval('#all-players-head [data-key="goals"]',
        (button) => button.closest('th').getAttribute('aria-sort'));

    assert.equal(ariaUp, 'ascending');
    assert.deepEqual(ascending, ascending.slice().sort((a, b) => a - b), 'голы по возрастанию');

    // Счётчик «Завершено» открывает матчи с фильтром «завершённые»
    await clickWhenReady(page, '[data-nav="home"]');
    await page.waitForFunction(() => document.getElementById('site-head').hidden === false);
    await clickInView(page, '#stat-finished');
    await page.waitForFunction(() => document.querySelector('.page-section.active').id === 'page-matches');

    const matches = await page.evaluate(() => ({
        cards: document.querySelectorAll('#matches-list .match-card').length,
        upcoming: document.querySelectorAll('#matches-list .match-card.upcoming').length
    }));

    assert.ok(matches.cards > 0, 'завершённые матчи показаны');
    assert.equal(matches.upcoming, 0, 'предстоящие матчи в списке не показаны');

    // Счётчик «Команд» открывает список команд
    await clickWhenReady(page, '[data-nav="home"]');
    await clickInView(page, '#stat-teams');
    await page.waitForFunction(() => document.querySelector('.page-section.active').id === 'page-teams');

    assert.equal(await page.evaluate(() => window.location.hash), '#/teams');

    const meaningful = problems.filter((item) => !item.includes('Failed to load resource'));

    assert.deepEqual(meaningful, [], 'нет ошибок консоли и сбоев загрузки');
    await page.close();
});

test('заставка: при открытии виден фон с названием, затем сайт открывается сам', { skip }, async () => {
    // Заставка длится 700 мс — тест не ждёт пять секунд
    const config = Object.assign({}, SITE_CONFIG, { splashMs: 700 });
    const { page, problems } = await openPage({ config });

    // Заставка видна поверх страницы: логотип, название, отсчёт и кнопка
    assert.equal(await textOf(page, '.splash-badge'), 'FT');
    assert.equal(await textOf(page, '.splash-title'), 'Чемпионат среди Артистов по футболу');
    assert.equal(await textOf(page, '#splash-countdown'), '1');
    assert.equal(await page.$eval('#splash', (element) => getComputedStyle(element).visibility), 'visible');

    // Фон заставки — та же картинка и затемнение поверх неё
    const background = await page.$eval('#splash', (element) => getComputedStyle(element).backgroundImage);
    assert.match(background, /Problem\/fon\.jpg/, 'фон заставки: ' + background);
    assert.match(background, /linear-gradient/, 'поверх фона затемнение для читаемости текста');

    // Пока заставка видна, страница не прокручивается
    assert.equal(await page.evaluate(() => document.body.classList.contains('splash-open')), true);

    // Полоска заполняется ровно за время показа заставки
    const progress = await page.$eval('.splash-progress',
        (element) => getComputedStyle(element, '::after').animationDuration);
    assert.equal(progress, '0.7s', 'полоска загрузки идёт всё время показа');

    // Через отведённое время заставка исчезает сама, страница снова прокручивается
    await page.waitForFunction(() => document.getElementById('splash').hidden === true, { timeout: 5000 });

    assert.equal(await page.evaluate(() => window.FTSplash.isVisible()), false);
    assert.equal(await page.evaluate(() => document.body.classList.contains('splash-open')), false, 'прокрутка вернулась');
    assert.equal(await page.evaluate(() => window.FTSplash.isSeen()), true, 'заставка отмечена показанной');

    // Сайт под заставкой работал как обычно
    await clickWhenReady(page, '[data-nav="teams"]');
    await page.waitForFunction(() => document.querySelector('.page-section.active').id === 'page-teams');

    assert.deepEqual(problems.filter((item) => !item.includes('Failed to load resource')), [], 'нет ошибок консоли');
    await page.close();
});

test('заставка: клик по экрану открывает сайт сразу, повторный вход — без заставки', { skip }, async () => {
    // Долгий показ: закрыть заставку должен именно клик
    const config = Object.assign({}, SITE_CONFIG, { splashMs: 60000 });
    const { page, problems } = await openPage({ config });

    assert.equal(await page.evaluate(() => window.FTSplash.isVisible()), true);
    assert.equal(await page.$('#splash button'), null, 'на заставке нет кнопок');

    await clickWhenReady(page, '#splash');
    await page.waitForFunction(() => document.getElementById('splash').hidden === true, { timeout: 3000 });

    assert.equal(await page.evaluate(() => window.FTSplash.isVisible()), false, 'клик открывает сайт сразу');
    assert.equal(await page.evaluate(() => document.body.classList.contains('splash-open')), false, 'прокрутка вернулась');

    // Второе открытие в той же вкладке: отметка есть — заставки нет вовсе
    await reloadApp(page);

    assert.equal(await page.$eval('#splash', (element) => element.hidden), true, 'заставки нет');
    assert.equal(await page.evaluate(() => window.FTSplash.isSeen()), true);

    // Заставка не мешает работать с сайтом
    await clickWhenReady(page, '[data-nav="matches"]');
    await page.waitForFunction(() => document.querySelector('.page-section.active').id === 'page-matches');

    assert.deepEqual(problems.filter((item) => !item.includes('Failed to load resource')), [], 'нет ошибок консоли');
    await page.close();
});

/**
 * Заставка на смартфоне: узкий вертикальный экран получает вертикальный снимок
 * fontel.jpg — его кадр снят под форму телефона и виден почти целиком. На широких
 * экранах (компьютер, планшет, телефон «лёжа») остаётся широкий fon.jpg: вертикальный
 * кадр там пришлось бы обрезать почти вдвое по высоте.
 */
test('заставка: на смартфоне фоном служит вертикальный снимок fontel.jpg', { skip }, async () => {
    // Долгий показ: проверяем саму заставку, а не её исчезновение
    const config = Object.assign({}, SITE_CONFIG, { splashMs: 60000 });
    const { page, problems } = await openPage({ mobile: true, config });

    /** Фон и размеры экрана заставки: важно и что нарисовано, и как оно уложено. */
    const splashView = () => page.$eval('#splash', (element) => {
        const style = getComputedStyle(element);
        const box = element.getBoundingClientRect();

        return {
            background: style.backgroundImage,
            size: style.backgroundSize,
            position: style.backgroundPosition,
            width: Math.round(box.width),
            height: Math.round(box.height)
        };
    });

    // Телефон 390×844: вертикальный снимок и затемнение поверх него
    const phone = await splashView();

    assert.match(phone.background, /Problem\/fontel\.jpg/, 'фон заставки на телефоне: ' + phone.background);
    assert.doesNotMatch(phone.background, /fon\.jpg/, 'широкий fon.jpg на телефоне не подключается');
    assert.match(phone.background, /linear-gradient/, 'поверх снимка затемнение для читаемости текста');
    assert.match(phone.size, /^cover(, cover)*$/, 'снимок закрывает экран целиком: ' + phone.size);
    assert.match(phone.position, /^50% 50%(, 50% 50%)*$/, 'кадр центрируется — обрезаются только полосы по бокам: ' + phone.position);
    assert.equal(phone.width, 390, 'заставка занимает экран по ширине');
    assert.equal(phone.height, 844, 'заставка занимает экран по высоте');

    // Текст заставки остался на месте: снимок служит фоном, а не заменяет название и отсчёт
    assert.equal(await textOf(page, '.splash-badge'), 'FT');
    assert.equal(await textOf(page, '.splash-title'), 'Чемпионат среди Артистов по футболу');
    assert.match(await textOf(page, '.splash-timer'), /Открываем сайт через/);

    // Браузер действительно скачал снимок телефона (предзагрузка в <head> + правило в стилях)
    await page.waitForFunction(() => performance.getEntriesByType('resource')
        .some((entry) => entry.name.indexOf('fontel.jpg') !== -1 && entry.responseEnd > 0), { timeout: 10000 });

    // Компьютер, планшет и телефон «лёжа»: там по-прежнему широкий фон
    const wideScreens = [[1280, 900], [820, 1180], [844, 390]];

    for (const [width, height] of wideScreens) {
        await page.setViewport({ width, height });

        const view = await splashView();

        assert.match(view.background, /Problem\/fon\.jpg/, width + '×' + height + ': ' + view.background);
        assert.doesNotMatch(view.background, /fontel\.jpg/, width + '×' + height + ': вертикальный снимок здесь не нужен');
        assert.equal(view.width, width, 'заставка всё ещё на весь экран');
    }

    assert.deepEqual(problems.filter((item) => !item.includes('Failed to load resource')), [], 'нет ошибок консоли');
    await page.close();
});


/**
 * Дисквалификации в браузере: жёлтые карточки превращаются в красную,
 * игрок пропускает следующий матч команды — и это видно во всех местах,
 * где смотрят матчи (список, детальный результат, карточка матча админки).
 *
 * Данные подставляются свои: в рабочем data.json карточек пока нет, а проверять
 * нужно и расчёт, и вёрстку. В конце тест возвращает репозиторий в исходное состояние.
 */
test('дисквалификации: жёлтые карточки превращаются в красную и видны в матчах', { skip }, async () => {
    const original = JSON.parse(fs.readFileSync(path.join(ROOT, 'data.json'), 'utf8'));
    const yellow = (team, player) => ({ team: team, player: player, type: 'yellow' });
    const red = (team, player) => ({ team: team, player: player, type: 'red' });
    const goal = (team, player) => ({ team: team, player: player, type: 'goal' });

    mockRepository.changeExternally({
        version: 10,
        revision: 900,
        updatedAt: '2026-09-10T10:00:00.000Z',
        teams: [
            { id: 1, name: 'Ветераны МГК', players: ['Шорохов Александр', 'Бусырев Сергей'] },
            { id: 2, name: 'ФК МГСО', players: ['Сергеев Валентин', 'Аракелян Арман'] },
            { id: 3, name: 'ФК МАМТ', players: ['Зангиев Тимур'] }
        ],
        matches: [
            {
                id: 1, teamA: 1, teamB: 2, scoreA: 3, scoreB: 1, date: '2026-09-01', finished: true,
                events: [
                    goal(1, 'Шорохов Александр'), goal(1, 'Бусырев Сергей'),
                    yellow(1, 'Шорохов Александр'), yellow(1, 'Шорохов Александр'),
                    yellow(1, 'Шорохов Александр'), red(2, 'Аракелян Арман'),
                    goal(2, 'Сергеев Валентин')
                ]
            },
            {
                id: 2, teamA: 1, teamB: 2, scoreA: 0, scoreB: 0, date: '2026-09-08', finished: true,
                events: [yellow(1, 'Шорохов Александр')]
            },
            { id: 3, teamA: 1, teamB: 3, scoreA: null, scoreB: null, date: '2026-09-15', finished: false, events: [] },
            { id: 4, teamA: 2, teamB: 3, scoreA: null, scoreB: null, date: '2026-09-16', finished: false, events: [] }
        ],
        photos: {},
        teamPhotos: {},
        teamImages: {},
        playerInfo: { '1|шорохов александр': { number: 10, note: '' } },
        settings: { yellowLimit: 4, yellowPeriodDays: 0 }
    });

    const { page, problems } = await openPage({ url: mockBaseUrl + '/#/matches', isolated: true });

    // 1. Список матчей: у предстоящего матча «Ветеранов МГК» — строка «Пропустят матч»
    await page.waitForFunction(() => document.querySelectorAll('#matches-list .match-card').length > 0);

    const list = await page.evaluate(() => {
        const cardOf = (matchId) => document.querySelector('#matches-list .match-card[data-id="' + matchId + '"]');
        const lineOf = (matchId) => (cardOf(matchId) ? cardOf(matchId).querySelector('.match-bans') : null);
        const line = lineOf(3);
        const finishedLine = lineOf(2);
        const box = line ? line.getBoundingClientRect() : { width: 0, height: 0 };

        return {
            text: line ? line.textContent.replace(/\s+/g, ' ').trim() : '',
            finishedText: finishedLine ? finishedLine.textContent.replace(/\s+/g, ' ').trim() : '',
            width: Math.round(box.width),
            height: Math.round(box.height),
            withoutBans: [1, 4].filter((matchId) => lineOf(matchId)).length,
            overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth
        };
    });

    assert.match(list.text, /Пропустят матч: Шорохов Александр \(Ветераны МГК\)/, 'строка в карточке матча: ' + list.text);
    assert.match(list.finishedText, /Пропустили матч: Аракелян Арман \(ФК МГСО\)/,
        'в сыгранном матче — «Пропустили матч»: ' + list.finishedText);
    assert.ok(list.width > 0 && list.height > 0, 'строка отрисована стилями: ' + list.width + 'x' + list.height);
    assert.equal(list.withoutBans, 0, 'у остальных матчей дисквалификаций нет');
    assert.equal(list.overflow, 0, 'страница не выходит за экран');

    // 2. Детальный результат: блок «Дисквалификации» с причиной и правилом
    await gotoApp(page, mockBaseUrl + '/#/match/3');
    await page.waitForFunction(() => !!document.querySelector('#match-detail .match-bans-block'));

    const detail = await page.evaluate(() => {
        const block = document.querySelector('#match-detail .match-bans-block');
        const box = block.getBoundingClientRect();

        return {
            text: block.textContent.replace(/\s+/g, ' ').trim(),
            width: Math.round(box.width),
            height: Math.round(box.height)
        };
    });

    assert.match(detail.text, /Дисквалификации/, 'заголовок блока');
    assert.match(detail.text, /Шорохов Александр/);
    assert.match(detail.text, /4-я жёлтая карточка, получена 08\.09\.2026/, 'причина дисквалификации');
    assert.match(detail.text, /превращается в красную, а любая красная карточка/, 'правило словами');
    assert.ok(detail.width > 0 && detail.height > 0, 'блок отрисован: ' + detail.width + 'x' + detail.height);

    // 3. Админка: значок «пропуск» у игрока и блок в карточке матча
    await clickWhenReady(page, '[data-nav="admin"]');
    await page.type('#admin-password', ADMIN.password);
    await clickWhenReady(page, '[data-form="login"] button[type="submit"]');
    await page.waitForFunction(() => window.FTApp && window.FTApp.isAdmin());
    await clickInView(page, '[data-action="admin-tab"][data-admin-tab="matches"]');
    await clickInView(page, '#admin-matches-list [data-action="match-open"][data-id="3"]');
    await page.waitForFunction(() => !!document.querySelector('#admin-match-bans .admin-ban-item'));

    const adminMatch = await page.evaluate(() => {
        const badge = document.querySelector('#admin-match-events .event-ban');
        const box = badge ? badge.getBoundingClientRect() : { width: 0, height: 0 };

        return {
            badges: document.querySelectorAll('#admin-match-events .event-ban').length,
            badgeWidth: Math.round(box.width),
            bans: document.querySelector('#admin-match-bans').textContent.replace(/\s+/g, ' ').trim()
        };
    });

    assert.equal(adminMatch.badges, 1, 'значок «пропуск» только у дисквалифицированного игрока');
    assert.ok(adminMatch.badgeWidth > 0, 'значок виден: ' + adminMatch.badgeWidth + 'px');
    assert.match(adminMatch.bans, /Пропустят матч по карточкам/);
    assert.match(adminMatch.bans, /Шорохов Александр/);

    // 4. Настройки: правило из данных подставлено, сохранение пересчитывает дисквалификации
    await clickInView(page, '[data-action="toggle-settings"]');
    await page.waitForFunction(() => !document.getElementById('admin-settings').hidden);

    const before = await page.evaluate(() => ({
        limit: document.getElementById('discipline-yellow-limit').value,
        period: document.getElementById('discipline-period').value,
        rule: document.getElementById('discipline-rule').textContent
    }));

    assert.equal(before.limit, '4', 'в поле — текущий лимит');
    assert.equal(before.period, '0', 'в поле — текущий период');
    assert.match(before.rule, /^4-я жёлтая карточка за весь турнир/);

    // Пустое значение отклоняется с понятной подсказкой
    await page.evaluate(() => {
        document.getElementById('discipline-yellow-limit').value = '';
    });
    await clickInView(page, '[data-form="discipline"] button[type="submit"]');
    await page.waitForFunction(() => document.getElementById('discipline-form-error').textContent.length > 0);

    assert.match(await textOf(page, '#discipline-form-error'), /от 1 до 12/, 'пустое значение отклоняется');

    // Рабочее правило: 3-я жёлтая за 30 дней
    await page.evaluate(() => {
        document.getElementById('discipline-yellow-limit').value = '3';
        document.getElementById('discipline-period').value = '30';
    });
    await clickInView(page, '[data-form="discipline"] button[type="submit"]');
    await page.waitForFunction(() => {
        const settings = window.FTApp.getData().settings;

        return settings && settings.yellowLimit === 3 && settings.yellowPeriodDays === 30;
    });

    const after = await page.evaluate(() => ({
        settings: window.FTApp.getData().settings,
        rule: document.getElementById('discipline-rule').textContent,
        toast: document.getElementById('toast-container').textContent
    }));

    assert.deepEqual(after.settings, { yellowLimit: 3, yellowPeriodDays: 30, theme: 'classic' },
        'правила сохранены в данных, оформление сайта при этом не потерялось');
    assert.match(after.rule, /^3-я жёлтая карточка за 30 дней/, 'подсказка обновилась: ' + after.rule);
    assert.match(after.toast, /Правила дисквалификаций сохранены/);

    assert.deepEqual(problems, [], 'нет ошибок консоли и сбоев загрузки');
    await page.close();

    // Репозиторий возвращаем в исходное состояние
    mockRepository.changeExternally(original);
});

/**
 * Главная страница в браузере: ближайший матч со временем начала и живой отсчёт.
 * Данные подставляются свои — матчи идут от сегодняшнего дня, а в рабочем
 * data.json время у матчей пока не указано. В конце репозиторий возвращается
 * в исходное состояние.
 */
test('главная: ближайший матч с отсчётом до начала', { skip }, async () => {
    const original = JSON.parse(fs.readFileSync(path.join(ROOT, 'data.json'), 'utf8'));
    const day = (offset) => {
        const date = new Date();

        date.setDate(date.getDate() + offset);

        return date.getFullYear() + '-' +
            String(date.getMonth() + 1).padStart(2, '0') + '-' +
            String(date.getDate()).padStart(2, '0');
    };

    mockRepository.changeExternally({
        version: 12,
        revision: 950,
        updatedAt: new Date().toISOString(),
        teams: [
            { id: 1, name: 'Ветераны МГК', players: ['Шорохов Александр'] },
            { id: 2, name: 'ФК МГСО', players: ['Сергеев Валентин'] }
        ],
        matches: [
            { id: 1, teamA: 1, teamB: 2, scoreA: 2, scoreB: 1, date: day(-5), time: '19:30', finished: true, events: [] },
            { id: 2, teamA: 2, teamB: 1, scoreA: null, scoreB: null, date: day(1), time: '19:30', finished: false, events: [] },
            { id: 3, teamA: 1, teamB: 2, scoreA: null, scoreB: null, date: day(4), finished: false, events: [] }
        ],
        photos: {},
        teamPhotos: {},
        teamImages: {},
        playerInfo: {},
        settings: { yellowLimit: 4, yellowPeriodDays: 0, theme: 'classic' }
    });

    const { page, problems, close } = await openPage({
        url: mockBaseUrl + '/', isolated: true, mobile: true
    });

    await page.waitForFunction(() => Boolean(document.querySelector('#next-match .match-card')));

    const view = await page.evaluate(() => {
        const card = document.querySelector('#next-match .match-card');
        const countdown = card.querySelector('.next-match-countdown');
        const box = countdown.getBoundingClientRect();
        const tiles = Array.from(countdown.querySelectorAll('.countdown-part'));

        return {
            id: card.getAttribute('data-id'),
            title: document.getElementById('next-match-title').textContent.trim(),
            countdown: countdown.textContent.replace(/\s+/g, ' ').trim(),
            parts: tiles.map((tile) => tile.getAttribute('data-part')),
            values: tiles.map((tile) => tile.querySelector('.countdown-value').textContent.trim()),
            units: tiles.map((tile) => tile.querySelector('.countdown-unit').textContent.trim()),
            seconds: countdown.querySelector('[data-part="seconds"] .countdown-value').textContent.trim(),
            shown: box.width > 0 && box.height > 0,
            width: Math.round(box.width),
            when: card.querySelector('.next-match-when').textContent.replace(/\s+/g, ' ').trim(),
            teams: Array.from(card.querySelectorAll('.team-name')).map((element) => element.textContent.trim()),
            stacked: (() => {
                // Блоки главной стоят друг под другом, а не рядом: второй ниже первого
                const above = document.querySelector('#next-match').closest('.card').getBoundingClientRect();
                const below = document.querySelector('#upcoming-matches').closest('.card').getBoundingClientRect();

                return below.top >= above.bottom - 1 && Math.abs(below.left - above.left) < 1;
            })(),
            list: Array.from(document.querySelectorAll('#upcoming-matches .match-card')).map((element) => ({
                id: element.getAttribute('data-id'),
                countdown: element.querySelector('.match-countdown').textContent.trim()
            })),
            overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth
        };
    });

    assert.equal(view.title, 'Ближайший матч');
    assert.equal(view.id, '2', 'афиша показывает ближайший по расписанию матч');
    assert.deepEqual(view.parts.slice(-3), ['hours', 'minutes', 'seconds'],
        'часы, минуты и секунды — отдельными плитками: ' + view.parts.join(' · '));
    assert.equal(view.parts[0], view.parts.length === 4 ? 'days' : 'hours',
        'плитка дней показывается, пока сутки остались');
    assert.deepEqual(view.units.slice(-3), ['часов', 'минут', 'секунд']);
    view.values.forEach((value) => assert.match(value, /^\d{1,2}$/, 'значение плитки: ' + value));
    assert.ok(view.shown, 'отсчёт отрисован стилями: ' + view.width + 'px');
    assert.match(view.when, /19:30/, 'время начала видно в строке даты: ' + view.when);
    assert.deepEqual(view.teams, ['ФК МГСО', 'Ветераны МГК']);
    assert.deepEqual(view.list, [{ id: '3', countdown: 'через 4 дня' }],
        'остальные матчи — со своим коротким отсчётом');
    assert.equal(view.overflow, 0, 'на телефоне страница не выходит за экран');
    assert.ok(view.stacked, 'блоки главной стоят друг под другом на всю ширину');

    // Секунды идут сами: счётчик живой, а не застывший
    await new Promise((resolve) => setTimeout(resolve, 1400));

    const secondsAfter = await textOf(page, '#next-match [data-part="seconds"] .countdown-value');

    assert.notEqual(secondsAfter, view.seconds, 'посекундный отсчёт обновляется сам');

    assert.deepEqual(problems, [], 'нет ошибок консоли и сбоев загрузки');
    await close();

    mockRepository.changeExternally(original);
});

/**
 * Второй стиль «Афиша матча»: администратор включает его кнопкой в настройках,
 * стиль применяется сразу, уезжает в данные турнира (значит, его видят все зрители)
 * и ничего не ломает на узких экранах: страница не шире экрана, блоки не «уезжают».
 */
test('оформление «Афиша матча»: включение в админке, работа на страницах и на телефоне', { skip }, async () => {
    const original = JSON.parse(fs.readFileSync(path.join(ROOT, 'data.json'), 'utf8'));

    // Своё хранилище: включаем стиль как администратор на своём устройстве
    const { page, problems } = await openPage({ url: mockBaseUrl + '/', isolated: true });

    await clickWhenReady(page, '[data-nav="admin"]');
    await page.type('#admin-password', ADMIN.password);
    await clickWhenReady(page, '[data-form="login"] button[type="submit"]');
    await page.waitForFunction(() => window.FTApp && window.FTApp.isAdmin());

    // Настройки скрыты за кнопкой в шапке панели
    await clickInView(page, '[data-action="toggle-settings"]');
    await page.waitForFunction(() => !document.getElementById('admin-settings').hidden);

    const before = await page.evaluate(() => ({
        buttons: document.querySelectorAll('#theme-publish [data-action="theme-publish"]').length,
        status: document.getElementById('theme-status').textContent,
        theme: window.FTApp.theme.current()
    }));

    // Оформление для всех зрителей лежит в данных: панель показывает именно его
    assert.equal(before.buttons, 2, 'в настройках два оформления: обычное и «Афиша матча»');
    assert.equal(before.theme, original.settings.theme, 'показано оформление, выбранное для всех зрителей');
    assert.match(before.status, THEME_LOOK[before.theme].status, 'подпись рассказывает про выбранное оформление');

    // Оформление сайта хранится в данных и может быть любым: приводим его к обычному виду,
    // чтобы дальше включить «Афишу» как в первый раз (иначе переключение — не изменение).
    await clickInView(page, '#theme-publish [data-action="theme-publish"][data-theme="classic"]');
    await page.waitForFunction(() => !document.body.classList.contains('theme-afisha'));

    // Включаем «Афишу» для всех зрителей
    await clickInView(page, '#theme-publish [data-action="theme-publish"][data-theme="afisha"]');
    await page.waitForFunction(() => document.body.classList.contains('theme-afisha'));

    const published = await page.evaluate(() => ({
        data: window.FTApp.getData().settings.theme,
        pressed: document.querySelector('#theme-publish [data-action="theme-publish"][aria-pressed="true"]')
            .getAttribute('data-theme'),
        toast: document.getElementById('toast-container').textContent
    }));

    assert.equal(published.data, 'afisha', 'выбор сохранён в данных турнира — его увидят все');
    assert.equal(published.pressed, 'afisha', 'кнопка показывает выбранное оформление');
    assert.match(published.toast, /Оформление «Афиша матча» включено/);

    // Стилевой файл подключён и действительно применился
    const look = await page.evaluate(() => {
        const panel = document.querySelector('#page-home .panel');
        const title = panel.querySelector('.section-title');
        const badge = getComputedStyle(title, '::before');
        const tiles = Array.from(document.querySelectorAll('.stat-ribbon .stat-box'));
        const tileStyles = new Set(tiles.map((tile) => {
            const style = getComputedStyle(tile);

            return style.borderTopStyle + ' ' + style.borderTopLeftRadius;
        }));

        return {
            sheet: Array.from(document.styleSheets).map((item) => item.href || '').join(' '),
            theme: document.body.getAttribute('data-theme'),
            radius: getComputedStyle(panel).borderTopLeftRadius,
            number: badge.content,
            numberBorder: badge.borderTopStyle,
            numberPadding: badge.paddingLeft,
            heading: getComputedStyle(title).textTransform,
            tilesUniform: tileStyles.size === 1,
            tileRadius: tiles.length ? getComputedStyle(tiles[0]).borderTopLeftRadius : ''
        };
    });

    assert.match(look.sheet, /theme-afisha\.css/, 'подключён файл второго оформления');
    assert.equal(look.theme, 'afisha');
    assert.equal(look.radius, '18px', 'блоки стали с мягкими скруглениями: ' + look.radius);
    assert.match(look.number, /counter\(af-panel|[0-9]{2}/,
        'заголовок раздела получает номер как в программке: ' + look.number);
    assert.equal(look.numberBorder, 'solid', 'номер оформлен рамкой');
    assert.notEqual(look.numberPadding, '0px', 'номер не прилипает к заголовку');
    assert.equal(look.heading, 'uppercase', 'заголовки разделов — капителью');
    assert.equal(look.tilesUniform, true, 'плитки-счётчики одной формы: цветом выделяется только активная');
    assert.equal(look.tileRadius, '18px', 'у плиток мягкие скругления: ' + look.tileRadius);

    // Публичные страницы: стиль работает и данные на месте
    for (const [hash, selector] of [['#/', '.match-card'], ['#/standings', '#standings-body tr'], ['#/teams', '#teams-grid .card']]) {
        await gotoApp(page, mockBaseUrl + '/' + hash);
        await page.waitForFunction((target) => Boolean(document.querySelector(target)), {}, selector);

        const view = await page.evaluate((target) => ({
            hash: window.location.hash,
            items: document.querySelectorAll(target).length,
            theme: document.body.classList.contains('theme-afisha')
        }), selector);

        assert.ok(view.items > 0, view.hash + ': список заполнен');
        assert.equal(view.theme, true, view.hash + ': стиль «Афиша» применён');
    }

    // Телефон, планшет и компьютер: страница не шире экрана, блоки внутри экрана.
    // Это и есть защита от «уехавших» блоков и горизонтальной прокрутки.
    const widths = [[320, 640], [360, 740], [390, 844], [768, 1024]];
    const pages = [['#/', 'page-home'], ['#/standings', 'page-standings'], ['#/teams', 'page-teams']];

    for (const [width, height] of widths) {
        await page.setViewport({ width, height, isMobile: width < 768, hasTouch: width < 768 });

        for (const [hash, section] of pages) {
            await page.evaluate((target) => { window.location.hash = target; }, hash);
            await page.waitForFunction((id) => document.getElementById(id).classList.contains('active'), {}, section);

            const fit = await page.evaluate(() => {
                const doc = document.documentElement;
                const wider = [];

                document.querySelectorAll('main .stat-ribbon, main .panel, main .match-card, main .stat-box, ' +
                    'main .hero-band, main .squad-toggle, main .team-gallery-item').forEach((element) => {
                    const box = element.getBoundingClientRect();

                    if (box.width > 0 && (box.right > doc.clientWidth + 1 || box.left < -1)) {
                        wider.push((element.className || element.tagName) +
                            ' [' + Math.round(box.left) + '…' + Math.round(box.right) + ']');
                    }
                });

                return {
                    page: doc.scrollWidth - doc.clientWidth,
                    wider: wider.slice(0, 4)
                };
            });

            assert.equal(fit.page, 0, width + 'px ' + hash + ': страница не шире экрана');
            assert.deepEqual(fit.wider, [], width + 'px ' + hash + ': все блоки внутри экрана');
        }
    }

    // Обычный вид возвращается той же кнопкой: зрителям — как было
    await gotoApp(page, mockBaseUrl + '/#/admin');
    await clickInView(page, '[data-action="toggle-settings"]');
    await clickInView(page, '#theme-publish [data-action="theme-publish"][data-theme="classic"]');
    await page.waitForFunction(() => !document.body.classList.contains('theme-afisha'));

    assert.equal(await page.evaluate(() => window.FTApp.getData().settings.theme), 'classic',
        'обычный вид возвращается одной кнопкой');

    assert.deepEqual(problems, [], 'нет ошибок консоли и сбоев загрузки');
    await page.close();

    // Репозиторий возвращаем в исходное состояние
    mockRepository.changeExternally(original);
});

/**
 * Движение: покачивание нот, латунный блик и зерно бумаги объявлены стилями, а кнопка
 * «Движение» в подвале выключает и включает анимации на устройстве.
 */
test('движение: анимации объявлены, а кнопка в подвале их выключает и включает', { skip }, async () => {
    const { page, problems } = await openPage({ url: mockBaseUrl + '/', isolated: true });

    await page.evaluate(() => window.FTApp.theme.preview('afisha'));
    await page.waitForFunction(() => document.body.classList.contains('theme-afisha'));

    const look = await page.evaluate(() => {
        const note = document.querySelector('.hero-note-1');
        const band = document.querySelector('.hero-band');
        const grain = getComputedStyle(document.body, '::after').backgroundImage;

        return {
            noteAnimation: getComputedStyle(note).animationName,
            noteTransform: getComputedStyle(note).transform,
            sheenAnimation: getComputedStyle(band, '::before').animationName,
            grain: grain.indexOf('svg+xml') !== -1,
            quiet: document.documentElement.classList.contains('reduce-motion'),
            button: document.getElementById('motion-toggle').textContent
        };
    });

    assert.equal(look.quiet, false, 'по умолчанию движение включено');
    assert.equal(look.noteAnimation, 'af-note-sway', 'ноты на табло покачиваются');
    assert.notEqual(look.noteTransform, 'none', 'у каждой ноты остался свой наклон');
    assert.equal(look.sheenAnimation, 'af-sheen', 'по табло идёт латунный блик');
    assert.equal(look.grain, true, 'на фоне «Афиши» есть зерно бумаги');
    assert.match(look.button, /включено/);

    // Кнопка в подвале выключает движение — и всё замирает
    await clickInView(page, '#motion-toggle');
    await page.waitForFunction(() => document.documentElement.classList.contains('reduce-motion'));

    const quiet = await page.evaluate(() => ({
        note: getComputedStyle(document.querySelector('.hero-note-1')).animationName,
        sheen: getComputedStyle(document.querySelector('.hero-band'), '::before').animationName,
        section: getComputedStyle(document.querySelector('.page-section.active')).animationName,
        button: document.getElementById('motion-toggle').textContent
    }));

    assert.equal(quiet.note, 'none', 'ноты перестали качаться');
    assert.equal(quiet.sheen, 'none', 'латунный блик остановился');
    assert.equal(quiet.section, 'none', 'разделы показываются без анимации');
    assert.match(quiet.button, /выключено/);

    // И включает обратно
    await clickInView(page, '#motion-toggle');
    await page.waitForFunction(() => !document.documentElement.classList.contains('reduce-motion'));

    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.hero-note-1')).animationName),
        'af-note-sway', 'движение вернулось');

    assert.deepEqual(problems.filter((item) => !item.includes('Failed to load resource')), [],
        'нет ошибок консоли (в том числе CSP на зерно бумаги)');
    await page.close();
});

/**
 * Движение: полоса света идёт по табло, и нота, над которой она проходит, подпрыгивает —
 * поднимается вверх и держится на высоте, пока свет на ней, — а когда полоса уходит,
 * опускается на своё место. За откликом следит скрипт: он читает ход полосы у её же слоя,
 * поэтому вспышки идут в такт.
 */
test('движение: ноты подпрыгивают под бликом, идущим по табло', { skip }, async () => {
    const { page, problems } = await openPage({ url: mockBaseUrl + '/', isolated: true });

    await page.evaluate(() => window.FTApp.theme.preview('afisha'));
    await page.waitForFunction(() => document.body.classList.contains('theme-afisha'));

    /* Прыжок: держим полосу света ровно над нотой — тогда скрипт ставит класс, и видно,
       что нота поднялась. Покачивание на время замера останавливаем, иначе оно мешало бы. */
    const jump = await page.evaluate(async () => {
        const band = document.querySelector('.hero-band');
        const note = document.querySelector('.hero-note-1');
        const sheen = document.getAnimations().filter((item) => item.animationName === 'af-sheen')[0];
        const sway = note.getAnimations().filter((item) => item.animationName === 'af-note-sway')[0];
        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const top = () => note.getBoundingClientRect().top;
        const shiftNow = () => {
            const matrix = getComputedStyle(band, '::before').transform;

            return parseFloat(matrix.slice(matrix.indexOf('(') + 1, -1).split(',')[4]) || 0;
        };

        sway.pause();
        sheen.pause();

        // Полосу уводим за левый край: ноты в покое, замер «обычного положения» честный
        sheen.currentTime = 0;
        await wait(700);

        const calm = { top: top(), opacity: Number(getComputedStyle(note).opacity) };

        // Ищем момент цикла, когда полоса накрывает ноту
        const bandBox = band.getBoundingClientRect();
        const noteBox = note.getBoundingClientRect();
        const middle = noteBox.left + noteBox.width / 2 - bandBox.left;
        const width = parseFloat(getComputedStyle(band, '::before').width);
        let hold = null;

        for (let time = 0; time <= 6400 && hold === null; time += 120) {
            sheen.currentTime = time;

            if (middle >= shiftNow() && middle <= shiftNow() + width) {
                hold = time;
            }
        }

        let rise = null;

        if (hold !== null) {
            await wait(600); // скрипт замечает свет над нотой, прыжок успевает закончиться (переход 0.45 с)
            rise = Math.round(calm.top - top());
        }

        const litStyle = getComputedStyle(note);
        const lit = { translate: litStyle.translate, opacity: Number(litStyle.opacity) };

        sheen.currentTime = 0; // полоса ушла — нота должна опуститься
        await wait(700);

        const back = Math.round(top() - calm.top);

        sheen.play();
        sway.play();

        return {
            hold: hold,
            rise: rise,
            back: back,
            translate: lit.translate,
            calmOpacity: calm.opacity,
            litOpacity: lit.opacity
        };
    });

    assert.notEqual(jump.hold, null, 'нашёлся момент, когда полоса света стоит над нотой');
    assert.equal(jump.rise, 18, 'под бликом нота поднимается вверх на всю высоту прыжка');
    assert.match(jump.translate, /-18px/, 'подъём задан свойством translate: ' + jump.translate);
    assert.equal(jump.back, 0, 'когда полоса ушла, нота опускается на своё место');
    assert.ok(jump.litOpacity > jump.calmOpacity, 'под светом нота ярче');

    /* Полосу света ведём руками: проверка не зависит от того, в какой момент открылась
       страница. Ноты должны вспыхивать по очереди — по мере того как полоса идёт над ними. */
    const lit = await page.evaluate(async () => {
        const sheen = document.getAnimations().filter((item) => item.animationName === 'af-sheen')[0];
        const notes = Array.from(document.querySelectorAll('.hero-note'));

        if (!sheen) {
            return null;
        }

        sheen.pause();

        const seen = [];
        const frame = () => new Promise((resolve) => { requestAnimationFrame(() => { setTimeout(resolve, 60); }); });

        // Проход по табло занимает 42% цикла (см. af-sheen в src/theme-afisha.css)
        for (let time = 0; time <= 6600; time += 300) {
            sheen.currentTime = time;
            await frame();

            notes.forEach((note, index) => {
                if (note.classList.contains('is-lit') && seen.indexOf(index + 1) === -1) {
                    seen.push(index + 1);
                }
            });
        }

        sheen.play();

        return seen;
    });

    assert.ok(lit, 'полоса света нашлась среди анимаций страницы');
    assert.ok(lit.length >= 4, 'ноты подпрыгивают, когда полоса идёт над ними: ' + lit.join(','));

    // Со страницы ушли — отклик снят, ноты снова в покое
    await page.evaluate(() => window.FTApp.navigate('standings'));

    assert.equal(await page.evaluate(() => document.querySelectorAll('.hero-note.is-lit').length), 0,
        'на другой странице ноты остаются в покое');

    // Движение выключили — прыжков больше нет
    await page.evaluate(() => {
        window.FTApp.navigate('home');
        document.getElementById('motion-toggle').click();
    });
    await page.waitForFunction(() => document.documentElement.classList.contains('reduce-motion'));
    await new Promise((resolve) => setTimeout(resolve, 400));

    assert.equal(await page.evaluate(() => document.querySelectorAll('.hero-note.is-lit').length), 0,
        'при «меньше движения» ноты не подпрыгивают');

    assert.deepEqual(problems.filter((item) => !item.includes('Failed to load resource')), [],
        'нет ошибок консоли');
    await page.close();
});

/**
 * Телефон, «Афиша матча»: нот на табло столько же, сколько на компьютере, — они просто
 * мельче и тише, чтобы не спорить с названием. Все они держатся внутри табло: табло узкое,
 * и вылезший значок выглядел бы мусором поверх текста.
 */
test('телефон: в «Афише» видны все ноты табло', { skip }, async () => {
    const { page, problems } = await openPage({ mobile: true, isolated: true });

    await page.evaluate(() => window.FTApp.theme.preview('afisha'));
    await page.waitForFunction(() => document.body.classList.contains('theme-afisha'));

    // Движение выключаем: замеры не зависят от того, где сейчас полоса света и как качнулись ноты
    await clickInView(page, '#motion-toggle');
    await page.waitForFunction(() => document.documentElement.classList.contains('reduce-motion'));

    const view = await page.evaluate(() => {
        const band = document.querySelector('.hero-band').getBoundingClientRect();
        const notes = Array.from(document.querySelectorAll('.hero-note')).map((note) => {
            const box = note.getBoundingClientRect();
            const style = getComputedStyle(note);

            return {
                // Ширина по стилю: рамка у повёрнутого значка чуть шире самого значка
                size: Math.round(parseFloat(style.width)),
                opacity: Number(style.opacity),
                inside: box.left >= band.left - 4 && box.right <= band.right + 4 &&
                    box.top >= band.top - 4 && box.bottom <= band.bottom + 4,
                jump: style.getPropertyValue('--note-jump').trim()
            };
        });

        return {
            count: notes.length,
            sizes: notes.map((note) => note.size),
            opacities: notes.map((note) => note.opacity),
            outside: notes.filter((note) => !note.inside).length,
            jump: notes[0].jump,
            sheenCycle: getComputedStyle(document.querySelector('.hero-band')).getPropertyValue('--sheen-cycle').trim()
        };
    });

    assert.equal(view.count, 9, 'нот ровно столько же, сколько на компьютере');
    assert.ok(view.sizes.every((size) => size >= 16 && size <= 26),
        'на телефоне ноты мельче компьютерных: ' + view.sizes.join(', '));
    assert.ok(view.opacities.every((value) => value >= 0.4 && value <= 0.6),
        'на телефоне ноты тише: ' + view.opacities.join(', '));
    assert.equal(view.outside, 0, 'ни одна нота не вылезает за табло');
    assert.equal(view.jump, '12px', 'прыжок соразмерен мелким значкам');
    assert.equal(view.sheenCycle, '12s', 'темп блика задаётся переменной');

    assert.deepEqual(problems.filter((item) => !item.includes('Failed to load resource')), []);
    await page.close();
});

