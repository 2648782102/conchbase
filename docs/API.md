# Runtime API status

The service listens on `127.0.0.1:4318` by default.

The machine-readable contract for currently implemented endpoints is [`openapi.yaml`](openapi.yaml). Conchbase owns this contract; Pagurus and other clients consume it.

## Implemented

### `GET /v1/health`

Returns the service health and API version.

```json
{"status":"ok","service":"conchbase","apiVersion":1}
```

### `GET /v1/runtime`

Returns the current service identity and advertised capabilities. Capabilities are empty in this scaffold.

## Planned contract

Task creation, cancellation, approvals, configuration validation/application, event streaming, and artifact access will be specified before implementation. The API will use versioned JSON schemas; events will be resumable by event ID. A user-defined agent composition is a future configuration concern, not an implemented route; no topology, layer count, or role registry is exposed here.

No remote bind or unauthenticated write endpoint is enabled in this scaffold.
