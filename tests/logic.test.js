/**
 * Юнит-тесты чистой логики (assets/js/logic.js).
 * Запуск: npm test   (встроенный тест-раннер Node.js, внешних зависимостей нет)
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../assets/js/logic.js');

/** Простое «фальшивое» хранилище для проверки работы с localStorage. */
function fakeStorage(initial) {
    const map = new Map(Object.entries(initial || {}));

    return {
        getItem: (key) => (map.has(key) ? map.get(key) : null),
        setItem: (key, value) => map.set(key, String(value)),
        removeItem: (key) => map.delete(key),
        raw: map
    };
}

test('escapeHtml: экранирует опасные символы', () => {
    assert.equal(L.escapeHtml('<b>Спартак</b>'), '&lt;b&gt;Спартак&lt;/b&gt;');
    assert.equal(L.escapeHtml(`Том & "Джерри" 'x'`), 'Том &amp; &quot;Джерри&quot; &#39;x&#39;');
    assert.equal(L.escapeHtml(null), '');
    assert.equal(L.escapeHtml(undefined), '');
    assert.equal(L.escapeHtml(5), '5');
});

test('cleanText: убирает лишние пробелы и обрезает длину', () => {
    assert.equal(L.cleanText('  Реал   Мадрид  '), 'Реал Мадрид');
    assert.equal(L.cleanText('абвгде', 3), 'абв');
    assert.equal(L.cleanText(null), '');
});

test('toInt: приводит значения к целым числам', () => {
    assert.equal(L.toInt('42'), 42);
    assert.equal(L.toInt(7.9), 7);
    assert.equal(L.toInt(' 5 '), 5);
    assert.equal(L.toInt('abc'), null);
    assert.equal(L.toInt(''), null);
    assert.equal(L.toInt(null), null);
});

test('nextFreeId: выдаёт следующий свободный идентификатор', () => {
    assert.equal(L.nextFreeId([{ id: 1 }, { id: 5 }]), 6);
    assert.equal(L.nextFreeId([]), 1);
    assert.equal(L.nextFreeId([{ id: 'x' }, { id: 3 }]), 4);
});

test('parseISODate: локальная дата без сдвига часового пояса', () => {
    const date = L.parseISODate('2026-09-10');

    assert.equal(date.getFullYear(), 2026);
    assert.equal(date.getMonth(), 8);
    assert.equal(date.getDate(), 10);
    assert.equal(date.getHours(), 0);

    assert.equal(L.parseISODate('2026-02-31'), null, 'несуществующая дата отклоняется');
    assert.equal(L.parseISODate('10.09.2026'), null);
    assert.equal(L.parseISODate(''), null);
    assert.equal(L.parseISODate(null), null);
});

test('toISODate и todayISO: формат ГГГГ-ММ-ДД', () => {
    assert.equal(L.toISODate(new Date(2026, 0, 5)), '2026-01-05');
    assert.match(L.todayISO(), /^\d{4}-\d{2}-\d{2}$/);
});

test('formatDate: русские форматы и безопасный фолбэк', () => {
    assert.equal(L.formatDate('2026-09-10'), '10 сент.');
    assert.equal(L.formatDate('2026-09-10', 'long'), '10 сентября 2026');
    assert.equal(L.formatDate('2026-09-10', 'numeric'), '10.09.2026');
    assert.equal(L.formatDate('2026-05-01'), '1 мая');
    assert.equal(L.formatDate(''), 'Дата не указана');
    assert.equal(L.formatDate(null, 'long'), 'Дата не указана');
});

test('getTeamInitials: две буквы для любого названия', () => {
    assert.equal(L.getTeamInitials('Спартак'), 'СП');
    assert.equal(L.getTeamInitials('ЦСКА'), 'ЦС');
    assert.equal(L.getTeamInitials('Реал Мадрид'), 'РМ');
    assert.equal(L.getTeamInitials('  Динамо  '), 'ДИ');
    assert.equal(L.getTeamInitials(''), '?');
    assert.equal(L.getTeamInitials(null), '?');
});

test('badgeColorForTeam: цвет стабилен и укладывается в палитру', () => {
    assert.equal(L.badgeColorForTeam(1), L.badgeColorForTeam(1));
    assert.ok(L.BADGE_COLORS.includes(L.badgeColorForTeam(37)));
    assert.ok(L.BADGE_COLORS.includes(L.badgeColorForTeam('abc')));
});

test('validateTeamName: пустое имя, дубликат, обрезка длины, переименование', () => {
    const teams = [{ id: 1, name: 'Спартак' }, { id: 2, name: 'Зенит' }];

    assert.equal(L.validateTeamName('', teams).ok, false);
    assert.equal(L.validateTeamName('   ', teams).ok, false);
    assert.equal(L.validateTeamName('зенит', teams).error, 'Команда с таким названием уже есть');
    assert.equal(L.validateTeamName('Зенит', teams, { ignoreId: 2 }).ok, true, 'себя переименовывать можно');
    assert.equal(L.validateTeamName('а'.repeat(31), teams).value.length, 30, 'длинное имя обрезается');
    assert.deepEqual(L.validateTeamName('  Динамо   Минск ', teams), { ok: true, value: 'Динамо Минск' });
});

