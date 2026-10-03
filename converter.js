'use strict';

const fs = require('fs');
const path = require('path');

const MAX_XML_SIZE = 50 * 1024 * 1024;
const MAX_XML_DEPTH = 200;

const BLOCKED_URL_SCHEMES = new Set(['javascript', 'vbscript', 'data']);

const SCHEME_RE = /^\s*([a-zA-Z][a-zA-Z0-9+.\-]*):/;
const CONTROL_RE = /[\x00-\x1f\x7f]/g;

function decodeBuffer(buf) {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(buf.subarray(2));
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(buf.subarray(2));
  }
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(buf.subarray(3));
  }
  const head = buf.subarray(0, 200).toString('latin1');
  const m = /^<\?xml[^>]*encoding\s*=\s*["']([^"']+)["']/i.exec(head);
  if (m) {
    try {
      return new TextDecoder(m[1]).decode(buf);
    } catch {}
  }
  return new TextDecoder('utf-8').decode(buf);
}

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(s) {
  if (s.indexOf('&') === -1) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) {
        throw new Error('XML содержит некорректную символьную ссылку.');
      }
      return String.fromCodePoint(code);
    }
    if (Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, body)) return NAMED_ENTITIES[body];
    throw new Error(`XML содержит неизвестную сущность &${body};`);
  });
}

function parseAttrs(src) {
  const attrs = {};
  const re = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    attrs[m[1]] = decodeEntities(m[2] !== undefined ? m[2] : m[3]);
  }
  return attrs;
}

function parseXml(text) {
  if (/<!DOCTYPE/i.test(text) || /<!ENTITY/i.test(text)) {
    throw new Error(
      'XML содержит DOCTYPE/ENTITY — это запрещено (защита от XXE и атак «billion laughs»).'
    );
  }

  const TOKEN_RE = new RegExp(
    [
      '<!--[\\s\\S]*?-->',
      '<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>',
      '<\\?[\\s\\S]*?\\?>',
      '<\\/([^\\s>]+)\\s*>',
      '<([^\\s\\/>!?]+)((?:\\s+[^\\s=\\/>]+\\s*=\\s*(?:"[^"]*"|\'[^\']*\'))*)\\s*(\\/?)>',
      '([^<]+)',
    ].join('|'),
    'g'
  );

  const root = { name: '#root', attrs: {}, children: [], text: '' };
  const stack = [root];
  let pos = 0;
  let m;

  while ((m = TOKEN_RE.exec(text)) !== null) {
    if (m.index !== pos) throw new Error('XML повреждён: неожиданный символ.');
    pos = TOKEN_RE.lastIndex;
    const top = stack[stack.length - 1];

    if (m[1] !== undefined) {
      top.text += m[1];
    } else if (m[2] !== undefined) {
      if (stack.length === 1 || top.name !== m[2]) {
        throw new Error(`XML повреждён: неожиданный закрывающий тег </${m[2]}>.`);
      }
      stack.pop();
    } else if (m[3] !== undefined) {
      if (stack.length > MAX_XML_DEPTH) throw new Error('XML слишком глубоко вложен.');
      const node = { name: m[3], attrs: parseAttrs(m[4] || ''), children: [], text: '' };
      top.children.push(node);
      if (!m[5]) stack.push(node);
    } else if (m[6] !== undefined) {
      if (stack.length === 1) {
        if (m[6].trim() !== '') throw new Error('XML повреждён: текст вне корневого элемента.');
      } else {
        top.text += decodeEntities(m[6]);
      }
    }
  }

  if (pos !== text.length) throw new Error('XML повреждён: неожиданный конец файла.');
  if (stack.length !== 1) throw new Error(`XML повреждён: тег <${stack[stack.length - 1].name}> не закрыт.`);
  if (root.children.length !== 1) throw new Error('XML должен содержать ровно один корневой элемент.');

  return root.children[0];
}

function childrenByName(node, name) {
  return node.children.filter((c) => c.name === name);
}

function firstChild(node, name) {
  return node.children.find((c) => c.name === name) || null;
}

function descendantsByName(node, name, out = []) {
  for (const c of node.children) {
    if (c.name === name) out.push(c);
    descendantsByName(c, name, out);
  }
  return out;
}

const isTrue = (v) => (v || '').toLowerCase() === 'true';

function readSafeXml(xmlPath) {
  const stat = fs.statSync(xmlPath);
  if (stat.size > MAX_XML_SIZE) throw new Error('XML файл слишком большой (лимит 50 МБ).');
  return decodeBuffer(fs.readFileSync(xmlPath));
}

function safeBasename(p) {
  let name = String(p || '').split(/[\\/]/).pop();
  name = name.replace(CONTROL_RE, '').trim();
  if (name === '' || name === '.' || name === '..') return '';
  return name;
}

