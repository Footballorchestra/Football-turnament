/**
 * Образец для входа в панель в автотестах.
 *
 * Настоящий пароль администратора в репозитории не хранится: сайт держит только
 * соль и солёный отпечаток (см. «Пароль администратора» в README). Поэтому тесты
 * подставляют в страницу свои настройки входа (FT_CONFIG.admin) и пользуются
 * своим паролем-образцом — настоящий пароль в тестах не нужен и не хранится.
 *
 * Отпечаток считается SHA-256 из Node.js, независимо от реализации в logic.js:
 * так расхождение с эталоном сразу заметно.
 */
'use strict';

const crypto = require('node:crypto');

const SALT = 'тест-соль';
const PASSWORD = 'тест-пароль';

/** Настройки входа для тестовой страницы: window.FT_CONFIG.admin */
function config() {
    return {
        passwordSalt: SALT,
        passwordHash: crypto.createHash('sha256').update(SALT + ':' + PASSWORD, 'utf8').digest('hex')
    };
}

module.exports = {
    password: PASSWORD,
    config: config
};
