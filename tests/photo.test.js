/**
 * Юнит-тесты подготовки фото игрока (assets/js/photo.js).
 * Запуск: npm test
 *
 * Canvas и FileReader есть только в браузере, поэтому здесь проверяются чистые
 * функции (имя файла, проверки, формат размера) и поведение без DOM. Само сжатие
 * картинки проверяется в браузерных тестах (npm run test:browser).
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../assets/js/logic.js');
const P = require('../assets/js/photo.js');

test('slugify: безопасное имя файла из имени игрока', () => {
    assert.equal(P.slugify('Иванов А.'), 'ivanov-a');
    assert.equal(P.slugify('  Щербаков Ёжик  '), 'shcherbakov-ezhik');
    assert.equal(P.slugify('Ли Станислав'), 'li-stanislav');
    assert.equal(P.slugify('Гладышев Андрей-младший'), 'gladyshev-andrei-mladshii');
    assert.equal(P.slugify('...'), '', 'без букв и цифр остаётся пусто');
    assert.equal(P.slugify('Оченьдлинноеимяигрокакотороенепоместится', 10).length, 10, 'имя обрезается');
    assert.equal(P.slugify(''), '');
});

test('hashOf: короткий устойчивый хеш', () => {
    assert.equal(P.hashOf('1|Иванов А.'), P.hashOf('1|Иванов А.'), 'хеш повторяем');
    assert.notEqual(P.hashOf('1|Иванов А.'), P.hashOf('2|Иванов А.'), 'разные команды — разные имена файлов');
    assert.equal(P.hashOf('').length, 8);
});

test('buildPath: путь внутрь папки фото, совместимый с проверкой логики', () => {
    const path = P.buildPath(3, 'Иванов А.');

    assert.match(path, /^assets\/photos\/ivanov-a-[0-9a-f]{6}\.jpg$/);
    assert.equal(L.isValidPhotoPath(path), true, 'путь принимается нормализацией данных');
    assert.equal(P.buildPath(3, 'Иванов А.'), path, 'то же фото — тот же файл (замена, а не дубли)');
    assert.notEqual(P.buildPath(4, 'Иванов А.'), path, 'однофамильцы в разных командах не конфликтуют');

    // Опасное имя не попадает в путь
    assert.match(P.buildPath(1, '..'), /^assets\/photos\/player-[0-9a-f]{6}\.jpg$/);
    assert.equal(L.isValidPhotoPath(P.buildPath(1, '..')), true);

    // Длина пути укладывается в ограничение логики
    assert.ok(P.buildPath(1, 'Оченьдлинноеимяигрока'.repeat(3)).length <= L.CONFIG.maxPhotoPathLength);
});

test('settings: значения по умолчанию и пользовательские', () => {
    const defaults = P.settings();

    assert.equal(defaults.folder, 'assets/photos/');
    assert.equal(defaults.maxSize, 512);
    assert.equal(defaults.quality, 0.82);
    assert.equal(P.settings({ maxSize: 1024 }).maxSize, 1024);
    assert.equal(P.settings({ maxSize: null }).maxSize, 512, 'пустое значение заменяется значением по умолчанию');
    assert.equal(P.settings({ folder: 'assets/photos/' }).maxSourceBytes, P.DEFAULTS.maxSourceBytes);
});

test('formatBytes: размер понятными словами', () => {
    assert.equal(P.formatBytes(512), '512 Б');
    assert.equal(P.formatBytes(204800), '200 КБ');
    assert.equal(P.formatBytes(2 * 1024 * 1024 + 512 * 1024), '2.5 МБ');
    assert.equal(P.formatBytes(0), '0 Б');
    assert.equal(P.formatBytes(null), '0 Б');
});

test('checkFile: тип и размер файла до чтения', () => {
    assert.equal(P.checkFile(null).ok, false);
    assert.match(P.checkFile(null).error, /Файл не выбран/);
    assert.match(P.checkFile({ size: 10, type: 'text/plain' }).error, /не изображение/i);
    assert.equal(P.checkFile({ size: 10, type: 'image/jpeg' }).ok, true);
    assert.equal(P.checkFile({ size: 10, type: 'image/png' }).ok, true);
    assert.equal(P.checkFile({ size: 10, type: '' }).ok, true, 'без типа решает попытка декодирования');

    const big = P.checkFile({ size: 20 * 1024 * 1024, type: 'image/jpeg' });
    assert.equal(big.ok, false);
    assert.match(big.error, /слишком большой/);

    assert.equal(P.checkFile({ size: 1024, type: 'image/jpeg' }, { maxSourceBytes: 512 }).ok, false, 'свой лимит');
});

test('prepare: без DOM честно сообщает, что браузер не умеет готовить фото', async () => {
    const result = await P.prepare({ size: 10, type: 'image/jpeg' });

    assert.equal(result.ok, false);
    assert.match(result.error, /не поддерживает/);
});
