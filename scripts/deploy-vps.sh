#!/usr/bin/env bash
#
# Установка «Диспетчера обращений» на VPS (Ubuntu 22.04 / 24.04) — интерактивно.
#
# Скрипт задаёт вопросы; Enter на любой вопрос — значение в [скобках].
# Сначала все вопросы, потом сводка и «Начинаем?» — до этого на сервере
# ничего не меняется.
#
# Что делает:
#   1. ставит Docker Engine + compose-plugin из официального репозитория Docker;
#   2. клонирует (или обновляет) репозиторий;
#   3. готовит .env: пароль БД, порты, токен бота — не затирая заполненное;
#   4. поднимает docker compose (db → migrate → api → bot);
#   5. по желанию: тестовые данные, nginx для двух доменов, HTTPS (certbot),
#      сборку мини-приложения, правила ufw.
#
# Токен бота спрашивается скрытым вводом и пишется только в .env: аргументом
# его передать нельзя — аргументы видны в history и в ps.
#
# Повторный запуск безопасен: .env не затирается, конфиги nginx перед
# перезаписью копируются в *.bak-<время>.
#
# Использование:
#   sudo bash scripts/deploy-vps.sh             — с вопросами
#   sudo bash scripts/deploy-vps.sh --yes       — без вопросов, всё по умолчанию (nginx не трогается)
#   sudo bash scripts/deploy-vps.sh --dry-run   — только вопросы, сводка и конфиги nginx; ничего не меняет
#
# Без терминала (cron, CI) вопросов нет — как --yes.
#
set -Eeuo pipefail

# ── Значения по умолчанию ───────────────────────────────────────────────────
DEFAULT_REPO="git@github.com:EEGRINO/magistral-dispatcher-max.git"
DEFAULT_DIR="/opt/max-dispatcher"
DEFAULT_BRANCH="main"
DEFAULT_API_PORT=3000
DEFAULT_DB_PORT=5432

ASSUME_YES=0
DRY_RUN=0

# ── Вывод ───────────────────────────────────────────────────────────────────
if [ -t 1 ]; then
  B=$'\033[1m'; DIM=$'\033[2m'; G=$'\033[1;32m'; Y=$'\033[1;33m'; R=$'\033[1;31m'; C=$'\033[1;36m'; N=$'\033[0m'
else
  B=''; DIM=''; G=''; Y=''; R=''; C=''; N=''
fi
log()     { printf '%s✓%s %s\n' "$G" "$N" "$*"; }
warn()    { printf '%s!%s %s\n' "$Y" "$N" "$*"; }
die()     { printf '%s✗%s %s\n' "$R" "$N" "$*" >&2; exit 1; }
section() { printf '\n%s━━ %s ━━%s\n' "$C" "$*" "$N"; }

trap 'die "Остановился на строке ${LINENO}: ${BASH_COMMAND}"' ERR

usage() {
  cat <<'EOF'
Интерактивная установка «Диспетчера обращений» на VPS.

  --yes, -y     не задавать вопросов: всё по умолчанию, nginx и HTTPS не трогаются
  --dry-run     задать вопросы и показать план и конфиги nginx, ничего не меняя
  -h, --help    эта справка

Каталог, репозиторий, порты, домены — спрашиваются по ходу; Enter — значение
по умолчанию. Токен бота аргументом не передаётся — только скрытым вводом.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    -y|--yes)  ASSUME_YES=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *)         die "Неизвестный аргумент: $1 (см. --help)" ;;
  esac
done

# ── Вопросы ─────────────────────────────────────────────────────────────────
# Ответы читаем с терминала, а не со stdin: при `curl … | bash` stdin — это
# сам скрипт. Терминала нет (CI, --yes) — берём значения по умолчанию.
if [ "$ASSUME_YES" -eq 0 ] && [ "${DEPLOY_ANSWERS:-}" = stdin ]; then
  TTY_IN=/dev/stdin   # ответы потоком — только явно, для проверки скрипта
elif [ "$ASSUME_YES" -eq 0 ] && { : </dev/tty; } 2>/dev/null; then
  TTY_IN=/dev/tty
else
  TTY_IN=''
  # Спросить некого — как --yes: всё по умолчанию, nginx не трогаем.
  ASSUME_YES=1
fi

# ask ПЕРЕМЕННАЯ "Вопрос" "по умолчанию"
ask() {
  local __var="$1" __q="$2" __def="${3:-}" __ans=''
  if [ -n "$TTY_IN" ]; then
    if [ -n "$__def" ]; then
      printf '%s?%s %s %s[%s]%s ' "$C" "$N" "$__q" "$DIM" "$__def" "$N"
    else
      printf '%s?%s %s ' "$C" "$N" "$__q"
    fi
    IFS= read -r __ans <"$TTY_IN" || true
  fi
  printf -v "$__var" '%s' "${__ans:-$__def}"
}

# ask_yn ПЕРЕМЕННАЯ "Вопрос" y|n — в переменную пишется 1 или 0
ask_yn() {
  local __var="$1" __q="$2" __def="$3" __ans='' __hint
  [ "$__def" = y ] && __hint='Y/n' || __hint='y/N'
  if [ -n "$TTY_IN" ]; then
    printf '%s?%s %s %s[%s]%s ' "$C" "$N" "$__q" "$DIM" "$__hint" "$N"
    IFS= read -r __ans <"$TTY_IN" || true
  fi
  case "${__ans:-$__def}" in
    y|Y|yes|д|Д|да|Да) printf -v "$__var" 1 ;;
    *)                 printf -v "$__var" 0 ;;
  esac
}

# ask_secret ПЕРЕМЕННАЯ "Вопрос" — ввод не отображается и не попадает в history
ask_secret() {
  local __var="$1" __q="$2" __ans=''
  if [ -n "$TTY_IN" ]; then
    printf '%s?%s %s ' "$C" "$N" "$__q"
    if [ "$TTY_IN" = /dev/tty ]; then
      IFS= read -rs __ans </dev/tty || true
      echo
    else
      IFS= read -r __ans <"$TTY_IN" || true
    fi
  fi
  printf -v "$__var" '%s' "$__ans"
}

is_port() { [[ "$1" =~ ^[0-9]+$ ]] && [ "$1" -ge 1 ] && [ "$1" -le 65535 ]; }

# Порт слушает кто-то, кроме docker-proxy (docker-proxy — скорее всего наша
# же прошлая установка, её compose пересоздаст сам).
port_busy() {
  [ -n "$(port_holder "$1")" ]
}

