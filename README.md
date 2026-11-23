# Kohaku Context Lens

A zero-configuration UI extension for KohakuTerrarium 2.2+. Inspect live local creatures and saved `.kohakutr` sessions without resuming or changing them. No Creature configuration changes are needed.

## Install and use

From a checkout of this package, run `kt install . -e` and open or reload KT Studio. On multi-user hosts, the host administrator must enable the package UI under KT’s extension policy.

Open the **Context Lens** tab to compare creatures or select a saved session. The session dock shows the focused creature; graph badges show the other creatures in the graph. Use **Ctrl+Alt+C** to toggle the lens and the **Context Lens** settings to set display thresholds.

## What Context Lens shows

- **Six-dimension context anatomy:** Estimate tokens for the system prompt, rules and memory, skills and tools, tool outputs, chat and channels, and reasoning and compaction. See up to ten tool outputs ranked by estimated text tokens in the inspected context, with previews and their share of the estimate.
- **Turn-by-turn KV cache forensics:** Compare prompt, cached, and completion tokens and cache hit rates. See likely causes of sharp drops: recorded compaction, system-prompt or tool-schema changes, or a long idle gap. Unexplained drops stay marked as unknown.
- **Compaction risk radar:** See when context approaches the model window or compaction threshold, and get a model-based signature-chain warning when compaction is not explicitly disabled.
- **One-click Markdown handoff:** Select a live local creature or saved `.kohakutr` session and click **Generate Handoff** to extract the goal, decisions, files touched, recent channel activity, and blockers or next steps. The packet helps start a fresh session and is generated deterministically from the recorded context, without a model call.

Token estimates exclude unrecorded prompt injections, provider framing, and image or file token costs. Unavailable context limits and hit rates are not shown as zero.
