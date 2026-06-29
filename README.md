# wcdashboard

## Automatic bracket updates

The workflow in `.github/workflows/update-world-cup-results.yml` can update knockout placeholders after matches finish.

Required GitHub secret:

- `THESTATSAPI_KEY` — TheStatsAPI key.

The updater runs in GitHub Actions during likely post-match windows. It calls the API only for matches that are already past the expected end time, then replaces downstream slots such as `W73`, `W74`, `L101`, and `L102` in `index.html`.

Optional exact API fixture IDs can be added in `scripts/world-cup-fixture-map.json`:

```json
{
  "73": "mt_1234567"
}
```