# Кто слушает порт: имя программы, для docker-proxy — имя контейнера.
# Пусто — порт свободен или его держит наша же установка (контейнеры
# ${PROJECT_NAME}-*): их compose пересоздаст сам.
port_holder() {
  command -v ss >/dev/null 2>&1 || return 0
  local lines name containers c
  lines="$(ss -ltnpH "sport = :$1" 2>/dev/null || true)"
  [ -n "$lines" ] || return 0
  name="$(grep -o 'users:(("[^"]*"' <<<"$lines" | head -n 1 | cut -d'"' -f2 || true)"
  if [ "$name" = docker-proxy ] && command -v docker >/dev/null 2>&1; then
    containers="$($SUDO docker ps --filter "publish=$1" --format '{{.Names}}' 2>/dev/null || true)"
    for c in $containers; do
      if [[ "$c" != "${PROJECT_NAME:-max-dispatcher}-"* ]]; then echo "$c"; return 0; fi
    done
    if [ -n "$containers" ]; then return 0; fi
  fi
  echo "${name:-неизвестная программа}"
}

next_free_port() {
  local p="$1"
  while port_busy "$p"; do p=$((p + 1)); done
  echo "$p"
}

# ask_port ПЕРЕМЕННАЯ "Что это" по_умолчанию
ask_port() {
  local __var="$1" __what="$2" __def="$3" __p
  while :; do
    ask __p "Порт ${__what}" "$__def"
    if ! is_port "$__p"; then warn "Нужно число от 1 до 65535."; [ -n "$TTY_IN" ] || die "Неверный порт: $__p"; continue; fi
    if port_busy "$__p"; then
      warn "Порт ${__p} уже занят другой программой."
      [ -n "$TTY_IN" ] || die "Порт ${__p} занят — запустите без --yes и выберите другой."
      __def="$(next_free_port "$__p")"
      continue
    fi
    printf -v "$__var" '%s' "$__p"
    return
  done
}

# ── .env ────────────────────────────────────────────────────────────────────
# Чтение/запись переменной без литералов «КЛЮЧ=значение» в коде скрипта: на
# них справедливо ругается pre-commit хук проекта (scripts/check-secrets.sh).
env_get() { [ -f "$2" ] && sed -n "s|^${1}=||p" "$2" | tail -n 1 || true; }
env_set() {
  local key="$1" value="$2" file="$ENV_FILE"
  # Значение пишем через awk, а не sed: в токене и ссылках бывают | / &.
  if grep -q "^${key}=" "$file"; then
    VALUE="$value" awk -v k="$key" 'BEGIN { FS = OFS = "=" } $1 == k { print k "=" ENVIRON["VALUE"]; next } { print }' \
      "$file" >"${file}.tmp" && cat "${file}.tmp" >"$file" && rm -f "${file}.tmp"
  else
    printf '%s=%s\n' "$key" "$value" >>"$file"
  fi
}

# Подходят ли логин и пароль из .env к базе. Поднимает только db; пароль
# берётся из окружения контейнера (оно из .env) — в аргументы команд не попадает.
db_auth_ok() {
  $SUDO docker compose up -d db >/dev/null 2>&1 || return 1
  for _ in $(seq 1 30); do
    if $SUDO docker compose exec -T db pg_isready -q >/dev/null 2>&1; then break; fi
    sleep 1
  done
  # Не через 127.0.0.1: в образе postgres петля — trust, пароль там не проверяется.
  # Через сетевой адрес контейнера — как входят api и migrate (scram-sha-256).
  # shellcheck disable=SC2016 # $POSTGRES_* и $(hostname -i) раскрывает sh внутри контейнера
  $SUDO docker compose exec -T db sh -c \
    'PGPASSWORD="$POSTGRES_PASSWORD" psql -h "$(hostname -i | cut -d" " -f1)" -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "SELECT 1"' \
    >/dev/null 2>&1
}

# apt на свежем сервере: первые минуты занят автообновлениями (unattended-upgrades),
# а прерванное обновление оставляет dpkg недонастроенным — apt-get тогда падает.
# Ждём освобождения блокировки (до 10 минут) и доделываем настройку dpkg.
wait_apt() {
  local waited=0
  while $SUDO fuser /var/lib/dpkg/lock-frontend /var/lib/dpkg/lock >/dev/null 2>&1; do
    if [ "$waited" -eq 0 ]; then log "apt занят (скорее всего, автообновления) — жду…"; fi
    waited=$((waited + 5))
    [ "$waited" -le 600 ] || die "apt занят больше 10 минут. Посмотрите: ps aux | grep -E 'apt|dpkg'"
    sleep 5
  done
  $SUDO dpkg --configure -a >/dev/null 2>&1 || true
}

apt_get() {
  wait_apt
  $SUDO apt-get "$@"
}

# ask_domain ПЕРЕМЕННАЯ "Вопрос" по_умолчанию — домен должен быть вашим: не
# поддомен основного — переспрашиваем (вписать сюда чужой адрес, например
# platform-api2.max.ru, легко по ошибке, а сертификат на него не выпустят).
ask_domain() {
  local __var="$1" __q="$2" __def="$3" __d __sure
  while :; do
    ask __d "$__q" "$__def"
    __d="${__d,,}"
    if ! [[ "$__d" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]]; then
      warn "«${__d}» не похоже на домен."; [ -n "$TTY_IN" ] || die "Неверный домен: ${__d}"; continue
    fi
    if [ "$__d" != "$BASE_DOMAIN" ] && [[ "$__d" != *".${BASE_DOMAIN}" ]]; then
      warn "${__d} — не поддомен ${BASE_DOMAIN}. Сертификат выпустят, только если домен ваш и смотрит на этот сервер."
      __sure=0
      ask_yn __sure "Это точно ваш домен?" n
      if [ "$__sure" -ne 1 ]; then [ -n "$TTY_IN" ] || die "Домен ${__d} не подтверждён."; continue; fi
    fi
    printf -v "$__var" '%s' "$__d"
    return
  done
}

token_ready() {
  case "$1" in
    ''|paste-your-*|your-*|change-me*) return 1 ;;
    *) [ "${#1}" -ge 20 ] ;;
  esac
}

# ════════════════════════════════════════════════════════════════════════════
printf '\n%s  🏠  Диспетчер обращений — установка на сервер%s\n' "$B" "$N"
printf '%s  Enter на любой вопрос — значение в [скобках]. До «Начинаем?» ничего не меняется.%s\n' "$DIM" "$N"

# ── 0. Сервер ───────────────────────────────────────────────────────────────
section "Сервер"
if [ "$(id -u)" -eq 0 ]; then
  SUDO=""
  TARGET_USER="${SUDO_USER:-root}"
else
  command -v sudo >/dev/null 2>&1 || die "Нужен root или sudo."
  SUDO="sudo"
  TARGET_USER="$(id -un)"
fi

