# Usage Panel

A Claude Code mod that docks a **Usage** pane on the right with live stats for the session you're in, plus totals kept across every session.

## What it shows

- **Context window**: how full it is, as a bar, with the tokens used and left.
- **Plan usage**: your current-session (5-hour) and weekly limits, with when each resets.
- **Usage credits**: an estimated balance that counts down while a plan limit is used up, plus your monthly spend limit if you have one.
- **Cost**: this session, average per reply, all time and average per session, at API rates.
- **Tokens**: input, output, cache read and cache write, for this session and all time.
- **Activity**: your messages, Claude's replies, sessions, how long this one has run, and the model.

Subagent tokens are counted in the totals but not as replies.

## Install

Copy this folder into your Claude Code mods directory as `usage-panel`:

```bash
git clone https://github.com/catflinger5000-netizen/claude-usage-panel.git ~/.claude/mods/usage-panel
```

Start a new session and the pane opens on its own.

## Commands

| Command | What it does |
| --- | --- |
| `/usage-panel` | Opens the pane if you closed it |
| `/usage-panel credits 12.78` | Sets your usage-credit balance (copy it from Settings → Usage → Current balance) |
| `/usage-panel credits` | Shows the estimated balance left |

Claude Code doesn't give mods the credit balance, so you enter it once and the pane counts down from there. Auto-reload top-ups aren't seen, so re-enter the balance after one.

## Starting totals

On first run, the all-time totals are seeded from `baseline.json`. It ships as zeros; put in your own past numbers if you want the totals to include history from before you installed the mod.

## Development

```
hooks/register.tsx    the mod: hooks, slash command and pane
types/index.d.ts      state types
tests/usage.test.tsx  tests
```
