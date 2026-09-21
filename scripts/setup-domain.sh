#!/usr/bin/env bash
#
# Часть Б — домен и TLS для сервиса api.
#
# Подход: не nginx+certbot на хосте, а Caddy ЕЩЁ ОДНИМ СЕРВИСОМ в compose.
# Caddy сам получает сертификат Let's Encrypt и сам его продлевает — cron,
# systemd-таймеры и certbot-хуки не нужны. Это сохраняет принцип проекта
# «всё через docker-compose»: на хост не ставится ничего лишнего.
#
# ВАЖНО, чтобы не путаться в двух разных сертификатах:
#   • Russian Trusted CA (bot/certs/russian-trusted-ca-chain.pem) — это доверие
#     НАШЕГО бота к чужому серверу platform-api2.max.ru. Часть Б его не трогает.
#   • Let's Encrypt (этот скрипт) — сертификат НАШЕГО домена, чтобы чужие
#     клиенты доверяли нам. Хранится в томе caddy_data, в репозиторий не попадает.
#
# Скрипт безопасно запускать раньше времени: пока DNS-запись не указывает на
# этот сервер, он ничего не делает и выходит с ненулевым кодом. Это сознательно:
# у Let's Encrypt есть лимит неудачных попыток на домен (5 в час), и жечь его
# запросами на неготовый DNS нельзя.
#
# Использование:
#   sudo ./scripts/setup-domain.sh --domain example.ru [--email admin@example.ru]
#
set -Eeuo pipefail

DOMAIN=""
EMAIL=""
INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FORCE=0

log()  { printf '\033[1;32m[+]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[x]\033[0m %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Часть Б — домен и TLS через Caddy в docker-compose.

  --domain NAME     домен, который указывает на этот сервер (обязателен)
  --email ADDR      e-mail для Let's Encrypt (необязателен; туда шлют
                    уведомления о проблемах с продлением)
  --dir PATH        каталог установки (по умолчанию — корень этого репозитория)
  --force           перезаписать существующий docker-compose.override.yml
  -h, --help        эта справка

Скрипт сначала проверяет, что домен резолвится на IP этого сервера,
и без этого не делает ничего.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="${2:?--domain требует значение}"; shift 2 ;;
    --email)  EMAIL="${2:?--email требует значение}"; shift 2 ;;
    --dir)    INSTALL_DIR="${2:?--dir требует значение}"; shift 2 ;;
    --force)  FORCE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "Неизвестный аргумент: $1 (см. --help)" ;;
  esac
done

[ -n "$DOMAIN" ] || { usage; die "Не задан --domain."; }

# Отсекаем частые опечатки: схему и слэш в значении домена.
case "$DOMAIN" in
  http://*|https://*|*/*) die "Домен указывается без схемы и без слэша: example.ru" ;;
esac
printf '%s' "$DOMAIN" | grep -qE '^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)+$' \
  || die "Непохоже на доменное имя: ${DOMAIN}"

if [ "$(id -u)" -eq 0 ]; then SUDO=""; else SUDO="sudo"; fi

cd "$INSTALL_DIR"
[ -f docker-compose.yml ] || die "В ${INSTALL_DIR} нет docker-compose.yml — укажи --dir."
[ -f .env ] || die "В ${INSTALL_DIR} нет .env — сначала отработай часть А (scripts/deploy-vps.sh)."

# ── 1. Куда проксировать ────────────────────────────────────────────────────
# Внутри контейнера api слушает порт из переменной PORT, которой compose
# присваивает ${API_PORT:-3000}. Значит и Caddy должен идти на этот же порт,
# а не на жёстко зашитый 3000.
API_PORT="$(sed -n 's|^API_PORT=||p' .env | tail -n 1)"
API_PORT="${API_PORT:-3000}"
log "api внутри сети compose слушает порт ${API_PORT} — туда и будет reverse_proxy."

# ── 2. Проверка DNS ─────────────────────────────────────────────────────────
# Внешний IP. Сначала спрашиваем у внешнего сервиса (на VPS за NAT локальный
# адрес интерфейса не совпадает с публичным), потом — локальный исходящий
# адрес как запасной вариант, если наружу не пустили.
public_ip=""
for probe in "https://api.ipify.org" "https://ifconfig.me/ip" "https://icanhazip.com"; do
  public_ip="$(curl -fsS --max-time 5 "$probe" 2>/dev/null | tr -d '[:space:]')" || public_ip=""
  [ -n "$public_ip" ] && break
