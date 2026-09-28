#!/usr/bin/env bash
#
# Удаление «Диспетчера обращений» с сервера — обратный шаг к deploy-vps.sh.
#
# Что убирает (каждый пункт — по вопросу):
#   1. резервная копия базы (pg_dump) — до всего остального, по умолчанию да;
#   2. контейнеры, сеть и собранные образы проекта; том с базой — отдельным вопросом;
#   3. сайты nginx max-dispatcher-api / max-dispatcher-miniapp и их *.bak-*;
#   4. сертификаты Let's Encrypt этих сайтов;
#   5. статика мини-приложения;
#   6. каталог установки вместе с .env.
#
# Не трогает: Docker, nginx, certbot, правила ufw и чужие сайты — ими могут
# пользоваться другие проекты на сервере.
#
# Использование:
#   sudo bash scripts/uninstall.sh              — с вопросами
#   sudo bash scripts/uninstall.sh --dry-run    — только вопросы и план; ничего не меняет
#
# Без терминала не работает: удаление всегда подтверждает человек.
#
set -Eeuo pipefail

DEFAULT_DIR="/opt/max-dispatcher"
COMPOSE_NAME="max-dispatcher"
NGINX_CONFS=(/etc/nginx/sites-available/max-dispatcher-api /etc/nginx/sites-available/max-dispatcher-miniapp)

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
Удаление «Диспетчера обращений» с сервера.

  --dry-run     задать вопросы и показать план, ничего не меняя
  -h, --help    эта справка

Перед удалением предлагается сохранить базу в файл (pg_dump).
Docker, nginx, certbot и правила ufw не удаляются.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *)         die "Неизвестный аргумент: $1 (см. --help)" ;;
  esac
done

# ── Вопросы ─────────────────────────────────────────────────────────────────
# Ответы — с терминала, как в deploy-vps.sh. Без терминала ничего не удаляем.
if [ "${DEPLOY_ANSWERS:-}" = stdin ]; then
  TTY_IN=/dev/stdin   # ответы потоком — только явно, для проверки скрипта
elif { : </dev/tty; } 2>/dev/null; then
  TTY_IN=/dev/tty
else
  die "Нет терминала — удаление без подтверждения не выполняю."
fi

# ask ПЕРЕМЕННАЯ "Вопрос" "по умолчанию"
ask() {
  local __var="$1" __q="$2" __def="${3:-}" __ans=''
  if [ -n "$__def" ]; then
    printf '%s?%s %s %s[%s]%s ' "$C" "$N" "$__q" "$DIM" "$__def" "$N"
  else
    printf '%s?%s %s ' "$C" "$N" "$__q"
  fi
  IFS= read -r __ans <"$TTY_IN" || true
  printf -v "$__var" '%s' "${__ans:-$__def}"
}

# ask_yn ПЕРЕМЕННАЯ "Вопрос" y|n — в переменную пишется 1 или 0
ask_yn() {
  local __var="$1" __q="$2" __def="$3" __ans='' __hint
  [ "$__def" = y ] && __hint='Y/n' || __hint='y/N'
  printf '%s?%s %s %s[%s]%s ' "$C" "$N" "$__q" "$DIM" "$__hint" "$N"
  IFS= read -r __ans <"$TTY_IN" || true
  case "${__ans:-$__def}" in
    y|Y|yes|д|Д|да|Да) printf -v "$__var" 1 ;;
    *)                 printf -v "$__var" 0 ;;
  esac
}

# Значение переменной из .env без source: файл может содержать что угодно.
env_get() {
  [ -f "$ENV_FILE" ] || return 0
  awk -F= -v k="$1" '$1 == k { sub(/^[^=]*=/, ""); gsub(/^["'\'']|["'\'']$/, ""); v = $0 } END { print v }' "$ENV_FILE"
}

printf '\n%s  🗑️  Диспетчер обращений — удаление с сервера%s\n' "$B" "$N"
printf '%s  Enter на любой вопрос — значение в [скобках]. До подтверждения ничего не удаляется.%s\n' "$DIM" "$N"

