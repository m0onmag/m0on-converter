import json
import os
import re
import sys
import xml.etree.ElementTree as ET
from xml.parsers import expat

# Максимальный размер входного XML (защита от DoS / нехватки памяти)
MAX_XML_SIZE = 50 * 1024 * 1024

# Схемы URL, которые нельзя переносить в сконвертированные команды
BLOCKED_URL_SCHEMES = {"javascript", "vbscript", "data"}

_SCHEME_RE = re.compile(r"^\s*([a-zA-Z][a-zA-Z0-9+.\-]*):")
_CONTROL_RE = re.compile(r"[\x00-\x1f\x7f]")


def _forbid_dtd(*_args, **_kwargs):
    raise ValueError(
        "XML содержит DOCTYPE/ENTITY — это запрещено "
        "(защита от XXE и атак «billion laughs»)."
    )


def _read_safe_xml(xml_path):
    """Читает файл один раз и проверяет, что в нём нет DTD и сущностей."""
    with open(xml_path, "rb") as f:
        data = f.read(MAX_XML_SIZE + 1)
    if len(data) > MAX_XML_SIZE:
        raise ValueError("XML файл слишком большой (лимит 50 МБ).")

    parser = expat.ParserCreate()
    parser.StartDoctypeDeclHandler = _forbid_dtd
    parser.EntityDeclHandler = _forbid_dtd
    parser.UnparsedEntityDeclHandler = _forbid_dtd
    parser.ExternalEntityRefHandler = _forbid_dtd
    parser.Parse(data, True)
    return data


def _safe_basename(path):
    """Имя файла из пути с любыми разделителями, без управляющих символов."""
    name = re.split(r"[\\/]", path or "")[-1]
    name = _CONTROL_RE.sub("", name).strip()
    if name in ("", ".", ".."):
        return ""
    return name


