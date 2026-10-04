# server/aegis — тонкие шимы (совместимость)

Легальное ядро AEGIS **переехало** в [`platform/core/`](../../platform/core/) —
это постоянное «Security Core» Этажа 27 платформы Meta Architectural Authority.

Файлы в этой папке — тонкие шимы: каждый делает
`module.exports = require("../../platform/core/<module>.js")` и ничего больше.
Так Next-сервер (`src/lib/aegis/core.ts`) и существующие юнит-тесты
(`tests/unit/aegis*.test.ts`) продолжают импортировать `server/aegis/*.js`
без изменений, а единственный источник истины — `platform/core/`.

Не добавляйте сюда логику. Правьте модули в `platform/core/`.