if [ "$(id -u)" -eq 0 ]; then SUDO=""; else
  command -v sudo >/dev/null 2>&1 || die "Нужны права root: запустите через sudo."
  SUDO="sudo"
fi
command -v docker >/dev/null 2>&1 || die "Docker не найден — удалять через compose нечего. Каталог проекта можно удалить вручную."

# ── Что удаляем ─────────────────────────────────────────────────────────────
section "Каталог установки"
# Запущен из установленного проекта — предлагаем его же.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || echo .)"
HERE="$(cd "$SCRIPT_DIR/.." 2>/dev/null && pwd || echo "")"
if [ -n "$HERE" ] && [ -f "$HERE/.env" ] && [ -f "$HERE/docker-compose.yml" ]; then
  GUESS_DIR="$HERE"
else
  GUESS_DIR="$DEFAULT_DIR"
fi
ask INSTALL_DIR "Каталог установки" "$GUESS_DIR"
INSTALL_DIR="$(realpath -m "$INSTALL_DIR")"

# Защита от опечатки: rm -rf по «/opt» или домашнему каталогу не делаем, а
# каталог должен быть именно этим проектом.
case "$INSTALL_DIR" in
  /|/root|/home|/opt|/var|/var/www|/usr|/etc|/srv|/project|/tmp)
    die "${INSTALL_DIR} — не каталог проекта, его не удаляю." ;;
esac
if getent passwd | cut -d: -f6 | grep -qx "$INSTALL_DIR"; then
  die "${INSTALL_DIR} — домашний каталог пользователя, его не удаляю."
fi
[ -d "$INSTALL_DIR" ] || die "Каталога ${INSTALL_DIR} нет. Где стоит проект: docker inspect ${COMPOSE_NAME}-api-1 --format '{{ index .Config.Labels \"com.docker.compose.project.working_dir\" }}'"
grep -qE "^name: ${COMPOSE_NAME}[[:space:]]*$" "$INSTALL_DIR/docker-compose.yml" 2>/dev/null \
  || die "В ${INSTALL_DIR} нет docker-compose.yml проекта ${COMPOSE_NAME} — не похоже на установку диспетчера."

ENV_FILE="$INSTALL_DIR/.env"
[ -f "$ENV_FILE" ] || warn "Нет ${ENV_FILE} — продолжаю без него."
STAMP="$(date +%Y%m%d-%H%M%S)"

section "База данных"
ask_yn WANT_BACKUP "Сохранить базу в файл перед удалением (pg_dump)?" y
BACKUP_FILE=''
if [ "$WANT_BACKUP" -eq 1 ]; then
  BACKUP_HOME="$(getent passwd "${SUDO_USER:-root}" | cut -d: -f6)"
  ask BACKUP_FILE "Файл копии" "${BACKUP_HOME:-/root}/max-dispatcher-backup-${STAMP}.sql"
  case "$(realpath -m "$BACKUP_FILE")" in
    "$INSTALL_DIR"/*) die "Копия внутри ${INSTALL_DIR} удалится вместе с каталогом — укажите другое место." ;;
  esac
fi
ask_yn WANT_DB "Удалить базу (том ${COMPOSE_NAME}_pgdata) — заявки, жители, дома?" y

# ── nginx, сертификаты, статика ─────────────────────────────────────────────
FOUND_CONFS=(); SITE_NAMES=''
for conf in "${NGINX_CONFS[@]}"; do
  if [ -e "$conf" ] || [ -e "/etc/nginx/sites-enabled/$(basename "$conf")" ]; then
    FOUND_CONFS+=("$conf")
    SITE_NAMES="${SITE_NAMES:+$SITE_NAMES, }$(basename "$conf")"
  fi
done

# Сертификаты — те, что certbot вписал в наши сайты.
CERTS=()
if [ "${#FOUND_CONFS[@]}" -gt 0 ]; then
  while IFS= read -r name; do
    [ -n "$name" ] && CERTS+=("$name")
  done < <(sed -n 's#.*/etc/letsencrypt/live/\([^/]*\)/.*#\1#p' "${FOUND_CONFS[@]}" 2>/dev/null | sort -u)
