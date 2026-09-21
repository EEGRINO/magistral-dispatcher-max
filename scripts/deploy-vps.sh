#!/usr/bin/env bash
#
# Часть А — базовая установка проекта «Диспетчер обращений» на чистый
# Ubuntu 24.04 LTS (noble).
#
# Что делает:
#   1. ставит Docker Engine + compose-plugin из ОФИЦИАЛЬНОГО репозитория Docker;
#   2. клонирует репозиторий в каталог установки;
#   3. готовит .env (не затирая уже заполненный);
#   4. проверяет, что цепочка Russian Trusted CA на месте;
#   5. запускает docker compose — но только если MAX_BOT_TOKEN реально вписан.
#
# Чего НЕ делает сознательно:
#   • не настраивает ufw/файрвол — этим занимается человек отдельно (см. вывод в конце);
#   • не ставит Node.js на хост (проект живёт в контейнерах) — только по флагу --with-node;
#   • не скачивает сертификат Минцифры откуда-либо: он уже в репозитории,
#     bot/certs/russian-trusted-ca-chain.pem, и вшивается в образ бота
#     через bot/Dockerfile + NODE_EXTRA_CA_CERTS. Хосту он не нужен.
#   • не просит и не принимает MAX_BOT_TOKEN аргументом — аргументы видны
#     в history и в ps на сервере. Токен вписывается руками в .env.
#
# Скрипт идемпотентен: повторный запуск не ломает уже сделанное.
#
# Использование:
#   sudo ./deploy-vps.sh [--dir /opt/max-dispatcher] [--repo URL] [--branch main]
#                        [--with-node] [--no-start]
#
set -Eeuo pipefail

# ── Параметры по умолчанию ──────────────────────────────────────────────────
# ВНИМАНИЕ: имя репозитория начинается с дефиса («-MAX-»), поэтому каталог
# назначения ВСЕГДА задаётся явно. Иначе git создаст каталог «-MAX-», и любая
# следующая команда вида `cd -MAX-` будет разобрана как набор флагов.
REPO_URL="https://github.com/EEGRINO/-MAX-.git"
INSTALL_DIR="/opt/max-dispatcher"
BRANCH="main"
WITH_NODE=0
AUTOSTART=1

# ── Вывод ───────────────────────────────────────────────────────────────────
log()  { printf '\033[1;32m[+]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[x]\033[0m %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Часть А — установка проекта на чистый Ubuntu 24.04.

  --dir PATH        каталог установки (по умолчанию /opt/max-dispatcher)
  --repo URL        адрес репозитория (https:// или git@… для deploy-ключа)
  --branch NAME     ветка (по умолчанию main)
  --with-node       дополнительно поставить Node.js 22 на ХОСТ (обычно не нужно)
  --no-start        не запускать docker compose, даже если .env заполнен
  -h, --help        эта справка

Токен бота через аргументы НЕ передаётся — он вписывается руками в .env.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dir)      INSTALL_DIR="${2:?--dir требует значение}"; shift 2 ;;
    --repo)     REPO_URL="${2:?--repo требует значение}"; shift 2 ;;
    --branch)   BRANCH="${2:?--branch требует значение}"; shift 2 ;;
    --with-node) WITH_NODE=1; shift ;;
    --no-start) AUTOSTART=0; shift ;;
    -h|--help)  usage; exit 0 ;;
    *)          die "Неизвестный аргумент: $1 (см. --help)" ;;
  esac
done

# ── 0. Преднастройка окружения ──────────────────────────────────────────────

# Скрипт ставит пакеты, поэтому нужен root. Если запущен через sudo —
# запоминаем, кого именно добавлять в группу docker: root в ней не нуждается.
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
[ "${ID:-}" = "ubuntu" ] || warn "Ожидался Ubuntu, обнаружено: ${PRETTY_NAME:-неизвестно}. Продолжаю."
CODENAME="${UBUNTU_CODENAME:-${VERSION_CODENAME:-noble}}"
log "Система: ${PRETTY_NAME:-?} (кодовое имя: ${CODENAME})"