# shellcheck disable=SC1091
. /etc/os-release
[ "${ID:-}" = "ubuntu" ] || warn "Проверено на Ubuntu, у вас: ${PRETTY_NAME:-неизвестно}. Продолжаю."
CODENAME="${UBUNTU_CODENAME:-${VERSION_CODENAME:-noble}}"
log "Система: ${PRETTY_NAME:-?}"

# Сборка образов — три npm install подряд. С 1 ГБ RAM без swap node ловит
# OOM-kill, и compose падает с невнятным «exit code 137».
RAM_MB="$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)"
if [ "$RAM_MB" -lt 1800 ]; then
  warn "RAM ${RAM_MB} МБ — сборка может упасть с кодом 137. Помогает swap:"
  warn "  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile"
fi

# ── 1. Вопросы ──────────────────────────────────────────────────────────────
section "Куда ставить"
# Скрипт запущен из клона — берём адрес оттуда: он заведомо рабочий.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || echo .)"
CLONE_REPO="$(git -C "$SCRIPT_DIR/.." remote get-url origin 2>/dev/null || true)"
ask INSTALL_DIR "Каталог установки" "$DEFAULT_DIR"
ask REPO_URL    "Репозиторий"      "${CLONE_REPO:-$DEFAULT_REPO}"
ask BRANCH      "Ветка"            "$DEFAULT_BRANCH"

ENV_FILE="${INSTALL_DIR}/.env"
# Имя проекта compose = имя каталога: по нему названы контейнеры и том базы.
PROJECT_NAME="$(basename "$INSTALL_DIR" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9_-')"

section "Порты Docker"
printf '%s  api и PostgreSQL слушают только 127.0.0.1 — снаружи их не видно, наружу отдаёт nginx.%s\n' "$DIM" "$N"
cur_api="$(env_get API_PORT "$ENV_FILE")"; cur_api="${cur_api:-$DEFAULT_API_PORT}"
cur_db="$(env_get DB_PORT "$ENV_FILE")";   cur_db="${cur_db##*:}"; cur_db="${cur_db:-$DEFAULT_DB_PORT}"
printf '  api: %s%s%s   PostgreSQL: %s%s%s\n' "$B" "$cur_api" "$N" "$B" "$cur_db" "$N"

# Занятый порт — частая беда на общем сервере (системный Postgres на 5432).
# Тогда не спрашиваем «сменить?», а сразу предлагаем свободный.
busy=0
port_busy "$cur_api" && { warn "Порт api ${cur_api} занят другой программой."; busy=1; }
port_busy "$cur_db"  && { warn "Порт PostgreSQL ${cur_db} занят (часто — системный Postgres)."; busy=1; }
if [ "$busy" -eq 1 ]; then
  CHANGE_PORTS=1
else
  ask_yn CHANGE_PORTS "Сменить порты?" n
fi
if [ "$CHANGE_PORTS" -eq 1 ]; then
  port_busy "$cur_api" && cur_api="$(next_free_port "$cur_api")"
  port_busy "$cur_db"  && cur_db="$(next_free_port "$cur_db")"
  ask_port API_PORT "api"        "$cur_api"
  ask_port DB_PORT  "PostgreSQL" "$cur_db"
  [ "$API_PORT" != "$DB_PORT" ] || die "Порты api и PostgreSQL совпадают."
else
  API_PORT="$cur_api"; DB_PORT="$cur_db"
fi

section "Бот MAX"
cur_token="$(env_get MAX_BOT_TOKEN "$ENV_FILE")"
NEW_TOKEN=''
if token_ready "$cur_token"; then
  ask_yn KEEP_TOKEN "Токен бота уже в .env. Оставить его?" y
  [ "$KEEP_TOKEN" -eq 1 ] || ask_secret NEW_TOKEN "Новый токен бота (ввод скрыт):"
else
  printf '%s  Токен выдаёт @MasterBot в MAX. Можно вписать позже в %s%s\n' "$DIM" "$ENV_FILE" "$N"
  ask_secret NEW_TOKEN "Токен бота (ввод скрыт, Enter — позже):"
fi
unset cur_token
if [ -n "$NEW_TOKEN" ] && ! token_ready "$NEW_TOKEN"; then
  warn "Это не похоже на токен (слишком коротко) — не записываю, впишете позже."
  NEW_TOKEN=''
fi

ask_yn WANT_SEED "Загрузить тестовые данные (дома и УК для демо)?" n
SEED_PHONES=''
if [ "$WANT_SEED" -eq 1 ]; then
  printf '%s  Телефоны — персональные данные: пишутся только в .env, в вывод не попадают.%s\n' "$DIM" "$N"
  ask_secret SEED_PHONES "Телефоны тестовых жителей через запятую (Enter — без жителей):"
fi

section "База данных PostgreSQL"
# Логин, пароль и имя БД применяются, только когда база создаётся впервые
# (initdb при первом старте). Для уже созданной базы правка .env ничего не
# поменяет внутри неё — api и migrate просто перестанут входить. Поэтому для
# существующей базы не спрашиваем вовсе.
DB_EXISTS=0
if command -v docker >/dev/null 2>&1 \
   && $SUDO docker volume ls --format '{{.Name}}' 2>/dev/null | grep -qx "${PROJECT_NAME}_pgdata"; then
  DB_EXISTS=1
fi
PG_USER="$(env_get POSTGRES_USER "$ENV_FILE")"; PG_USER="${PG_USER:-max}"
PG_DB="$(env_get POSTGRES_DB "$ENV_FILE")";     PG_DB="${PG_DB:-max_dispatcher}"
PG_PASS=''
RECREATE_DB=0
if [ "$DB_EXISTS" -eq 1 ]; then
  case "$(env_get POSTGRES_PASSWORD "$ENV_FILE")" in
    change-me*|'')
      # Том базы есть, а пароля от неё в .env нет: прошлая установка или
      # неудачный запуск, после которого .env создан заново. С новым паролем
      # в старую базу не войти — api и migrate упадут на входе.
      warn "База уже есть (том ${PROJECT_NAME}_pgdata), а пароля от неё в .env нет."
      ask_yn RECREATE_DB "Удалить эту базу со всеми данными и создать новую?" n
      if [ "$RECREATE_DB" -eq 0 ]; then
        printf '%s  Тогда нужен пароль от неё — перед запуском скрипт проверит вход.%s\n' "$DIM" "$N"
      fi
      ;;
    *)
      printf '%s  База уже создана: пользователь %s, база %s. Поменять их можно только вместе%s\n' "$DIM" "$PG_USER" "$PG_DB" "$N"
      printf '%s  с пересозданием базы. Перед запуском проверю, что пароль из .env к ней подходит.%s\n' "$DIM" "$N"
      ;;
  esac