fi

# Статика мини-приложения: из .env, иначе из root в конфиге nginx.
STATIC_DIR="$(env_get MINIAPP_DIST_DIR)"
if [ -z "$STATIC_DIR" ] && [ -e "${NGINX_CONFS[1]}" ]; then
  STATIC_DIR="$(awk '$1 == "root" { gsub(/;/, "", $2); print $2; exit }' "${NGINX_CONFS[1]}")"
fi
# Только подкаталог /var/www — сам /var/www и что-то вне него не трогаем.
case "$STATIC_DIR" in
  /var/www/?*) [ -d "$STATIC_DIR" ] || STATIC_DIR='' ;;
  *)           STATIC_DIR='' ;;
esac

WANT_NGINX=0; WANT_CERTS=0; WANT_STATIC=0
if [ "${#FOUND_CONFS[@]}" -gt 0 ] || [ "${#CERTS[@]}" -gt 0 ] || [ -n "$STATIC_DIR" ]; then
  section "nginx, HTTPS, мини-приложение"
fi
if [ "${#FOUND_CONFS[@]}" -gt 0 ]; then
  ask_yn WANT_NGINX "Удалить сайты nginx (${SITE_NAMES})?" y
fi
if [ "${#CERTS[@]}" -gt 0 ]; then
  ask_yn WANT_CERTS "Удалить сертификаты Let's Encrypt (${CERTS[*]})?" y
fi
if [ -n "$STATIC_DIR" ]; then
  ask_yn WANT_STATIC "Удалить статику мини-приложения (${STATIC_DIR})?" y
fi

# ── Сводка ──────────────────────────────────────────────────────────────────
section "Сводка"
printf '  Каталог          %s — удаляется вместе с .env\n' "$INSTALL_DIR"
printf '  Контейнеры       %s: остановить и удалить, образы проекта — тоже\n' "$COMPOSE_NAME"
if [ "$WANT_BACKUP" -eq 1 ]; then printf '  Копия базы       %s\n' "$BACKUP_FILE"; else printf '  Копия базы       %sне делается%s\n' "$Y" "$N"; fi
if [ "$WANT_DB" -eq 1 ]; then printf '  База             %sудалить%s\n' "$R" "$N"; else printf '  База             оставить (том %s_pgdata)\n' "$COMPOSE_NAME"; fi
if [ "$WANT_NGINX" -eq 1 ]; then printf '  nginx            удалить %s\n' "$SITE_NAMES"; fi
if [ "$WANT_CERTS" -eq 1 ]; then printf '  Сертификаты      удалить %s\n' "${CERTS[*]}"; fi
if [ "$WANT_STATIC" -eq 1 ]; then printf '  Статика          удалить %s\n' "$STATIC_DIR"; fi
printf '%s  Остаются: Docker, nginx, certbot, правила ufw.%s\n' "$DIM" "$N"

if [ "$WANT_DB" -eq 1 ] && [ "$WANT_BACKUP" -eq 0 ]; then
  warn "База удалится без копии — вернуть её будет нельзя."
fi

if [ "$DRY_RUN" -eq 1 ]; then
  echo
  log "--dry-run: на сервере ничего не изменено."
  exit 0
fi

echo
ask CONFIRM "Для подтверждения введите слово «удалить»:" ""
[ "$CONFIRM" = "удалить" ] || die "Не подтверждено — ничего не удалено."

# ── 1. Копия базы ───────────────────────────────────────────────────────────
cd "$INSTALL_DIR"
# Без .env compose не разберёт docker-compose.yml (POSTGRES_PASSWORD обязателен).
# Для down и pg_dump пароль не нужен — подставляем заглушку только в этом случае.
if [ ! -f "$ENV_FILE" ]; then export POSTGRES_PASSWORD=unused; fi
compose() { $SUDO docker compose --profile deploy "$@"; }