test('validatePlayerName: пустое имя и дубликат внутри команды', () => {
    const team = { id: 1, name: 'Спартак', players: ['Иванов А.'] };

    assert.equal(L.validatePlayerName('', team).ok, false);
    assert.equal(L.validatePlayerName('иванов а.', team).ok, false);
    assert.equal(L.validatePlayerName('Иванов А.', team, { ignoreIndex: 0 }).ok, true);
    assert.equal(L.validatePlayerName('Петров П.', team).ok, true);
});

test('normalizeScore: допустим пустой ввод или целое 0…99', () => {
    assert.equal(L.normalizeScore(''), null);
    assert.equal(L.normalizeScore('   '), null);
    assert.equal(L.normalizeScore(null), null);
    assert.equal(L.normalizeScore('0'), 0);
    assert.equal(L.normalizeScore(7), 7);
    assert.ok(Number.isNaN(L.normalizeScore('3.5')));
    assert.ok(Number.isNaN(L.normalizeScore('-1')));
    assert.ok(Number.isNaN(L.normalizeScore('abc')));
    assert.ok(Number.isNaN(L.normalizeScore('100')));
});

test('validateMatchInput: все проверки формы матча', () => {
    const teams = [{ id: 1, name: 'A' }, { id: 2, name: 'B' }];
    const base = { teamA: 1, teamB: 2, date: '2026-09-20', scoreA: '', scoreB: '' };

    assert.equal(L.validateMatchInput(Object.assign({}, base, { teamA: '' }), teams).ok, false);
    assert.equal(L.validateMatchInput(Object.assign({}, base, { teamA: 99 }), teams).error, 'Выберите первую команду');
    assert.equal(L.validateMatchInput(Object.assign({}, base, { teamB: '' }), teams).error, 'Выберите вторую команду');
    assert.equal(L.validateMatchInput(Object.assign({}, base, { teamB: 1 }), teams).error, 'Команды должны быть разными');
    assert.equal(L.validateMatchInput(Object.assign({}, base, { date: '31.12.2026' }), teams).error, 'Укажите дату матча');
    assert.equal(L.validateMatchInput(Object.assign({}, base, { scoreA: '2' }), teams).error,
        'Заполните счёт обеих команд или оставьте оба поля пустыми');
    assert.equal(L.validateMatchInput(Object.assign({}, base, { scoreA: '2', scoreB: 'x' }), teams).ok, false);

    const upcoming = L.validateMatchInput(base, teams);
    assert.equal(upcoming.ok, true);
    assert.equal(upcoming.match.finished, false);
    assert.equal(upcoming.match.scoreA, null);

    const finished = L.validateMatchInput(Object.assign({}, base, { scoreA: '3', scoreB: '0' }), teams);
    assert.equal(finished.match.finished, true);
    assert.deepEqual([finished.match.scoreA, finished.match.scoreB], [3, 0]);
});

test('adminPasswordMatches: сравнение пароля', () => {
    assert.equal(L.adminPasswordMatches('admin'), true);
    assert.equal(L.adminPasswordMatches('admin '), false);
    assert.equal(L.adminPasswordMatches(''), false);
    assert.equal(L.adminPasswordMatches(undefined), false);
});

test('computeStandings: очки, разница мячей и места команд', () => {
    const data = L.createDefaultData();
    const rows = L.computeStandings(data.teams, data.matches);

    assert.deepEqual(rows.map((row) => row.name), ['Спартак', 'Динамо', 'ЦСКА', 'Локомотив']);
    assert.deepEqual(rows.map((row) => row.points), [3, 1, 1, 0]);

    const spartak = rows[0];
    assert.equal(spartak.played, 1);
    assert.equal(spartak.wins, 1);
    assert.equal(spartak.goalsFor, 2);
    assert.equal(spartak.goalsAgainst, 1);
    assert.equal(spartak.goalDiff, 1);
    assert.equal('form' in spartak, false, 'формы команды в таблице больше нет');
});

test('computeStandings: сортировка по разнице мячей и по названию', () => {
    const teams = [{ id: 1, name: 'Бета' }, { id: 2, name: 'Альфа' }, { id: 3, name: 'Гамма' }];
    // «Бета» и «Альфа» набирают абсолютно одинаковые показатели — порядок решает название
    const matches = [
        { id: 1, teamA: 1, teamB: 3, scoreA: 4, scoreB: 0, date: '2026-09-01', finished: true },
        { id: 2, teamA: 2, teamB: 3, scoreA: 4, scoreB: 0, date: '2026-09-02', finished: true },
        { id: 3, teamA: 1, teamB: 2, scoreA: 1, scoreB: 1, date: '2026-09-03', finished: true },
        { id: 4, teamA: 2, teamB: 1, scoreA: 0, scoreB: 0, date: '2026-09-04', finished: false }
    ];

    const rows = L.computeStandings(teams, matches);
    const alfa = rows.find((row) => row.name === 'Альфа');
    const beta = rows.find((row) => row.name === 'Бета');

    assert.deepEqual([alfa.points, alfa.goalDiff, alfa.goalsFor], [4, 4, 5]);
    assert.deepEqual([beta.points, beta.goalDiff, beta.goalsFor], [4, 4, 5]);
    assert.deepEqual(rows.map((row) => row.name), ['Альфа', 'Бета', 'Гамма'], 'при полном равенстве — по алфавиту');
    assert.equal(alfa.played, 2, 'незавершённый матч не учитывается');
    assert.equal(rows[2].points, 0);
    assert.deepEqual(rows.map((row) => row.place), [1, 2, 3]);
});