const SOUND_MAP = {
  'Есть.wav': 'Voices/Подтверждение_Ответ/Есть.WAV',
  'Да сэр.wav': 'Voices/Подтверждение_Ответ/Да, сэр.WAV',
  'Да сэр(второй).wav': 'Voices/Подтверждение_Ответ/Да, сэр (второй).WAV',
  'Загружаю сэр.wav': 'Voices/Запуск_Действие/Загружаю, сэр.WAV',
  'Как пожелаете .wav': 'Voices/Подтверждение_Ответ/Как пожелаете.WAV',
  'Запрос выполнен сэр.wav': 'Voices/Подтверждение_Ответ/Запрос выполнен, сэр.WAV',
  'Всегда к вашим услугам сэр.wav': 'Voices/Вежливое общение/Всегда к вашим услугам, сэр.WAV',
  'К вашим услугам сэр.wav': 'Voices/Вежливое общение/К вашим услугам, сэр.WAV',
  'Вы создали новый элемент.wav': 'Voices/Запуск_Действие/Вы создали новый элемент.WAV',
  'Джарвис - приветствие.wav': 'Voices/Приветствия/Джарвис - приветствие.WAV',
  'Доброе утро.wav': 'Voices/Приветствия/Доброе утро, сэр.WAV',
  'Отключаю питание, начинаю диагностику системы.wav': 'Voices/Система/Отключаю питание.WAV',
  'Импортирую установки, начинаю калибровку виртуальной среды.wav': 'Voices/Система/Импортирую установки.WAV',
  'Сохранить его в центральной базе данных Stark Industries.wav': 'Voices/Система/Сохраняю в базу данных.WAV',
};

const KEY_MAP = {
  LCONTROL: 'Ctrl', CONTROL: 'Ctrl',
  LSHIFT: 'Shift', SHIFT: 'Shift',
  LALT: 'Alt', ALT: 'Alt',
  LWIN: 'Win',
  LEFT: 'Left', RIGHT: 'Right',
  UP: 'Up', DOWN: 'Down',
  ENTER: 'Enter', DELETE: 'Delete',
  HOME: 'Home', END: 'End', TAB: 'Tab',
  F1: 'F1', F2: 'F2', F3: 'F3', F4: 'F4', F5: 'F5', F12: 'F12',
};

function normalizeSoundName(name) {
  return name
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/, '')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

class VoiceCommandsConverter {
  constructor() {
    this.skipReasons = new Map();
    this.log = (msg) => this.skipReasons.set(msg, (this.skipReasons.get(msg) || 0) + 1);
    this.soundLookup = new Map(
      Object.entries(SOUND_MAP).map(([k, v]) => [normalizeSoundName(k), v])
    );
    this.stats = { commands: 0, actions: 0, skipped: 0 };
  }

  convertXmlToJson(xmlPath) {
    const root = parseXml(readSafeXml(xmlPath));

    const result = {
      type: 'collection',
      name: 'Конвертированные команды',
      description: '',
      isEnabled: true,
      activationPhrases: [],
      children: [],
    };

    for (const groupCollection of descendantsByName(root, 'groupCollection')) {
      for (const commandGroup of childrenByName(groupCollection, 'commandGroup')) {
        if (!isTrue(commandGroup.attrs.enabled)) continue;

        const folder = {
          type: 'folder',
          name: commandGroup.attrs.name !== undefined ? commandGroup.attrs.name : 'Без названия',
          description: '',
          isEnabled: true,
          activationPhrases: [],
          children: [],
        };

        for (const command of childrenByName(commandGroup, 'command')) {
          if (!isTrue(command.attrs.enabled)) continue;

          const phrases = [];
          const optional = [];

          for (const phrase of childrenByName(command, 'phrase')) {
            const parts = phrase.text.split(',').map((p) => p.trim()).filter(Boolean);
            if (isTrue(phrase.attrs.optional)) optional.push(...parts);
            else phrases.push(...parts);
          }

          if (phrases.length === 0) continue;

          const cmd = {
            type: 'command',
            name: command.attrs.name || '',
            description: '',
            isEnabled: true,
            activationPhrases: phrases,
            optionalPhrases: optional,
            requiresConfirmation: isTrue(command.attrs.confirm),
            chainEnabled: true,
            sequence: [],
          };

          for (const action of childrenByName(command, 'action')) {
            const typeElem = firstChild(action, 'cmdType');
            if (!typeElem || !typeElem.text.trim()) {
              this.log('Пропущено действие без cmdType');
              this.stats.skipped++;
              continue;
            }
            const actionType = typeElem.text.trim();

            const paramsElem = firstChild(action, 'params');
            const params = paramsElem
              ? childrenByName(paramsElem, 'param').filter((p) => p.text).map((p) => p.text)
              : [];

            const converted = this.convertAction(actionType, params);
            if (converted) {
              cmd.sequence.push(converted);
              this.stats.actions++;
            } else {
              this.stats.skipped++;
            }
          }

          if (cmd.sequence.length > 0) {
            folder.children.push(cmd);
            this.stats.commands++;
          }
        }

        if (folder.children.length > 0) result.children.push(folder);
      }
    }

    return result;
  }

