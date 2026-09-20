# certs/

`russian-trusted-ca-chain.pem` — Root CA + Sub CA «Russian Trusted CA»
(Минцифры России), которым подписан сертификат `platform-api2.max.ru`.

**Это не секрет** — публичные сертификаты, ровно то, что доверенный центр
сертификации раздаёт всем желающим. Их можно и нужно коммитить.

## Зачем это здесь

У Node.js свой встроенный список доверенных CA (Mozilla), и Russian Trusted CA
в него не входит. Windows этому CA доверяет (поэтому curl и браузер открывают
`https://platform-api2.max.ru` без вопросов), а `fetch` в Node — нет:

```
TypeError: fetch failed
  cause: Error: unable to get local issuer certificate
  code: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY'
```

Файл передаётся в Node через `NODE_EXTRA_CA_CERTS` (см. `.env.example` в корне
репозитория и `bot/Dockerfile`) — так проблема решается одинаково что локально,
что в Alpine-контейнере, где этого CA в системе тоже нет.

Альтернатива — флаг `node --use-system-ca`: работает локально на машине,
где Windows уже доверяет этому CA, но бесполезен в чистом Docker-образе.
Поэтому выбран `NODE_EXTRA_CA_CERTS` — переносимое решение.

## Как получен

```bash
openssl s_client -connect platform-api2.max.ru:443 \
  -servername platform-api2.max.ru -showcerts
```

Sub CA сервер отдаёт сам. Root CA сервер не отдаёт (это нормально для TLS —
клиент должен доверять ему заранее), поэтому Root CA взят из системного
хранилища Windows (`Cert:\CurrentUser\Root`), куда он уже был установлен.
Цепочка проверена независимо от Node: `openssl verify -CAfile ... → OK`.

Годен до 28.02.2032 (Root CA). Если MAX сменит CA — переснять по той же команде.