test('computeStandings: матч с несуществующей командой игнорируется', () => {
    const teams = [{ id: 1, name: 'A', players: [] }];
    const rows = L.computeStandings(teams, [{ id: 9, teamA: 1, teamB: 42, scoreA: 3, scoreB: 0, finished: true }]);

    assert.equal(rows.length, 1);
    assert.equal(rows[0].played, 0);
});

test('getStats: сводка по данным', () => {
    const stats = L.getStats(L.createDefaultData());

    assert.deepEqual(stats, { teams: 4, matches: 4, players: 9, finished: 2, upcoming: 2, goals: 5 });
});

test('sortMatches и selectMatches: порядок и фильтры', () => {
    const matches = [
        { id: 1, teamA: 1, teamB: 2, date: '2026-09-10', scoreA: 2, scoreB: 1, finished: true },
        { id: 2, teamA: 1, teamB: 2, date: '2026-10-10', scoreA: null, scoreB: null, finished: false },
        { id: 3, teamA: 1, teamB: 2, date: '', scoreA: null, scoreB: null, finished: false }
    ];

    assert.deepEqual(L.sortMatches(matches, 'asc').map((m) => m.id), [1, 2, 3], 'матч без даты уходит в конец');
    assert.deepEqual(L.sortMatches(matches, 'desc').map((m) => m.id), [2, 1, 3]);
    assert.deepEqual(L.selectMatches(matches, 'finished').map((m) => m.id), [1]);
    assert.deepEqual(L.selectMatches(matches, 'upcoming').map((m) => m.id), [2, 3]);
    assert.equal(L.selectMatches(matches, 'all').length, 3);
    assert.equal(matches[0].id, 1, 'исходный массив не мутируется (было побочным эффектом в старой версии)');
});

test('searchMatches: поиск по части названия команды', () => {
    const teams = [
        { id: 1, name: 'Ветераны МГК' },
        { id: 2, name: 'ФК Моцарт' },
        { id: 3, name: 'Большой Театр' }
    ];
    const matches = [
        { id: 1, teamA: 1, teamB: 2, date: '2026-09-07' },
        { id: 2, teamA: 3, teamB: 1, date: '2026-09-14' },
        { id: 3, teamA: 2, teamB: 3, date: '2026-09-21' }
    ];

    // Пустой запрос и одни пробелы ничего не отсеивают
    assert.equal(L.searchMatches(matches, teams, '').length, 3);
    assert.equal(L.searchMatches(matches, teams, '   ').length, 3);
    assert.deepEqual(L.searchMatches(null, teams, 'Моц'), [], 'нет списка матчей — пустой результат');

    // Часть названия, регистр не важен
    assert.deepEqual(L.searchMatches(matches, teams, 'ветер').map((m) => m.id), [1, 2]);
    assert.deepEqual(L.searchMatches(matches, teams, 'МОЦАРТ').map((m) => m.id), [1, 3]);

    // Матч находится по любой из двух команд, «часть слова» тоже подходит
    assert.deepEqual(L.searchMatches(matches, teams, 'Театр').map((m) => m.id), [2, 3]);
    assert.deepEqual(L.searchMatches(matches, teams, 'ФК').map((m) => m.id), [1, 3]);

    // Ничего не нашлось
    assert.deepEqual(L.searchMatches(matches, teams, 'зенит'), []);
    assert.equal(matches.length, 3, 'исходный список матчей не меняется');
});

test('teamMatches: матчи одной команды — прошедшие, затем предстоящие', () => {
    const matches = [
        { id: 1, teamA: 1, teamB: 2, date: '2026-09-10', scoreA: 2, scoreB: 1, finished: true },
        { id: 2, teamA: 3, teamB: 4, date: '2026-09-11', scoreA: 1, scoreB: 1, finished: true },
        { id: 3, teamA: 1, teamB: 3, date: '2026-09-20', scoreA: null, scoreB: null, finished: false },
        { id: 4, teamA: 1, teamB: 4, date: '2026-09-13', scoreA: 0, scoreB: 3, finished: true },
        { id: 5, teamA: 1, teamB: 4, date: '2026-09-25', scoreA: null, scoreB: null, finished: false }
    ];

    // Прошедшие — от новых к старым (13-е раньше 10-го), затем предстоящие по дате
    assert.deepEqual(L.teamMatches(matches, 1).map((m) => m.id), [4, 1, 3, 5]);
    assert.deepEqual(L.teamMatches(matches, 3).map((m) => m.id), [2, 3], 'только матчи этой команды');
    assert.deepEqual(L.teamMatches(matches, '1').map((m) => m.id), [4, 1, 3, 5], 'id строкой тоже подходит');
    assert.deepEqual(L.teamMatches(matches, 9).map((m) => m.id), [], 'у неизвестной команды матчей нет');
    assert.deepEqual(L.teamMatches(null, 1), [], 'нет списка матчей — пустой результат');
    assert.equal(matches.length, 5, 'исходный список не меняется');
});