if [ "$WANT_BACKUP" -eq 1 ]; then
  section "Копия базы"
  if ! compose ps --status running --services 2>/dev/null | grep -qx db; then
    log "Запускаю базу для копии…"
    compose up -d --wait db >/dev/null
  fi
  tmp="$(mktemp)"
  # Логин и имя базы берём из окружения контейнера — они там точно верные.
  if compose exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB"' >"$tmp"; then
    $SUDO mkdir -p "$(dirname "$BACKUP_FILE")"
    $SUDO mv "$tmp" "$BACKUP_FILE"
    $SUDO chmod 600 "$BACKUP_FILE"
    if [ -n "${SUDO_USER:-}" ]; then $SUDO chown "$SUDO_USER:" "$BACKUP_FILE"; fi
    log "База сохранена: ${BACKUP_FILE} ($(du -h "$BACKUP_FILE" | cut -f1))."
  else
    rm -f "$tmp"
    die "pg_dump не удался — остановился, ничего не удалено."
  fi
fi

# ── 2. Контейнеры, образы, база ─────────────────────────────────────────────
section "Контейнеры"
down_args=(down --remove-orphans --rmi local)
if [ "$WANT_DB" -eq 1 ]; then down_args+=(-v); fi
compose "${down_args[@]}"
if [ "$WANT_DB" -eq 1 ]; then
  log "Контейнеры, образы и база удалены."
else
  log "Контейнеры и образы удалены; база осталась в томе ${COMPOSE_NAME}_pgdata."
fi

# ── 3. nginx ────────────────────────────────────────────────────────────────
# Сертификаты удаляем до конфигов: certbot delete смотрит в свои файлы, а не в
# nginx, но после удаления сайтов nginx уже не должен на них ссылаться.
if [ "$WANT_CERTS" -eq 1 ] && command -v certbot >/dev/null 2>&1; then
  section "Сертификаты"
  for name in "${CERTS[@]}"; do
    if $SUDO certbot delete --non-interactive --cert-name "$name" >/dev/null 2>&1; then
      log "Сертификат ${name} удалён."
    else
      warn "Сертификат ${name} не удалён — вручную: sudo certbot delete --cert-name ${name}"
    fi
  done
fi

if [ "$WANT_NGINX" -eq 1 ]; then
  section "nginx"
  for conf in "${FOUND_CONFS[@]}"; do
    $SUDO rm -f "/etc/nginx/sites-enabled/$(basename "$conf")" "$conf" "$conf".bak-*
  done
  if $SUDO nginx -t >/dev/null 2>&1; then
    $SUDO systemctl reload nginx 2>/dev/null || true
    log "Сайты nginx удалены, nginx перезагружен."
  else
    warn "После удаления сайтов nginx -t с ошибкой — посмотрите: sudo nginx -t"
  fi
fi

# ── 4. Статика ──────────────────────────────────────────────────────────────
if [ "$WANT_STATIC" -eq 1 ]; then
  $SUDO rm -rf "$STATIC_DIR"
  log "Статика ${STATIC_DIR} удалена."
fi

# ── 5. Каталог ──────────────────────────────────────────────────────────────
section "Каталог"
cd /
$SUDO rm -rf "$INSTALL_DIR"
log "Каталог ${INSTALL_DIR} удалён."

# ── Итог ────────────────────────────────────────────────────────────────────
section "Готово"
if [ -n "$BACKUP_FILE" ]; then
  printf '  Копия базы: %s\n' "$BACKUP_FILE"
  printf '%s  Вернуть в новую установку: docker compose exec -T db sh -c '\''psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"'\'' < файл%s\n' "$DIM" "$N"
fi
printf '%s  Docker, nginx и certbot остались. Кэш сборки Docker: sudo docker builder prune%s\n' "$DIM" "$N"
