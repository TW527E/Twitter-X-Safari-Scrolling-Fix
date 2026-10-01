[繁體中文](https://github.com/TW527E/Twitter-X-Safari-Scrolling-Fix/blob/main/README.md) | [English](https://github.com/TW527E/Twitter-X-Safari-Scrolling-Fix/blob/main/README.en.md)

# X (Twitter) Safari Timeline Position Fix

A Tampermonkey userscript for Safari that fixes X (Twitter) returning to the wrong timeline position after opening a post.

> **v2.3.7 has been tested in Safari at 100%, 115% and 125% page zoom.** At other zoom levels the timeline may still jump after returning; see [Zoom Behavior](#zoom-behavior).

## Quick Install

**[Install the script from Greasy Fork](https://greasyfork.org/zh-TW/scripts/588900-x-twitter-safari-時間線位置修復)**

## Features

- Restores the exact post and viewport position after returning from a post detail page.
- Restores the Home timeline after returning from Notifications, Search, Profile, and other pages.
- Uses the post ID and its viewport coordinate as an anchor instead of relying only on the unstable `scrollY` value.
- Waits for the Home tab bar and ignores hidden or leftover post-detail copies of the same post, so it never corrects against the wrong element.
- Guards the anchor position frame by frame for a short period after returning, catching delayed shifts from X's virtualized timeline.
- Supports non-100% page zoom: corrections snap to Safari's zoomed scroll grid instead of flip-flopping between two positions.
- Retries the saved raw position with backoff while the anchor is missing, and stops once the anchor has appeared so it never fights X's re-layout.
- Completely bypasses image navigation so X and Safari retain their native, already-correct behavior.
- Stores state in `sessionStorage`; it sends no data and makes no network requests.
- Uses Tampermonkey's `@sandbox DOM` mode to avoid being blocked by X's Content Security Policy.

## Requirements

- macOS
- Safari
- Tampermonkey for Safari
- A Retina display environment where `devicePixelRatio === 2` at 100%
- X page zoom of **100%, 115% or 125%** recommended

## Installation

1. Install and enable [Tampermonkey](https://www.tampermonkey.net/) in Safari.
2. Open the [Greasy Fork script page](https://greasyfork.org/zh-TW/scripts/588900-x-twitter-safari-時間線位置修復).
3. Select the install option and confirm it in Tampermonkey.
4. Reload `https://x.com/home`.

Alternatively, create a new Tampermonkey userscript and manually paste the complete contents of [`twitter-x-safari-scroll-fix.user.js`](https://github.com/TW527E/Twitter-X-Safari-Scrolling-Fix/blob/main/twitter-x-safari-scroll-fix.user.js).

## Usage

No additional configuration is required after installation:

1. Scroll down the X Home timeline.
2. Open a post.
3. Use Safari's Back button to return to the timeline.
4. The script uses the clicked post as an anchor and restores its previous viewport position.

When opening a post image, the script temporarily bypasses restoration to avoid interfering with the native image-return flow.

## Zoom Behavior

The script derives the zoom level from a Retina baseline of `devicePixelRatio === 2` at 100%. At non-100% zoom Safari can only stop the scroll position on a fixed grid (about 0.8 px at 125%), so an error within one grid step counts as aligned.

| Safari page zoom | Status |
|---|---|
| 100%, 115%, 125% | Tested |
| Any other zoom level | May still jump after returning; not handled yet |

You can verify the active state in the Safari Web Inspector Console:

```js
document.documentElement.dataset.xSafariScrollFixVersion
document.documentElement.dataset.xSafariScrollFixState
devicePixelRatio
```

They should return values similar to:

```text
"2.3.7"
"idle", "restoring" or "restored"
2 (100%), 2.3 (115%), 2.5 (125%)
```

When reporting a jump, run this in the Console right after it happens and attach the copied text to your report:

```js
copy(sessionStorage.getItem("x-safari-scroll-fix:v4:debug-log"))
```

## How It Works

Before leaving a timeline, the script saves:

- The current route
- `scrollY`
- The anchor post ID
- The anchor post's position relative to the viewport top
- `devicePixelRatio`
- The save timestamp

On return, it waits until the timeline is ready (on Home, until the For you / Following tab bar appears), skips hidden or leftover post-detail copies of the same post, and then corrects the anchor's position. If X has not mounted the post yet, it retries the saved `scrollY` with backoff to wake the virtualized list, and stops using `scrollY` once the anchor has appeared. After aligning, it keeps watching for about 2 more seconds to catch layout changes X finishes late.

Any active restoration is immediately cancelled when the user scrolls, touches the page, or presses a scrolling key. The trackpad back-swipe gesture does not cancel it.

## License

This project is licensed under the [MIT License](https://github.com/TW527E/Twitter-X-Safari-Scrolling-Fix/blob/main/LICENSE).