test('фото игроков: запись, чтение, перенос при переименовании и очистка', () => {
    const data = L.createDefaultData();
    const path = 'assets/photos/ivanov-a-1a2b3c.jpg';

    assert.equal(L.photoKey(1, 'Иванов А.'), '1|иванов а.', 'ключ — команда и имя в нижнем регистре');
    assert.equal(L.getPhoto(data, 1, 'Иванов А.'), '', 'фото ещё нет');
    assert.equal(L.hasPhoto(data, 1, 'Иванов А.'), false);

    L.setPhoto(data, 1, 'Иванов А.', path);
    assert.equal(L.getPhoto(data, 1, 'Иванов А.'), path);
    assert.equal(L.getPhoto(data, 1, 'иванов а.'), path, 'регистр имени не важен');
    assert.equal(L.hasPhoto(data, 1, 'Иванов А.'), true);
    assert.equal(L.getPhoto(data, 2, 'Иванов А.'), '', 'у другой команды своё фото');

    // Пути проверяются: всё, кроме файла внутри папки фотографий, отбрасывается
    assert.equal(L.isValidPhotoPath('assets/photos/ok-name.jpg'), true);
    assert.equal(L.isValidPhotoPath('../secrets.jpg'), false);
    assert.equal(L.isValidPhotoPath('/assets/photos/ok.jpg'), false);
    assert.equal(L.isValidPhotoPath('assets/photos/ok.jpg?x=1'), false);
    assert.equal(L.isValidPhotoPath('javascript:alert(1)'), false);
    assert.equal(L.isValidPhotoPath('assets/photos/плохое имя.jpg'), false);
    assert.equal(L.isValidPhotoPath('х'.repeat(L.CONFIG.maxPhotoPathLength)), false);
    assert.equal(L.isValidPhotoPath(42), false);

    L.setPhoto(data, 1, 'Иванов А.', 'http://чужой-сайт/x.jpg');
    assert.equal(L.getPhoto(data, 1, 'Иванов А.'), '', 'недопустимый путь не сохраняется');

    // Переименование игрока переносит фото на новое имя
    L.setPhoto(data, 1, 'Иванов А.', path);
    L.renamePlayerPhoto(data, 1, 'Иванов А.', 'Иванов-старший');
    assert.equal(L.getPhoto(data, 1, 'Иванов-старший'), path);
    assert.equal(L.getPhoto(data, 1, 'Иванов А.'), '');

    // Удаление игрока и команды
    L.setPhoto(data, 3, 'Смирнов Д.', path);
    L.removePhoto(data, 3, 'Смирнов Д.');
    assert.equal(L.getPhoto(data, 3, 'Смирнов Д.'), '');

    L.setPhoto(data, 2, 'Кузнецов К.', path);
    L.setPhoto(data, 2, 'Попов П.', path);
    L.removeTeamPhotos(data, 2);
    assert.equal(L.getPhoto(data, 2, 'Кузнецов К.'), '', 'фото команды удалены');
    assert.equal(L.getPhoto(data, 2, 'Попов П.'), '');
    assert.equal(L.getPhoto(data, 3, 'Смирнов Д.'), '', 'чужие фото не задеты');
});

test('нормализация фото: валидные пути остаются, «мусор» и фото ушедших игроков отбрасываются', () => {
    const result = L.normalizeData({
        teams: [
            { id: 1, name: 'Спартак', players: ['Иванов А.'] },
            { id: 2, name: 'Зенит', players: [] }
        ],
        matches: [],
        photos: {
            '1|Иванов А.': 'assets/photos/ivanov-a-1a2b3c.jpg',
            '1|Ушедший У.': 'assets/photos/gone-111111.jpg',
            '2|Кто-то': 'assets/photos/nobody-222222.jpg',
            '1|Иванов А.2': '../etc/passwd',
            'нет|ключа': 'assets/photos/x-333333.jpg'
        }
    });

    assert.deepEqual(Object.keys(result.data.photos), ['1|иванов а.'], 'осталось только фото игрока из заявки');
    assert.equal(result.data.photos['1|иванов а.'], 'assets/photos/ivanov-a-1a2b3c.jpg');
    assert.equal(result.repaired, true, 'отброшенные записи — это исправление данных');
    assert.equal(result.data.version, 6);

    // Старый файл без карты фото грузится без предупреждений
    const legacy = L.normalizeData({ teams: [{ id: 1, name: 'A', players: ['X'] }], matches: [] });
    assert.deepEqual(legacy.data.photos, {});
    assert.equal(legacy.repaired, false, 'отсутствие фото — не повреждение данных');
});

test('экспорт и импорт данных переносят фото', () => {
    const data = L.createDefaultData();

    L.setPhoto(data, 1, 'Иванов А.', 'assets/photos/ivanov-a-1a2b3c.jpg');
    L.setTeamPhoto(data, 1, 'assets/photos/team-spartak-4d5e6f.jpg');

    const text = L.serializeData(data);

    assert.ok(text.indexOf('assets/photos/ivanov-a-1a2b3c.jpg') !== -1, 'путь к фото попал в экспорт');
    assert.ok(text.indexOf('assets/photos/team-spartak-4d5e6f.jpg') !== -1, 'эмблема команды попала в экспорт');

    const imported = L.parseImport(text);
    assert.equal(imported.ok, true);
    assert.equal(L.getPhoto(imported.data, 1, 'Иванов А.'), 'assets/photos/ivanov-a-1a2b3c.jpg');
    assert.equal(L.getTeamPhoto(imported.data, 1), 'assets/photos/team-spartak-4d5e6f.jpg');
});

