# CQA — оценка качества диалогов

Прототип Conversation Quality Analytics для хакатона Freedom Broker: оценка работы оператора
в чатах и звонках (RU, KZ, EN) по настраиваемому чек-листу, апелляция и решение проверяющего.

## Запуск

Нужен Node.js 22 или новее.

```bash
npm install
cp .env.example .env          # впишите DATASET_URL, для настоящей оценки ещё ключ и LLM_PROVIDER=anthropic
npm run fetch -- DEV          # скачать набор в data/dev.json и БД
npm start                     # http://127.0.0.1:3000
npm test
```

## Что нельзя коммитить

Репозиторий публичный. В `.env` лежит подпись API организаторов, в `docs/task.pdf` зашита та же ссылка,
а `data/dev.json` содержит подписанные ссылки на записи и транскрипты реальных звонков.
Эти файлы в `.gitignore`, а `npm install` включает pre-commit, который останавливает коммит с ними.
