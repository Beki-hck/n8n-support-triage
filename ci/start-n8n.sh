#!/usr/bin/env bash
# Import the workflows into a fresh n8n (official Docker image), publish them, start it.
set -euo pipefail
IMG=${N8N_IMAGE:-n8nio/n8n:2.47.7}
ENV=(-e N8N_DIAGNOSTICS_ENABLED=false -e N8N_PERSONALIZATION_ENABLED=false -e N8N_LISTEN_ADDRESS=0.0.0.0)
run() { docker run --rm --network host -v n8n_ci:/home/node/.n8n -v "$PWD":/repo -w /repo "${ENV[@]}" --entrypoint n8n "$IMG" "$@"; }

node ci/attach-test-creds.mjs            # fake Telegram/Sheets credentials for CI only
docker volume create n8n_ci >/dev/null
run import:credentials --input=ci/.creds.json
run import:workflow --separate --input=ci/.build
# Sub-workflow first: n8n refuses to publish a workflow whose sub-workflow is unpublished.
for id in TriageClassify01 TriageErrors0001 TriageEval000001 TriageIntake0001; do
  run publish:workflow --id=$id
done
docker run -d --name n8n-ci --network host -v n8n_ci:/home/node/.n8n "${ENV[@]}" "$IMG" >/dev/null
for i in $(seq 1 90); do curl -sf 127.0.0.1:5678/healthz >/dev/null && break; sleep 2; done
sleep 5
curl -sf 127.0.0.1:5678/healthz && echo
