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
required increase, which drives a tiered **elasticity** table (increase → sales reduction; defaults
5–10%→0%, 10–15%→10%, 15–20%→20%, 20–30%→30%, 30–40%→40%, >40%→50%). Finally:

```
sales2027(state) = baseline2026(state) × (1 + growth) × (1 − reduction)    # growth default 0%
```

All inputs are adjustable in the app; per-state reduction overrides are supported.

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
