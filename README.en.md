[繁體中文](README.md) | [English](README.en.md)

# X (Twitter) Safari Timeline Position Fix

A Tampermonkey userscript for Safari that fixes X (Twitter) returning to the wrong timeline position after opening a post.

> **v2.0.0 supports Safari at 100% page zoom only.** On the target Retina Mac, `devicePixelRatio` is `2` at 100%. The script automatically disables itself at other zoom levels and leaves scrolling to Safari.

## Quick Install

**[Install the script from Greasy Fork](https://greasyfork.org/zh-TW/scripts/588900-x-twitter-safari-時間線位置修復)**

## Features

- Restores the exact post and viewport position after returning from a post detail page.
- Restores the Home timeline after returning from Notifications, Search, Profile, and other pages.
- Uses the post ID and its viewport coordinate as an anchor instead of relying only on the unstable `scrollY` value.
- Guards the anchor position frame by frame for a short period after returning, catching delayed shifts from X's virtualized timeline.
- Tries the saved raw position only once when the anchor is missing; it does not search up and down or create repeated jumps.
- Completely bypasses image navigation so X and Safari retain their native, already-correct behavior.
- Stores state in `sessionStorage`; it sends no data and makes no network requests.
- Uses Tampermonkey's `@sandbox DOM` mode to avoid being blocked by X's Content Security Policy.

## Requirements

- macOS
- Safari
- Tampermonkey for Safari
- X page zoom set to **100%**
- A Retina display environment where `devicePixelRatio === 2` at 100%

## Installation

1. Install and enable [Tampermonkey](https://www.tampermonkey.net/) in Safari.
2. Open the [Greasy Fork script page](https://greasyfork.org/zh-TW/scripts/588900-x-twitter-safari-時間線位置修復).
3. Select the install option and confirm it in Tampermonkey.
4. Set Safari's page zoom for X to **100%**.
5. Reload `https://x.com/home`.

Alternatively, create a new Tampermonkey userscript and manually paste the complete contents of [`twitter-x-safari-scroll-fix.user.js`](twitter-x-safari-scroll-fix.user.js).

## Usage

No additional configuration is required after installation:

1. Scroll down the X Home timeline.
2. Open a post.
3. Use Safari's Back button to return to the timeline.
4. The script uses the clicked post as an anchor and restores its previous viewport position.

When opening a post image, the script temporarily bypasses restoration to avoid interfering with the native image-return flow.

## Zoom Behavior

This version intentionally does not support zoom levels other than 100%:

| Safari page zoom | Script state |
|---|---|
| 100% (DPR 2) | Enabled |
| Any other zoom level | Disabled; Safari handles scrolling natively |

You can verify the active state in the Safari Web Inspector Console:

```js
document.documentElement.dataset.xSafariScrollFixVersion
document.documentElement.dataset.xSafariScrollFixState
devicePixelRatio
```

A supported environment should return values similar to:

```text
"2.0.0"
"idle" or "restored"
2
```

At an unsupported zoom level, the state is:

```text
"unsupported-zoom"
```

## How It Works

Before leaving a timeline, the script saves:

- The current route
- `scrollY`
- The anchor post ID
- The anchor post's position relative to the viewport top
- The save timestamp

On return, it first looks for the same post and corrects its position using integer CSS pixels. If X has not mounted the post yet, the script uses the saved `scrollY` once to wake the virtualized list and then waits for the anchor.

Any active restoration is immediately cancelled when the user scrolls, touches the page, or presses a scrolling key.

## Files

- [`twitter-x-safari-scroll-fix.user.js`](twitter-x-safari-scroll-fix.user.js) — Tampermonkey userscript
- [`README.md`](README.md) — Traditional Chinese documentation
- [`README.en.md`](README.en.md) — English documentation

## License

This project is licensed under the [MIT License](LICENSE).
