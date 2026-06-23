# Wellabe Rate Competitiveness & 2027 Sales Impact

An interactive, GitHub-Pages–deployable dashboard that answers two questions for the Med Supp (Plan G) book:

1. **How much higher do Wellabe's rates need to be to land in the "ballpark" of the Big 6 carriers**, given
   that the Big 6 are assumed to take ~15% rerates over the next 6–9 months (before we get new rates out)?
2. **What does taking those increases do to 2027 sales**, starting from the 2026 projection and carrying it
   forward (no baseline growth) minus a rate-driven attrition curve?

## Live app

Once GitHub Pages is enabled (Settings → Pages → **Source: GitHub Actions**), the site deploys automatically
on every push to the working branch via `.github/workflows/pages.yml`.

## Tabs

- **Executive Summary** – headline KPIs (gap today, required increase, 2026 base vs. 2027 adjusted, $ lost).
- **Rate Competitiveness** – where we stack up vs. each Big 6 group, drillable to state → age/gender → zip-3.
- **Required Rate Increases** – the increase each state needs to reach target, ranked and tabulated.
- **2027 Sales Projection** – baseline vs. adjusted by state, a loss waterfall, and the monthly view.
- **Assumptions & Inputs** – every lever, persisted to your browser.

## Model

Per granular cell (state × zip-3 × age × gender):

```
big6Bench        = avg | median | min   over the six Big-6 group rates present
big6AfterRerate  = big6Bench × (1 + rerate)              # rerate default 15%
targetRate       = big6AfterRerate × (1 + offset)        # offset default −5% (5% below the pack)
requiredIncrease = max(0, targetRate / wellabeRate − 1)  # never assume cutting rates
```

`wellabeRate` is the lowest of the three Medico legal entities in the cell. Cells roll up to a state-average
required increase, which drives a tiered **elasticity** table. By default the elasticity reduces the **policy
count** while premium per remaining policy rises with the rate increase, so the net premium impact is smaller
than the count drop (and can even be positive where the rate increase outweighs the count loss):

```
# "count" mode (default)  — elasticity cuts policy count; premium/policy rises with the increase
sales2027(state) = baseline2026(state) × (1 + growth) × (1 − countReduction) × (1 + requiredIncrease)
# "premium" mode          — elasticity cuts premium dollars directly
sales2027(state) = baseline2026(state) × (1 + growth) × (1 − reduction)
```

Default count-reduction tiers: 5–10%→5%, 10–15%→15%, 15–20%→30%, 20–30%→40%, 30–40%→60%, >40%→70%
(growth default 0%). The reduction (and premium uplift) apply only to **2027 months on/after each state's
rate-increase start date**, weighted by the seasonal monthly shape.

**Baseline is established before the rerate layer.** Per state: `2027 = 2026 × (1+growth)`, then **baseline
adjustments** (period reductions, e.g. IN −50% Jan–Apr) are applied; the rerate plan is layered on top. The
**Assumptions & Inputs** tab leads with the baseline: download a CSV template, upload your own 12-month-by-state
2026 projection, set the runrate growth, manage adjustment rules, and edit the baseline table (full-year totals,
each month's share, then 2026/2027 monthly dollars — frozen State column, totals row; edit a 2026 total to scale
its months or any monthly cell directly).

**Default plan:** only the **top 10 states we are furthest below the Big 6** take the increase (start **4/1/2027**);
all others off; MD and CA on but start **10/1**.

**Monte Carlo** tab: stochastic stress test — a market-wide impact factor ~ Normal(1, σ) scales every state's
reduction, and a correlated launch-delay ~ Normal(0, σ) months shifts all start dates. Reports P5/P50/P95,
mean, σ, and P(below base case) over N trials, with a histogram and trial-level CSV export.

**Save / share:** export the entire model (all assumptions) as JSON — or just the start dates as CSV — and
import them back to reproduce a scenario. The Executive Summary table and the monthly-by-state matrix also
export to CSV.

## Data sources

- `data_sources/Ranks_v_Sales_MS_June.xlsx` — `Rates G` sheet: granular Plan G rates by carrier;
  `Lookup` sheet: Big 6 carrier tagging.
- `data_sources/MS_Sales_Tracking_2026.xlsx` — `Projection` sheet, **"Projected w action"** block
  (Approved/issued basis): the company's planned-action 2026 projection by state × month (~$288.3M total),
  the 2027 carry-forward base. This app's aggressive Big-6-matching increases are applied on top via the
  elasticity curve.

The Big 6 = UnitedHealthcare/AARP, Humana, Aetna, Cigna, Mutual of Omaha, and the Blue Cross Blue Shield plans.

## Rebuilding the data

The front-end reads a single precomputed `data.json`. To regenerate it after the source workbooks change:

```bash
pip install openpyxl
python3 build_data.py
```

## Local preview

```bash
python3 -m http.server 8000   # then open http://localhost:8000
```