fi
if [ "$RECREATE_DB" -eq 1 ]; then DB_EXISTS=0; fi
if [ "$DB_EXISTS" -eq 0 ]; then
  NAME_RE='^[a-z_][a-z0-9_]{0,62}$'
  while :; do
    ask PG_USER "Логин пользователя БД" "$PG_USER"
    [[ "$PG_USER" =~ $NAME_RE ]] && break
    warn "Логин: латиница в нижнем регистре, цифры и «_», с буквы."; [ -n "$TTY_IN" ] || die "Неверный логин БД."
    PG_USER=max
  done
  while :; do
    ask PG_DB "Название БД" "$PG_DB"
    [[ "$PG_DB" =~ $NAME_RE ]] && break
    warn "Название: латиница в нижнем регистре, цифры и «_», с буквы."; [ -n "$TTY_IN" ] || die "Неверное название БД."
    PG_DB=max_dispatcher
  done
  # Пароль входит в адрес подключения (DATABASE_URL) и в .env, где compose
  # раскрывает «$», — поэтому только безопасные символы.
  cur_pass="$(env_get POSTGRES_PASSWORD "$ENV_FILE")"
  case "$cur_pass" in change-me*|'') pass_hint='Enter — сгенерировать' ;; *) pass_hint='Enter — оставить прежний' ;; esac
  while :; do
    ask_secret PG_PASS "Пароль пользователя БД (ввод скрыт, ${pass_hint}):"
    if [ -z "$PG_PASS" ] || [[ "$PG_PASS" =~ ^[A-Za-z0-9._~-]{12,128}$ ]]; then break; fi
    warn "Пароль: от 12 символов — латиница, цифры и . _ ~ - (он входит в адрес подключения к БД)."
    [ -n "$TTY_IN" ] || die "Неверный пароль БД."
  done
  if [ -z "$PG_PASS" ]; then
    case "$cur_pass" in
      change-me*|'') PG_PASS="$(openssl rand -hex 24 2>/dev/null || head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')" ;;
      *) PG_PASS="$cur_pass" ;;
    esac
  fi
  unset cur_pass
fi

section "nginx, домен и HTTPS"
if [ "$ASSUME_YES" -eq 1 ]; then
  WANT_NGINX=0
else
  ask_yn WANT_NGINX "Настроить nginx?" y
fi
API_DOMAIN=''; APP_DOMAIN=''; STATIC_DIR=''; WANT_DOMAIN=0; WANT_TLS=0; LE_EMAIL=''; WANT_UFW=0; NGINX_PORT=80
# 80/443 держит не nginx (например, Nginx Proxy Manager в Docker) — тогда наш
# nginx эти порты не получит. Домен и сертификат пусть остаются за тем
# прокси, а наш nginx встанет за ним на отдельный порт.
FRONT_PROXY=''
for p in 80 443; do
  h="$(port_holder "$p")"
  if [ -n "$h" ] && [ "$h" != nginx ]; then FRONT_PROXY="$h"; break; fi
done
if [ "$WANT_NGINX" -eq 1 ]; then
  printf '%s  С доменом: api.домен (наружу только /health) и app.домен (мини-приложение).%s\n' "$DIM" "$N"
  printf '%s  Без домена: мини-приложение по http://IP:порт — только проверить в браузере:%s\n' "$DIM" "$N"
  printf '%s  MAX принимает адрес мини-приложения только https:// (docs/max-notes.md).%s\n' "$DIM" "$N"
  if [ -n "$FRONT_PROXY" ]; then
    warn "Порты 80/443 уже заняты: «${FRONT_PROXY}». Свой домен и сертификат nginx здесь не получит."
    printf '%s  Настрою nginx на отдельном порту, а домен и HTTPS заведёте в «%s»:%s\n' "$DIM" "$FRONT_PROXY" "$N"
    printf '%s  прокси с вашего домена на этот сервер и порт (подсказка — в конце).%s\n' "$DIM" "$N"
    WANT_DOMAIN=0
  else
    ask_yn WANT_DOMAIN "Привязать домен?" y
  fi
fi
if [ "$WANT_NGINX" -eq 1 ] && [ "$WANT_DOMAIN" -eq 1 ]; then
  printf '%s  DNS-записи A обоих доменов должны смотреть на этот сервер.%s\n' "$DIM" "$N"
  # Основной домен по умолчанию — из имени сервера, если оно похоже на домен.
  host_fqdn="$(hostname -f 2>/dev/null || true)"
  [[ "$host_fqdn" == *.* ]] || host_fqdn=''
  ask BASE_DOMAIN "Основной домен (например, example.ru)" "$host_fqdn"
  if [ -z "$BASE_DOMAIN" ]; then
    warn "Домен не указан — настрою nginx без домена."
    WANT_DOMAIN=0
  else
    ask_domain API_DOMAIN "Домен api"             "api.${BASE_DOMAIN}"
    ask_domain APP_DOMAIN "Домен мини-приложения" "app.${BASE_DOMAIN}"
    [ "$API_DOMAIN" != "$APP_DOMAIN" ] || die "Домены api и мини-приложения должны различаться."
    ask STATIC_DIR "Каталог статики мини-приложения" "/var/www/${APP_DOMAIN}"
    ask_yn WANT_TLS "Выпустить HTTPS-сертификаты Let's Encrypt (certbot)?" y
    if [ "$WANT_TLS" -eq 1 ]; then
      ask LE_EMAIL "Email для уведомлений Let's Encrypt (Enter — без email)" ""
    fi
  fi
fi
if [ "$WANT_NGINX" -eq 1 ] && [ "$WANT_DOMAIN" -eq 0 ]; then
  # Без домена — отдельный порт: 80 на сервере часто уже занят другими сайтами.
  nginx_def=8080; port_busy "$nginx_def" && nginx_def="$(next_free_port "$nginx_def")"
  ask_port NGINX_PORT "nginx для мини-приложения" "$nginx_def"
  ask STATIC_DIR "Каталог статики мини-приложения" "/var/www/max-dispatcher-miniapp"
fi
if [ "$WANT_NGINX" -eq 1 ] && command -v ufw >/dev/null 2>&1 && $SUDO ufw status 2>/dev/null | grep -q "Status: active"; then
  if [ "$WANT_DOMAIN" -eq 1 ]; then
    ask_yn WANT_UFW "ufw включён. Открыть порты 80 и 443?" y
  else
    ask_yn WANT_UFW "ufw включён. Открыть порт ${NGINX_PORT}?" y
  fi
fi

