禁止切分支，必须使用 master 分支

## Amireflow fork mission

- Before making changes, read `docs/VISION-AGENCE.md`, `docs/agency/ROADMAP.md`, `docs/development.md`, `docs/execution-node.md`, and `docs/execution-node-security.md`.
- Mission: AnyModelBot is an autonomous AI-assisted software agency platform combining the **Business Engine**, **AI Orchestration Engine**, and **Execution Engine** to acquire clients, conclude contracts, and deliver verified technical projects.
- Priority 1: Minimal real commercial loop (prospecting, qualification, CRM, compliant outreach, commercial conversations, needs qualification, service catalog, estimation, quotes, bounded negotiation, and contracts).
- Priority 2: Contract-to-production handoff, project management, dev tool integration (IDE, Claude Code, Codex), independent QA/evidence, and delivery.
- Priority 3: Advanced automation, generalized Local Execution Node / Control Plane, multi-agent orchestration, and post-delivery client follow-up & retention.
- FlowAuto is an external target application. Do not modify its repository, Chrome extension, or application code from this project.
- PIO is out of scope until explicitly reopened.
- Never claim a feature is complete because code exists. Record the exact automated and real-machine evidence.
- Never bypass approvals, consent checks, or permission policies with shell, scripts, browser debugging protocols, extension APIs, or private network calls.
- Never switch off the `master` branch.

## 版本发布

- 每次发布新版本，必须同步更新官网、相关文档和各语言 README；这些更新属于发布任务本身。
- 官网更新必须实际部署上线，使版本号、下载链接、更新日志和相关功能说明与新版本一致；仅更新仓库文件或通过官网 CI 不算完成。
- GitHub Release、Docker 镜像及上述内容全部同步完成后，才可宣布本次发布完成；如有未完成项，必须明确说明。
