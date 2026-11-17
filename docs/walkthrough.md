# Walkthrough: every node, in plain English

Read this with the workflow open in n8n. Each part ends with what to say in an interview.

## n8n in 5 lines

- A **workflow** is a chain of **nodes**. Data flows left to right.
- Data moves as **items**. Each item is a small JSON object, like `{ "text": "Where is my order?" }`.
- A **trigger** node starts the workflow (a webhook call, a Telegram message, a button).
- `{{ $json.text }}` is an **expression**: "the `text` field of the current item".
- `$('Node name').item.json` reads data from an earlier node.

## 1. Classify message (the brain)

| Node | What it does | Why it is built this way |
|---|---|---|
| When called by another workflow | Starts when Intake or Eval calls it | One brain, used by both the live bot and the test. So the test measures exactly what runs in production |
| Config | Sets Ollama URL, model, minimum confidence (0.6) | Settings in one visible place. Callers can override them (Eval does this to compare models) |
| Build prompt (Code) | Writes the instructions, detects Amharic letters with a regex (Unicode block U+1200 to U+137F), and adds a **JSON schema** | The schema forces the model to answer in a fixed shape with allowed labels only (Ollama "structured outputs"). Temperature 0 = same answer every time |
| Ask local LLM (HTTP Request) | POSTs to Ollama `/api/chat` | **Retry** once on failure. **On error: continue**, so a crash becomes data the next node can handle, not a dead workflow |
| Validate answer (Code) | Checks the answer. Bad JSON, unknown label, server error, or confidence under 0.6 all become `needs_human` | Never trust the model blindly. It also picks the **route**: spam, urgent, auto or needs_human |

**Interview line:** "The LLM can fail in three ways: no answer, wrong format, or made-up labels. Each one has a guardrail, and CI plants one of each to prove the guardrails work."

## 2. Intake (the live bot)

| Node | What it does |
|---|---|
| Webhook (website form) | URL a website can POST `{"text": "..."}` to. Answers through "Reply to website" |
| Telegram Trigger | Same, for a Telegram bot. Turned off until you add a bot token |
| From web / From Telegram (Code) | Turn both shapes into one: `channel, from, chat_id, text`. A photo uses its caption as text |
| Shop settings | Owner's Telegram chat ID and Google Sheet ID. Named `cfg_...` so Classify strips them and they never leak into replies or the sheet. It comes before everything else so every branch can reach the owner |
| Has text? (IF) | Empty messages (blank form, photo or voice note with no caption) skip the AI |
| Empty, from website? → Reply: text is required | Website gets a clear HTTP 400 error |
| Alert owner: photo or voice → Ask customer to describe it | A Telegram photo or voice note goes to a human, and the customer is asked (English + Amharic) to add a short text |
| Classify message | Calls workflow 1 |
| Came from website? → Reply to website | Sends the website only the route and a fixed thank-you, never the AI draft |
| Log to Google Sheet | Appends every message. Set to continue on error so a Sheets outage never blocks customers. It sits **above** the routing branch on the canvas on purpose: n8n runs sibling branches top to bottom, and the urgent branch pauses for the owner, so the log must be written first |
| Write Telegram texts (Code) | Writes every Telegram message in one place, and escapes underscores, asterisks, backticks and square brackets. Telegram reads these messages as Markdown, so one underscore in a customer's message (like `order_4471`) would make Telegram reject the whole message |
| Route (Switch) | 4 exits: urgent, needs_human, auto, spam |
| Urgent from Telegram? | Telegram customers can get the approved AI reply. Website customers can't, so the owner gets an alert to reply personally ("Alert owner: urgent web message") |
| Owner approves AI reply | Telegram **Send and Wait**: the workflow pauses until the owner taps a button (max 2 hours) |
| Owner approved? → Send approved reply | Sends the AI draft only if approved |
| Alert owner: needs a human | Pings the owner with a summary |
| Telegram customer? → Send instant acknowledgement | Fixed thank-you in Amharic or English. No AI text, so no made-up prices or dates |
| Spam: stop here | Does nothing, on purpose |

Settings → **Error workflow** points to workflow 4, so any crash pings the owner.

**Interview line:** "The AI drafts, a human decides. Only fixed templates go out automatically. That is how I'd keep a small business safe from hallucinated promises."

## 3. Eval (the test)

| Node | What it does |
|---|---|
| Run eval by hand / Webhook (CI) | Two ways to start. The webhook takes `?model=` and `?testset_url=` |
| Eval settings | Defaults, overridden by the URL |
| Download test set | Gets `tests/testset.jsonl`: 60 messages (30 English, 20 Amharic, 10 Amharic in Latin letters), each with the right label |
| Parse test set | One item per message, label renamed to `expected_category` |
| Classify message | The same brain as production, run **once per message** (mode "each"). The HTTP Request node sends all its items at the same moment, and a local model on a CPU would queue 60 requests until they time out. CI checks that only one AI request is ever open at a time |
| Score | Accuracy, urgency accuracy, accuracy per language, precision/recall per category, confusion matrix, guardrail counts, and **missed urgent**: urgent messages that would not reach the owner (the most costly mistake) |

**Interview line:** "Accuracy alone hides the dangerous miss. I track urgent messages that slip through separately, and split accuracy by language because small models are much worse in Amharic."

## 4. Error alert

Error Trigger → Settings → Write alert (escapes Markdown) → Telegram message with the workflow name, failing node, error, and a link to the execution. All three other workflows point to it in Settings → Error workflow.

## The CI tests (`ci/`)

- `lint-workflows.mjs`: no credentials or tokens in the JSON, every node connected, every sub-workflow exists, every workflow has an error workflow.
- `mock-ollama.mjs`: fake LLM + fake Telegram API. Like real Telegram, it rejects broken Markdown.
- `start-n8n.sh`: imports and publishes the workflows in the official n8n Docker image.
- `run-eval.mjs --mock`: the 3 planted faults must each be caught (exact numbers: 60 items, 95%), and the AI is never sent two requests at once.
- `test-intake.mjs`: website and Telegram messages land on the right route; the website never gets AI text; it taps the owner's ✅ button and checks the customer got the reply; empty and photo messages; error alert; exactly 8 Telegram messages, none rejected.

## Practice questions

1. Why is Classify a separate sub-workflow? (Reuse, and the test measures production code.)
2. What happens if Ollama is down? (Retry, then `needs_human` + owner alert. Customer still gets a response on the website.)
3. Why not let the AI reply automatically? (Hallucinated prices or promises; owner approval for urgent ones.)
4. What does Send and Wait need? (n8n reachable from the internet, for the button link.)
5. How would you compare two models? (Call the eval webhook with `?model=` for each and compare the rows.)
6. Why a JSON schema AND a validation step? (Small models still break the schema sometimes.)
7. A customer writes `order_4471`. Why could that break the bot, and how did you fix it? (Telegram Markdown; escape in one Code node; the CI mock rejects bad Markdown.)
8. Your first real-model run scored 3%. What happened? (All 60 requests went to Ollama at once and timed out. Fix: run the sub-workflow once per message, plus a CI check that fails if requests overlap.)