done
if [ -z "$public_ip" ]; then
  public_ip="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") print $(i+1)}')"
  warn "Внешний IP определить не удалось, беру исходящий адрес интерфейса: ${public_ip:-?}"
fi
[ -n "$public_ip" ] || die "Не смог определить IP этого сервера."

# Все адреса, которые реально принадлежат машине: домен может указывать
# на любой из них (например, на второй белый IP).
own_ips="$(hostname -I 2>/dev/null || true)
${public_ip}"

# Резолв домена. dig, если есть, — с запросом к 1.1.1.1 напрямую: локальный
# кеш systemd-resolved умеет держать отрицательный ответ и показывать «нет
# записи» уже после того, как DNS разъехался. getent — запасной путь, он есть
# всегда (на чистом Ubuntu 24.04 пакета dnsutils может не быть).
resolved=""
if command -v dig >/dev/null 2>&1; then
  resolved="$(dig +short +time=3 +tries=1 A "$DOMAIN" @1.1.1.1 2>/dev/null | grep -E '^[0-9.]+$' || true)"
fi
if [ -z "$resolved" ]; then
  resolved="$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk '{print $1}' | sort -u || true)"
fi

if [ -z "$resolved" ]; then
  cat >&2 <<EOF

[x] DNS ещё не готов: домен ${DOMAIN} не резолвится в IPv4.

    IP этого сервера: ${public_ip}

    Что сделать:
      • в панели регистратора завести A-запись ${DOMAIN} → ${public_ip}
      • подождать TTL (обычно минуты, иногда до нескольких часов)
      • если запись уже создана, а ответа нет — сбросить локальный кеш:
            sudo resolvectl flush-caches
      • проверить снаружи: https://dnschecker.org/#A/${DOMAIN}

    Запусти этот скрипт повторно позже — он ничего не сломал и ничего не создал.
EOF
  exit 2
fi

match=0
for ip in $resolved; do
  printf '%s\n' $own_ips | grep -qx "$ip" && match=1
done

if [ "$match" -eq 0 ]; then
  cat >&2 <<EOF

[x] DNS указывает не на этот сервер — сертификат заказывать рано.

    ${DOMAIN} резолвится в: $(printf '%s' "$resolved" | tr '\n' ' ')
    IP этого сервера:       ${public_ip}

    Let's Encrypt проверяет владение доменом, обращаясь по этому адресу
    на порт 80. Пока адреса не совпадают, проверка не пройдёт, а неудачные
    попытки тратят лимит (5 в час на домен) — поэтому скрипт останавливается
    здесь, а не «пробует всё равно».

    Если запись только что поменяли — подожди TTL и запусти скрипт снова.
EOF
  exit 3
fi

log "DNS готов: ${DOMAIN} → ${public_ip}"

# ── 3. Свободны ли 80 и 443 ─────────────────────────────────────────────────
# Занятый порт 80 — вторая по частоте причина провала HTTP-01 проверки
# (обычно это уже поставленный кем-то nginx или apache).
if command -v ss >/dev/null 2>&1; then
  busy="$($SUDO ss -ltnpH '( sport = :80 or sport = :443 )' 2>/dev/null | awk '{print $4, $6}' || true)"
  if [ -n "$busy" ]; then
    warn "Порты 80/443 уже кем-то заняты:"
    printf '%s\n' "$busy" | sed 's/^/      /'
    warn "Если это не контейнер proxy от предыдущего запуска — освободи их, иначе Caddy не стартует."
  fi
fi

# ── 4. Caddyfile ────────────────────────────────────────────────────────────
# Проксируем на api, а НЕ на bot: бот работает по long polling (исходящие
# соединения) и входящего порта не имеет вовсе — в docker-compose.yml у него
# нет секции ports, и проксировать там нечего.
CADDYFILE="${INSTALL_DIR}/Caddyfile"
{
  echo "# Сгенерирован scripts/setup-domain.sh — правки будут перезаписаны."
  echo "# TLS-сертификат Caddy получает и продлевает сам, хранит в томе caddy_data."
  echo ""
  if [ -n "$EMAIL" ]; then
    echo "{"
    echo "    email ${EMAIL}"
    echo "}"
    echo ""
  fi
  echo "${DOMAIN} {"
  echo "    reverse_proxy api:${API_PORT}"
  echo "}"
} > "$CADDYFILE"
log "Записан ${CADDYFILE}"

