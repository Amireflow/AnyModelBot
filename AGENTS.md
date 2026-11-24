禁止切分支，必须使用 master 分支

## Amireflow fork mission

- Before making changes, read `docs/roadmap-local-workstation-operator.md`, `docs/execution-node.md`, `docs/execution-node-security.md`, and `docs/development.md`.
- Current product priority: complete and validate the secure FlowAuto / Google Flow workstation-automation path using the local Execution Node and the self-hosted Control Plane.
- FlowAuto is an external target application. Do not modify its repository, Chrome extension, or application code from this project.
- PIO is out of scope until explicitly reopened.
- Keep the Agency feature track frozen. Fix its syntax/build regressions when necessary, but do not add Agency features before the FlowAuto MVP is validated.
- Never claim a feature is complete because code exists. Record the exact automated and real-machine evidence.
- Never bypass Computer Use approvals with shell, scripts, browser debugging protocols, extension APIs, or private network calls from a remote task session.

## 版本发布

- 每次发布新版本，必须同步更新官网、相关文档和各语言 README；这些更新属于发布任务本身。
- 官网更新必须实际部署上线，使版本号、下载链接、更新日志和相关功能说明与新版本一致；仅更新仓库文件或通过官网 CI 不算完成。
- GitHub Release、Docker 镜像及上述内容全部同步完成后，才可宣布本次发布完成；如有未完成项，必须明确说明。
