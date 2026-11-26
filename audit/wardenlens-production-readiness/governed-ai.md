# Governed AI integration evidence

The successful acceptance document was an 87,758-byte one-page PNG derived from the repository's
fictional referral packet. The verified object SHA-256 was captured by the runner without logging
clinical text.

| Capability | Backend/model pin | Result | Tokens (in/out) | Duration |
|---|---|---|---:|---:|
| `doclens_sud_detect` | `local-llama-3.1-8b-instruct` / `ollama/llama3.1:8b-instruct-q8_0` | PASS | 636/14 | 8,039 ms |
| `doclens_classify` | same Llama pin | PASS | 495/17 | 1,659 ms |
| `doclens_extract` | same Llama pin | PASS | 851/195 | 8,634 ms |
| `doclens_vision_verify` (3 calls) | `local-qwen2.5-vl-7b-instruct` / `ollama/qwen2.5vl:7b` | PASS | 4,268/81 total | 27,595 ms total |

Every invocation had encrypted prompt and response columns populated. Candidate persistence contained
three rows, all with `value_cipher`, none with `value_text`. The real SUD result was `not_detected`;
the positive SUD enforcement path is covered by the isolated F237 live suite, not by pretending this
negative document contained Part 2 data.

Approved clinical writeback is **BLOCKED** for this real-AI run. The model produced three demographic
candidates at medium risk. `writeback-plan.ts` permits only low-risk allowlisted demographics, so review
completion created no provenance or commit event. This is the expected safety outcome, but it is not
evidence that a real model output can complete approved chart writeback.

