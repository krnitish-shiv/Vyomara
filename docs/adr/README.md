# Vyomara Architecture Decision Records

ADRs capture project decisions and proposals. **Accepted** means supported by
the current product requirements or established project configuration;
**Proposed** means a reasoned recommendation awaiting user confirmation;
**Superseded** means a later product decision has replaced it. Superseded and
proposed decisions must not be presented as current implementation choices.

## Records

| ADR | Topic | Status |
|---|---|---|
| [0001](./0001-modular-monolith.md) | Overall architecture and module boundaries | Accepted |
| [0002](./0002-runtime-and-language.md) | Runtime and language | Accepted |
| [0003](./0003-model-provider.md) | Provider interface and local Ollama integration | Accepted |
| [0004](./0004-text-interaction.md) | First text interaction interface | Accepted |
| [0005](./0005-persistence.md) | Sessions, messages, and explicit memory | Accepted |
| [0006](./0006-tool-contracts.md) | Tool registration and execution | Accepted |
| [0007](./0007-permission-gateway.md) | Permissions and approval gateway | Accepted |
| [0008](./0008-configuration-and-secrets.md) | Configuration and secrets | Accepted |
| [0009](./0009-diagnostics-and-audit.md) | Logging, diagnostics, and audit events | Accepted |
| [0010](./0010-testing-and-evaluation.md) | Testing and repeatable agent evaluation | Accepted |
| [0011](./0011-platform-baseline.md) | macOS, Node.js, and compatibility baseline | Accepted |
| [0012](./0012-desktop-interface.md) | Initial macOS desktop interaction shell | Superseded |
| [0013](./0013-voice-first-app-integrations.md) | Voice-first assistant and existing-app integrations | Superseded |
| [0014](./0014-human-reviewed-filesystem-operations.md) | Human-reviewed machine-wide filesystem operations | Accepted; amended by 0015 |
| [0015](./0015-coding-agent-loop-and-approved-actions.md) | Coding-agent loop, approved commands/apps/web, selectable models | Accepted |
| [0016](./0016-web-reading-and-remembered-approvals.md) | Reading web pages, SearXNG search, remembered approvals | Accepted |
| [0017](./0017-standing-permissions.md) | Standing permissions for apps, browsers, and websites (Permissions panel) | Accepted |
| [0018](./0018-voice-wake-phrase-spoken-approvals.md) | Wake phrase, spoken approvals, Hindi/English/Hinglish speech models | Accepted |
| [0019](./0019-mini-controller-window.md) | Mini controller window (PiP), ⌥Space, model warm-up | Accepted |
| [0020](./0020-orb-conversation-mode.md) | Orb conversation mode and turn-taking | Accepted |
| [0021](./0021-two-assistants-vyom-and-vyomara.md) | Two assistants: Vyom (male) and Vyomara (female) | Accepted |
| [0022](./0022-undo-approved-file-changes.md) | Undo approved file changes | Accepted |
| [0023](./0023-proposed-changes-as-vs-code-diffs.md) | Show proposed file changes as VS Code diffs | Accepted |
| [0024](./0024-coding-agent-project-context.md) | Project instructions, language, and batch edit approval | Accepted |
| [0025](./0025-memories-across-conversations.md) | Memories across conversations | Accepted |

## Open decisions

The current product direction is recorded in
[docs/product-direction.md](../product-direction.md). Historical ADRs remain
useful as context but do not authorize the removed desktop panels or manual
project selection. ADR-0014 defines the reviewed filesystem workflow, and
ADR-0015 defines the current agent loop, tools, approved actions, and model
selection.

User confirmation is needed for:

1. **Approval UX:** whether specific safe commands (for example a project's
   test script) should get standing grants, and how spoken approvals are
   confirmed in the voice phase.
2. **Configuration:** secret injection for any future credential-bearing
   provider.
3. **Diagnostics:** retention/rotation policy and any future opt-in content
   logging.
4. **Testing:** evaluation set, model-evaluation acceptance criteria, and
   benchmark environment.
5. **Compatibility:** minimum macOS release, packaging/distribution, and
   confirmation that Node.js `>=22.22.1` is the release baseline.

See [the architecture overview](../architecture.md) and each Proposed ADR for
the rationale and consequences. The model endpoint and initial model are
resolved defaults in [ADR-0003](./0003-model-provider.md); live Ollama
compatibility succeeded in one local request, but the installed server version
was not recorded. No Proposed ADR should be treated as user approval.