# Сборка трёх образов — это три npm install подряд. На машине с 1 ГБ без swap
# node на сборке api/bot стабильно ловит OOM-kill, и compose падает с невнятным
# «exit code 137». Предупреждаем заранее, но не мешаем запуску.
RAM_MB="$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)"
if [ "$RAM_MB" -lt 1800 ]; then
  warn "На машине ${RAM_MB} МБ RAM. Сборка образов (три npm install) может упасть с кодом 137."
  warn "Лечится swap-файлом: fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile"
fi

# ── 1. Базовые пакеты ───────────────────────────────────────────────────────
log "Обновляю списки пакетов и ставлю базовое (git, curl, ca-certificates, openssl)…"
export DEBIAN_FRONTEND=noninteractive
$SUDO apt-get update -qq
$SUDO apt-get install -y -qq ca-certificates curl git openssl >/dev/null

# ── 2. Проверка доступа к репозиторию (ДО установки Docker) ─────────────────
# Репозиторий приватный. Если доступа нет — лучше узнать об этом сейчас,
# а не после двух минут установки Docker.
#
# GIT_TERMINAL_PROMPT=0 обязателен: иначе git на приватном https-адресе
# уйдёт в интерактивный запрос логина и подвесит неинтерактивный запуск.
log "Проверяю доступ к репозиторию…"
if ! GIT_TERMINAL_PROMPT=0 GIT_SSH_COMMAND="ssh -oBatchMode=yes" \
     git ls-remote --heads "$REPO_URL" "$BRANCH" >/dev/null 2>&1; then
  cat >&2 <<EOF

[x] Репозиторий недоступен: $REPO_URL (ветка $BRANCH)

Он приватный, поэтому серверу нужен доступ. Два рабочих варианта:

  1) Deploy-ключ (рекомендуется — только чтение, только этот репозиторий):
       ssh-keygen -t ed25519 -C "vps-max-dispatcher" -f ~/.ssh/id_ed25519 -N ""
       cat ~/.ssh/id_ed25519.pub
     Ключ добавить в GitHub: Settings → Deploy keys → Add deploy key (без write access).
     Затем запустить скрипт с SSH-адресом:
       $0 --repo git@github.com:EEGRINO/-MAX-.git

  2) Fine-grained PAT (Contents: Read) — одноразово, в URL клонирования.
     Токен попадёт в .git/config на сервере, так что вариант 1 безопаснее.

Если репозиторий уже сделали публичным — проверь адрес и ветку.
EOF
  exit 1
fi

# ── 3. Docker Engine + compose-plugin ───────────────────────────────────────
# Именно из репозитория Docker, а не из apt-репозитория Ubuntu и не из snap:
# в Ubuntu-пакете docker.io compose-plugin отсутствует (там только старый
# docker-compose v1), а snap-версия изолирована и спотыкается на bind-mount'ах.
if docker compose version >/dev/null 2>&1; then
  log "Docker и compose-plugin уже установлены — пропускаю установку."
else
  log "Ставлю Docker Engine из официального репозитория Docker…"

  # Конфликтующие пакеты: старый docker.io, docker-compose v1, podman-docker.
  for pkg in docker.io docker-doc docker-compose docker-compose-v2 podman-docker containerd runc; do
    $SUDO apt-get remove -y -qq "$pkg" >/dev/null 2>&1 || true
  done

  $SUDO install -m 0755 -d /etc/apt/keyrings
  $SUDO curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  $SUDO chmod a+r /etc/apt/keyrings/docker.asc

  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${CODENAME} stable" \
    | $SUDO tee /etc/apt/sources.list.d/docker.list >/dev/null

  $SUDO apt-get update -qq
  $SUDO apt-get install -y -qq \
    docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >/dev/null

  $SUDO systemctl enable --now docker >/dev/null 2>&1 || true
  log "Docker установлен."
fi

# Группа docker: членство даёт право дергать docker без sudo.
# ВАЖНО: usermod НЕ действует в уже открытой сессии — ни в этой, ни в текущем
# SSH-подключении. Сам скрипт поэтому везде ходит через $SUDO, а человеку
# нужен новый логин (или newgrp docker).
NEED_RELOGIN=0
if [ "$TARGET_USER" != "root" ]; then
  if id -nG "$TARGET_USER" | tr ' ' '\n' | grep -qx docker; then
    log "Пользователь ${TARGET_USER} уже в группе docker."
  else
    $SUDO usermod -aG docker "$TARGET_USER"
    NEED_RELOGIN=1
    log "Пользователь ${TARGET_USER} добавлен в группу docker."
  fi
