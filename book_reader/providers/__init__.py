"""Provider adapters, one per file. llm.py picks one by the provider's "kind"."""
from . import anthropic_api, claude_cli, codex_cli, grok_cli, openai_api
from .base import LLMError, NoKey, RateLimited

ADAPTERS = {m.KIND: m for m in (openai_api, anthropic_api, claude_cli, codex_cli, grok_cli)}
