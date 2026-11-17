# n8n Support Triage (Amharic + English)

An n8n automation that reads customer messages for a small Ethiopian online shop, sorts them with a **free local LLM** (Ollama), and routes them, with a **human approval step** before any AI-written reply reaches a customer. It ships with its own **60-message test set and CI**, so you can measure the AI instead of hoping it works.

![Intake workflow](docs/intake.png)

## What it does

| Message type | What happens |
|---|---|
| **urgent** (money lost, broken item, angry customer) | Telegram customer: owner gets the AI draft reply and taps ✅ to send it or ❌ to handle it. Website customer: owner is alerted to reply personally |
| **needs_human** (model unsure, broken answer, LLM down, photo or voice note) | Owner is pinged in Telegram |
| **auto** (simple question) | Customer gets a fixed thank-you in their language. Never free AI text |
| **spam** | Logged only |

Every message is logged to Google Sheets. The website only gets back the route and a fixed thank-you, never AI text. Any crash sends the owner a Telegram alert.

## Workflows (`workflows/`)

1. **Classify message**: shared sub-workflow. Prompt + JSON schema → Ollama → guardrails (bad JSON, unknown label, server error, low confidence → `needs_human`).
2. **Intake**: website webhook or Telegram bot → classify → reply / log / route.
3. **Eval**: runs the labelled test set through the same Classify step and reports accuracy, per-language accuracy, confusion matrix, and urgent messages it missed.
4. **Error alert**: Telegram alert when any of the other three fails.

## Testing

`.github/workflows/ci.yml` runs on every push. It starts the official n8n Docker image, imports all 4 workflows, and runs them for real against a fake LLM and a fake Telegram API:

- **Eval contract test:** the fake LLM answers correctly **except 3 planted faults** (chatty non-JSON, invented category, HTTP 500). Each one must be caught and sent to a human.
- **Intake test:** website and Telegram messages land on the right route, the owner's ✅ tap sends the AI reply, the website never receives AI text, a photo with no text goes to a human, Telegram Markdown never breaks on `_ * [` in customer text, and a crash alerts the owner.

```
| model | n  | category acc | urgency acc | urgent missed | english | amharic | amharic_latin |
| mock  | 60 | 95%          | 95%         | 0             | 90%     | 100%    | 100%          |
PASS: all 3 planted faults were caught and routed to a human
PASS: website + Telegram routing, owner approval, Markdown safety and error alerts all work
```

`model-eval.yml` (run by hand from the Actions tab) installs Ollama and scores a real model on the same 60 messages.

**Real model results** (GitHub Actions CPU runner, 2026-11-17, same 60 messages):

| model | category acc | urgency acc | urgent missed | English | Amharic | Amharic (Latin letters) | sent to a human by guardrails |
|---|---|---|---|---|---|---|---|
| **gemma3:4b** (default) | **91.7%** | 76.7% | 1 of 17 | 100% | 90% | 70% | 2 |
| qwen2.5:3b | 56.7% | 46.7% | 7 of 17 | 90% | 10% | 50% | 10 |

gemma3:4b is the default because it also scored best on Amharic in my [amharic-llm-bench](https://github.com/Beki-hck/amharic-llm-bench). Every guardrail catch was the model getting stuck repeating broken Amharic in its draft reply, which is exactly the case a human should see.

The real runs found three bugs that the mock could not: all 60 requests hit Ollama at once and timed out (scores fell to 3%), some answers looped until the 5-minute timeout, and English messages sometimes got Amharic drafts. All three are fixed, and the first one now has a CI check.

## Run it

1. Install [Ollama](https://ollama.com), then `ollama pull gemma3:4b`.
2. Start n8n: `npx n8n` (needs Node 24) or `docker run -it -p 5678:5678 n8nio/n8n`.
   If n8n runs in Docker, set **Config → ollama_url** in Classify to `http://host.docker.internal:11434`.
3. Import the workflows with the n8n CLI, which keeps their links to each other:
   `n8n import:workflow --separate --input=workflows`
   (Importing in the editor works too, but then re-pick **Triage · Classify message** in the Classify nodes, and **Triage · Error alert** under each workflow's Settings → Error workflow.)
4. Add your Telegram bot and Google Sheets credentials. Fill in **Shop settings** in Intake (your Telegram chat ID and sheet ID; the sheet needs a tab named `Inbox`, n8n adds the columns) and **Settings** in Error alert (your chat ID again). **Telegram Trigger** ships turned off so you can publish before you have a bot; turn it on once your bot credential is added.
5. Publish **Classify** first, then the others. Test the website path:
   `curl -X POST http://127.0.0.1:5678/webhook/triage -H "content-type: application/json" -d "{\"text\":\"Where is my order 4471?\"}"`

Telegram needs n8n reachable from the internet (n8n Cloud, a server, or a tunnel).

## Honest limits

- Tested automatically: all 4 workflows inside real n8n 2.47.7, with a fake LLM and a fake Telegram API.
- Not tested: real Telegram servers and a real Google Sheet (the Sheets step never blocks a customer if it fails).
- The 20 Amharic + 10 Latin-script Amharic test messages should get a native-speaker review.

Built with Claude Code as a learning project. Walkthrough of every node: [docs/walkthrough.md](docs/walkthrough.md).
