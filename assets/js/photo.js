/**
 * Подготовка фото игрока к загрузке в репозиторий — целиком в браузере, без сервера.
 *
 * Задача модуля: превратить выбранный файл (с телефона или компьютера, часто
 * несколько мегабайт) в аккуратную квадратную картинку ~20–80 КБ, которую можно
 * навсегда положить в репозиторий сайта рядом с остальными файлами.
 *
 * Модуль используется двумя потребителями:
 *   1) браузером (подключается обычным <script>, доступ через window.FTPhoto);
 *   2) автотестами Node.js (tests/photo.test.js, через module.exports).
 *
 * Canvas и FileReader есть только в браузере, поэтому основная работа с картинкой
 * собрана в prepare(). Чистые функции (имя файла, проверки, формат размера)
 * тестируются отдельно в Node.js.
 */
(function (root, factory) {
    'use strict';

    var api = factory();

    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }

    if (root) {
        root.FTPhoto = api;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    /** Значения по умолчанию; переопределяются из window.FT_CONFIG.photo (см. config.js). */
    var DEFAULTS = {
        folder: 'assets/photos/',          // папка с фото в репозитории
        prefix: '',                        // префикс имени файла: 'team-' для эмблем команд
        maxSize: 512,                      // сторона квадрата, px
        quality: 0.82,                     // качество JPEG
        maxSourceBytes: 15 * 1024 * 1024,  // исходник: до 15 МБ
        maxResultBytes: 400 * 1024         // результат: до 400 КБ
    };

    /** Кириллица → латиница: имя файла должно быть безопасным в любой системе. */
    var TRANSLIT = {
        'а': 'a', 'б': 'b', 'в': 'v', 'г': 'g', 'д': 'd', 'е': 'e', 'ё': 'e', 'ж': 'zh',
        'з': 'z', 'и': 'i', 'й': 'i', 'к': 'k', 'л': 'l', 'м': 'm', 'н': 'n', 'о': 'o',
        'п': 'p', 'р': 'r', 'с': 's', 'т': 't', 'у': 'u', 'ф': 'f', 'х': 'kh', 'ц': 'ts',
        'ч': 'ch', 'ш': 'sh', 'щ': 'shch', 'ъ': '', 'ы': 'y', 'ь': '', 'э': 'e',
        'ю': 'yu', 'я': 'ya'
    };

    /** Настройки с подстановкой значений по умолчанию. */
    function settings(options) {
        var source = options || {};
        var result = {};

        Object.keys(DEFAULTS).forEach(function (key) {
            var value = source[key];

            result[key] = (value === undefined || value === null || value === '') ? DEFAULTS[key] : value;
        });

        return result;
    }

    /** Кириллица и латиница: остальные символы остаются как есть. */
    function transliterate(value) {
        var text = String(value === null || value === undefined ? '' : value).toLowerCase();
        var result = '';

        for (var i = 0; i < text.length; i++) {
            var symbol = text.charAt(i);

            result += TRANSLIT[symbol] !== undefined ? TRANSLIT[symbol] : symbol;
        }

        return result;
    }

    /** Имя файла из имени игрока: «Иванов А.» → «ivanov-a». */
    function slugify(value, maxLength) {
        var limit = Number(maxLength) > 0 ? Number(maxLength) : 40;

        return transliterate(value)
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, limit)
            .replace(/-+$/g, '');
    }

    /** Короткий устойчивый хеш: одно и то же фото всегда попадает в один и тот же файл. */
    function hashOf(value) {
        var text = String(value === null || value === undefined ? '' : value);
        var hash = 0x811c9dc5;

        for (var i = 0; i < text.length; i++) {
            hash ^= text.charCodeAt(i);
            hash = (hash * 0x01000193) >>> 0;
        }

        return ('0000000' + hash.toString(16)).slice(-8);
    }

    /** Путь к фото в репозитории: фото игрока или эмблема команды (префикс). */
    function buildPath(teamId, player, options) {
        var config = settings(options);
        var folder = String(config.folder).replace(/\/+$/, '') + '/';
        var prefix = String(config.prefix || '');
        var slug = slugify(player) || 'player';
        var suffix = hashOf(String(teamId) + '|' + String(player)).slice(0, 6);

        return folder + prefix + slug + '-' + suffix + '.jpg';
    }

    /** Размер файла понятными словами. */
    function formatBytes(bytes) {
        var value = Number(bytes) || 0;

        if (value < 1024) {
            return value + ' Б';
        }

        if (value < 1024 * 1024) {
            return Math.round(value / 1024) + ' КБ';
        }

        return (Math.round((value / (1024 * 1024)) * 10) / 10) + ' МБ';
    }

    /** Проверка выбранного файла до чтения (тип и размер). */
    function checkFile(file, options) {
        var config = settings(options);
        var type = file && file.type ? String(file.type).toLowerCase() : '';

        if (!file || typeof file.size !== 'number') {
            return { ok: false, error: 'Файл не выбран' };
        }

        // Некоторые браузеры не сообщают тип — тогда решает попытка декодирования
        if (type && type.indexOf('image/') !== 0) {
            return { ok: false, error: 'Это не изображение: выберите файл JPEG, PNG или WebP' };
        }

        if (file.size > config.maxSourceBytes) {
            return {
                ok: false,
                error: 'Файл слишком большой (' + formatBytes(file.size) + '): выберите фото до ' +
                    formatBytes(config.maxSourceBytes)
            };
        }

        return { ok: true };
    }

    /** Файл или Blob → data-URL. */
    function readAsDataUrl(blob) {
        return new Promise(function (resolve, reject) {
            var reader = new FileReader();

            reader.onload = function () { resolve(String(reader.result || '')); };
            reader.onerror = function () { reject(new Error('Не удалось прочитать файл')); };
            reader.readAsDataURL(blob);
        });
    }

    /** data-URL → готовая картинка. */
    function loadImage(dataUrl) {
        return new Promise(function (resolve, reject) {
            var image = new Image();

            image.onload = function () { resolve(image); };
            image.onerror = function () {
                reject(new Error('Не удалось открыть изображение — попробуйте другое фото (например, JPEG)'));
            };
            image.src = dataUrl;
        });
    }

    /** Квадратная картинка по центру, белый фон (чтобы прозрачный PNG не стал чёрным). */
    function drawSquare(image, config) {
        var width = image.naturalWidth || image.width || 0;
        var height = image.naturalHeight || image.height || 0;
        var side = Math.min(width, height);
        var size = Math.max(1, Math.round(config.maxSize));
        var canvas = document.createElement('canvas');
        var context = canvas.getContext('2d');

        if (!side) {
            throw new Error('Изображение пустое — попробуйте другое фото');
        }

        if (!context) {
            throw new Error('Браузер не поддерживает обработку изображений');
        }

        canvas.width = size;
        canvas.height = size;
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, size, size);
        context.drawImage(image, (width - side) / 2, (height - side) / 2, side, side, 0, 0, size, size);

        return canvas;
    }

    /** Canvas → Blob (с запасным вариантом через toDataURL для старых браузеров). */
    function toBlob(canvas, quality) {
        return new Promise(function (resolve, reject) {
            if (typeof canvas.toBlob === 'function') {
                canvas.toBlob(function (blob) {
                    if (blob) {
                        resolve({ blob: blob, size: blob.size, type: blob.type || 'image/jpeg',
                            dataUrl: '' });
                    } else {
                        reject(new Error('Не удалось сжать изображение'));
                    }
                }, 'image/jpeg', quality);

                return;
            }

            try {
                var dataUrl = canvas.toDataURL('image/jpeg', quality);
                var base64 = dataUrl.split(',')[1] || '';

                resolve({
                    blob: null,
                    size: Math.round(base64.length * 0.75),
                    type: 'image/jpeg',
                    dataUrl: dataUrl
                });
            } catch (error) {
                reject(new Error('Не удалось сжать изображение'));
            }
        });
    }

    /**
     * Готовит фото к загрузке: квадрат по центру, JPEG заданного качества.
     * Возвращает { ok: true, base64, path, bytes, mime, size } либо { ok: false, error }.
     */
    function prepare(file, options) {
        var config = settings(options);

        if (typeof Promise === 'undefined' || typeof FileReader === 'undefined' ||
            typeof Image === 'undefined' || typeof document === 'undefined') {
            return Promise.resolve({ ok: false, error: 'Браузер не поддерживает подготовку изображений' });
        }

        var check = checkFile(file, config);

        if (!check.ok) {
            return Promise.resolve({ ok: false, error: check.error });
        }

        return readAsDataUrl(file)
            .then(function (dataUrl) { return loadImage(dataUrl); })
            .then(function (image) { return toBlob(drawSquare(image, config), config.quality); })
            .then(function (drawn) {
                var readBase64 = drawn.dataUrl
                    ? function () { return Promise.resolve(drawn.dataUrl); }
                    : function () { return readAsDataUrl(drawn.blob); };

                return readBase64().then(function (dataUrl) {
                    var base64 = String(dataUrl).split(',')[1] || '';

                    if (!base64) {
                        return { ok: false, error: 'Не удалось подготовить фото — попробуйте другой файл' };
                    }

                    if (drawn.size > config.maxResultBytes) {
                        return {
                            ok: false,
                            error: 'После сжатия фото всё ещё большое (' + formatBytes(drawn.size) +
                                ') — выберите фото попроще или уменьшите сторону квадрата в настройках'
                        };
                    }

                    return {
                        ok: true,
                        base64: base64,
                        bytes: drawn.size,
                        mime: drawn.type,
                        size: config.maxSize,
                        path: buildPath(options && options.teamId, options && options.player, config)
                    };
                });
            })
            .catch(function (error) {
                return {
                    ok: false,
                    error: (error && error.message) ? error.message : 'Не удалось подготовить фото'
                };
            });
    }

    return {
        DEFAULTS: DEFAULTS,
        settings: settings,
        transliterate: transliterate,
        slugify: slugify,
        hashOf: hashOf,
        buildPath: buildPath,
        formatBytes: formatBytes,
        checkFile: checkFile,
        prepare: prepare
    };
});