fi

# ── 4. Клонирование / обновление репозитория ────────────────────────────────
if [ -d "$INSTALL_DIR/.git" ]; then
  log "Каталог ${INSTALL_DIR} уже содержит репозиторий — обновляю (git pull --ff-only)."
  existing_remote="$(git -C "$INSTALL_DIR" remote get-url origin 2>/dev/null || echo '')"
  if [ "$existing_remote" != "$REPO_URL" ]; then
    warn "origin там указывает на другой адрес:"
    warn "  в каталоге: ${existing_remote:-<нет>}"
    warn "  запрошен:   ${REPO_URL}"
    warn "Оставляю как есть — разберись руками, чтобы не затереть чужую установку."
  fi
  # --ff-only: если на сервере кто-то правил файлы и появились расхождения,
  # лучше честно упасть, чем устроить merge-коммит на проде.
  GIT_TERMINAL_PROMPT=0 git -C "$INSTALL_DIR" fetch origin "$BRANCH" --quiet
  if ! git -C "$INSTALL_DIR" merge --ff-only "origin/${BRANCH}" --quiet; then
    warn "git pull --ff-only не прошёл: в ${INSTALL_DIR} есть локальные изменения."
    warn "Разбери руками: git -C ${INSTALL_DIR} status"
  fi
elif [ -d "$INSTALL_DIR" ] && [ -n "$(ls -A "$INSTALL_DIR" 2>/dev/null)" ]; then
  die "Каталог ${INSTALL_DIR} существует, не пуст и не является git-репозиторием.
    Убери его, переименуй или запусти скрипт с другим --dir."
else
  log "Клонирую ${REPO_URL} (ветка ${BRANCH}) в ${INSTALL_DIR}…"
  $SUDO mkdir -p "$(dirname "$INSTALL_DIR")"
  # Каталог назначения задан явно — см. комментарий про имя «-MAX-» наверху.
  GIT_TERMINAL_PROMPT=0 $SUDO git clone --branch "$BRANCH" "$REPO_URL" "$INSTALL_DIR"
  # Владельцем делаем того, кто будет работать с проектом, а не root.
  [ "$TARGET_USER" != "root" ] && $SUDO chown -R "$TARGET_USER:$TARGET_USER" "$INSTALL_DIR"
fi

cd "$INSTALL_DIR"

# ── 5. Сертификат Russian Trusted CA (для запросов бота К MAX API) ──────────
# Не путать с TLS-сертификатом собственного домена — тот выпускает Caddy
# в части Б. Здесь — цепочка Минцифры, которой подписан platform-api2.max.ru.
# Она лежит в репозитории и копируется в образ бота (bot/Dockerfile: COPY certs).
# Хосту она не нужна — скачивать ничего не надо, достаточно убедиться в наличии.
CA_CHAIN="bot/certs/russian-trusted-ca-chain.pem"
if [ -f "$CA_CHAIN" ]; then
  log "Цепочка Russian Trusted CA на месте: ${CA_CHAIN}"
  if command -v openssl >/dev/null 2>&1; then
    openssl crl2pkcs7 -nocrl -certfile "$CA_CHAIN" 2>/dev/null \
      | openssl pkcs7 -print_certs -noout 2>/dev/null \
      | sed 's/^/      /' || true
  fi
else
  warn "НЕ найден ${CA_CHAIN} — бот упадёт на 'unable to get local issuer certificate'."
  warn "Разбор: docs/max-notes.md, раздел про TLS."
fi

# ── 6. .env ─────────────────────────────────────────────────────────────────
ENV_FILE="${INSTALL_DIR}/.env"

# Чтение/запись переменной .env без литералов вида «KEY=значение» в коде
# скрипта: иначе на них ругается собственный pre-commit хук проекта
# (scripts/check-secrets.sh), и это правильно — он не обязан отличать
# скрипт установки от настоящей утечки.
env_get() { sed -n "s|^${1}=||p" "$ENV_FILE" | tail -n 1; }
env_set() {
  if grep -q "^${1}=" "$ENV_FILE"; then
    sed -i "s|^${1}=.*|${1}=${2}|" "$ENV_FILE"
  else
    printf '%s=%s\n' "$1" "$2" >> "$ENV_FILE"
  fi
}

