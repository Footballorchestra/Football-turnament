/**
 * Предстартовая заставка: при первом открытии сайта в сессии показывается фон
 * с названием чемпионата, через несколько секунд сайт открывается сам.
 *
 * Правила:
 *   • время показа — window.FT_CONFIG.splashMs (0 — заставку не показывать);
 *   • повторные открытия в той же сессии — сразу сайт (отметка в sessionStorage);
 *   • пропустить заставку можно кликом по экрану или клавишей Esc;
 *   • пока заставка видна, страница не прокручивается;
 *   • разметка заставки лежит в index.html и видна сразу, ещё до скриптов, а CSS
 *     прячет её через splashMs даже если скрипт не выполнился (страховка).
 *
 * Разметка: #splash (см. index.html), стили — в src/input.css.
 */
(function (window, document) {
    'use strict';

    var SETTINGS = window.FT_CONFIG || {};
    var KEYS = SETTINGS.storageKeys || {};
    var SEEN_KEY = KEYS.splashSeen || 'ft.splashSeen';
    var FALLBACK_MS = 5000;
    var CLOUD_MS = 400;                 // длительность плавного исчезновения, мс
    var splash = document.getElementById('splash');
    var countdown = document.getElementById('splash-countdown');
    var timer = null;
    var ticker = null;

    if (!splash) {
        return;
    }

    /** Сколько миллисекунд показывать заставку: 0 — не показывать. */
    function duration() {
        var value = Number(SETTINGS.splashMs);

        if (!Number.isFinite(value) || value < 0) {
            return FALLBACK_MS;
        }

        return value;
    }

    /** Отметка «заставка показана» — чтобы не показывать её второй раз за сессию. */
    function markSeen() {
        try {
            window.sessionStorage.setItem(SEEN_KEY, '1');
        } catch (error) {
            // Приватный режим браузера: просто показываем заставку при каждом открытии
        }
    }

    function wasSeen() {
        try {
            return window.sessionStorage.getItem(SEEN_KEY) === '1';
        } catch (error) {
            return false;
        }
    }

    /** Пропуск заставки: посетитель нажал кнопку, кликнул по фону или нажал Esc. */
    function skip() {
        markSeen();
        hide(false);
    }

    function onKeydown(event) {
        if (event.key === 'Escape') {
            skip();
        }
    }

    /** Прячет заставку: сразу (уже видели) или плавно, и возвращает прокрутку страницы. */
    function hide(silent) {
        if (timer) {
            window.clearTimeout(timer);
            timer = null;
        }

        if (ticker) {
            window.clearInterval(ticker);
            ticker = null;
        }

        // Заставка уходит — её обработчики больше не нужны
        splash.removeEventListener('click', skip);
        document.removeEventListener('keydown', onKeydown);
        splash.classList.add(silent ? 'is-hidden' : 'is-closing');
        document.body.classList.remove('splash-open');

        if (silent) {
            splash.hidden = true;
            return;
        }

        window.setTimeout(function () {
            splash.hidden = true;
        }, CLOUD_MS);
    }

    /** Показывает заставку с обратным отсчётом и закрывает её через duration(). */
    function show(ms) {
        var left = Math.ceil(ms / 1000);

        document.body.classList.add('splash-open');
        document.documentElement.style.setProperty('--splash-ms', ms + 'ms');

        if (countdown) {
            countdown.textContent = String(left);
        }

        ticker = window.setInterval(function () {
            left -= 1;

            if (countdown && left > 0) {
                countdown.textContent = String(left);
            }
        }, 1000);

        timer = window.setTimeout(function () {
            markSeen();
            hide(false);
        }, ms);

        // Пропустить заставку: клик по экрану или Esc
        splash.addEventListener('click', skip);
        document.addEventListener('keydown', onKeydown);
    }

    var ms = duration();

    if (ms === 0 || wasSeen()) {
        // Заставка выключена или уже показана в этой сессии — сразу отдаём сайт
        hide(true);
    } else {
        show(ms);
    }

    /* Публичный API: нужен автотестам и удобен для отладки из консоли */
    window.FTSplash = {
        duration: ms,
        hide: hide,
        isSeen: wasSeen,
        isVisible: function () {
            return !splash.hidden && !splash.classList.contains('is-closing');
        }
    };
})(window, document);