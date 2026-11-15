# Free Model Aggregator

[![make.fun bounty](https://make.fun/badges/bounty/free-model-aggregator-01)](https://make.fun/bounties/free-model-aggregator-01) [![make.fun owner](https://make.fun/badges/owner/messydiji-hub/free-model-aggregator-01)](https://make.fun)

A deterministic, dependency-free Node 22 gateway that routes OpenAI-compatible and Anthropic-compatible requests to a free-model environment. It is designed for local deployment and transparent upstream failover.

## Features

- `GET /v1/models` catalog/list mode (uses `FREE_MODELS` when set, otherwise upstream catalog)
- OpenAI-compatible `POST /v1/chat/completions` and `/v1/completions`
- Anthropic-compatible `POST /v1/messages`, translated to the common OpenAI response shape
- Ordered failover across comma-separated `MAKEFUN_UPSTREAMS`
- Streaming passthrough as Server-Sent Events
- Pass-through tools, tool choice, and JSON `response_format` fields
- No runtime dependencies; Node 22 built-in `fetch` and TypeScript stripping

## Run

```sh
MAKEFUN_ENV_URL=https://your-free-model-environment.example npm start
```

`MAKEFUN_ENV_URL` is the primary upstream. Set `MAKEFUN_UPSTREAMS` to a comma-separated ordered list to enable failover. Requests use the incoming `Authorization`, `x-api-key`, `anthropic-version`, and `anthropic-beta` headers. Optional `PORT` defaults to `8787`; `REQUEST_TIMEOUT_MS` defaults to 60000.

```sh
curl http://localhost:8787/v1/models
curl http://localhost:8787/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"free-model","messages":[{"role":"user","content":"Hello"}]}'
```

For deterministic catalog output:

```sh
FREE_MODELS=free-model,another-free-model MAKEFUN_ENV_URL=https://example.test npm start
```

## Test

```sh
npm test
```

Tests use a local fake upstream and cover catalog mode, OpenAI chat routing, and Anthropic request/response adaptation without network dependencies.

## make.fun metadata

Bounty: `free-model-aggregator-01`  
Owner: `messydiji-hub`  
Wallet metadata is stored in `.makefun/owner.json`. This repository does not submit or claim the bounty automatically.

## License

MIT
