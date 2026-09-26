#!/bin/sh
# Real omp in ACP mode against a small local model (Ollama, OpenAI-compatible API).
# For integration testing without cloud credentials. Use as AGENT_CMD.
#
# One-time setup (tested with Ollama 0.12.0 and qwen3:1.7b on 2 CPU cores):
#   OLLAMA_CONTEXT_LENGTH=12288 ollama serve &        # default 4k context truncates omp's prompt
#   ollama pull qwen3:1.7b
#   mkdir -p "$OMP_HOME/.omp/agent" && cat > "$OMP_HOME/.omp/agent/models.yml" <<'YML'
#   providers:
#     ollama:
#       baseUrl: http://127.0.0.1:11434/v1
#       api: openai-completions
#       apiKey: ollama
#       models:
#         - id: qwen3:1.7b
#   YML
#
# Global flags must come before the `acp` subcommand. `--tools read,ask` keeps
# omp's first request near 2.5k tokens (about 75 s of prompt processing on 2 CPU
# cores); with all tools it is about 10k tokens. `ask` is only registered when
# the ACP client advertises elicitation.form, which our transport shim does.
export HOME="${OMP_HOME:-/tmp/omp-home}"
exec "${OMP_BIN:-omp}" --model "${OMP_MODEL:-ollama/qwen3:1.7b}" --thinking off --no-lsp --no-extensions \
  --tools "${OMP_TOOLS:-read,ask}" acp
