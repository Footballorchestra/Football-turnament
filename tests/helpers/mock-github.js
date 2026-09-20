/**
 * Макет GitHub для автотестов: хранит файл данных и ведёт себя как Contents API.
 *
 * Используется в двух видах:
 *   • createMockRepository() — «репозиторий в памяти» + поддельный fetch (тесты в jsdom);
 *   • createMockServer()     — тот же репозиторий, но доступный по HTTP (e2e в браузере).
 *
 * Реальный GitHub при этом не затрагивается.
 */
'use strict';

const http = require('node:http');
const { createHandler } = require('../../tools/serve.js');

const RAW_PREFIX = '/mock-raw';
const API_PREFIX = '/mock-api';

function createMockRepository(options) {
    const settings = options || {};

    const state = {
        data: settings.data ? JSON.parse(JSON.stringify(settings.data)) : null,
        sha: null,
        // Файлы репозитория, кроме data.json: путь → { content (base64), sha }
        files: {},
        // Код ответа для следующей загрузки файла (проверка обработки ошибок)
        uploadStatus: 0,
        token: settings.token || 'test-token',
        commits: [],
        requests: []
    };

    if (state.data) {
        state.sha = 'sha-1';
    }

    let shaCounter = 1;

    function response(status, payload) {
        return {
            ok: status >= 200 && status < 300,
            status,
            json: () => Promise.resolve(payload)
        };
    }

    function encode(text) {
        return Buffer.from(String(text), 'utf8').toString('base64');
    }

    function decode(base64) {
        return Buffer.from(String(base64).replace(/\s+/g, ''), 'base64').toString('utf8');
    }

    function headersOf(headers) {
        const normalized = {};

        Object.keys(headers || {}).forEach((key) => {
            normalized[key.toLowerCase()] = headers[key];
        });

        return normalized;
    }

    /** Общая логика запроса: одинаково работает и из fetch, и по HTTP. */
    function handle(method, url, headers, body) {
        const target = String(url);
        const normalizedHeaders = headersOf(headers);
        const auth = normalizedHeaders.authorization || '';
        const isApi = target.includes(API_PREFIX + '/repos/');
        const isRaw = !isApi && target.includes(RAW_PREFIX + '/');
        const isSiteFile = !isApi && !isRaw && target.split('?')[0].endsWith('data.json');

        // Путь запрашиваемого файла внутри /contents/ (data.json или фото игрока)
        const apiMatch = isApi ? target.match(/\/contents\/([^?]*)/) : null;
        const apiPath = apiMatch ? decodeURIComponent(apiMatch[1]) : '';
        const isDataFile = apiPath.endsWith('data.json');

        state.requests.push({ method, url: target, headers: normalizedHeaders, body: body || null });

        if (isApi) {
            if (auth !== 'Bearer ' + state.token) {
                return response(401, { message: 'Bad credentials' });
            }

            if (!apiPath) {
                return response(404, { message: 'Not Found' });
            }

            if (method === 'GET') {
                if (!isDataFile) {
                    const file = state.files[apiPath];

                    return file
                        ? response(200, { sha: file.sha, content: file.content, path: apiPath })
                        : response(404, { message: 'Not Found' });
                }

                return state.data
                    ? response(200, { sha: state.sha, content: encode(JSON.stringify(state.data, null, 2)) })
                    : response(404, { message: 'Not Found' });
            }

            if (method === 'PUT') {
                const parsed = typeof body === 'string' ? JSON.parse(body) : (body || {});

                if (state.uploadStatus) {
                    const status = state.uploadStatus;
                    state.uploadStatus = 0;

                    return response(status, { message: 'Simulated error' });
                }

                if (!isDataFile) {
                    const existing = state.files[apiPath];

                    if (existing && parsed.sha !== existing.sha) {
                        return response(409, { message: 'is at ' + existing.sha + ' but expected ' + parsed.sha });
                    }

                    shaCounter += 1;
                    state.files[apiPath] = { content: String(parsed.content || ''), sha: 'sha-' + shaCounter };
                    state.commits.push({ message: parsed.message, path: apiPath, content: parsed.content });

                    return response(200, {
                        content: { sha: state.files[apiPath].sha, path: apiPath },
                        commit: {
                            html_url: 'https://github.com/' + (settings.owner || 'test') + '/' +
                                (settings.repo || 'test') + '/commit/' + shaCounter
                        }
                    });
                }

                if (state.data && parsed.sha !== state.sha) {
                    return response(409, { message: 'is at ' + state.sha + ' but expected ' + parsed.sha });
                }

                state.data = JSON.parse(decode(parsed.content));
                shaCounter += 1;
                state.sha = 'sha-' + shaCounter;
                state.commits.push({ message: parsed.message, data: state.data });

                return response(200, {
                    content: { sha: state.sha },
                    commit: {
                        html_url: 'https://github.com/' + (settings.owner || 'test') + '/' +
                            (settings.repo || 'test') + '/commit/' + shaCounter
                    }
                });
            }
        }

        if (method === 'GET' && (isRaw || isSiteFile)) {
            return state.data
                ? response(200, state.data)
                : response(404, { message: 'Not Found' });
        }

        return response(404, { message: 'Not Found' });
    }

    function fetchImpl(url, init) {
        const options = init || {};
        return Promise.resolve(handle(options.method || 'GET', url, options.headers, options.body));
    }

    /** Имитация правки файла «с другого устройства»: меняет содержимое и sha. */
    function changeExternally(data) {
        state.data = JSON.parse(JSON.stringify(data));
        shaCounter += 1;
        state.sha = 'sha-external-' + shaCounter;
    }

    /** Следующая загрузка файла ответит этой ошибкой (например, 413 — файл велик). */
    function failNextUpload(status) {
        state.uploadStatus = Number(status) || 0;
    }

    return {
        state,
        handle,
        fetch: fetchImpl,
        changeExternally,
        failNextUpload,
        encode,
        decode,
        rawPrefix: RAW_PREFIX,
        apiPrefix: API_PREFIX
    };
}

/** HTTP-сервер: отдаёт сайт из root, а пути /mock-raw и /mock-api обслуживает макет GitHub. */
function createMockServer(root, repository) {
    const repo = repository || createMockRepository({});
    const staticHandler = createHandler(root);

    const server = http.createServer((request, response) => {
        const isMock = request.url.startsWith(RAW_PREFIX) || request.url.startsWith(API_PREFIX);

        if (!isMock) {
            staticHandler(request, response);
            return;
        }

        const chunks = [];

        request.on('data', (chunk) => chunks.push(chunk));
        request.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf8');
            const result = repo.handle(request.method, request.url, request.headers, body || null);

            Promise.resolve(result.json())
                .then((data) => {
                    response.writeHead(result.status, {
                        'Content-Type': 'application/json; charset=utf-8',
                        'Cache-Control': 'no-store'
                    });
                    response.end(JSON.stringify(data));
                })
                .catch(() => {
                    response.writeHead(result.status, { 'Content-Type': 'application/json; charset=utf-8' });
                    response.end('{}');
                });
        });
    });

    return { server, repository: repo };
}

module.exports = { createMockRepository, createMockServer, RAW_PREFIX, API_PREFIX };