test('эмблема команды: запись, чтение, удаление и нормализация', () => {
    const data = L.createDefaultData();
    const path = 'assets/photos/team-spartak-33abcd.jpg';

    assert.equal(L.teamPhotoKey(1), '1');
    assert.equal(L.getTeamPhoto(data, 1), '', 'эмблемы ещё нет');
    assert.equal(L.hasTeamPhoto(data, 1), false);

    L.setTeamPhoto(data, 1, path);
    assert.equal(L.getTeamPhoto(data, 1), path);
    assert.equal(L.hasTeamPhoto(data, 1), true);
    assert.equal(L.getTeamPhoto(data, 2), '', 'у другой команды своя эмблема');

    // Недопустимый путь не сохраняется
    L.setTeamPhoto(data, 1, 'team-spartak.png');
    assert.equal(L.getTeamPhoto(data, 1), '');

    // Нормализация: остаются только эмблемы существующих команд с корректным путём
    const result = L.normalizeData({
        teams: [{ id: 1, name: 'Спартак', players: [] }, { id: 2, name: 'Зенит', players: [] }],
        matches: [],
        teamPhotos: {
            '1': 'assets/photos/team-spartak-33abcd.jpg',
            '9': 'assets/photos/team-gone-111111.jpg',
            '2': '../evil.jpg'
        }
    });

    assert.deepEqual(result.data.teamPhotos, { '1': 'assets/photos/team-spartak-33abcd.jpg' });
    assert.equal(result.repaired, true, 'отброшенные эмблемы — исправление данных');
    assert.equal(result.data.version, 6);

    // Удаление и данные без карты эмблем загружаются без предупреждений
    L.removeTeamPhoto(data, 1);
    assert.equal(L.getTeamPhoto(data, 1), '');
    assert.equal(L.normalizeData({ teams: [{ id: 1, name: 'A', players: [] }], matches: [] }).repaired, false);
});

test('normalizeData: мусор на входе даёт демонстрационные данные', () => {
    [null, undefined, 42, 'текст', {}, { teams: [] }, { teams: {}, matches: [] }].forEach((value) => {
        const result = L.normalizeData(value);

        assert.equal(result.repaired, true);
        assert.equal(result.data.teams.length, 4);
    });
});

test('normalizeData: чинит дубликаты, битые id и «висячие» матчи', () => {
    const result = L.normalizeData({
        teams: [
            { id: 1, name: 'Спартак', players: ['Иванов А.', 'Иванов А.', '', null] },
            { id: 1, name: 'спартак', players: [] },
            { id: 'x', name: 'Зенит', players: 'не массив' },
            { name: 'Зенит', players: [] },
            { id: 5, name: '   ', players: [] }
        ],
        matches: [
            { id: 1, teamA: 1, teamB: 2, scoreA: 2, scoreB: 1, date: '2026-09-10', finished: true },
            { id: 1, teamA: 1, teamB: 2, scoreA: '1', scoreB: '1', date: '2026-09-11', finished: true },
            { id: 3, teamA: 1, teamB: 999, scoreA: 1, scoreB: 0, date: '2026-09-12', finished: true },
            { id: 4, teamA: 1, teamB: 1, scoreA: 1, scoreB: 0, date: '2026-09-13', finished: true },
            { id: 5, teamA: 1, teamB: 2, scoreA: 3, scoreB: null, date: null, finished: true }
        ]
    });

    assert.equal(result.repaired, true);
    assert.deepEqual(result.data.teams.map((team) => team.name), ['Спартак', 'Зенит']);
    assert.deepEqual(result.data.teams[0].players, ['Иванов А.'], 'дубликаты и пустые имена удалены');
    assert.deepEqual(result.data.teams.map((team) => team.id), [1, 2]);
    assert.equal(result.data.matches.length, 3, 'матчи без команд, с чужой командой и «сам с собой» удалены');
    assert.deepEqual(result.data.matches[1].scoreA, 1, 'строковый счёт приводится к числу');
    assert.equal(result.data.matches[1].finished, true);
    assert.equal(result.data.matches[1].date, '2026-09-11');

    // Матч с единственным счётом не теряется, а возвращается в статус «предстоящий»
    const partial = result.data.matches.filter((match) => match.scoreA === null && match.scoreB === null);
    assert.equal(partial.length, 1);
    assert.equal(partial[0].finished, false);
    assert.equal(L.getStats(result.data).finished, 2, 'в зачёт идут только матчи с полным счётом');
});

test('normalizeData: матч с единственным счётом становится предстоящим', () => {
    const result = L.normalizeData({
        teams: [{ id: 1, name: 'A' }, { id: 2, name: 'B' }],
        matches: [{ id: 1, teamA: 1, teamB: 2, scoreA: 3, scoreB: null, date: '2026-09-10', finished: true }]
    });

    assert.equal(result.repaired, true);
    assert.equal(result.data.matches[0].scoreA, null);
    assert.equal(result.data.matches[0].finished, false);
});

test('loadFromStorage: первый запуск, битый JSON, отсутствие хранилища', () => {
    const empty = L.loadFromStorage(fakeStorage({}));
    assert.equal(empty.fresh, true);
    assert.equal(empty.repaired, false);

    const broken = L.loadFromStorage(fakeStorage({ [L.CONFIG.storageKey]: '{это не json' }));
    assert.equal(broken.repaired, true);
    assert.equal(broken.error, 'invalid-json');
    assert.equal(broken.data.teams.length, 4, 'приложение не падает, показываются демо-данные');

    const denied = L.loadFromStorage({
        getItem() { throw new Error('SecurityError'); },
        setItem() { throw new Error('SecurityError'); }
    });
    assert.equal(denied.error, 'storage-denied');
    assert.equal(denied.data.teams.length, 4);

    assert.equal(L.loadFromStorage(null).error, 'storage-unavailable');
});