# Домен уже обслуживает чужой конфиг nginx — второй server_name с тем же
# именем nginx молча проигнорирует, и «ничего не работает» будет загадкой.
NGINX_API_CONF="/etc/nginx/sites-available/max-dispatcher-api"
NGINX_APP_CONF="/etc/nginx/sites-available/max-dispatcher-miniapp"
if [ "$WANT_NGINX" -eq 1 ] && [ "$WANT_DOMAIN" -eq 1 ] && [ -d /etc/nginx/sites-enabled ]; then
  for d in "$API_DOMAIN" "$APP_DOMAIN"; do
    other="$(grep -rlE "server_name[^;]*[[:space:]]${d//./\\.}[[:space:];]" /etc/nginx/sites-enabled/ 2>/dev/null \
             | grep -v max-dispatcher- || true)"
    if [ -n "$other" ]; then
      warn "Домен ${d} уже настроен в: ${other//$'\n'/, }"
      warn "Чтобы не сломать работающий сайт, nginx не трогаю. Уберите старый конфиг или выберите другой домен."
      WANT_NGINX=0; WANT_TLS=0; WANT_UFW=0
    fi
  done
fi

# ── 2. Сводка ───────────────────────────────────────────────────────────────
yesno() { [ "$1" -eq 1 ] && echo "да" || echo "нет"; }
section "Сводка"
printf '  Каталог          %s\n' "$INSTALL_DIR"
printf '  Репозиторий      %s (%s)\n' "$REPO_URL" "$BRANCH"
printf '  Порты            api %s, PostgreSQL %s (127.0.0.1)\n' "$API_PORT" "$DB_PORT"
if [ -n "$NEW_TOKEN" ]; then printf '  Токен бота       будет записан в .env\n'
elif [ "${KEEP_TOKEN:-0}" -eq 1 ]; then printf '  Токен бота       остаётся прежним\n'
else printf '  Токен бота       %sвписать позже%s — бот не запустится без него\n' "$Y" "$N"; fi
printf '  Тестовые данные  %s\n' "$(yesno "$WANT_SEED")"
if [ "$RECREATE_DB" -eq 1 ]; then
  printf '  PostgreSQL       %sстарая база будет УДАЛЕНА%s, новая: пользователь %s, база %s\n' "$R" "$N" "$PG_USER" "$PG_DB"
elif [ "$DB_EXISTS" -eq 1 ]; then
  printf '  PostgreSQL       база уже есть (%s / %s) — без изменений, вход проверю перед запуском\n' "$PG_USER" "$PG_DB"
else
  printf '  PostgreSQL       пользователь %s, база %s, пароль задан (в вывод не попадает)\n' "$PG_USER" "$PG_DB"
fi
if [ "$WANT_NGINX" -eq 1 ] && [ "$WANT_DOMAIN" -eq 1 ]; then
  printf '  nginx            %s → api, %s → мини-приложение\n' "$API_DOMAIN" "$APP_DOMAIN"
  printf '  Статика          %s\n' "$STATIC_DIR"
  printf '  HTTPS            %s\n' "$(yesno "$WANT_TLS")"
  if [ "$WANT_UFW" -eq 1 ]; then printf '  ufw              открыть 80, 443\n'; fi
elif [ "$WANT_NGINX" -eq 1 ]; then
  printf '  nginx            без домена, порт %s (мини-приложение по http://IP:%s)\n' "$NGINX_PORT" "$NGINX_PORT"
  if [ -n "$FRONT_PROXY" ]; then printf '  Домен и HTTPS    в «%s» — прокси на этот сервер:%s\n' "$FRONT_PROXY" "$NGINX_PORT"; fi
  printf '  Статика          %s\n' "$STATIC_DIR"
  if [ "$WANT_UFW" -eq 1 ]; then printf '  ufw              открыть %s\n' "$NGINX_PORT"; fi
else
  printf '  nginx            не настраивается\n'
fi