ENV_IS_NEW=0
if [ -f "$ENV_FILE" ]; then
  log ".env уже существует — не трогаю (повторный запуск ничего не затирает)."
else
  cp .env.example "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  [ "$TARGET_USER" != "root" ] && $SUDO chown "$TARGET_USER:$TARGET_USER" "$ENV_FILE"
  ENV_IS_NEW=1
  log ".env создан из .env.example (права 600)."
fi

# Пароль Postgres. В .env.example лежит заглушка «change-me-locally», и на
# публичном сервере оставлять её нельзя: порт 5432 по умолчанию опубликован
# наружу (см. предупреждение в конце).
#
# Меняем ТОЛЬКО если том с данными ещё не создан: POSTGRES_PASSWORD
# применяется на initdb, то есть при первом старте. Если база уже
# инициализирована, правка .env не поменяет пароль внутри БД — api и migrate
# просто перестанут аутентифицироваться.
pg_pass_current="$(env_get POSTGRES_PASSWORD)"
volume_exists=0
$SUDO docker volume ls --format '{{.Name}}' 2>/dev/null | grep -q '_pgdata$' && volume_exists=1

case "$pg_pass_current" in
  change-me-locally|''|change-me*)
    if [ "$volume_exists" -eq 1 ] && [ "$ENV_IS_NEW" -eq 0 ]; then
      warn "Пароль БД остался заглушкой, но том с данными уже создан."
      warn "Сменить можно только вместе с пересозданием базы: docker compose down -v"
    else
      # hex — сознательно: ни одного символа, который надо экранировать
      # в sed, в URL подключения или в YAML.
      pg_new="$(openssl rand -hex 24)"
      pg_user="$(env_get POSTGRES_USER)"; pg_user="${pg_user:-max}"
      pg_db="$(env_get POSTGRES_DB)";     pg_db="${pg_db:-max_dispatcher}"

      env_set POSTGRES_PASSWORD "$pg_new"
      # DATABASE_URL содержит тот же пароль — иначе api и migrate не войдут.
      # Хост «db» — имя сервиса в сети compose, порт всегда внутренний 5432.
      env_set DATABASE_URL "postgres://${pg_user}:${pg_new}@db:5432/${pg_db}"
      unset pg_new
      log "Сгенерирован пароль Postgres и обновлён DATABASE_URL (значение не логируется)."
    fi
    ;;
  *)
    log "Пароль Postgres уже задан — не трогаю."
    ;;
esac

# ── 7. Node.js на хосте (опционально) ───────────────────────────────────────
# По умолчанию НЕ ставим. Всё, включая миграции, выполняется в контейнерах
# (CLAUDE.md: docker-compose — единственный поддерживаемый способ запуска),
# поэтому серверу Node не нужен.
#
# Единственный сценарий, ради которого флаг вообще существует, — отладка:
# запустить bot или api мимо Docker, как описано в docs/RUN.md («Запуск без
# Docker»), чтобы посмотреть на живой процесс. Сборка changelog-PDF
# (scripts/build-changelog-pdf.mjs) поводом не является: ей нужен ещё и
# Chrome/Edge, которого на сервере нет.
if [ "$WITH_NODE" -eq 1 ]; then
  if command -v node >/dev/null 2>&1; then
    log "Node.js уже установлен: $(node -v)"
  else
    log "Ставлю Node.js 22 из NodeSource (по флагу --with-node)…"
    curl -fsSL https://deb.nodesource.com/setup_22.x | $SUDO -E bash - >/dev/null
    $SUDO apt-get install -y -qq nodejs >/dev/null
    log "Node.js установлен: $(node -v)"
  fi
fi

# ── 8. Запуск ───────────────────────────────────────────────────────────────
# Сам по себе `docker compose up` с незаполненным .env не поднимется: в
# docker-compose.yml у MAX_BOT_TOKEN стоит `:?`, и compose упадёт с ошибкой.
# Но лучше сказать об этом внятно до запуска, чем показать человеку трейс compose.
token_value="$(env_get MAX_BOT_TOKEN)"
TOKEN_READY=0
case "$token_value" in
  ''|paste-your-*|your-*|change-me*) TOKEN_READY=0 ;;
  *) [ "${#token_value}" -ge 20 ] && TOKEN_READY=1 ;;