test('loadFromStorage и saveToStorage: сохранение и чтение', () => {
    const storage = fakeStorage({});
    const data = L.createDefaultData();

    data.teams.push({ id: 5, name: 'Зенит', players: [] });

    assert.equal(L.saveToStorage(storage, data).ok, true);
    assert.equal(L.loadFromStorage(storage).data.teams.length, 5);

    const full = { getItem: () => null, setItem() { throw new Error('QuotaExceeded'); } };
    const failed = L.saveToStorage(full, data);

    assert.equal(failed.ok, false);
    assert.match(failed.error, /Не удалось сохранить/);
});

test('данные старой версии сайта загружаются без изменений', () => {
    // Ровно тот JSON, который писала прежняя версия в localStorage
    const legacy = {
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

    const loaded = L.loadFromStorage(fakeStorage({ [L.CONFIG.storageKey]: JSON.stringify(legacy) }));

    assert.equal(loaded.repaired, false, 'перенос данных не требует исправлений');
    assert.deepEqual(loaded.data.teams, legacy.teams);

    // Все поля матчей сохраняются один в один, события (их раньше не было) — пустые
    assert.equal(loaded.data.matches.length, legacy.matches.length);
    loaded.data.matches.forEach((match, index) => {
        const source = legacy.matches[index];

        assert.deepEqual(
            {
                id: match.id, teamA: match.teamA, teamB: match.teamB,
                scoreA: match.scoreA, scoreB: match.scoreB, date: match.date, finished: match.finished
            },
            source
        );
        assert.deepEqual(match.events, [], 'у матчей старой версии нет голов и пасов');
    });

    assert.deepEqual(L.getStats(loaded.data), { teams: 4, matches: 4, players: 9, finished: 2, upcoming: 2, goals: 5 });
});

test('события матча: голы и карточки', () => {
    let events = [];

    events = L.addEvent(events, 2, 'Петров П.', 'goal');
    events = L.addEvent(events, 2, 'Петров П.', 'yellow');
    events = L.addEvent(events, 2, 'Сидоров С.', 'red');
    events = L.addEvent(events, 1, 'Иванов А.', 'goal');
    const twoGoals = L.addEvent(events, 1, 'Иванов А.', 'goal');

    assert.equal(twoGoals.length, 5);
    assert.equal(L.playerEventCount(twoGoals, 2, 'Петров П.', 'goal'), 1);
    assert.equal(L.playerEventCount(twoGoals, 2, 'Петров П.', 'yellow'), 1);
    assert.equal(L.playerEventCount(twoGoals, 2, 'Сидоров С.', 'red'), 1);
    assert.equal(L.playerEventCount(twoGoals, 1, 'Иванов А.', 'goal'), 2);
    assert.equal(L.playerEventCount(twoGoals, 1, 'иванов а.'), 2, 'без типа — все события игрока');
    assert.equal(L.playerEventCount(twoGoals, 9, 'Иванов А.', 'goal'), 0, 'чужая команда — ничего');
    assert.equal(L.playerEventCount(twoGoals, 2, 'Петров П.', 'red'), 0, 'другой тип события не считается');
    assert.equal(L.countTeamEvents(twoGoals, 1), 2);
    assert.equal(L.countTeamEvents(twoGoals, 2, 'yellow'), 1);
    assert.equal(L.countTeamEvents(twoGoals, 2, 'goal'), 1);

    // Некорректные записи не добавляются (голевых передач в новых данных нет)
    assert.equal(L.addEvent(twoGoals, 1, '', 'goal').length, 5);
    assert.equal(L.addEvent(twoGoals, 1, 'Иванов А.', 'карточка').length, 5);
    assert.equal(L.addEvent(twoGoals, 1, 'Иванов А.', 'assist').length, 5);
    assert.equal(L.addEvent(twoGoals, null, 'Иванов А.', 'goal').length, 5);

    // Убирается последняя запись игрока, исходный список не меняется
    const undone = L.removeLastEvent(twoGoals, 1, 'Иванов А.', 'goal');
    assert.equal(L.playerEventCount(undone, 1, 'Иванов А.', 'goal'), 1);
    assert.equal(L.playerEventCount(L.removeLastEvent(twoGoals, 2, 'Петров П.', 'yellow'), 2, 'Петров П.', 'yellow'), 0);
    assert.equal(twoGoals.length, 5, 'исходный список не мутируется');

    assert.equal(L.isEventType('goal'), true);
    assert.equal(L.isEventType('yellow'), true);
    assert.equal(L.isEventType('red'), true);
    assert.equal(L.isEventType('assist'), false, 'голевые передачи больше не поддерживаются');
    assert.equal(L.isEventType('карточка'), false);
    assert.equal(L.eventLabel('goal'), 'Гол');
    assert.equal(L.eventLabel('yellow'), 'Жёлтая карточка');
    assert.equal(L.eventLabel('red'), 'Красная карточка');
});

test('normalizeMatchEvents: остаются только корректные события команд матча', () => {
    const match = { teamA: 1, teamB: 2 };
    const result = L.normalizeMatchEvents([
        { team: 1, player: 'Иванов А.', type: 'goal' },
        { team: 2, player: '  Кузнецов К.  ', type: 'yellow' },
        { team: 1, player: 'Петров П.', type: 'red' },
        { team: 3, player: 'Чужой', type: 'goal' },
        { team: 1, player: '', type: 'goal' },
        { team: 1, player: 'Голевой Г.', type: 'assist' },
        'мусор'
    ], match);

    assert.equal(result.repaired, true);
    assert.deepEqual(result.events, [
        { team: 1, player: 'Иванов А.', type: 'goal' },
        { team: 2, player: 'Кузнецов К.', type: 'yellow' },
        { team: 1, player: 'Петров П.', type: 'red' }
    ]);

    assert.deepEqual(L.normalizeMatchEvents(undefined, match), { events: [], repaired: false });
    assert.deepEqual(L.normalizeMatchEvents('нет', match), { events: [], repaired: true });
});

test('matchSquad: состав плюс игроки с записями, которых уже нет в заявке', () => {
    const team = { id: 1, players: ['Иванов А.', 'Петров П.'] };
    const events = [
        { team: 1, player: 'Петров П.', type: 'goal' },
        { team: 1, player: 'Ушедший У.', type: 'goal' },
        { team: 2, player: 'Волков В.', type: 'goal' }
    ];

    assert.deepEqual(L.matchSquad(team, events, 1), ['Иванов А.', 'Петров П.', 'Ушедший У.']);
    assert.deepEqual(L.matchSquad({ id: 2, players: [] }, events, 2), ['Волков В.'], 'в заявке пусто — видны записи');
    assert.deepEqual(L.matchSquad(null, events, 2), ['Волков В.'], 'команды нет — остаются только записи');
});

test('переименование игрока переносит его записи на новое имя', () => {
    const events = [
        { team: 1, player: 'Иванов А.', type: 'goal' },
        { team: 2, player: 'Иванов А.', type: 'yellow' }
    ];
    const renamed = L.renamePlayerEvents(events, 1, 'Иванов А.', 'Иванов-старший');

    assert.deepEqual(renamed, [
        { team: 1, player: 'Иванов-старший', type: 'goal' },
        { team: 2, player: 'Иванов А.', type: 'yellow' }
    ]);
    assert.equal(events[0].player, 'Иванов А.', 'исходный список не мутируется');
});

test('порядок матчей в админке: сначала прошедшие, затем предстоящие', () => {
    const matches = [
        { id: 1, teamA: 1, teamB: 2, scoreA: null, scoreB: null, date: '2026-09-25', finished: false },
        { id: 2, teamA: 1, teamB: 2, scoreA: 1, scoreB: 0, date: '2026-09-10', finished: true },
        { id: 3, teamA: 1, teamB: 2, scoreA: null, scoreB: null, date: '2026-09-20', finished: false },
        { id: 4, teamA: 1, teamB: 2, scoreA: 0, scoreB: 3, date: '2026-09-15', finished: true }
    ];

    const groups = L.groupMatchesForAdmin(matches);

    assert.deepEqual(groups.finished.map((match) => match.id), [4, 2], 'прошедшие — от новых к старым');
    assert.deepEqual(groups.upcoming.map((match) => match.id), [3, 1], 'предстоящие — от ближних к дальним');
    assert.deepEqual(groups.all.map((match) => match.id), [4, 2, 3, 1]);
});

test('normalizeData: события матчей сохраняются, «мусор» отбрасывается', () => {
    const result = L.normalizeData({
        teams: [
            { id: 1, name: 'Спартак', players: ['Иванов А.'] },
            { id: 2, name: 'Зенит', players: [] }
        ],
        matches: [{
            id: 1, teamA: 1, teamB: 2, scoreA: 1, scoreB: 0, date: '2026-09-10', finished: true,
            events: [
                { team: 1, player: 'Иванов А.', type: 'goal' },
                { team: 5, player: 'Чужой', type: 'goal' }
            ]
        }]
    });

    assert.equal(result.repaired, true, 'событие чужой команды — это исправление данных');
    assert.deepEqual(result.data.matches[0].events, [{ team: 1, player: 'Иванов А.', type: 'goal' }]);
    assert.equal(result.data.version, 6, 'в данных отмечена новая версия формата');
});

test('лучшие бомбардиры: сортировка по голам, при равенстве — по имени', () => {
    const data = {
        teams: [
            { id: 1, name: 'Спартак', players: ['Иванов А.', 'Петров П.'] },
            { id: 2, name: 'Динамо', players: ['Сидоров С.'] }
        ],
        matches: [
            {
                id: 1, teamA: 1, teamB: 2, scoreA: 3, scoreB: 1, date: '2026-09-10', finished: true,
                events: [
                    { team: 1, player: 'Иванов А.', type: 'goal' },
                    { team: 1, player: 'Иванов А.', type: 'goal' },
                    { team: 1, player: 'Петров П.', type: 'yellow' },
                    { team: 2, player: 'Сидоров С.', type: 'goal' }
                ]
            },
            {
                id: 2, teamA: 2, teamB: 1, scoreA: 2, scoreB: 1, date: '2026-09-17', finished: true,
                events: [
                    { team: 1, player: 'Петров П.', type: 'goal' },
                    { team: 1, player: 'Иванов А.', type: 'red' }
                ]
            }
        ]
    };

    const rows = L.computePlayerStats(data);

    // Сначала по голам, при равенстве — по имени: карточки на порядок не влияют
    assert.deepEqual(rows.map((row) => row.player), ['Иванов А.', 'Петров П.', 'Сидоров С.']);
    assert.deepEqual(
        rows.map((row) => ({ goals: row.goals, yellow: row.yellow, red: row.red, team: row.teamName })),
        [
            { goals: 2, yellow: 0, red: 1, team: 'Спартак' },
            { goals: 1, yellow: 1, red: 0, team: 'Спартак' },
            { goals: 1, yellow: 0, red: 0, team: 'Динамо' }
        ]
    );
    assert.deepEqual(rows.map((row) => row.place), [1, 2, 3]);
});

test('лучшие бомбардиры: только забивавшие, равные голы — по имени', () => {
    const data = {
        teams: [
            { id: 1, name: 'Спартак', players: ['Иванов А.', 'Петров П.', 'Сидоров С.'] },
            { id: 2, name: 'Динамо', players: [] }
        ],
        matches: [{
            id: 1, teamA: 1, teamB: 2, scoreA: 2, scoreB: 0, date: '2026-09-10', finished: true,
            events: [
                { team: 1, player: 'Петров П.', type: 'goal' },
                { team: 1, player: 'Иванов А.', type: 'goal' },
                { team: 1, player: 'Иванов А.', type: 'yellow' },
                { team: 1, player: 'Сидоров С.', type: 'yellow' }
            ]
        }]
    };

    const rows = L.computePlayerStats(data);

    // Один гол у обоих: порядок решает имя, карточка у Иванова его не опускает
    assert.deepEqual(rows.map((row) => row.player), ['Иванов А.', 'Петров П.']);
    assert.equal(rows.some((row) => row.player === 'Сидоров С.'), false, 'игрок только с карточкой не бомбардир');

    // Нумерация идёт подряд — без пропусков из-за отброшенных записей
    assert.deepEqual(rows.map((row) => row.place), [1, 2]);
});

test('лучшие бомбардиры: пустые данные и записи игроков без заявки', () => {
    assert.deepEqual(L.computePlayerStats(null), []);
    assert.deepEqual(L.computePlayerStats({ teams: [], matches: [] }), []);

    // Игрок отмечен в матче, но из состава его убрали: запись остаётся, команда известна
    const rows = L.computePlayerStats({
        teams: [{ id: 1, name: 'Спартак', players: [] }],
        matches: [{
            id: 1, teamA: 1, teamB: 2, scoreA: 1, scoreB: 0, date: '2026-09-10', finished: true,
            events: [
                { team: 1, player: 'Ушедший У.', type: 'goal' },
                { team: 9, player: 'Чужой Ч.', type: 'goal' },
                { team: 1, player: 'Ушедший У.', type: 'карточка' }
            ]
        }]
    });

    assert.equal(rows.length, 2, 'неизвестный тип события не считается');
    assert.deepEqual(rows[0], {
        teamId: 1, teamName: 'Спартак', player: 'Ушедший У.', goals: 1, yellow: 0, red: 0, place: 1
    });
    assert.equal(rows[1].teamName, 'Неизвестная команда');
});

test('нормализация: пустой турнир — допустимое состояние, а не «битые данные»', () => {
    // Именно такая ситуация была в реальном репозитории: администратор удалил все команды.
    // Раньше приложение подменяло пустой список демонстрационными командами.
    const result = L.normalizeData({
        version: 2,
        revision: 5,
        updatedAt: '2026-09-15T10:08:34.710Z',
        teams: [],
        matches: []
    });

    assert.equal(result.data.teams.length, 0);
    assert.equal(result.data.matches.length, 0);
    assert.equal(result.data.revision, 5, 'версия документа сохраняется');
    assert.equal(result.data.updatedAt, '2026-09-15T10:08:34.710Z');
    assert.equal(result.repaired, false, 'это не повреждение данных');

    // Приложение работает с пустым турниром без ошибок
    assert.deepEqual(L.getStats(result.data), {
        teams: 0, matches: 0, players: 0, finished: 0, upcoming: 0, goals: 0
    });
    assert.deepEqual(L.computeStandings(result.data.teams, result.data.matches), []);

    // А настоящие повреждения по-прежнему заменяются демонстрационными данными
    assert.equal(L.normalizeData({ teams: 'нет', matches: [] }).data.teams.length, 4);
});

test('serializeData и parseImport: экспорт, импорт и проверка формата', () => {
    const data = L.createDefaultData();
    const text = L.serializeData(data);
    const parsed = JSON.parse(text);

    assert.equal(parsed.version, L.CONFIG.dataVersion);
    assert.equal(parsed.teams.length, 4);
    assert.ok(typeof parsed.exportedAt === 'string');

    const imported = L.parseImport(text);
    assert.equal(imported.ok, true);
    assert.deepEqual(imported.data.teams.length, 4);
    assert.equal(imported.repaired, false);

    assert.equal(L.parseImport('{не json').error, 'Файл не является корректным JSON');
    assert.equal(L.parseImport('{"foo":1}').error, 'В файле нет списков команд и матчей');
    assert.equal(L.parseImport('[]').ok, false);

    const withRepair = L.parseImport(JSON.stringify({
        teams: [{ id: 1, name: 'A' }, { id: 1, name: 'A' }],
        matches: []
    }));
    assert.equal(withRepair.ok, true);
    assert.equal(withRepair.repaired, true, 'импорт сообщает, что данные были исправлены');
});
