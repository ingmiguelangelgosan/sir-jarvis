# Experimental expense conversation — synthetic use only

2026-11-17. Explicitly authorized local experiment with the independent Don Gastón
repository. Implements ORC-01/05/06/07/08: orchestration and consent in Jarvis,
financial facts in the external agent. This does not enable FIN-01 or authorize
real financial data, Telegram traffic, deployment or operational configuration.

The existing `/agent` and `AgentReadService` remain read-only. No operational
loader or main installs the new `RuntimeHooks.expenseConversation` hook. It must
be composed explicitly with `createExpenseConversation`,
`ExpenseConfirmationService`, `SqliteConfirmationStore`, the financial schema
definitions, a real execution service/registry and a durable channel journal.
The handler applies its existing private-chat/allowlist checks first and refuses
financial commands without a channel journal. Omitting the hook disables the route.

## Grammar

Only the bounded grammar below is recognized; there is no AI interpreter:

```text
/gasto 45000 COP gasolina 2026-11-17
Jarvis, gasté $45.000 en gasolina el 2026-11-17
sí G-<12 hexadecimal characters>
cancelar G-<12 hexadecimal characters>
consultar G-<12 hexadecimal characters>
pendientes
```

A bare `sí` cannot execute. Missing date/amount/category produces clarification;
the user resubmits a complete supported expression. No implicit “today”, category
creation or remote category lookup. Test composition supplies a subject-scoped
Gasolina alias. Dates and exact monetary strings are validated against the
unchanged external record/lookup v1.0 profile. Human labels are not authority.

## State and consent

A separate SQLite v1 confirmation store retains the authorized scope (opaque
conversation HMAC), immutable draft revision, random public reference, input hash,
created/expires timestamps, stable request/correlation/intent IDs and outcomes.
Consent records a HMAC of the authenticated message origin and timestamp, not raw
channel IDs, message text or credentials. Append-only audit tables/triggers retain
preparation, supersession, confirmation, cancellation and recovery events.

Preparation and replacement use `BEGIN IMMEDIATE`, an active-scope unique index
and CAS. A new complete draft supersedes only an awaiting revision, never an
executing/uncertain write. Consent expires after 300 seconds. On confirmation the
store atomically saves consent, the final envelope with a 20-second deadline and
executing state before network I/O. Only the CAS winner sends. Repeated confirmation
returns the same state; old references cannot authorize the replacement revision.

Registry permissions are rechecked by the service. The channel resolver is called
on every message so a revoked subject cannot confirm or retrieve evidence.
The delegate actor in Don Gastón is not the human identity: Jarvis retains the
opaque consent provenance; no human identity or permissions are added to wire input.

Uncertain operations are recovered only through lookup with a fresh read intent
and the original write key. Found evidence does not reset the Gateway journal;
not found does not prove absence of execution. RESULT_EXPIRED/completed recovers
output by lookup without another write. Evidence must match the confirmed amount,
category and civil date before presenting success. Cancellation after execution
may have started is refused and never represented as financial reversal.

## Persistence and operational limits

The confirmation database is separate from the existing durable Gateway/channel
database and both Don Gastón databases. No distributed transaction or coordinated
backup is claimed. Missing/incompatible files fail closed; creation is explicit
and exclusive. One store has an installation binding; scope isolation is checked
on reads and mutations. Maximum 10,000 prepared records; audit growth/retention,
OS access controls, authenticated backups and multi-process operational recovery
require further work before real use. No automatic cleanup of synthetic fixtures.

The state machine preserves uncertainty after interrupted dispatch and concurrent
recovery. Channel result/receipt phases are not human consent. A lost prompt or
result delivery can be queried using the same reference; it never creates another
financial intent. There is no automatic uncertain-journal reconciliation.

## Validation

The independent Don Gastón harness imports these actual Jarvis components and uses
the real handler/polling with a simulated `TelegramApi`. It supplies an exact
loopback test policy and temporary CA with TLS verification; production network
policy remains unchanged. It uses Node 24.22.3 and four separate synthetic databases.

Local store tests: `node --test tests/expense-conversation.test.ts`. End-to-end:
from Don Gastón, `npm.cmd run test:interop` with the compatible portable runtime.
See its `docs/reviews/JARVIS_CONVERSATIONAL_E2E.md` for exact executed checks and
limitations. No cross-repository imports exist in Jarvis production source.

Future loader activation, real credential configuration, bot restart/deployment,
Telegram traffic, additional capabilities or data require separate approval.