# Конфиги nginx — те же, что в docs/RUN.md («Деплой на VPS»): наружу только
# явно перечисленные пути api, всё остальное — 404.
nginx_api_conf() {
  cat <<EOF
# Создано scripts/deploy-vps.sh — «Диспетчер обращений», api.
# Наружу только /health: остальные маршруты api — для бота внутри сервера.
server {
    listen 80;
    server_name ${API_DOMAIN};

    location = /health {
        proxy_pass http://127.0.0.1:${API_PORT};
        proxy_set_header Host              \$host;
        proxy_set_header X-Real-IP         \$remote_addr;
        proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    location / {
        return 404;
    }
}
EOF
}

nginx_app_conf() {
  cat <<EOF
# Создано scripts/deploy-vps.sh — «Диспетчер обращений», мини-приложение.
# Статика + маршруты api, нужные мини-аппу, под тем же origin (без CORS).
# Без домена — server_name _ на отдельном порту: 80 на сервере бывает занят.
server {
    listen ${NGINX_PORT};
    server_name ${APP_DOMAIN:-_};
    root ${STATIC_DIR};

    location /assets/ {
        add_header Cache-Control "public, max-age=31536000, immutable";
    }
    location / {
        try_files \$uri \$uri/ /index.html;
        add_header Cache-Control "no-cache";
    }
    location = /api/health {
        proxy_pass http://127.0.0.1:${API_PORT}/health;
        proxy_set_header Host              \$host;
        proxy_set_header X-Real-IP         \$remote_addr;
        proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
    # Жителя api узнаёт по подписи initData MAX (api/src/routes/app.ts).
    location /api/app/ {
        proxy_pass http://127.0.0.1:${API_PORT}/app/;
        proxy_set_header Host              \$host;
        proxy_set_header X-Real-IP         \$remote_addr;
        proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        client_max_body_size 16k;
    }
    # Иначе try_files отдал бы на неизвестный /api/... index.html с кодом 200.
    location /api/ {
        return 404;
    }
}
EOF
}

if [ "$DRY_RUN" -eq 1 ]; then
  if [ "$WANT_NGINX" -eq 1 ]; then
    if [ "$WANT_DOMAIN" -eq 1 ]; then section "Конфиг nginx: ${NGINX_API_CONF}"; nginx_api_conf; fi
    section "Конфиг nginx: ${NGINX_APP_CONF}";  nginx_app_conf
  fi
  echo
  log "--dry-run: на сервере ничего не изменено."
  exit 0
fi

echo
ask_yn GO "Начинаем?" y
[ "$GO" -eq 1 ] || { warn "Отменено — ничего не изменено."; exit 0; }

# ── 3. Пакеты и доступ к репозиторию ────────────────────────────────────────
section "Пакеты"
export DEBIAN_FRONTEND=noninteractive
apt_get update -qq
apt_get install -y -qq ca-certificates curl git openssl >/dev/null
log "git, curl, openssl на месте."

# Репозиторий приватный: без доступа лучше упасть сейчас, а не после
# двух минут установки Docker. GIT_TERMINAL_PROMPT=0 — иначе git на
# приватном https-адресе повиснет на запросе логина.
if ! GIT_TERMINAL_PROMPT=0 GIT_SSH_COMMAND="ssh -oBatchMode=yes" \
     git ls-remote --heads "$REPO_URL" "$BRANCH" >/dev/null 2>&1; then
  cat >&2 <<EOF

${R}✗${N} Нет доступа к репозиторию: ${REPO_URL} (ветка ${BRANCH})

  Репозиторий приватный — серверу нужен deploy-ключ (только чтение):
    ssh-keygen -t ed25519 -f ~/.ssh/max_deploy_key -N "" -C "vps-deploy"
    cat ~/.ssh/max_deploy_key.pub
  Ключ → GitHub → Settings → Deploy keys → Add deploy key (без write access).
  Подробно — docs/RUN.md, «Доступ с сервера к приватному репозиторию».
EOF
  exit 1
fi
log "Репозиторий доступен."

# ── 4. Docker ───────────────────────────────────────────────────────────────
section "Docker"
# Из репозитория Docker, а не из apt Ubuntu и не snap: в docker.io нет
# compose-plugin, а snap-версия спотыкается на bind-mount'ах.
if docker compose version >/dev/null 2>&1; then
  log "Docker и compose уже установлены."
else
  for pkg in docker.io docker-doc docker-compose docker-compose-v2 podman-docker containerd runc; do
    apt_get remove -y -qq "$pkg" >/dev/null 2>&1 || true
  done
  $SUDO install -m 0755 -d /etc/apt/keyrings
  $SUDO curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  $SUDO chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${CODENAME} stable" \
    | $SUDO tee /etc/apt/sources.list.d/docker.list >/dev/null
  apt_get update -qq
  apt_get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >/dev/null
  $SUDO systemctl enable --now docker >/dev/null 2>&1 || true
  log "Docker установлен."
fi

# Группа docker действует только в НОВОЙ сессии — сам скрипт ходит через $SUDO.
NEED_RELOGIN=0
if [ "$TARGET_USER" != "root" ] && ! id -nG "$TARGET_USER" | tr ' ' '\n' | grep -qx docker; then
  $SUDO usermod -aG docker "$TARGET_USER"
  NEED_RELOGIN=1
  log "${TARGET_USER} добавлен в группу docker."
fi

# ── 5. Код ──────────────────────────────────────────────────────────────────
section "Код"
if [ -d "$INSTALL_DIR/.git" ]; then
  # --ff-only: правки на сервере — повод остановиться, а не делать merge на проде.
  GIT_TERMINAL_PROMPT=0 git -C "$INSTALL_DIR" fetch origin "$BRANCH" --quiet
  if git -C "$INSTALL_DIR" merge --ff-only "origin/${BRANCH}" --quiet; then
    log "Обновлён до последнего коммита: $(git -C "$INSTALL_DIR" log -1 --format='%h %s')"
  else
    warn "В ${INSTALL_DIR} есть локальные изменения — обновление пропущено (git -C ${INSTALL_DIR} status)."
  fi
elif [ -d "$INSTALL_DIR" ] && [ -n "$(ls -A "$INSTALL_DIR" 2>/dev/null)" ]; then
  die "${INSTALL_DIR} не пуст и не git-репозиторий. Выберите другой каталог."
else
  $SUDO mkdir -p "$(dirname "$INSTALL_DIR")"
  GIT_TERMINAL_PROMPT=0 $SUDO git clone --quiet --branch "$BRANCH" "$REPO_URL" "$INSTALL_DIR"
  if [ "$TARGET_USER" != "root" ]; then $SUDO chown -R "$TARGET_USER:$TARGET_USER" "$INSTALL_DIR"; fi
  log "Склонирован в ${INSTALL_DIR}."
fi
cd "$INSTALL_DIR"

# Цепочка Минцифры для запросов бота к platform-api2.max.ru — в репозитории,
# вшивается в образ бота. Не путать с сертификатом вашего домена (certbot ниже).
[ -f bot/certs/russian-trusted-ca-chain.pem ] \
  || warn "Нет bot/certs/russian-trusted-ca-chain.pem — бот упадёт на 'unable to get local issuer certificate'."

# ── 6. .env ─────────────────────────────────────────────────────────────────
section ".env"
if [ ! -f "$ENV_FILE" ]; then
  cp .env.example "$ENV_FILE"
  log ".env создан из .env.example."
fi
chmod 600 "$ENV_FILE"
if [ "$TARGET_USER" != "root" ]; then $SUDO chown "$TARGET_USER:$TARGET_USER" "$ENV_FILE"; fi

# Логин, пароль и имя БД — только пока база не создана: они применяются при
# initdb, потом правка .env просто отрезала бы api и migrate от базы.
if [ "$DB_EXISTS" -eq 1 ]; then
  log "PostgreSQL: база уже создана — логин, пароль и имя не меняю."
else
  env_set POSTGRES_USER "$PG_USER"
  env_set POSTGRES_DB "$PG_DB"
  env_set POSTGRES_PASSWORD "$PG_PASS"
  # Хост «db» — имя сервиса в сети compose, порт всегда внутренний 5432.
  env_set DATABASE_URL "postgres://${PG_USER}:${PG_PASS}@db:5432/${PG_DB}"
  log "PostgreSQL: пользователь ${PG_USER}, база ${PG_DB}, пароль записан (в вывод не попадает)."
fi
unset PG_PASS

env_set API_PORT "$API_PORT"
env_set DB_PORT "$DB_PORT"
log "Порты: api ${API_PORT}, PostgreSQL ${DB_PORT}."

if [ -n "$NEW_TOKEN" ]; then
  env_set MAX_BOT_TOKEN "$NEW_TOKEN"
  log "Токен бота записан в .env (длина ${#NEW_TOKEN})."
fi
unset NEW_TOKEN

if [ "$WANT_SEED" -eq 1 ] && [ -n "$SEED_PHONES" ]; then
  env_set SEED_TEST_PHONES "$SEED_PHONES"
  log "Тестовые телефоны записаны в .env."
fi
unset SEED_PHONES

if [ "$WANT_NGINX" -eq 1 ]; then env_set MINIAPP_DIST_DIR "$STATIC_DIR"; fi

TOKEN_OK=0
token_ready "$(env_get MAX_BOT_TOKEN "$ENV_FILE")" && TOKEN_OK=1

# ── 7. Запуск ───────────────────────────────────────────────────────────────
# Без токена compose не поднимется вовсе (MAX_BOT_TOKEN с `:?` в
# docker-compose.yml) — ни up, ни run. Тогда только подсказка в конце.
STARTED=0
if [ "$TOKEN_OK" -eq 1 ]; then
  section "Запуск"

  if [ "$RECREATE_DB" -eq 1 ]; then
    # Житель подтвердил «удалить базу» ещё в вопросах; здесь — после «Начинаем?».
    $SUDO docker compose down -v >/dev/null 2>&1 || true
    $SUDO docker volume rm "${PROJECT_NAME}_pgdata" >/dev/null 2>&1 || true
    log "Старая база удалена — будет создана новая."
  elif [ "$DB_EXISTS" -eq 1 ]; then
    # Пароль из .env к существующей базе может не подойти — тогда migrate
    # упадёт с «password authentication failed». Проверяем заранее и даём
    # исправить здесь же, а не после двух минут сборки.
    while ! db_auth_ok; do
      warn "Логин или пароль из .env не подходят к существующей базе (том ${PROJECT_NAME}_pgdata)."
      if [ -z "$TTY_IN" ]; then
        die "Впишите в ${ENV_FILE} прежние POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_DB и DATABASE_URL — или удалите базу: cd ${INSTALL_DIR} && docker compose down -v"
      fi
      wipe=0
      ask_yn wipe "Удалить существующую базу со всеми данными и создать новую?" n
      if [ "$wipe" -eq 1 ]; then
        $SUDO docker compose down -v >/dev/null 2>&1 || true
        $SUDO docker volume rm "${PROJECT_NAME}_pgdata" >/dev/null 2>&1 || true
        log "Старая база удалена — будет создана новая с паролем из .env."
        break
      fi
      ask PG_USER "Логин от существующей базы" "$(env_get POSTGRES_USER "$ENV_FILE")"
      ask PG_DB   "Название существующей базы" "$(env_get POSTGRES_DB "$ENV_FILE")"
      ask_secret PG_PASS "Пароль от существующей базы (ввод скрыт, Enter — выйти):"
      [ -n "$PG_PASS" ] || die "Остановлено. Пароль от базы — в .env прошлой установки (POSTGRES_PASSWORD)."
      env_set POSTGRES_USER "$PG_USER"
      env_set POSTGRES_DB "$PG_DB"
      env_set POSTGRES_PASSWORD "$PG_PASS"
      env_set DATABASE_URL "postgres://${PG_USER}:${PG_PASS}@db:5432/${PG_DB}"
      unset PG_PASS
    done
    log "Вход в существующую базу проверен."
  fi

  log "Собираю и поднимаю контейнеры — пара минут…"
  # --remove-orphans: контейнеры проекта, которых больше нет в compose (старый Caddy-прокси
  # держал бы 80/443, нужные nginx).
  if ! $SUDO docker compose up -d --build --remove-orphans; then
    die "Контейнеры не поднялись. Причина — в логах: cd ${INSTALL_DIR} && docker compose logs migrate api | tail -40"
  fi
  STARTED=1
  log "Запущено: db → migrate → api → bot."

  if [ "$WANT_SEED" -eq 1 ]; then
    $SUDO docker compose run --rm -T migrate npm run seed | grep -E '^(Тестовые|  )' || true
  fi
fi

# ── 8. nginx, мини-приложение, HTTPS ────────────────────────────────────────
TLS_OK=0
if [ "$WANT_NGINX" -eq 1 ]; then
  section "nginx"
  if ! command -v nginx >/dev/null 2>&1; then
    apt_get install -y -qq nginx >/dev/null
    log "nginx установлен."
  fi
  $SUDO mkdir -p "$STATIC_DIR"

  if [ "$STARTED" -eq 1 ]; then
    # Вывод не глушим: сборка (--build) рисует прогресс в консоль и на Linux
    # падает с «failed to get console», если stdout перенаправлен в /dev/null.
    # -T — контейнеру терминал не нужен, он только копирует файлы.
    $SUDO docker compose --profile deploy run --rm -T --build miniapp-build
    log "Мини-приложение собрано в ${STATIC_DIR}."
  else
    warn "Мини-приложение не собрано — нет токена бота (см. «Что осталось» ниже)."
  fi

  # С доменом — два сайта (api и мини-приложение), без домена — один.
  confs=("$NGINX_APP_CONF")
  if [ "$WANT_DOMAIN" -eq 1 ]; then confs+=("$NGINX_API_CONF"); fi
  stamp="$(date +%Y%m%d-%H%M%S)"
  backups=()
  for conf in "${confs[@]}"; do
    if [ -f "$conf" ]; then
      $SUDO cp "$conf" "${conf}.bak-${stamp}"
      backups+=("$conf")
    fi
  done
  if [ "$WANT_DOMAIN" -eq 1 ]; then nginx_api_conf | $SUDO tee "$NGINX_API_CONF" >/dev/null; fi
  nginx_app_conf | $SUDO tee "$NGINX_APP_CONF" >/dev/null
  for conf in "${confs[@]}"; do $SUDO ln -sf "$conf" /etc/nginx/sites-enabled/; done

  if [ "$WANT_DOMAIN" -eq 0 ]; then
    # Наш сайт api с прошлого запуска (с доменом) слушает 80 — без домена он не нужен.
    $SUDO rm -f "/etc/nginx/sites-enabled/$(basename "$NGINX_API_CONF")"
    # Порт 80 держит другой прокси — сайт nginx по умолчанию (default, тоже 80)
    # не дал бы nginx стартовать. Отключаем только ссылку: файл остаётся в
    # sites-available, вернуть — ln -s ../sites-available/default.
    if [ -n "$FRONT_PROXY" ] && [ -L /etc/nginx/sites-enabled/default ]; then
      $SUDO rm -f /etc/nginx/sites-enabled/default
      log "Отключён сайт nginx по умолчанию (default): порт 80 занимает «${FRONT_PROXY}»."
    fi
  fi

  if $SUDO nginx -t >/dev/null 2>&1; then
    if $SUDO systemctl is-active --quiet nginx; then
      $SUDO systemctl reload nginx
    elif ! $SUDO systemctl enable --now nginx >/dev/null 2>&1; then
      # Только что поставленный nginx не стартовал — почти всегда порт уже занят.
      listen_port=80
      if [ "$WANT_DOMAIN" -eq 0 ]; then listen_port="$NGINX_PORT"; fi
      holder="$(ss -ltnpH "sport = :${listen_port}" 2>/dev/null | grep -o 'users:(("[^"]*"' | head -n 1 | cut -d'"' -f2 || true)"
      die "nginx не запустился.${holder:+ Порт ${listen_port} занят программой «${holder}».} Подробности: journalctl -u nginx -n 20 --no-pager"
    fi
    if [ "$WANT_DOMAIN" -eq 1 ]; then log "nginx: ${API_DOMAIN}, ${APP_DOMAIN}."; else log "nginx: порт ${NGINX_PORT}."; fi
  else
    # Сломанный конфиг не оставляем: откатываем, чтобы не уронить другие сайты.
    for conf in "${confs[@]}"; do
      if [[ " ${backups[*]:-} " == *" $conf "* ]]; then
        $SUDO cp "${conf}.bak-${stamp}" "$conf"
      else
        $SUDO rm -f "$conf" "/etc/nginx/sites-enabled/$(basename "$conf")"
      fi
    done
    $SUDO nginx -t || true
    die "nginx -t не прошёл — конфиги откатены, работающие сайты не тронуты."
  fi

  if [ "$WANT_UFW" -eq 1 ] && [ "$WANT_DOMAIN" -eq 1 ]; then
    $SUDO ufw allow 80/tcp >/dev/null && $SUDO ufw allow 443/tcp >/dev/null
    log "ufw: открыты 80 и 443."
  elif [ "$WANT_UFW" -eq 1 ]; then
    $SUDO ufw allow "${NGINX_PORT}/tcp" >/dev/null
    log "ufw: открыт ${NGINX_PORT}."
  fi

  if [ "$WANT_TLS" -eq 1 ] && [ "$WANT_DOMAIN" -eq 1 ]; then
    section "HTTPS"
    if ! command -v certbot >/dev/null 2>&1; then
      apt_get install -y -qq certbot python3-certbot-nginx >/dev/null
    fi
    email_args=(--register-unsafely-without-email)
    if [ -n "$LE_EMAIL" ]; then email_args=(-m "$LE_EMAIL"); fi
    # Домена нет в DNS — certbot заведомо не выпустит, не тратим попытку
    # (у Let's Encrypt лимит неудачных попыток в час).
    no_dns=''
    for d in "$API_DOMAIN" "$APP_DOMAIN"; do
      getent ahostsv4 "$d" >/dev/null 2>&1 || no_dns="${no_dns:+$no_dns, }$d"
    done
    # Не падаем, если certbot не смог: сайт по http уже работает, сертификат
    # можно выпустить позже той же командой.
    if [ -n "$no_dns" ]; then
      warn "Нет DNS-записи для: ${no_dns} — сертификат не запрашиваю."
      warn "Заведите A-запись на этот сервер и выполните: sudo certbot --nginx -d ${API_DOMAIN} -d ${APP_DOMAIN}"
    elif $SUDO certbot --nginx -n --agree-tos --redirect --keep-until-expiring \
         "${email_args[@]}" -d "$API_DOMAIN" -d "$APP_DOMAIN"; then
      TLS_OK=1
      log "Сертификаты выпущены, http → https."
    else
      warn "certbot не выпустил сертификат — причина в его сообщении выше. Частые: A-запись домена"
      warn "смотрит не на этот сервер, закрыт порт 80, домен чужой (Let's Encrypt откажет по политике)."
      warn "Повторить: sudo certbot --nginx -d ${API_DOMAIN} -d ${APP_DOMAIN}"
    fi
  fi
fi

# ── 9. Итог ─────────────────────────────────────────────────────────────────
section "Готово"
scheme=http
if [ "$TLS_OK" -eq 1 ]; then scheme=https; fi
# Без домена — адрес по IP сервера (первый из hostname -I).
server_ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
APP_URL="${scheme}://${APP_DOMAIN}"
if [ "$WANT_DOMAIN" -eq 0 ]; then APP_URL="http://${server_ip:-IP-сервера}:${NGINX_PORT}"; fi
if [ "$STARTED" -eq 1 ]; then
  if curl -fsS "http://127.0.0.1:${API_PORT}/health" >/dev/null 2>&1; then
    log "api отвечает: http://127.0.0.1:${API_PORT}/health"
  else
    warn "api пока не отвечает — посмотрите: docker compose logs api"
  fi
fi
if [ "$WANT_NGINX" -eq 1 ] && [ "$WANT_DOMAIN" -eq 1 ]; then
  printf '  api             %s://%s/health\n' "$scheme" "$API_DOMAIN"
fi
if [ "$WANT_NGINX" -eq 1 ]; then
  printf '  мини-приложение %s\n' "$APP_URL"
  # hostname -I знает только адрес внутри сети сервера — снаружи он может быть недоступен.
  if [ "$WANT_DOMAIN" -eq 0 ] && [[ "${server_ip:-}" =~ ^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.) ]]; then
    printf '%s  %s — адрес во внутренней сети сервера. Снаружи — по публичному IP (тому, что для SSH)%s\n' "$DIM" "$server_ip" "$N"
    printf '%s  или через туннель: ssh -L %s:127.0.0.1:%s <сервер>, затем http://localhost:%s%s\n' "$DIM" "$NGINX_PORT" "$NGINX_PORT" "$NGINX_PORT" "$N"
  fi
fi

echo
printf '%sЧто осталось%s\n' "$B" "$N"
step=1
if [ "$TOKEN_OK" -eq 0 ]; then
  printf '  %d. Вписать токен бота (@MasterBot в MAX) в %s — строка MAX_BOT_TOKEN,\n' "$step" "$ENV_FILE"
  printf '     затем снова запустить этот скрипт (или: cd %s && docker compose up -d --build).\n' "$INSTALL_DIR"
  step=$((step + 1))
fi
if [ "$WANT_NGINX" -eq 1 ] && [ "$TLS_OK" -eq 1 ]; then
  printf '  %d. В настройках бота на business.max.ru указать адрес мини-приложения: %s\n' "$step" "$APP_URL"
  step=$((step + 1))
elif [ "$WANT_NGINX" -eq 1 ] && [ -n "$FRONT_PROXY" ]; then
  printf '  %d. В «%s» добавить прокси для домена мини-приложения:\n' "$step" "$FRONT_PROXY"
  printf '       куда — http://%s:%s (Forward Hostname/IP и Port в Nginx Proxy Manager),\n' "${server_ip:-IP-сервера}" "$NGINX_PORT"
  printf '       там же выпустить сертификат Let'\''s Encrypt и включить Force SSL.\n'
  printf '     Затем в настройках бота на business.max.ru указать https://ваш-домен\n'
  step=$((step + 1))
elif [ "$WANT_NGINX" -eq 1 ]; then
  printf '  %d. MAX принимает адрес мини-приложения только https://: нужен домен и сертификат (запустите скрипт снова).\n' "$step"
  step=$((step + 1))
fi
printf '  %d. Завести дома и жителей — docs/RUN.md, «Дома и жители» (или pgAdmin).\n' "$step"
step=$((step + 1))
printf '  %d. Написать боту /start в MAX → «Поделиться контактом».\n' "$step"
echo
printf '%sОбновление потом:%s cd %s && git pull && docker compose up -d --build\n' "$DIM" "$N" "$INSTALL_DIR"
if [ "$WANT_NGINX" -eq 1 ]; then
  printf '%s  мини-приложение: docker compose --profile deploy run --rm --build miniapp-build%s\n' "$DIM" "$N"
fi

if [ "$NEED_RELOGIN" -eq 1 ]; then
  echo
  warn "Перезайдите по SSH — иначе docker будет требовать sudo (группа docker действует в новой сессии)."
fi
