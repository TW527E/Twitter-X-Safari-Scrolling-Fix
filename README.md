[繁體中文](README.md) | [English](README.en.md)

# X（Twitter）Safari 時間線位置修復

一個專為 Safari 與 Tampermonkey 製作的使用者腳本，用來修復瀏覽 X（Twitter）時間線時，開啟推文後返回卻跳到錯誤位置的問題。

> **v2.0.0 僅支援 Safari 100% 頁面縮放。** 目前這台 Retina Mac 在 100% 時的 `devicePixelRatio` 為 `2`；其他縮放比例會自動停用腳本並交回 Safari 原生處理。

## 快速安裝

**[前往 Greasy Fork 安裝腳本](https://greasyfork.org/zh-TW/scripts/588900-x-twitter-safari-時間線位置修復)**

## 功能

- 從推文詳情返回時間線時，恢復到原本點擊的推文與畫面位置。
- 從通知、搜尋、個人頁面等其他頁面返回首頁時，恢復首頁時間線位置。
- 以推文 ID 與畫面座標作為錨點，不只依賴容易變動的 `scrollY`。
- 返回後短暫逐幀監控位置，攔截 X 虛擬時間線造成的延遲位移。
- 找不到錨點時只嘗試一次原始位置，不進行上下搜尋，避免畫面反覆跳動。
- 開啟及關閉圖片時完全不介入，沿用 X 與 Safari 的原生行為。
- 使用 `sessionStorage` 保存狀態；不會傳送資料或發出網路請求。
- 使用 Tampermonkey `@sandbox DOM`，避免受到 X Content Security Policy 阻擋。

## 系統需求

- macOS
- Safari
- Tampermonkey for Safari
- X 頁面縮放設為 **100%**
- Retina 顯示環境，100% 時 `devicePixelRatio === 2`

## 安裝

1. 在 Safari 安裝並啟用 [Tampermonkey](https://www.tampermonkey.net/)。
2. 前往 [Greasy Fork 腳本頁面](https://greasyfork.org/zh-TW/scripts/588900-x-twitter-safari-時間線位置修復)。
3. 選擇安裝腳本，並在 Tampermonkey 確認安裝。
4. 將 Safari 的 X 頁面縮放設定為 **100%**。
5. 重新載入 `https://x.com/home`。

也可以建立新的 Tampermonkey 使用者腳本，手動貼入 [`twitter-x-safari-scroll-fix.user.js`](twitter-x-safari-scroll-fix.user.js) 的完整內容。

## 使用方式

安裝後不需要額外設定：

1. 在 X 首頁向下瀏覽時間線。
2. 開啟一則推文。
3. 使用 Safari 返回按鈕回到時間線。
4. 腳本會以原本點擊的推文作為錨點，維持返回前的位置。

開啟推文圖片時，腳本會暫時停用位置還原，避免干擾原本已正常的圖片返回流程。

## 縮放行為

此版本刻意不處理非 100% 縮放：

| Safari 頁面縮放 | 腳本狀態 |
|---|---|
| 100%（DPR 2） | 啟用 |
| 其他縮放比例 | 停用，使用 Safari 原生行為 |

可使用 Safari Web Inspector Console 確認狀態：

```js
document.documentElement.dataset.xSafariScrollFixVersion
document.documentElement.dataset.xSafariScrollFixState
devicePixelRatio
```

在支援的環境中應分別看到類似：

```text
"2.0.0"
"idle" 或 "restored"
2
```

非 100% 環境會顯示：

```text
"unsupported-zoom"
```

## 實作方式

腳本會在離開時間線前保存：

- 目前路由
- `scrollY`
- 錨點推文 ID
- 錨點推文相對於視窗頂端的位置
- 保存時間

返回時優先尋找相同推文，並以整數 CSS pixel 校正位置。若 X 尚未掛載該推文，腳本只會使用保存的 `scrollY` 喚醒虛擬列表一次，之後繼續等待錨點出現。

使用者主動捲動、觸控或按下捲動按鍵時，任何進行中的自動還原都會立即取消。

## 檔案

- [`twitter-x-safari-scroll-fix.user.js`](twitter-x-safari-scroll-fix.user.js) — Tampermonkey 使用者腳本
- [`README.md`](README.md) — 繁體中文說明
- [`README.en.md`](README.en.md) — English documentation

## 授權

本專案採用 [MIT License](LICENSE)。
