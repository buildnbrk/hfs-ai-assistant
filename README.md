# hfs-ai

An AI assistant plugin for [HFS (HTTP File Server)](https://github.com/rejetto/hfs). Adds a floating chat bubble to every HFS page that lets users talk to a locally-running [Ollama](https://ollama.com) model, with optional voice input via Whisper and automatic web search via DuckDuckGo.

---

## Features

- **Floating chat bubble** — sits on every HFS page, expandable to a full-screen panel
- **Ollama integration** — streams responses from any model running locally
- **Voice input** — microphone button transcribes speech via a local Whisper server
- **Web search** — auto-detects when a question needs current information and fetches DuckDuckGo results before answering
- **Chat history** — saves and restores past conversations per user (guests use browser localStorage)
- **Two personas** — switchable system prompts (concise/technical and casual/friendly), both editable by the user
- **Think mode** — enables extended reasoning on models that support it
- **Text-to-speech** — reads responses aloud using the browser's built-in speech synthesis
- **Image & file attachments** — send images or text files along with your message
- **Admin controls** — lock models, restrict guest access, set rate limits, enforce storage quotas, and more

---

## Requirements

- **HFS** version with API level 8 or higher
- **[Ollama](https://ollama.com)** running locally (default: `http://localhost:11434`)
- **Whisper server** *(optional)* — only needed for voice input (default: `http://localhost:11436`)

---

## Recommended Setup

For the safest deployment, run Ollama and Whisper bound to localhost only. Because the plugin proxies all AI requests server-side, the browser never connects to Ollama or Whisper directly — so there is no reason to expose those ports to your network. With localhost binding in place, all access goes through the plugin's rate limiter, endpoint allowlist, and login checks.

### Containers (Docker, Podman, or any other runtime — example using Podman)

**Ollama**
```bash
podman run -d \
  --name ollama \
  -p 127.0.0.1:11434:11434 \
  -v ollama-data:/root/.ollama \
  --env OLLAMA_HOST=0.0.0.0:11434 \
  docker.io/ollama/ollama:latest
podman exec ollama ollama pull gemma4
```

**Whisper**
```bash
podman run -d \
  --name whisper \
  -p 127.0.0.1:11436:8000 \
  -v whisper-cache:/home/ubuntu/.cache/huggingface/hub \
  --env WHISPER__MODEL=Systran/faster-whisper-small \
  ghcr.io/speaches-ai/speaches:latest-cpu
curl -X POST http://127.0.0.1:11436/v1/models/Systran/faster-whisper-small
```

> The `curl` command downloads and caches the model. Run it once after the container starts — without it, the first transcription request will fail or hang while the model tries to download on demand.

> **Note:** You do not need `OLLAMA_ORIGINS` or any CORS/allow-origins environment variable. The browser never contacts Ollama or Whisper directly, so those settings serve no purpose and can be omitted.

### Running natively (no container)

Ollama respects the `OLLAMA_HOST` environment variable. Set it to `127.0.0.1` before starting:

```bash
OLLAMA_HOST=127.0.0.1:11434 ollama serve
```

Most Whisper servers have an equivalent bind-address flag — check the docs for whichever one you use.

---

## Installation

1. Download the plugin zip and extract it into your HFS plugins folder:
   ```
   <hfs-config-dir>/plugins/hfs-ai/
   ```
   The folder should contain `plugin.js` and a `public/` subfolder with `bubble.js` and `bubble.css`.

2. In the HFS admin panel, go to **Plugins** and enable **hfs-ai**.

3. Make sure Ollama is running and has at least one model pulled:
   ```bash
   ollama pull llama3
   ```

4. Open any HFS page — the AI bubble will appear in the bottom-right corner.

---

## Ollama Setup

### Linux

Download and run the official install script:

```bash
curl -fsSL https://ollama.com/install.sh | sh
```

Ollama starts automatically as a systemd service. To start/stop it manually:

```bash
sudo systemctl start ollama
sudo systemctl stop ollama
```

By default Ollama listens on all interfaces. To restrict it to localhost only (recommended — see [Recommended Setup](#recommended-setup)), create a systemd override:

```bash
sudo systemctl edit ollama
```

Add the following, save, then restart:

```ini
[Service]
Environment="OLLAMA_HOST=127.0.0.1:11434"
```

```bash
sudo systemctl restart ollama
```

### macOS

Download the app from [ollama.com](https://ollama.com/download/mac) and open it. Ollama runs as a menu bar app and starts automatically on login.

To restrict to localhost, set the environment variable before launching or add it to your shell profile:

```bash
OLLAMA_HOST=127.0.0.1:11434 ollama serve
```

### Windows

Download the installer from [ollama.com](https://ollama.com/download/windows) and run it. Ollama installs as a background service accessible at `http://localhost:11434`.

To restrict to localhost, set the environment variable in System Properties → Environment Variables:

```
OLLAMA_HOST=127.0.0.1:11434
```

Then restart Ollama from the system tray.

### Container (Docker / Podman)

See [Recommended Setup](#recommended-setup) for the full container commands with localhost binding already applied.

### Pull a model

Once Ollama is running, pull at least one model:

```bash
# Lightweight, fast
ollama pull phi3

# Balanced
ollama pull llama3

# Strong reasoning (supports think mode)
ollama pull deepseek-r1
```

Ollama runs on `http://localhost:11434` by default, which matches the plugin's default setting. If you run Ollama on a different host or port, update the **Ollama host** setting in the plugin config.

---

## Whisper Setup (optional — voice input)

The plugin expects an OpenAI-compatible Whisper API at `http://localhost:11436`. The recommended server is [speaches](https://github.com/speaches-ai/speaches), which is what this plugin was developed and tested against.

If you don't want voice input at all, enable **Disable Whisper (microphone)** in the plugin settings to hide the mic button entirely — you can skip this section.

### Linux

Using Podman (recommended — see [Recommended Setup](#recommended-setup) for localhost binding):

```bash
podman run -d \
  --name whisper \
  -p 127.0.0.1:11436:8000 \
  -v whisper-cache:/home/ubuntu/.cache/huggingface/hub \
  --env WHISPER__MODEL=Systran/faster-whisper-small \
  ghcr.io/speaches-ai/speaches:latest-cpu
```

Or with Docker:

```bash
docker run -d \
  --name whisper \
  -p 127.0.0.1:11436:8000 \
  -v whisper-cache:/home/ubuntu/.cache/huggingface/hub \
  --env WHISPER__MODEL=Systran/faster-whisper-small \
  ghcr.io/speaches-ai/speaches:latest-cpu
```

Then load the model (only needed once — it downloads and caches the model file):

```bash
curl -X POST http://127.0.0.1:11436/v1/models/Systran/faster-whisper-small
```

### macOS

The speaches container should work on macOS with Docker Desktop or Podman Desktop using the same commands as Linux above. Note that the `-cpu` image does not use the GPU, so transcription will be slower on larger models. This has not been extensively tested on macOS — if you run into issues, the [speaches GitHub](https://github.com/speaches-ai/speaches) is a good place to check for platform-specific notes.

### Windows

Running the speaches container on Windows via Docker Desktop may work but has not been tested. If you try it and it works, the Linux commands above should apply as-is inside a WSL2 or Docker Desktop terminal. If voice input is important on Windows, check the [speaches GitHub](https://github.com/speaches-ai/speaches) for any Windows-specific guidance.

### Changing the Whisper model

The `Systran/faster-whisper-small` model is a good default — small download, fast transcription, decent accuracy. If you want better accuracy at the cost of speed, swap it for a larger model:

| Model | Size | Notes |
|---|---|---|
| `Systran/faster-whisper-small` | ~250 MB | Default, fast |
| `Systran/faster-whisper-medium` | ~750 MB | Better accuracy |
| `Systran/faster-whisper-large-v3` | ~1.5 GB | Best accuracy, slower |

Update the `WHISPER__MODEL` environment variable and re-run the `curl` load command with the new model name.

---

## Configuration

All settings are available in the HFS admin panel under **Plugins → hfs-ai**.

### Connection

| Setting | Default | Description |
|---|---|---|
| Ollama host | `http://localhost:11434` | Base URL of your Ollama server |
| Whisper host | `http://localhost:11436` | Base URL of your Whisper transcription server |
| Disable Whisper (microphone) | Off | Hides the mic button and disables voice transcription for all users |

### Web Search

| Setting | Default | Description |
|---|---|---|
| Max search results | 4 | How many DuckDuckGo results to fetch per query (1–10) |
| Fetch timeout | 7000 ms | Timeout for web page fetches during search |
| Explicit search commands | `search, look up, find out, ...` | Phrases that always trigger a search |
| Recency signals | `latest, today, this week, ...` | Phrases suggesting current information is needed |
| Question patterns | `who is the, who won, ...` | Question phrases that trigger a search |
| Live data topics | `price of, weather, news, ...` | Topics that typically require live data |

All four trigger lists are comma-separated and fully editable — add or remove phrases to tune when automatic search fires.

### Access & Rate Limiting

| Setting | Default | Description |
|---|---|---|
| Require login to use chat | Off | When on, guests see no bubble and cannot access any AI endpoint |
| Rate limit (requests/min) | 20 | Max Ollama + Whisper + search calls per minute, per user or IP. Set to 0 for unlimited (not recommended with guest access) |

### Chat Storage

| Setting | Default | Description |
|---|---|---|
| Max saved chats per user | 100 | Oldest chat is deleted when this is exceeded. 0 = unlimited |
| Max chat storage per user | 50 MB | Oldest chats are deleted until under this limit. 0 = unlimited |

Guests are not affected by storage limits — their chats are stored in browser localStorage only.

### Model

| Setting | Default | Description |
|---|---|---|
| Default model | *(blank)* | Ollama model name pre-selected on first use (e.g. `llama3`, `phi3`). Blank = use the user's last selection |
| Lock model for all users | Off | When on and a default model is set, the model selector is hidden and fixed for everyone |

### Appearance

| Setting | Default | Description |
|---|---|---|
| Chat theme | HFS Theme | Color theme for the bubble and panel. Users can override this in the chat settings |

### Chat Defaults

These set the starting values for each user. Users can change them in the chat settings panel unless the corresponding lock is enabled.

| Setting | Default | Description |
|---|---|---|
| Default persona | Prompt 1 | Which persona is active when a user first opens the chat |
| Disable persona switching | Off | Locks everyone to the default persona |
| Default speak mode | Off | Whether the assistant reads responses aloud by default |
| Default think mode | Off | Whether extended reasoning is on by default (only affects compatible models) |
| Disable think mode toggle | Off | Locks everyone to the default think mode |
| Default response length | -1 (unlimited) | Max tokens per reply. -1 = no limit |
| Default temperature | 1.0 | Creativity/randomness (0 = focused, 2 = very creative) |
| Disable temperature/length settings | Off | Locks everyone to the default values above |

### Persona Prompts

| Setting | Description |
|---|---|
| Prompt 1 persona prompt | System prompt for Persona 1. Default is concise and technical |
| Prompt 2 persona prompt | System prompt for Persona 2. Default is casual and conversational |

Users can edit their own local copy of these prompts from the chat settings panel. Leave a prompt blank to send no system message for that persona.

---

## Security Notes

- **Bind AI services to localhost.** When running Ollama or Whisper in a container, use `127.0.0.1:<host-port>:<container-port>` instead of `<port>:<port>`. This ensures all access is routed through the plugin's controls and nothing on your local network can reach those services directly. See [Recommended Setup](#recommended-setup) for example commands.
- **Ollama model management is blocked.** The proxy only allows inference and read endpoints (`/api/chat`, `/api/generate`, `/api/tags`, `/api/show`, `/api/embed`, `/api/ps`, `/api/version`). Routes that pull, delete, push, or copy models are blocked — users cannot fill your disk or remove models via the chat.
- **Rate limiting** applies to all proxied services. The default of 20 requests/min per user or IP is a reasonable starting point; lower it for public-facing servers.
- **Guest access** is allowed by default. If your HFS server is public, consider enabling **Require login** or lowering the rate limit.
- **Chat storage** is sandboxed per user under `<hfs-config-dir>/plugins/hfs-ai/storage/chats/<username>/`. Usernames are sanitized before use as directory names.
- **Markdown rendering** uses [marked](https://marked.js.org) + [DOMPurify](https://github.com/cure53/DOMPurify) to strip dangerous HTML from AI responses before display.
- **Web search results** are passed to the model with an explicit instruction not to follow any commands embedded in the results (prompt-injection defense).

---

## How Web Search Works

The plugin watches each message for trigger phrases before sending it to Ollama. If a match is found — or if the user clicks the search toggle — it:

1. Sends the query to DuckDuckGo and collects up to `maxSearchResults` results
2. Injects the titles, URLs, and snippets as a system message with today's date
3. Sends the combined context to Ollama so the answer reflects current information

Sources are not shown in the UI by default, but the model is instructed to reference them in its answer. You can also click the search button manually to force a search for any message, or right-click it to toggle automatic search on/off.

---

## File Structure

```
plugins/hfs-ai/
├── plugin.js          # Server-side plugin (proxy, chat storage, config)
├── public/
│   ├── bubble.js      # Client-side chat UI (injected into every HFS page)
│   └── bubble.css     # Styles
└── storage/
    └── chats/
        └── <username>/
            └── <chat-id>.json
```

---

## License

MIT
