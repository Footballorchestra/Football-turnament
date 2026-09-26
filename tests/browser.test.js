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

const ROOT = path.resolve(__dirname, '..');

/** Ищет исполняемый файл Chrome: переменная окружения, кэш puppeteer, системные пути. */
function findChrome() {
    const candidates = [];

    if (process.env.CHROME_PATH) {
        candidates.push(process.env.CHROME_PATH);
    }

    const cacheDir = '/root/.cache/puppeteer/chrome-headless-shell';

    if (fs.existsSync(cacheDir)) {
        fs.readdirSync(cacheDir).forEach((version) => {
            candidates.push(path.join(cacheDir, version, 'chrome-headless-shell-linux64', 'chrome-headless-shell'));
        });
    }

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
    autoPublishDelayMs: 50
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
    page.on('requestfailed', (request) => problems.push('Не загрузилось: ' + request.url()));

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

function clickAction(page, selector) {
    return page.click(selector);
}

test('страница открывается без ошибок: стили, локальные шрифты и CSP', { skip }, async () => {
    const { page, problems } = await openPage();

    const data = await dataSnapshot(page);
    assert.equal(await textOf(page, '#stat-teams'), String(data.teams));
    assert.equal(await textOf(page, '#stat-matches'), String(data.matches));

    // Стили из собранного Tailwind применились
    const background = await page.$eval('body', (element) => getComputedStyle(element).backgroundColor);
    assert.equal(background, 'rgb(248, 249, 250)');

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
    await page.click('[data-filter="finished"]');
    assert.equal(await page.$$eval('#matches-list .match-card', (cards) => cards.length), data.finished);

    assert.deepEqual(problems, [], 'ошибок по пути не возникло');
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
    await page.type('#admin-password', 'admin');
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
    assert.equal(await textOf(page, '#stat-teams'), String(before.teams + 1));
    assert.equal(await textOf(page, '#stat-matches'), String(before.matches));

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
    assert.equal(await textOf(page, '#stat-teams'), String(before.teams + 1));
    assert.equal(await textOf(page, '#stat-finished'), String(before.finished + 1));

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

        assert.equal(await textOf(page, '#stat-teams'), String(data.teams), 'данные загрузились из подпапки');
        assert.equal(await page.$$eval('#standings-body tr', (rows) => rows.length), data.teams);
        assert.equal(await page.$eval('body', (element) => getComputedStyle(element).backgroundColor), 'rgb(248, 249, 250)');

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
        ['/robots.txt', 'text/plain']
    ];

    for (const [url, expectedType] of resources) {
        const response = await fetch(baseUrl + url);
        const contentType = response.headers.get('content-type') || '';

        assert.equal(response.status, 200, 'код ответа для ' + url);
        assert.ok(contentType.includes(expectedType), 'тип для ' + url + ': получен ' + contentType);
    }

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

    assert.equal(await textOf(visitor.page, '#stat-teams'), String(remote.teams.length));
    assert.match(await textOf(visitor.page, '#teams-grid'), /Клуб из репозитория/);
    assert.match(await textOf(visitor.page, '#data-freshness'), /Данные обновлены: 10 сентября 2026/);
    assert.deepEqual(visitor.problems, []);
    assert.deepEqual(await visitor.page.evaluate(() => window.__cspViolations), []);
    await visitor.close();

    // 2. Администратор публикует новый клуб
    const admin = await openPage({ url: mockBaseUrl + '/', isolated: true });

    await clickWhenReady(admin.page, '[data-nav="admin"]');
    await admin.page.type('#admin-password', 'admin');
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

    assert.equal(await textOf(otherPage, '#stat-teams'), String(remote.teams.length + 1), 'другое устройство получило опубликованные данные');
    assert.match(await textOf(otherPage, '#teams-grid'), /Опубликовано из админки/);
    assert.match(await textOf(otherPage, '#data-freshness'), /10 сентября 2026|сентября 2026/);

    await otherPage.close();
    await otherContext.close();
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
    await page.type('#admin-password', 'admin');
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

    // Кнопка «Состав» раскрывает список игроков столбиком: имя, дата рождения, голы, карточки
    assert.equal(await page.$eval('#team-squad', (block) => block.hidden), true, 'список состава скрыт');

    await clickInView(page, '#team-detail [data-action="squad-toggle"]');

    assert.equal(await page.$eval('#team-squad', (block) => block.hidden), false, 'состав раскрылся по нажатию');
    assert.deepEqual(
        await page.$$eval('#team-squad thead th', (cells) => cells.map((cell) => cell.textContent.trim())),
        ['Игрок', 'Дата рождения', 'Г', 'Ж', 'К'],
        'столбцы состава'
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
    assert.equal(await sectionVisible(page, 'back-row'), false, 'кнопка скрыта');

    // Таблица → команда: кнопка знает, куда вернуться
    await page.click('[data-nav="standings"]');
    assert.equal(await sectionVisible(page, 'back-row'), true, 'кнопка появилась');
    assert.match(await textOf(page, '#back-target'), /Главная/);

    const teamId = await page.$eval('#standings-body tr[data-action="team-public-open"]',
        (row) => row.getAttribute('data-id'));

    await clickInView(page, '#standings-body tr[data-action="team-public-open"][data-id="' + teamId + '"]');
    assert.equal(await sectionVisible(page, 'team-detail-view'), true, 'открылась страница команды');
    assert.match(await textOf(page, '#back-target'), /Таблица/);

    await clickInView(page, '[data-action="go-back"]');
    assert.equal(await sectionVisible(page, 'page-standings'), true, 'вернулись в турнирную таблицу');
    assert.equal(await page.evaluate(() => window.location.hash), '#/standings');

    // И ещё раз — на главную: история пуста, кнопка снова скрыта
    await clickInView(page, '[data-action="go-back"]');
    assert.equal(await sectionVisible(page, 'page-home'), true, 'вернулись на главную');
    assert.equal(await sectionVisible(page, 'back-row'), false, 'история пуста — кнопки нет');

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
    await page.type('#admin-password', 'admin');
    await clickWhenReady(page, '[data-form="login"] button[type="submit"]');
    await page.waitForFunction(() => window.FTApp && window.FTApp.isAdmin());

    await clickInView(page, '[data-action="toggle-settings"]');
    await page.type('#github-token', 'test-token');
    await clickInView(page, '[data-action="github-save-token"]');
    await page.waitForFunction(() => document.getElementById('github-token').placeholder.includes('сохранён'));

    const logosBefore = await page.evaluate(() => Object.keys(window.FTApp.getData().teamPhotos || {}).length);

    // Открываем первую команду: в карточке есть загрузка эмблемы
    await clickWhenReady(page, '#admin-teams-list [data-action="team-open"]');
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

    const result = await page.evaluate(() => {
        const data = window.FTApp.getData();
        const team = data.teams[0];
        const image = document.querySelector('#admin-team-photo img.team-photo');

        return {
            count: Object.keys(data.teamPhotos || {}).length,
            path: team ? (data.teamPhotos[String(team.id)] || '') : '',
            previews: Object.keys(window.FTApp.getState().photoPreviews).length,
            width: image ? image.naturalWidth : 0
        };
    });

    assert.equal(result.count, logosBefore + 1, 'эмблема записана в данные');
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
test('карточка игрока: имя ведёт на карточку, администратор заполняет дату рождения и принадлежность', { skip }, async () => {
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
            hasBirthLine: box.textContent.includes('Дата рождения:'),
            hasNote: !!box.querySelector('.player-note-text'),
            stats: box.textContent.includes('В турнире: голы —')
        };
    });

    assert.equal(opened.hash, link.hash, 'страница игрока со своим адресом');
    assert.equal(opened.active, 'page-player', 'показана страница игрока');
    assert.match(opened.name, /\S/);
    assert.equal(opened.photo, true, 'крупное фото игрока');
    assert.match(opened.team, /\S/, 'видна команда игрока');
    assert.equal(opened.hasBirthLine, true, 'видна дата рождения');
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
        await page.type('#admin-password', 'admin');
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
        maxDate: document.getElementById('player-birth-date').getAttribute('max'),
        admin: document.querySelector('.page-section.active').id
    }));

    assert.equal(limits.admin, 'page-admin-dashboard', 'открылась админка с формой данных игрока');
    assert.equal(limits.maxLength, '200', 'длина принадлежности ограничена 200 символами');
    assert.match(limits.maxDate, /^\d{4}-\d{2}-\d{2}$/, 'будущие даты рождения выбрать нельзя');

    const note = 'Школа №5, первый тренер — Петров И. С 2023 года играет за «Добрик».';

    await page.$eval('#player-birth-date', (input) => {
        input.value = '2011-05-03';
    });
    await page.type('#player-note', note);
    await page.click('[data-form="player-info"] button[type="submit"]');

    await page.waitForFunction(() => document.getElementById('toast-container').textContent.includes('сохранены'));

    const saved = await page.evaluate((hash) => {
        const parts = hash.replace('#/player/', '').split('/');
        const data = window.FTApp.getData();
        const team = data.teams.find((item) => String(item.id) === parts[0]);
        const player = team ? team.players[Number(parts[1])] : '';
        const key = parts[0] + '|' + String(player).toLowerCase();

        return { key: key, value: (data.playerInfo || {})[key] || null };
    }, link.hash);

    assert.deepEqual(saved.value, { birthDate: '2011-05-03', note: note },
        'дата рождения и принадлежность сохранены (' + saved.key + ')');

    // 3. Данные видны на публичной карточке игрока
    await page.evaluate((hash) => {
        window.location.hash = hash;
    }, link.hash);
    await page.waitForFunction(() => document.getElementById('player-card').textContent.includes('3 мая 2011'));

    const shown = await page.evaluate(() => document.getElementById('player-card').textContent);

    assert.match(shown, /Школа №5, первый тренер/, 'принадлежность видна на карточке');

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
        freshness: document.getElementById('data-freshness').textContent,
        teams: document.getElementById('stat-teams').textContent
    }));

    assert.match(view.freshness, /Данные обновлены: 21 сентября 2026/);
    assert.match(view.freshness, /обновляется автоматически/, 'в подвале видно, что обновление автоматическое');
    assert.equal(view.teams, String(updated.teams.length), 'счётчики пересчитаны');

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
    const { page, problems } = await openPage({ url: mockBaseUrl + '/', isolated: true });

    // 1. Вход и токен публикации
    await clickWhenReady(page, '[data-nav="admin"]');
    await page.type('#admin-password', 'admin');
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
    await page.waitForFunction(() => {
        const image = document.querySelector('#admin-team-images .admin-gallery-item img');

        return !!image && image.getAttribute('src').indexOf('data:image/jpeg;base64,') === 0 &&
            image.complete && image.naturalWidth > 0;
    });

    const uploaded = await page.evaluate(() => {
        const data = window.FTApp.getData();
        const team = data.teams[0];
        const paths = (data.teamImages || {})[String(team.id)] || [];
        const image = document.querySelector('#admin-team-images .admin-gallery-item img');

        return {
            teamId: String(team.id),
            count: paths.length,
            path: paths[0] || '',
            width: image ? image.naturalWidth : 0,
            height: image ? image.naturalHeight : 0
        };
    });

    assert.equal(uploaded.count, 1, 'фотография записана в данные команды');
    assert.match(uploaded.path, /^assets\/photos\/team-photo-[a-z0-9-]+-[0-9a-f]{6}\.jpg$/, 'имя файла фотографии');
    assert.ok(mockRepository.state.files[uploaded.path], 'файл фотографии ушёл в репозиторий');
    assert.equal(uploaded.height, 900, 'пропорции сохранены (высота не сломана)');
    assert.ok(uploaded.width >= 1600, 'ширина сохранена, фото остаётся чётким: ' + uploaded.width);

    // 3. Публичная страница команды: фото в блоке «Фотографии»
    await clickWhenReady(page, '[data-nav="teams"]');
    await clickInView(page, '#teams-grid [data-action="team-public-open"][data-id="' + uploaded.teamId + '"] .team-name');
    await page.waitForFunction(() => !!document.querySelector('#team-detail .team-gallery-item'));

    const block = await page.evaluate(() => ({
        count: document.querySelectorAll('#team-detail .team-gallery-item').length,
        hasHeading: document.getElementById('team-detail').textContent.includes('Фотографии')
    }));

    assert.equal(block.count, 1, 'фотография видна в блоке на странице команды');
    assert.equal(block.hasHeading, true, 'у блока есть заголовок');

    // 4. Нажатие на фото — просмотр на весь экран
    await clickInView(page, '#team-detail .team-gallery-item');
    await page.waitForFunction(() => {
        const viewer = document.getElementById('image-viewer');
        const image = document.getElementById('image-viewer-photo');

        return !viewer.hidden && !!image && image.complete && image.naturalWidth > 0;
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

    const meaningful = problems.filter((item) => !item.includes('Failed to load resource'));

    assert.deepEqual(meaningful, [], 'нет ошибок консоли и сбоев загрузки');
    await page.close();
});

