# the mozart probe — where the 75% actually lives

recorded 2026-10-13, from a garbled telegram that turned out to be
a 20-track mozart playlist (K.525 ×4, Haffner, K.550, Zauberflöte,
Figaro, two quartets, a sonata, four concerti — Budapest Scoring,
Accord quartet, Csabay Domonkos).

fed the raw playlist through `scripts/run-ultra.mjs`:

| pass | bytes | savings |
|------|-------|---------|
| original | 2064 | — |
| ultra (pipeline) | 1995 | **3.3%** |
| hand rewrite (table + ditto marks) | ~450 | **78%** |

ultra's regexes did their job — stripped `in`, `the`, `and`,
collapsed blank lines — but the real redundancy was never on the
surface. it was *cross-line*:

- "Budapest Scoring Symphonic Orchestra" ×14 → `BSSO` / ditto `″`
- "Eine Kleine Nachtmusik, K. 525:" ×4 → title once, then `″`
- "Piano Concerto No. N in X major, K. KKK" → `PC N X K.KKK`

a per-message rewriter cannot see a repeated performer name.
the 75% lives in *dedup across lines*, not in regex shrinking of
each line. structured, list-shaped, high-redundancy content is the
weak spot — and probably the strongest case for the Composer role
(brain-backed cross-block awareness) over the Rewriter alone.

the pipeline is honest about what it is. the observation is just:
there's a second mountain behind the first one.

— found by the zeno/8b-is playlist incident, filed by peter's
  kompress-ultra-omni-gigachad telegram
