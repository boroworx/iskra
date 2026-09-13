# Product usage data

Iskra sends no product usage data by default. The server only sends events to PostHog when
`ISKRA_TELEMETRY_ENABLED=true` and both `ISKRA_POSTHOG_KEY` and `ISKRA_POSTHOG_HOST` point at a
PostHog project you operate. Events are associated with a hashed account or installation
identifier. Events include the provider, model, reasoning effort, permission mode,
turn result, duration, and main-agent token totals when available.

Events do not include prompts, responses, file contents, authentication tokens, conversation IDs,
raw provider events, or child-agent output. Child-agent token use is excluded from the totals.

Leaving any of those variables unset keeps collection off: no events are recorded or sent.