# ── 5. docker-compose.override.yml ──────────────────────────────────────────
# Отдельным файлом, а не правкой docker-compose.yml: основной файл лежит в git,
# и его правка на сервере превратит любой следующий git pull в конфликт.
# Compose подхватывает override автоматически, никаких -f указывать не нужно.
OVERRIDE="${INSTALL_DIR}/docker-compose.override.yml"
if [ -f "$OVERRIDE" ] && [ "$FORCE" -eq 0 ]; then
  if grep -q 'caddy' "$OVERRIDE" 2>/dev/null; then
    log "${OVERRIDE} уже описывает proxy — перезаписываю (домен мог смениться)."
  else
    die "${OVERRIDE} существует и написан не этим скриптом.
    Слей руками или запусти с --force (старый файл будет сохранён рядом с суффиксом .bak)."
  fi
fi
[ -f "$OVERRIDE" ] && cp "$OVERRIDE" "${OVERRIDE}.bak"

cat > "$OVERRIDE" <<'EOF'
# Сгенерирован scripts/setup-domain.sh — правки будут перезаписаны.
#
# Caddy как сервис compose: сам получает и продлевает сертификат Let's Encrypt.
# Отдельный cron/certbot не нужен.

services:
  proxy:
    image: caddy:2-alpine
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
      # HTTP/3 ходит по UDP. Без этой публикации Caddy работает, но каждый
      # старт пишет в лог жалобу на недоступный QUIC.
      - "443:443/udp"
    volumes:
      # :ro — конфиг генерируется скриптом, контейнеру править его незачем.
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      # Именованные тома: в caddy_data лежит выданный сертификат и ключ
      # ACME-аккаунта. Без него каждое пересоздание контейнера заказывало бы
      # сертификат заново и быстро упёрлось бы в лимиты Let's Encrypt.
      - caddy_data:/data
      - caddy_config:/config
    depends_on:
      - api
    networks:
      # Та же сеть, что у остальных сервисов: иначе имя api не разрезолвится.
      - backend

volumes:
  caddy_data:
  caddy_config:
EOF
log "Записан ${OVERRIDE}"

# Проверка, что основной файл и override вместе дают валидную конфигурацию.
$SUDO docker compose config -q || die "docker compose config не принял конфигурацию — смотри сообщение выше."

# ── 6. Запуск ───────────────────────────────────────────────────────────────
log "Поднимаю proxy…"
$SUDO docker compose up -d --build proxy

echo ""
echo "═══════════════════════════════════════════════════════════════════"
echo " Часть Б завершена: ${DOMAIN} → api:${API_PORT}"
echo "═══════════════════════════════════════════════════════════════════"
echo ""
echo "Открыть порты 80 и 443 — это делаешь ты сам, скрипт в файрвол не лезет:"
echo "      sudo ufw allow 80/tcp"
echo "      sudo ufw allow 443/tcp"
echo "  Порт 80 нужен не только для редиректа: по нему Let's Encrypt проверяет"
echo "  владение доменом (HTTP-01). Закроешь — сертификат не выпустится и не продлится."
echo ""
echo "Проверить, что сертификат получен:"
echo "      docker compose logs -f proxy      # ждём строку 'certificate obtained successfully'"
echo "      curl -sS -o /dev/null -w '%{http_code}\\n' https://${DOMAIN}/health   # ожидается 200"
echo "      curl -I https://${DOMAIN}/health  # в первой строке ожидается HTTP/2 200"
echo ""
echo "  Если /health отвечает 503 — сертификат тут ни при чём: это api говорит,"
echo "  что не видит базу (см. docs/api.md, раздел GET /health)."
echo ""
echo "Теперь публикацию внутренних портов можно убрать — снаружи всё ходит через proxy:"
echo "      • db:  в .env поставить DB_PORT=127.0.0.1:5432 и выполнить docker compose up -d"
echo "             (или удалить блок ports у db в docker-compose.yml совсем)"
echo "      • api: удалить блок ports у api в docker-compose.yml — внутри сети"
echo "             compose proxy обращается к api по имени, публикация ему не нужна."
echo "        Отладка при закрытых портах — через SSH-туннель:"
echo "             ssh -L 3000:127.0.0.1:3000 -L 5432:127.0.0.1:5432 пользователь@${public_ip}"
echo ""
warn "Правка docker-compose.yml делает рабочее дерево на сервере грязным, и следующий"
warn "git pull --ff-only упрётся в неё. Либо держи это как осознанный локальный патч,"
warn "либо внеси то же изменение в репозиторий и подтяни его на сервер."
echo ""
