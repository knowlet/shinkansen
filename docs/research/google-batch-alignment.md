# Google batch segment alignment

Base: 52b0118cb7283161b0c01ed2fb78c8651bd446ae.

Google batches join input segments with a separator and split the translated
response on that separator. If the response removes or adds a separator, the old
code returned positional guesses: merged text assigned to the first segment,
original text substituted for missing segments, or surplus translations silently
ignored. background.js then caches those results against the original inputs.

Reject a group whose returned segment count differs from its input count. The
batch promise rejects before background.js can reach cache.setBatch, even if an
earlier group succeeded. This avoids returning partially aligned data and does
not issue retries or extra translation requests. Existing message-handler error
handling remains responsible for surfacing the failure.

Offline regression cases cover missing and extra separators, a malformed later
group, and an aligned multi-chunk response. On unchanged code the three rejection
cases fail and the valid control passes. After the fix all four pass, together
with the existing batching/index/URL-splitting tests.

This validates cardinality, not translation quality or equal-length semantic
reordering. It does not prove a current Google outage or contact Google's endpoint.
Full browser extension/live-page acceptance is not part of these offline tests.
No dependency, manifest, release archive, tag, or workflow changes are included.
