const { app, BrowserWindow, ipcMain, dialog, session } = require('electron');
const path = require('path');
const fs = require('fs');
const { Worker } = require('worker_threads');

const MAX_XML_SIZE = 50 * 1024 * 1024;
const CONVERSION_TIMEOUT_MS = 60 * 1000;

let mainWindow = null;
let converting = false;
let approvedXmlPath = null;

function isTrustedSender(event) {
  return !!mainWindow && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents;
}

function validateXmlPath(xmlPath) {
  if (typeof xmlPath !== 'string' || xmlPath.length === 0 || xmlPath.length > 4096) {
    throw new Error('Некорректный путь к файлу.');
  }
  if (!path.isAbsolute(xmlPath)) {
    throw new Error('Путь должен быть абсолютным.');
  }
  if (path.extname(xmlPath).toLowerCase() !== '.xml') {
    throw new Error('Допускаются только файлы .xml.');
  }
  let stat;
  try {
    stat = fs.statSync(xmlPath);
  } catch {
    throw new Error('Файл не найден.');
  }
  if (!stat.isFile()) {
    throw new Error('Указанный путь не является файлом.');
  }
  if (stat.size > MAX_XML_SIZE) {
    throw new Error('Файл слишком большой (лимит 50 МБ).');
  }
}

function runConversion(xmlPath) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'convert-worker.js'), {
      workerData: { xmlPath },
    });

    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate();
      fn(value);
    };

    const timer = setTimeout(() => {
      finish(reject, new Error('Конвертация прервана по тайм-ауту.'));
    }, CONVERSION_TIMEOUT_MS);

    worker.on('message', (msg) => {
      if (msg && msg.ok) finish(resolve, msg.result);
      else finish(reject, new Error((msg && msg.error) || 'Неизвестная ошибка конвертации.'));
    });
    worker.on('error', (err) => finish(reject, new Error(`Сбой конвертации: ${err.message}`)));
    worker.on('exit', (code) => {
      if (code !== 0) finish(reject, new Error(`Процесс конвертации завершился с кодом ${code}.`));
    });
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 780,
    backgroundColor: '#030508',
    frame: false,
    transparent: false,
    icon: path.join(__dirname, 'm0on_industries.png'),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      devTools: !app.isPackaged,
    }
  });

  mainWindow.loadFile('index.html');

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (e) => e.preventDefault());
  mainWindow.webContents.on('will-attach-webview', (e) => e.preventDefault());

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    approvedXmlPath = null;
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    session.defaultSession.setPermissionRequestHandler((_wc, _perm, callback) => callback(false));
    createWindow();
  });

  app.on('window-all-closed', () => {
    app.quit();
  });
}

ipcMain.handle('open-file-dialog', async (event) => {
  if (!isTrustedSender(event)) throw new Error('Недопустимый источник запроса.');

  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    filters: [{ name: 'XML Files', extensions: ['xml'] }],
    properties: ['openFile'],
  });

  if (canceled || !filePaths[0]) return null;
  approvedXmlPath = filePaths[0];
  return approvedXmlPath;
});

ipcMain.handle('run-conversion', async (event, xmlPath) => {
  if (!isTrustedSender(event)) {
    throw new Error('Недопустимый источник запроса.');
  }
  if (converting) {
    throw new Error('Конвертация уже выполняется.');
  }
  if (!approvedXmlPath || xmlPath !== approvedXmlPath) {
    throw new Error('Файл не был выбран через диалог. Выберите файл заново.');
  }

  validateXmlPath(approvedXmlPath);

  converting = true;
  try {
    return await runConversion(approvedXmlPath);
  } finally {
    converting = false;
  }
});

ipcMain.handle('window-minimize', (event) => {
  if (!isTrustedSender(event)) return;
  mainWindow.minimize();
});

ipcMain.handle('window-close', (event) => {
  if (!isTrustedSender(event)) return;
  mainWindow.close();
});
