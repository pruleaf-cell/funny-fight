# Funny Fight

A tiny Street Fighter-style, side-scrolling 1v1 browser game:

- Two fighters: **Rohan** vs **Dev**
- You choose who you play; the other becomes the AI by default
- Cheesy 90's-style background music (WebAudio) that loops during play

## Run locally

1. From this repo root:

```sh
python3 -m http.server 5173
```

2. Open:

- http://localhost:5173/site/

## Controls

- Move: `A`/`D` or `←`/`→`
- Jump: `W` or `↑` or `Space`
- Block: hold `S` (or `↓`) + move away from opponent
- Punch: `J` (or `Z`)
- Kick: `K` (or `X`)
- Special: `L` (or `C`)
- Mute/unmute: `M`
- Restart round: `R`

## CI deploy (GitHub Pages)

This repo includes a GitHub Actions workflow that:

1. Runs a smoke test (`tools/smoke_test.py`)
2. Deploys `/site` to GitHub Pages on pushes to `main`

