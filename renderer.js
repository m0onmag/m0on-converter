'use strict';

const bootScreen = document.getElementById('boot-screen');
const bootBar    = document.getElementById('boot-bar');
const bootStatus = document.getElementById('boot-status');
const mainUI     = document.getElementById('main-ui');

const bootSteps = [
    { pct: 15,  msg: 'ИНИЦИАЛИЗАЦИЯ ЯДРА...',              delay: 350 },
    { pct: 32,  msg: 'ЗАГРУЗКА МАТРИЦ ШИФРОВАНИЯ...',      delay: 420 },
    { pct: 55,  msg: 'КАЛИБРОВКА ДУГОВОЙ РЕАКЦИИ...',      delay: 380 },
    { pct: 74,  msg: 'УСТАНОВКА ЗАЩИЩЁННОГО КАНАЛА...',    delay: 450 },
    { pct: 90,  msg: 'ПРОВЕРКА ПРОТОКОЛОВ КОНВЕРТАЦИИ...', delay: 340 },
    { pct: 100, msg: 'M0ON CONVERTER — ГОТОВ.',            delay: 300 },
];

let bootSkipped = false;

function delay(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

function bootDelay(ms) {
    return bootSkipped ? Promise.resolve() : delay(ms);
}

async function runBoot() {
    await bootDelay(600);

    for (const step of bootSteps) {
        bootBar.style.width = step.pct + '%';
        bootStatus.textContent = step.msg;
        await bootDelay(step.delay);
    }

    await bootDelay(500);

    bootScreen.classList.add('hidden');

    mainUI.style.pointerEvents = 'auto';
    mainUI.style.opacity = '1';

    document.querySelector('.window-controls').classList.add('visible');

    setTimeout(() => bootScreen.remove(), 800);
}

bootScreen.addEventListener('click', () => { bootSkipped = true; });
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') bootSkipped = true;
});

runBoot();

function setStatus(statusMsg, type, icon, text) {
    const cls = { idle: 'status-idle', running: 'status-running', ok: 'status-ok', err: 'status-err' }[type];
    statusMsg.className = cls;
    const iconEl = document.createElement('span');
    iconEl.className = 'status-icon';
    iconEl.textContent = icon;
    statusMsg.replaceChildren(iconEl, document.createTextNode(text));
}

function showProgress(progressWrap, progressFill, visible) {
    progressWrap.style.display = visible ? 'block' : 'none';
    if (!visible) progressFill.style.width = '0%';
}

async function animateProgress(progressFill, steps, token) {
    for (const w of steps) {
        if (token.stop) return;
        progressFill.style.width = w + '%';
        await delay(320 + Math.random() * 180);
    }
}

function showResult(els, success, title, text) {
    els.resultBox.style.display = 'flex';
    els.resultBox.className = success ? 'result-box' : 'result-box error';
    els.resultIcon.textContent = success ? '✓' : '✕';
    els.resultText.textContent = title;
    els.resultPath.textContent = text;
}

function cleanError(err) {
    const msg = String((err && err.message) || err || 'Неизвестная ошибка');
    return msg.replace(/^Error invoking remote method '[^']*': (Error: )?/, '');
}

document.addEventListener('DOMContentLoaded', () => {
    const initBtn      = document.getElementById('init-btn');
    const xmlInput     = document.getElementById('xml-path');
    const browseBtn    = document.getElementById('browse-btn');
    const progressWrap = document.getElementById('progress-wrap');
    const progressFill = document.getElementById('progress-fill');
    const statusMsg    = document.getElementById('status-msg');
    const resultEls = {
        resultBox:  document.getElementById('result-box'),
        resultIcon: document.getElementById('result-icon'),
        resultText: document.getElementById('result-text'),
        resultPath: document.getElementById('result-path'),
    };

    browseBtn.addEventListener('click', async () => {
        try {
            const path = await window.starkCore.openFileDialog();

            if (path) {
                xmlInput.value = path;
                initBtn.disabled = false;
                setStatus(statusMsg, 'idle', '◈', 'Файл выбран. Нажмите «Запустить конвертацию».');
                resultEls.resultBox.style.display = 'none';
            }
        } catch (e) {
            setStatus(statusMsg, 'err', '✕', 'Ошибка открытия диалога.');
        }
    });

    initBtn.addEventListener('click', async () => {
        const path = xmlInput.value.trim();
        if (!path) return;

        initBtn.disabled   = true;
        browseBtn.disabled = true;
        resultEls.resultBox.style.display = 'none';

        setStatus(statusMsg, 'running', '⟳', 'Конвертация...');
        showProgress(progressWrap, progressFill, true);

        const token = { stop: false };
        const animation = animateProgress(progressFill, [25, 55, 85], token);

        try {
            const result = await window.starkCore.initializeConversion(path);

            token.stop = true;
            await animation;
            progressFill.style.width = '100%';
            await delay(250);

            showProgress(progressWrap, progressFill, false);
            showResult(resultEls, true, 'КОНВЕРТАЦИЯ ЗАВЕРШЕНА', result);
            setStatus(statusMsg, 'ok', '✓', 'Успешно сконвертировано!');

        } catch (err) {
            token.stop = true;
            showProgress(progressWrap, progressFill, false);
            showResult(resultEls, false, 'ОШИБКА КОНВЕРТАЦИИ', cleanError(err));
            setStatus(statusMsg, 'err', '✕', 'Произошла ошибка. Проверьте файл.');
        } finally {
            initBtn.disabled   = false;
            browseBtn.disabled = false;
        }
    });

    document.getElementById('minimize-btn').addEventListener('click', () => {
        window.electronAPI?.minimize();
    });

    document.getElementById('close-btn').addEventListener('click', () => {
        window.electronAPI?.close();
    });
});
