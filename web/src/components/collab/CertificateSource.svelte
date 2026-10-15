<script lang="ts">
  // A certificate's definitions and Lean source, read from LeanGround when first shown.
  // Definitions registered with a sketch are no longer in its source, so they come separately.
  import { untrack } from "svelte";
  import type { Collab } from "../../lib/collab.svelte";
  let { c, cert }: { c: Collab; cert: string } = $props();
  $effect(() => {
    const id = cert;
    untrack(() => void c.loadDetail(id));
  });
  const d = $derived(c.details[cert]);
</script>

{#if !d || d === "loading"}
  <p class="muted">Reading the certificate from LeanGround…</p>
{:else if "error" in d}
  <p class="error">{d.error}</p>
{:else}
  {#if d.definition_sources.length}
    <p class="group">Definitions used</p>
    {#each d.definition_sources as def (def.id)}<pre class="lean" title={def.id}>{def.source.trim()}</pre>{/each}
  {/if}
  {#if d.source}
    <details class="source"><summary>Lean source</summary><pre class="lean">{d.source.trim()}</pre></details>
  {/if}
{/if}