class VoiceCommandsConverter:

    def __init__(self, log_func=None):
        # Логи уходят в stderr, чтобы не попадать в результат для интерфейса
        self.log = log_func or (lambda msg: print(msg, file=sys.stderr))
        self.sound_map = {
            "Есть.wav": "Voices/Подтверждение_Ответ/Есть.WAV",
            "Да сэр.wav": "Voices/Подтверждение_Ответ/Да, сэр.WAV",
            "Да сэр(второй).wav": "Voices/Подтверждение_Ответ/Да, сэр (второй).WAV",
            "Загружаю сэр.wav": "Voices/Запуск_Действие/Загружаю, сэр.WAV",
            "Как пожелаете .wav": "Voices/Подтверждение_Ответ/Как пожелаете.WAV",
            "Запрос выполнен сэр.wav": "Voices/Подтверждение_Ответ/Запрос выполнен, сэр.WAV",
            "Всегда к вашим услугам сэр.wav": "Voices/Вежливое общение/Всегда к вашим услугам, сэр.WAV",
            "К вашим услугам сэр.wav": "Voices/Вежливое общение/К вашим услугам, сэр.WAV",
            "Вы создали новый элемент.wav": "Voices/Запуск_Действие/Вы создали новый элемент.WAV",
            "Джарвис - приветствие.wav": "Voices/Приветствия/Джарвис - приветствие.WAV",
            "Доброе утро.wav": "Voices/Приветствия/Доброе утро, сэр.WAV",
            "Отключаю питание, начинаю диагностику системы.wav": "Voices/Система/Отключаю питание.WAV",
            "Импортирую установки, начинаю калибровку виртуальной среды.wav": "Voices/Система/Импортирую установки.WAV",
            "Сохранить его в центральной базе данных Stark Industries.wav": "Voices/Система/Сохраняю в базу данных.WAV",
        }
        # Ключи в нижнем регистре считаем один раз, а не при каждом звуке
        self._sound_lookup = [(k.lower(), v) for k, v in self.sound_map.items()]
        self.stats = {"commands": 0, "actions": 0, "skipped": 0}

    def convert_xml_to_json(self, xml_path):
        root = ET.fromstring(_read_safe_xml(xml_path))

        result = {
            "type": "collection",
            "name": "Конвертированные команды",
            "description": "",
            "isEnabled": True,
            "activationPhrases": [],
            "children": []
        }

        for group_collection in root.findall(".//groupCollection"):
            for command_group in group_collection.findall("commandGroup"):
                if (command_group.get("enabled") or "").lower() != "true":
                    continue

                folder = {
                    "type": "folder",
                    "name": command_group.get("name", "Без названия"),
                    "description": "",
                    "isEnabled": True,
                    "activationPhrases": [],
                    "children": []
                }

                for command in command_group.findall("command"):
                    if (command.get("enabled") or "").lower() != "true":
                        continue

                    phrases = []
                    optional = []

                    for phrase in command.findall("phrase"):
                        text = phrase.text or ""
                        parts = [p.strip() for p in text.split(",") if p.strip()]

                        if (phrase.get("optional") or "").lower() == "true":
                            optional.extend(parts)
                        else:
                            phrases.extend(parts)

                    if not phrases:
                        continue

                    cmd = {
                        "type": "command",
                        "name": command.get("name", ""),
                        "description": "",
                        "isEnabled": True,
                        "activationPhrases": phrases,
                        "optionalPhrases": optional,
                        "requiresConfirmation": (command.get("confirm") or "").lower() == "true",
                        "chainEnabled": True,
                        "sequence": []
                    }

                    for action in command.findall("action"):
                        type_elem = action.find("cmdType")
                        if type_elem is None or not (type_elem.text or "").strip():
                            self.log("Пропущено действие без cmdType")
                            self.stats["skipped"] += 1
                            continue
                        action_type = type_elem.text.strip()

                        params_elem = action.find("params")
                        params = []

                        if params_elem is not None:
                            for param in params_elem.findall("param"):
                                if param.text:
                                    params.append(param.text)

                        converted = self._convert_action(action_type, params)
                        if converted:
                            cmd["sequence"].append(converted)
                            self.stats["actions"] += 1
                        else:
                            self.stats["skipped"] += 1

                    if cmd["sequence"]:
                        folder["children"].append(cmd)
                        self.stats["commands"] += 1

                if folder["children"]:
                    result["children"].append(folder)

        return result

    def _convert_action(self, action_type, params):

        if action_type == "Sound.PlayStream":
            sound_name = _safe_basename(params[0] if params else "")
            if not sound_name:
                self.log("Пропущено Sound.PlayStream с пустым именем файла")
                return None
            low = sound_name.lower()
            # Сначала точное совпадение, потом поиск по вхождению
            for old_low, new in self._sound_lookup:
                if old_low == low:
                    return f"Sound.PlayWav:{new}"
            for old_low, new in self._sound_lookup:
                if old_low in low or low in old_low:
                    return f"Sound.PlayWav:{new}"
            return f"Sound.PlayWav:Voices/Other/{sound_name}"

        elif action_type == "Launch.OpenURL":
            url = _CONTROL_RE.sub("", params[0] if params else "").strip()
            match = _SCHEME_RE.match(url)
            if match and match.group(1).lower() in BLOCKED_URL_SCHEMES:
                self.log(f"Пропущен небезопасный URL со схемой «{match.group(1)}»")
                return None
            return f"Launch.Url:{url}"

        elif action_type == "Launch.OpenFile":
            return f"Launch.File:{_CONTROL_RE.sub('', params[0]) if params else ''}"

        elif action_type == "Window.Close":
            return "Key.Press:Alt+F4"

        elif action_type == "Window.Minimize":
            return "Key.Press:Win+Down"

        elif action_type == "Window.Maximize":
            return "Key.Press:Win+Up"

        elif action_type == "Window.Normalize":
            return "Key.Press:Win+Down"

        elif action_type == "InputKeys.Send":
            keys = params[0] if params else ""
            return self._convert_keys(keys)

        elif action_type == "Mouse.LeftClick":
            return "Mouse.ClickLeft"

        elif action_type == "System.Monitor.Off":
            return "System.MonitorOff"

        elif action_type == "System.Sleep":
            return "System.Sleep"

        elif action_type == "Sound.SetVol":
            return f"Sound.SetVolume:{params[0] if params else '50'}"

        elif action_type == "TTS.Speak":
            return f"TTS.Speak:{params[0] if params else ''}"

        elif action_type == "VC.Pause":
            return f"Wait:{params[0] if params else '1000'}"

        self.log(f"Неизвестный тип действия пропущен: {action_type}")
        return None

    def _convert_keys(self, keys):
        keys = keys.replace("{", "").replace("}", "")
        keys = keys.replace("(", "").replace(")", "")

        map_keys = {
            "LCONTROL": "Ctrl", "CONTROL": "Ctrl",
            "LSHIFT": "Shift", "SHIFT": "Shift",
            "LALT": "Alt", "ALT": "Alt",
            "LWIN": "Win",
            "LEFT": "Left", "RIGHT": "Right",
            "UP": "Up", "DOWN": "Down",
            "ENTER": "Enter", "DELETE": "Delete",
            "HOME": "Home", "END": "End", "TAB": "Tab",
            "F1": "F1", "F2": "F2", "F3": "F3", "F4": "F4",
            "F5": "F5", "F12": "F12",
        }

        for old, new in map_keys.items():
            keys = keys.replace(old, new)

        parts = [p.strip() for p in keys.split("+") if p.strip()]
        return f"Key.Press:{'+'.join(parts)}"


def convert(xml_path):
    """Возвращает True при успехе, False при ошибке."""
    if not os.path.isfile(xml_path):
        print(f"ОШИБКА: Файл {xml_path} не найден.", file=sys.stderr)
        return False

    base, ext = os.path.splitext(xml_path)
    if ext.lower() != ".xml":
        print("ОШИБКА: Ожидается файл с расширением .xml.", file=sys.stderr)
        return False

    # Расширение .json гарантированно отличается от исходного .xml,
    # поэтому исходный файл никогда не будет перезаписан.
    output_path = base + ".json"
    tmp_path = output_path + ".tmp"

    try:
        converter = VoiceCommandsConverter()
        result = converter.convert_xml_to_json(xml_path)

        # Атомарная запись: не оставляем наполовину записанный JSON
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(result, f, ensure_ascii=False, indent=2)
        os.replace(tmp_path, output_path)

        s = converter.stats
        print(
            f"УСПЕШНО: {output_path} сохранен. "
            f"Команд: {s['commands']}, действий: {s['actions']}, пропущено: {s['skipped']}."
        )
        return True

    except Exception as e:
        print(f"SYSTEM ERROR: {str(e)}", file=sys.stderr)
        return False

    finally:
        if os.path.exists(tmp_path):
            try:
                os.remove(tmp_path)
            except OSError:
                pass


if __name__ == "__main__":
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except Exception:
            pass

    if len(sys.argv) > 1:
        sys.exit(0 if convert(sys.argv[1]) else 1)
    else:
        print("АРГУМЕНТЫ НЕ ПРИНЯТЫ", file=sys.stderr)
        sys.exit(2)
