#!/bin/sh
# Ищет секреты перед коммитом.
#
#   scripts/check-secrets.sh            — staged-файлы (так вызывает pre-commit)
#   scripts/check-secrets.sh --tracked  — все файлы, которые уже лежат в репозитории
#
# Ловит три вещи:
#   1. сам факт коммита .env,
#   2. присваивание секретного ключа непустым непохожим-на-плейсхолдер значением,
#   3. длинные base64url-строки — по форме токена MAX.
#
# Осознанное ограничение: проверяется только текущее содержимое, НЕ история git.
# Аудит истории — отдельная задача на Д-3.
set -eu

MODE="${1:-staged}"
REPORT="$(mktemp)"
# Содержимое файла кладём во временный файл, а не в переменную: подстановка
# $(...) вырезает null-байты, и бинарник после неё выглядит как текст —
# определить его и пропустить становится нечем.
CONTENT="$(mktemp)"
trap 'rm -f "$REPORT" "$CONTENT"' EXIT INT TERM

# Ключи, у которых значение обязано быть секретом.
KEY_RE='(MAX_BOT_TOKEN|BOT_TOKEN|ACCESS_TOKEN|AUTH_TOKEN|API_KEY|APIKEY|SECRET|PASSWORD|PASSWD|PRIVATE_KEY)[A-Za-z0-9_]*[[:space:]]*[=:]'

# Токен MAX — длинная base64url-строка (реальный ~88 символов).
TOKEN_RE='[A-Za-z0-9_-]{50,}'

# Значения, которые секретом не являются.
# `\$\{.*` — это ссылка на переменную вида ${MAX_BOT_TOKEN:?...} из docker-compose.
# Закрывающая скобка не требуется: значение обрезается по первому пробелу,
# а внутри :?-сообщения пробелы есть.
PLACEHOLDER_RE='^(|paste-your.*|your[-_].*|change[-_]?me.*|changeme.*|placeholder.*|example.*|dummy.*|test.*|todo.*|none|null|xxx+|\$\{.*|\$[A-Za-z_].*|\*+)$'

# Обрамляющая пунктуация, которую снимаем со значения: кавычки, бэктики, запятые.
STRIP_CHARS="\"'\`,;|)(<>"

report() {
  printf '%s\n' "$1" >>"$REPORT"
}

# Содержимое файла: из индекса для staged, с диска для --tracked.
read_file() {
  if [ "$MODE" = "--tracked" ]; then
    cat "$1" 2>/dev/null || true
  else
    git show ":$1" 2>/dev/null || true
  fi
}

list_files() {
  if [ "$MODE" = "--tracked" ]; then
    git ls-files
  else
    git diff --cached --name-only --diff-filter=ACM
  fi
}

scan_file() {
  file="$1"

  # 1. .env коммитить нельзя ни при каких условиях. .env.example — можно.
  case "$file" in
    .env.example | */.env.example) : ;;
    .env | .env.* | */.env | */.env.*)
      report "  $file — файл окружения не должен попадать в репозиторий"
      return 0
      ;;
  esac

  read_file "$file" > "$CONTENT" 2>/dev/null || return 0

  # Везде `return 0`, а не голый `return`: голый возвращает статус предыдущей
  # команды, и под `set -e` пустой файл молча ронял бы весь хук.
  [ -s "$CONTENT" ] || return 0

  # Бинарники пропускаем: grep -I считает файл с NUL-байтом несовпадающим.
  grep -qI . "$CONTENT" 2>/dev/null || return 0

  # 2. Присваивания секретных ключей.
  grep -nEi "$KEY_RE" "$CONTENT" 2>/dev/null | while IFS= read -r hit; do
    lineno="${hit%%:*}"
    # Значение = один токен после первого = или :, обрезанный по первому пробелу.
    # Обрезка обязательна: без неё строка документации вида
    # "| Токен | `?access_token=TOKEN` в query |" даёт ложное срабатывание
    # на весь остаток строки. Настоящий секрет пробелов не содержит.
    value="$(printf '%s' "$hit" \
      | sed -E 's/^[0-9]+:[^=:]*[=:][[:space:]]*//' \
      | sed -E 's/[[:space:]].*$//' \
      | tr -d "$STRIP_CHARS")"
    lower="$(printf '%s' "$value" | tr '[:upper:]' '[:lower:]')"

    # `grep && continue` здесь нельзя: под `set -e` упавший grep уронил бы хук.
    if printf '%s' "$lower" | grep -qE "$PLACEHOLDER_RE"; then
      continue
    fi
    [ "${#value}" -ge 12 ] || continue

    report "  $file:$lineno — секретный ключ с непустым значением (${#value} симв.)"
  done

  # 3. Строки формы токена MAX. Lock-файлы пропускаем: там base64-хеши целостности.
  case "$file" in
    *package-lock.json | *yarn.lock | *pnpm-lock.yaml | *.min.js | *.map) return 0 ;;
    .env.example | */.env.example) return 0 ;;
  esac

  grep -nE "$TOKEN_RE" "$CONTENT" 2>/dev/null | while IFS= read -r hit; do
    lineno="${hit%%:*}"
    candidate="$(printf '%s' "$hit" | grep -oE "$TOKEN_RE" | head -n 1)"
    # Настоящий токен MAX смешивает регистры и содержит - или _.
    printf '%s' "$candidate" | grep -qE '[a-z]' || continue
    printf '%s' "$candidate" | grep -qE '[A-Z]' || continue
    printf '%s' "$candidate" | grep -qE '[0-9]' || continue
    printf '%s' "$candidate" | grep -qE '[_-]' || continue

    report "  $file:$lineno — строка похожа на токен MAX (${#candidate} симв., base64url)"
  done
}

list_files | while IFS= read -r file; do
  [ -n "$file" ] || continue
  # `|| true`: падение разбора одного файла не должно превращаться в «хук упал»
  # без объяснений. Настоящие находки копятся в $REPORT и печатаются ниже.
  scan_file "$file" || true
done

if [ -s "$REPORT" ]; then
  echo ""
  echo "🔒 Проверка секретов не пройдена — коммит остановлен."
  echo ""
  sort -u "$REPORT"
  echo ""
  echo "Что делать:"
  echo "  • настоящее значение переносим в .env (он в .gitignore)"
  echo "  • в коде и в .env.example оставляем только плейсхолдер"
  echo "  • если токен уже успел утечь — перевыпустить его в @MasterBot"
  echo ""
  echo "Ложное срабатывание — и только в этом случае: git commit --no-verify"
  echo ""
  exit 1
fi

exit 0
