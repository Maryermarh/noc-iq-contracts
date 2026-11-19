# SLA Calculation Mathematical Spec and Edge-Case Boundary Guide

## Mathematical Specification
The Service Level Agreement (SLA) calculation computes penalties or rewards based on the Mean Time To Repair (MTTR) of an incident, compared to a predefined threshold for its severity.

Let:
- `M` = MTTR (in minutes)
- `T` = Threshold (in minutes)
- `P` = Penalty per minute (for M > T)
- `R` = Base Reward (for M <= T)

If `M <= T`:
  Status: MET
  Amount: `+R` (Reward)

If `M > T`:
  Status: VIOLATED
  Amount: `-(M - T) * P` (Penalty)

## Edge-Case Boundary Guide

1. **M = T (Exact Boundary)**
   - The SLA is considered MET.
   - The user receives the full reward `R`.
   - Penalty calculation is NOT triggered since the violation time is 0.

2. **M = 0 (Instant Resolution)**
   - Naturally `M <= T`, so the SLA is MET.
   - Full reward `R` is given.

3. **Missing Configuration**
   - If a severity is not configured in the SLA configuration maps, any outage calculation against it must immediately abort with a `ConfigNotFound` error.

4. **Extreme Penalty (M >> T)**
   - The penalty grows linearly. There is no built-in cap in this exact formula, so long outages may result in extremely large negative amounts.

5. **Paused Contract**
   - No SLA calculations can be performed when the contract is paused.

## Rounding and Evaluation Order

All amounts are whole numbers of the contract's smallest unit (`i128`), and every intermediate
value is an integer. There are no fractions anywhere in the calculation; the only operation that
discards a remainder is integer division, and it always floors (the operands are non-negative, so
`div_euclid` and truncation agree). The reference is `compute_result` in
`sla_calculator/src/lib.rs`. The examples below follow its formulas exactly; the `critical` cases
with `M = 5`, `7` and `15` are also pinned by the contract fixtures in `sla_calculator/src/tests.rs`.

### Order of operations

1. **Cap the duration.** `M` is first limited to the configured maximum outage duration
   (default 10,080 minutes). Everything below uses the capped value.
2. **`M = 0` short-circuits.** The result is MET, rating `top`, amount `0`. No tier or
   multiplier is applied.
3. **Violation (`M > T`).** `overtime = M - T` (integer minutes), then
   `penalty = overtime * P`, then the amount is `-penalty`. This is a single multiplication of two
   integers: **nothing is rounded**. Multiplication saturates at the `i128` limits instead of
   overflowing.
4. **Met (`0 < M <= T`).**
   1. `ratio = floor(M * 100 / T)`: multiply first, then divide. (`T` is at least 1, so there is no
      division by zero.)
   2. The tier is chosen from `ratio`: `< 50` is `top`, `< 75` is `excel`, anything else is `good`.
      The boundaries are strict: `ratio = 50` is `excel` and `ratio = 75` is `good`.
   3. `reward = floor(R * multiplier / 100)`, where `multiplier` is the tier's percentage
      (default `top` 200, `excel` 150, `good` 100). Again **multiply first, then floor**:
      the remainder of `R * multiplier / 100` is dropped, never rounded up.

Rounding the intermediate `ratio` before the multiplication, or dividing `multiplier / 100`
first, gives different answers and breaks parity with the contract.

### Boundary examples

Default `critical` configuration: `T = 15`, `P = 100`, `R = 750`, multipliers 200 / 150 / 100.

| MTTR `M` | `ratio = floor(M*100/T)` | Tier | Amount |
|---|---|---|---|
| 0 | n/a (short-circuit) | `top` | `0` |
| 5 | 33 | `top` | `750 * 200 / 100 = 1500` |
| 7 | 46 | `top` | `1500` |
| 8 | 53 | `excel` | `750 * 150 / 100 = 1125` |
| 11 | 73 | `excel` | `1125` |
| 12 | 80 | `good` | `750 * 100 / 100 = 750` |
| 15 (`M = T`) | 100 | `good` | `750` (still MET) |
| 16 | n/a | violated | `-(16 - 15) * 100 = -100` |
| 60 | n/a | violated | `-(60 - 15) * 100 = -4500` |

Exactly on a tier boundary, default `medium` (`T = 60`, `R = 250`):

| MTTR `M` | `ratio` | Tier | Amount |
|---|---|---|---|
| 29 | 48 | `top` | `250 * 200 / 100 = 500` |
| 30 | 50 | `excel` (not `top`) | `250 * 150 / 100 = 375` |
| 45 | 75 | `good` (not `excel`) | `250` |

Flooring, with a base that does not divide evenly (`T = 60`, `R = 101`, `M = 40`: ratio 66, `excel`):

`floor(101 * 150 / 100) = floor(151.5) = 151`. The reward is `151`, not `152`.

### Related fixed-point helpers

- **Uptime basis points:** `floor(M * 10000 / T)`, multiply first, floor last.
- **Multi-site penalty discount:** `floor(base_penalty * factor_bps / 10000)` with factor 10,000 / 9,000 /
  8,000 / 7,000 for 1 / 2 / 3 / 4+ sites. A non-positive base penalty yields `0`.
- **Bounds:** `penalty_per_minute` must be within 1 to 10,000 (`sla_calculator/src/penalty_bounds.rs`),
  so a single minute of overtime can never produce a zero penalty.

### Parity notes for backend implementations

- Use integer (or `BigInt`) arithmetic. Floating point loses precision above 2^53 and its division
  does not floor.
- Reject, rather than round, any off-chain amount that is not a whole number.
- Penalties are negative in the contract result; whether a payout intent carries the sign or the
  magnitude is a backend convention, but the magnitude must equal the contract's.