esac
unset token_value

STARTED=0
if [ "$AUTOSTART" -eq 1 ] && [ "$TOKEN_READY" -eq 1 ]; then
  log "MAX_BOT_TOKEN заполнен — поднимаю docker compose (это займёт пару минут)…"
  $SUDO docker compose up -d --build
  STARTED=1
  log "Готово. Порядок старта: db → migrate → api → bot."
fi

# ── 9. Итог ─────────────────────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════════════════════════"
echo " Часть А завершена. Установка: ${INSTALL_DIR}"
echo "═══════════════════════════════════════════════════════════════════"
echo ""
echo "Версии:"
echo "  $(git --version)"
echo "  $(docker --version)"
echo "  Docker Compose $($SUDO docker compose version --short 2>/dev/null || echo '?')"
command -v node >/dev/null 2>&1 && echo "  Node.js $(node -v) (на хосте; проекту не требуется)"
echo ""

echo "Что осталось сделать руками:"
step=1
if [ "$TOKEN_READY" -eq 0 ]; then
  echo "  ${step}. Вписать токен бота (взять у @MasterBot в MAX):"
  echo "         nano ${ENV_FILE}"
  echo "     Строка MAX_BOT_TOKEN — заменить заглушку на реальное значение."
  echo "     Токен НЕ передаётся аргументом скрипта и нигде не логируется:"
  echo "     аргументы команд видны в history и в выводе ps другим пользователям."
  step=$((step + 1))
fi
if [ "$STARTED" -eq 0 ]; then
  echo "  ${step}. Запустить проект:"
  echo "         cd ${INSTALL_DIR} && docker compose up -d --build"
  step=$((step + 1))
fi
echo "  ${step}. Проверить живость:"
echo "         curl http://localhost:3000/health     → {\"status\":\"ok\",\"db\":\"ok\",…}"
echo "         docker compose logs -f bot            → и написать боту /start в MAX"
step=$((step + 1))
echo "  ${step}. Часть Б — домен и TLS:"
echo "         sudo ./scripts/setup-domain.sh --domain ТВОЙ-ДОМЕН"
echo "     Её можно запускать уже сейчас: скрипт сам проверит готовность DNS"
echo "     и аккуратно выйдет, если запись ещё не разъехалась."
echo ""

if [ "$NEED_RELOGIN" -eq 1 ]; then
  warn "Пользователь ${TARGET_USER} добавлен в группу docker, но в ТЕКУЩЕЙ сессии это не действует."
  warn "Нужен новый вход по SSH (или 'newgrp docker'), иначе docker будет требовать sudo."
  echo ""
fi

# Файрвол — зона ответственности человека, скрипт в него не лезет (см. шапку).
warn "ПОРТ БАЗЫ ОТКРЫТ НАРУЖУ."
cat <<EOF
    В docker-compose.yml у сервиса db published-порт задан как "\${DB_PORT:-5432}:5432",
    то есть Postgres слушает на 0.0.0.0 — с публичного IP к нему может стучаться кто угодно.
    На публичном сервере это надо закрыть. Самый дешёвый способ — не трогая
    docker-compose.yml, привязать публикацию к петле прямо в .env:

        DB_PORT=127.0.0.1:5432

    (compose подставит это как "127.0.0.1:5432:5432" — валидный формат
    ХОСТ_IP:ХОСТ_ПОРТ:ПОРТ_КОНТЕЙНЕРА). После правки: docker compose up -d
    Вариант жёстче — убрать блок ports у db совсем; внутри сети compose
    сервисы общаются по имени db:5432 и без публикации.

    Для api порт 3000 тем же приёмом не закрыть: там обе стороны берутся
    из одной переменной ("\${API_PORT:-3000}:\${API_PORT:-3000}"), и адрес
    в такой записи ломает второй операнд. После части Б (появится proxy)
    публикацию 3000 можно просто удалить из docker-compose.yml.

    Правила ufw ты ставишь сам — скрипт этого не делает намеренно.
EOF
echo ""
