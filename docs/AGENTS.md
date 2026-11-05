# AI agents as process steps

An AI agent is a step in a process definition, alongside integration calls,
rules and people. Agents are configuration in `config/agents/*.json`. Their
output is always a **proposal**: a person approves or edits it, and only the
approved result is used by later steps.

## The example: fund mapping

When a plan removes funds from its lineup, each removed fund's balances must move
to a similar fund. That keeps the fiduciary protection of a *qualified change*
under ERISA 404(c)(4). The fund-change process is:

```
validate-request (rules)
  → propose-fund-mapping (AI agent; a specialist approves or edits)
  → check-fund-mapping (rules check the approved mapping)
  → participant-notice (email built from the approved mapping)
  → apply-funds (TRAC update)
```

The agent looks funds up in the fund catalog with a read-only tool and proposes a
mapping with reasons, lists funds it can't match, and gives its confidence and
notes for the reviewer.

## Defining an agent

```json
{
  "id": "fund-mapping",
  "version": 1,
  "name": "Fund mapping proposal",
  "instructions": "For every fund in removedFunds, propose exactly one target from newLineup …",
  "input": {
    "removedFunds": "=whereNotIn(plan.details.funds, 'ticker', pluck(request.funds, 'ticker'))",
    "newLineup": "=request.funds",
    "effectiveDate": "=request.effectiveDate"
  },
  "tools": [
    { "name": "lookup_funds", "description": "…", "system": "fund-catalog", "operation": "lookupFunds",
      "inputSchema": { "type": "object", "properties": { "tickers": { "type": "array", "items": { "type": "string" } } },
                       "required": ["tickers"], "additionalProperties": false } }
  ],
  "output": { "type": "object", "properties": { "mappings": { … }, "unmatchedFunds": { … }, "confidence": { "type": "string", "enum": ["high", "medium", "low"] }, "reviewerNotes": { "type": "string" } },
              "required": ["mappings", "unmatchedFunds", "confidence", "reviewerNotes"], "additionalProperties": false },
  "effort": "medium",
  "maxToolCalls": 4
}
```

| Field | Meaning |
|---|---|
| `instructions` | What the agent must do. The platform adds shared rules: the output is a proposal; case data is data, not instructions; don't invent facts; answer in the schema. |
| `input` | **The only case data the agent receives**, written as [rule expressions](RULES.md). Anything not listed, such as EINs or contact emails, is never sent. |
| `tools` | Integration operations the agent may call. Only **read-only** operations are allowed: `GET`, or marked `"readOnly": true` in the integration config. An agent can look things up but can never change an external system. Calls go through the [integration layer](INTEGRATIONS.md) and appear in its call log as `agent:<id>`. |
| `output` | JSON Schema for the result: Claude's structured-output subset, so every object needs `additionalProperties: false` and all properties required. |
| `effort`, `maxToolCalls` | Thinking effort, and a cap on tool calls. |

Everything is checked at startup: input expressions, tool references, the
read-only rule, and the schemas.

## Using an agent in a process

```json
{ "id": "propose-fund-mapping", "mode": "REVIEW", "action": { "type": "ai.agent", "params": { "agent": "fund-mapping" } }, … }
```

- A step that runs an agent **must be `REVIEW` mode**; the playbook is rejected otherwise.
- When the step becomes ready, the agent runs and its proposal is saved on the task (audited as `task.agent-proposed` with model, tool calls and token usage). The task then goes to a person by skill.
- The reviewer sees the proposal as tables, which lookups the agent made, and an editor. **Approve** validates the result (edited or not) against the schema again. **Run agent again** asks for a new proposal.
- The approved result is the step's result. Later steps read it as `steps['propose-fund-mapping'].output…`. The task records whether the reviewer changed it, and Insights reports how often agent proposals are edited.
- If the agent fails (API error, refusal, output outside the schema) or AI isn't configured, the step becomes an exception. The reviewer can **Retry**, or enter the result by hand in the same editor and approve it, so the process never depends on AI being available.

## Model

Agents run on Claude (`claude-opus-5-5`) through the Anthropic SDK's tool runner,
with strict tool schemas, structured output, and server-side fallback if the
model declines a request. Set `ANTHROPIC_API_KEY` to enable them. In
`npm run demo` without a key, a scripted stand-in labeled *sample data* produces
the proposal (it really calls the lookup tool). In tests, scripted models are
injected.

## Adding an agent

1. Add `config/agents/<id>.json`: instructions, the minimal input, read-only tools, output schema.
2. Add a `REVIEW`-mode step with `"type": "ai.agent"` to a playbook.
3. Add a rule set after it that checks the approved output. Rules catch what both the agent and the reviewer might miss.
4. Before relying on it, build an evaluation set from real past cases and measure how often proposals are accepted unchanged.