  convertAction(actionType, params) {
    const p0 = params.length ? params[0] : undefined;

    switch (actionType) {
      case 'Sound.PlayStream': {
        const soundName = safeBasename(p0);
        if (!soundName) {
          this.log('Пропущено Sound.PlayStream с пустым именем файла');
          return null;
        }
        const key = normalizeSoundName(soundName);
        if (this.soundLookup.has(key)) return `Sound.PlayWav:${this.soundLookup.get(key)}`;
        return `Sound.PlayWav:Voices/Other/${soundName}`;
      }

      case 'Launch.OpenURL': {
        const url = (p0 || '').replace(CONTROL_RE, '').trim();
        const match = SCHEME_RE.exec(url);
        if (match && BLOCKED_URL_SCHEMES.has(match[1].toLowerCase())) {
          this.log(`Пропущен небезопасный URL со схемой «${match[1]}»`);
          return null;
        }
        return `Launch.Url:${url}`;
      }

      case 'Launch.OpenFile':
        return `Launch.File:${p0 !== undefined ? p0.replace(CONTROL_RE, '') : ''}`;

      case 'Window.Close':     return 'Key.Press:Alt+F4';
      case 'Window.Minimize':  return 'Key.Press:Win+Down';
      case 'Window.Maximize':  return 'Key.Press:Win+Up';
      case 'Window.Normalize': return 'Key.Press:Win+Down';

      case 'InputKeys.Send':
        return this.convertKeys(p0 || '');

      case 'Mouse.LeftClick':     return 'Mouse.ClickLeft';
      case 'System.Monitor.Off':  return 'System.MonitorOff';
      case 'System.Sleep':        return 'System.Sleep';
      case 'Sound.SetVol':        return `Sound.SetVolume:${p0 !== undefined ? p0 : '50'}`;
      case 'TTS.Speak':           return `TTS.Speak:${p0 !== undefined ? p0 : ''}`;
      case 'VC.Pause':            return `Wait:${p0 !== undefined ? p0 : '1000'}`;

      default:
        this.log(`Неизвестный тип действия пропущен: ${actionType}`);
        return null;
    }
  }

  convertKeys(keys) {
    const tokens = keys.split(/[\s+{}()]+/).filter(Boolean);
    const mapped = tokens.map((t) => {
      const upper = t.toUpperCase();
      return Object.prototype.hasOwnProperty.call(KEY_MAP, upper) ? KEY_MAP[upper] : t;
    });
    return `Key.Press:${mapped.join('+')}`;
  }
}

function uniqueOutputPath(dir, name) {
  let candidate = path.join(dir, `${name}.json`);
  for (let i = 1; fs.existsSync(candidate); i++) {
    candidate = path.join(dir, `${name} (${i}).json`);
  }
  return candidate;
}

function convert(xmlPath) {
  if (!fs.existsSync(xmlPath) || !fs.statSync(xmlPath).isFile()) {
    throw new Error(`Файл ${xmlPath} не найден.`);
  }

  const parsed = path.parse(xmlPath);
  if (parsed.ext.toLowerCase() !== '.xml') {
    throw new Error('Ожидается файл с расширением .xml.');
  }

  const outputPath = uniqueOutputPath(parsed.dir, parsed.name);
  const tmpPath = outputPath + '.tmp';

  try {
    const converter = new VoiceCommandsConverter();
    const result = converter.convertXmlToJson(xmlPath);

    fs.writeFileSync(tmpPath, JSON.stringify(result, null, 2), 'utf8');
    fs.renameSync(tmpPath, outputPath);

    const s = converter.stats;
    let message =
      `УСПЕШНО: ${outputPath} сохранен. ` +
      `Команд: ${s.commands}, действий: ${s.actions}, пропущено: ${s.skipped}.`;

    if (converter.skipReasons.size > 0) {
      const lines = [...converter.skipReasons.entries()]
        .slice(0, 10)
        .map(([reason, count]) => `• ${reason}${count > 1 ? ` (×${count})` : ''}`);
      message += `\nПропущено:\n${lines.join('\n')}`;
    }

    return message;
  } finally {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {}
  }
}

module.exports = { convert, VoiceCommandsConverter, parseXml };
