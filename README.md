# 🛡️ ContextShield

[![CI](https://github.com/NurLucas/context-shield/actions/workflows/ci.yml/badge.svg)](https://github.com/NurLucas/context-shield/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22.0.0-brightgreen.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue.svg)](https://www.typescriptlang.org/)
[![Tests](https://img.shields.io/badge/tests-23%20passed-success.svg)](tests/)

> **High-performance reverse proxy, secret redaction firewall, and two-tier caching engine for AI coding agents and LLM applications.**

Sits transparently between your developer tools (**Cursor**, **Claude Code**, **Aider**, custom agentic loops) and upstream LLM providers (**OpenAI**, **Anthropic**, **Groq**, **Ollama**) to eliminate runaway token spend, prevent credential leakage, and slash latency with sub-5ms cached responses.

---

## ⚡ Key Capabilities

- 🛡️ **Zero-Leak Secret Firewall:** Pre-flight scanning catches accidental leakage of AWS keys, GitHub tokens, database URIs, JWTs, and private keys using compiled regex heuristics and Shannon entropy analysis.
- ⚡ **Two-Tier Semantic Caching:** L1 in-memory LRU + L2 persistent SQLite store. Identical or normalized requests resolve locally in `< 5ms`, avoiding 100% of LLM costs for that turn.
- 🌊 **Zero-Copy Streaming SSE Tap:** Pipes Server-Sent Events (`text/event-stream`) directly to your client without buffering latency, while simultaneously reassembling complete payloads for cache storage and usage accounting.
- 🛑 **Runaway Loop & Budget Guard:** Sliding-window token bucket rate limiter paired with session and daily token quotas to kill recursive agent loops before unexpected cloud bills hit.
- 📊 **Cloud-Native Observability:** Real-time terminal telemetry dashboard plus a `/metrics` endpoint compatible with Prometheus and OpenTelemetry.

---

## 🏗️ Architecture

```mermaid
flowchart TD
    Client["AI Tool / IDE (Cursor, Claude Code, Aider)"] -->|HTTP / SSE Request| Gateway["ContextShield Gateway (:8080)"]
    
    subgraph Gateway ["ContextShield Pipeline"]
        Step1["1. Token Bucket Rate Limiter"]
        Step2["2. Secret Scanner & Redactor (Entropy + Regex)"]
        Step3["3. Token Budget Guard (Session / Daily Quota)"]
        Step4{"4. Two-Tier Cache Lookup"}
        L1["L1: In-Memory LRU"]
        L2["L2: SQLite Store"]
        StreamTap["5. Zero-Copy SSE Stream Tap"]
        Telemetry["6. Telemetry & Metrics Engine"]
    end

    Step1 --> Step2 --> Step3 --> Step4
    Step4 -- "Cache Hit (0-5ms)" --> Client
    Step4 -- "Cache Miss" --> Upstream["Upstream LLM Provider (OpenAI, Anthropic, Ollama)"]
    Upstream --> StreamTap --> Client
    StreamTap --> L1
    StreamTap --> L2
    StreamTap --> Telemetry
```

---

## 🚀 Quickstart

### 1. Installation
```bash
git clone https://github.com/NurLucas/context-shield.git
cd context-shield
npm install
npm run build
```

### 2. Launch ContextShield

#### Option A: Double-Click Executable (Windows)
Simply double-click **`ContextShield.exe`** (or `launch.bat`) in the project folder!
It instantly launches a dedicated terminal controller menu:
```
╔═══════════════════════════════════════════════════════════════╗
║          🛡️  CONTEXT-SHIELD CONTROLLER & GATEWAY             ║
╚═══════════════════════════════════════════════════════════════╝

  [1] Start Proxy Gateway (:8080) with Live Telemetry Dashboard
  [2] Run Live Demo & Visual Proof (Zero-Config Test)
  [3] Run Full Automated Test Suite (Vitest)
  [4] Scan a File or Prompt for Exposed Credentials
  [5] View Cumulative Token & Dollar Savings
  [6] Clear Persistent Cache
  [0] Exit
```

#### Option B: Command Line (CLI)
```bash
# Start proxy pointing to OpenAI with live telemetry dashboard
node dist/cli.js start --port 8080 --dashboard

# Or run the instant self-test & visual proof demo
node dist/cli.js demo
```

### 3. Connect Your Tools
ContextShield is a **100% drop-in replacement**. Simply change your provider endpoint:

#### Cursor / Aider / Custom Scripts
- **Base URL:** `http://localhost:8080/v1`
- **API Key:** Your normal OpenAI/Anthropic key (or pass via proxy `-k` flag)

#### Python (OpenAI SDK)
```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:8080/v1",
    api_key="your-openai-api-key"
)

response = client.chat.completions.create(
    model="gpt-4o",
    messages=[{"role": "user", "content": "Explain binary search"}]
)
print(response.choices[0].message.content)
```

#### Node.js / TypeScript
```typescript
import OpenAI from 'openai';

const openai = new OpenAI({
  baseURL: 'http://localhost:8080/v1',
  apiKey: process.env.OPENAI_API_KEY,
});

const stream = await openai.chat.completions.create({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'Write a quicksort in Go' }],
  stream: true,
});

for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content || '');
}
```

---

## 🔒 Security Engine: Secret Scanner

ContextShield inspects all outgoing prompts and code context before requests leave your local environment.

| Pattern | Target Credential | Detection Method |
| :--- | :--- | :--- |
| `AKIA[0-9A-Z]{16}` | AWS Access Key ID | High-speed Regex |
| `aws_secret_access_key` | AWS Secret Access Key | Regex + Shannon Entropy ($H \ge 4.2$) |
| `ghp_[A-Za-z0-9_]{36}` | GitHub Personal Access Token | Regex Token Pattern |
| `sk-proj-[a-zA-Z0-9_-]{32,}` | OpenAI API Key | Vendor Prefix Matching |
| `sk-ant-[a-zA-Z0-9_-]{32,}` | Anthropic API Key | Vendor Prefix Matching |
| `eyJ...` | JSON Web Token (JWT) | Base64 Segment Verification |
| `-----BEGIN PRIVATE KEY-----` | RSA / EC / SSH Keys | Header & Block Validation |
| `postgres://user:pass@host` | Database Connection URIs | URI Scheme + Credential Extractor |

### Modes
- `--redact-mode redact` *(default)*: Replaces sensitive tokens with `[REDACTED:<TYPE>]` in place without interrupting developer workflow.
- `--redact-mode block`: Aborts request immediately with `HTTP 403 Forbidden` and details the offending pattern.
- `--redact-mode off`: Disables inspection.

---

## ⚡ Two-Tier Caching Details

1. **Request Canonicalization:** Key orders, spacing, and optional parameter fields are deterministically sorted and hashed via SHA-256 (`src/cache/hasher.ts`).
2. **L1 LRU (Memory):** Sub-millisecond lookup for hot agent prompt repeats within the active session.
3. **L2 SQLite (Disk):** Persistent across machine restarts using Node 22/24 native `node:sqlite` prepared statements.
4. **SSE Replay Engine:** If a client requests `stream: true` and the entry is cached, ContextShield synthesizes and streams valid OpenAI-compliant SSE chunks (`data: {...}`, `data: [DONE]`) instantly.

---

## 📊 Observability & Telemetry

### Terminal Dashboard
Run with `--dashboard` for live operational stats:
```
╔═════════════════════════════════════════════════════════════════╗
║               🛡️  CONTEXT-SHIELD TELEMETRY                     ║
╠═════════════════════════════════════════════════════════════════╣
║ Uptime: 452s   Requests: 128   Hit Rate: 48.4%                  ║
║ Cache Hits: L1: 42 | L2: 20 | Misses: 66                       ║
║ Tokens Saved: 184,200 tokens                                   ║
║ Est. Savings: $1.4736 USD                                      ║
║ Secrets Intercepted: 3                                         ║
║ Latency: Upstream avg: 820ms | Cached: 2ms                     ║
╚═════════════════════════════════════════════════════════════════╝
```

### Endpoints
- `GET /health`: Healthcheck probe.
- `GET /metrics`: Standard Prometheus metrics export.
- `GET /stats`: JSON summary of active session and persistent cache statistics.
- `POST /cache/clear`: Clear L1 and L2 caches.

---

## 🛠️ CLI Reference

```
Usage: context-shield [command] [options]

Commands:
  start           Start the ContextShield HTTP proxy and firewall server
  scan <target>   Scan a prompt file or directory for exposed secrets
  stats           Display cumulative caching and savings statistics
  cache clear     Purge all entries from the persistent SQLite cache
  init            Scaffold a default .contextshieldrc.json configuration file

Options for 'start':
  -p, --port <port>        Port to listen on (default: 8080)
  -h, --host <host>        Host address to bind (default: 127.0.0.1)
  -u, --upstream <url>     Upstream LLM provider URL (default: https://api.openai.com)
  -k, --api-key <key>      Default upstream API key fallback
  --redact-mode <mode>     Security mode: redact, block, or off (default: redact)
  --no-l1                  Disable in-memory L1 cache
  --no-l2                  Disable persistent SQLite L2 cache
  --budget <tokens>        Session token budget ceiling
  --daily-budget <tokens>  Daily token budget ceiling
  --rate-limit <rpm>       Max requests per minute allowed (default: 120)
  --dashboard              Display live terminal telemetry dashboard
```

---

## 🧪 Testing

```bash
# Run unit and integration test suite
npm test

# Run strict type checking
npm run typecheck

# Generate test coverage report
npm run test:coverage
```

ContextShield maintains 100% test pass rate across unit, caching, streaming SSE, and end-to-end proxy integration tests.

---

## 📜 License

Distributed under the [MIT License](LICENSE). Built for high-reliability developer infrastructure.
