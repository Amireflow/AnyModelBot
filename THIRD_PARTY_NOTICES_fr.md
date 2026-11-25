# Mentions tierces et licences

[English](./THIRD_PARTY_NOTICES_en.md) | [简体中文](./THIRD_PARTY_NOTICES.md) | Français | [日本語](./THIRD_PARTY_NOTICES_ja.md) | [한국어](./THIRD_PARTY_NOTICES_ko.md) | [Русский](./THIRD_PARTY_NOTICES_ru.md) | [Español](./THIRD_PARTY_NOTICES_es.md) | [Português (Brasil)](./THIRD_PARTY_NOTICES_pt.md) | [Türkçe](./THIRD_PARTY_NOTICES_tr.md)

AnyModelBot est distribué sous licence [MIT](./LICENSE). Les composants tiers inclus ou adaptés conservent leur licence d'origine respective ; le texte complet des licences est disponible dans le dossier [`LICENSES/`](./LICENSES) ainsi que dans l'application via Paramètres → À propos.

## magpie (passerelle de modèles et styles UI adaptés — MIT)

Source : https://github.com/yetone/magpie

- AnyModelBot intègre le binaire compilé `magpie` comme passerelle locale de modèles.
- Les styles et composants neutres de l'interface (`ui/design/`) sont adaptés du projet magpie sous licence MIT.

```
MIT License
Copyright (c) yetone and magpie contributors
```

## openclaw-weixin (canal WeChat iLink — MIT)

Source : https://github.com/Tencent/openclaw-weixin

Les modules sous `src/channels/weixin/` ont été portés et adaptés en TypeScript depuis `openclaw-weixin` sous licence MIT (voir `LICENSE.openclaw-weixin`).

## DeepSeek Harness / DSH & dsh-superagent (moteur d'agent et file sortante — MIT)

Sources :
- https://github.com/deepseek-ai/deepseek-harness
- https://github.com/deepseek-ai/dsh-superagent-prototype

- Le runtime d'agent s'exécute comme processus séparé via DeepSeek Harness (licence MIT).
- Le plugin `dsh-runtime/plugins/amb-bridge.mjs` est original à ce projet (MIT).
- La conception des règles système (`src/agent/prompts/system.ts`), de `dsh-runtime/plugins/amb-prompt.mjs` et de la file d'envoi persistante (`src/core/outbox.ts`) s'inspire des prototypes `dsh-superagent` (MIT, Copyright (c) 2026 DeepSeek Harness Team), sans copie directe de code.
- Les dépendances transitives de DSH sont distribuées sans modification avec leurs licences respectives (majoritairement MIT / Apache-2.0 / BSD / ISC, plus `@deepseek-ai/libreoffice-kit(-wasm)@0.1.5` en MPL-2.0 et `@img/sharp-libvips-*` en LGPL-3.0-or-later comme bibliothèques dynamiques remplaçables).

```
MIT License

Copyright (c) 2026 DeepSeek Harness Team

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## DS Bot (mémoire à long terme, gestionnaire de contexte, paramètres — Apache-2.0)

Source : https://github.com/Fei2411/DS-Bot

Des composants de `src/agent/memory.ts`, `src/agent/steward.ts`, `src/agent/manager.ts` et `src/agent/settings.ts` ont été portés et modifiés en TypeScript sous la section 4 de la licence Apache 2.0 (voir `LICENSES/Apache-2.0.txt` ou https://www.apache.org/licenses/LICENSE-2.0).

```
DS Bot
Copyright 2026 Fei2411 and the DS Bot contributors
This product is licensed under the Apache License, Version 2.0 (see LICENSE).
```

## kimi-computer-use (pont MCP Computer Use macOS — MIT)

Source : https://github.com/songkeys/kimi-computer-use (`vendor/kimi-computer-use`)

Distribue le pont MCP stdio (`bin/computer-use-mcp-bridge.mjs`) et les scripts associés sous licence MIT pour les utilisateurs macOS 14.4+ disposant d'OpenAI Codex Computer Use installé localement.

```
MIT License

Copyright (c) 2026 Songkeys

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Cua Driver (pilote Computer Use multiplateforme — MIT)

Source : https://github.com/trycua/cua (`libs/cua-driver`, version `cua-driver-rs-v0.37.0`)

Les installateurs incluent l'exécutable officiel `cua-driver` sans modification avec vérification SHA256 (`scripts/fetch-cua-driver.mjs`). Aucun composant AGPL (`cua-perception`, OmniParser) ou FSL (`Cua Spaces`) n'est distribué.

```
MIT License

Copyright (c) 2025 Cua AI, Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## yuque-mcp (serveur MCP officiel Yuque — MIT)

Source : https://github.com/yuque/yuque-mcp-server (`yuque-mcp` 1.0.0)

Fourni sous forme de fichier unique (`vendor/yuque-mcp/yuque-mcp.mjs`, généré par `scripts/vendor-yuque-mcp.mjs`) avec la liste de ses dépendances dans `THIRD_PARTY_LICENSES.txt`.

```
MIT License

Copyright (c) 2026 cwg

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
