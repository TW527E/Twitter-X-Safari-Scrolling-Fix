[繁體中文](README.md) | [English](README.en.md)

# X（Twitter）Safari 時間線位置修復

一個專為 Safari 與 Tampermonkey 製作的使用者腳本，用來修復瀏覽 X（Twitter）時間線時，開啟推文後返回卻跳到錯誤位置的問題。

> **v2.3.7 已在 Safari 100%、115%、125% 頁面縮放下測試。** 其他縮放比例返回後仍可能跳動，詳見[縮放行為](#縮放行為)。

## 快速安裝

**[前往 Greasy Fork 安裝腳本](https://greasyfork.org/zh-TW/scripts/588900-x-twitter-safari-時間線位置修復)**

## 功能

- 從推文詳情返回時間線時，恢復到原本點擊的推文與畫面位置。
- 從通知、搜尋、個人頁面等其他頁面返回首頁時，恢復首頁時間線位置。
- 以推文 ID 與畫面座標作為錨點，不只依賴容易變動的 `scrollY`。
- 等待首頁分頁列出現，並排除隱藏或推文詳情頁殘留的同 ID 推文，避免以錯誤的元素校正。
- 返回後短暫逐幀監控位置，攔截 X 虛擬時間線造成的延遲位移。
- 支援非 100% 頁面縮放：校正會對齊 Safari 縮放時的捲動格點，避免來回抖動。
- 找不到錨點時以退避方式重試原始位置；錨點出現過後就不再強制拉回，避免與 X 的重新排版互相拉扯。
- 開啟及關閉圖片時完全不介入，沿用 X 與 Safari 的原生行為。
- 使用 `sessionStorage` 保存狀態；不會傳送資料或發出網路請求。
- 使用 Tampermonkey `@sandbox DOM`，避免受到 X Content Security Policy 阻擋。

## 系統需求

- macOS
- Safari
- Tampermonkey for Safari
- Retina 顯示環境，100% 時 `devicePixelRatio === 2`
- X 頁面縮放建議為 **100%、115% 或 125%**

## 安裝

1. 在 Safari 安裝並啟用 [Tampermonkey](https://www.tampermonkey.net/)。
2. 前往 [Greasy Fork 腳本頁面](https://greasyfork.org/zh-TW/scripts/588900-x-twitter-safari-時間線位置修復)。
3. 選擇安裝腳本，並在 Tampermonkey 確認安裝。
4. 重新載入 `https://x.com/home`。

也可以建立新的 Tampermonkey 使用者腳本，手動貼入 [`twitter-x-safari-scroll-fix.user.js`](twitter-x-safari-scroll-fix.user.js) 的完整內容。

## 使用方式

安裝後不需要額外設定：

1. 在 X 首頁向下瀏覽時間線。
2. 開啟一則推文。
3. 使用 Safari 返回按鈕回到時間線。
4. 腳本會以原本點擊的推文作為錨點，維持返回前的位置。

開啟推文圖片時，腳本會暫時停用位置還原，避免干擾原本已正常的圖片返回流程。

## 縮放行為

腳本以 Retina 顯示器 100% 縮放時 `devicePixelRatio === 2` 為基準換算縮放比例。Safari 在非 100% 縮放時只能把捲動位置停在固定間隔的格點上（125% 約 0.8 px），因此誤差在一格以內即視為已對齊。

| Safari 頁面縮放 | 狀態 |
|---|---|
| 100%、115%、125% | 已測試 |
| 其他縮放比例 | 返回後可能跳動，尚未處理 |

可使用 Safari Web Inspector Console 確認狀態：

```js
document.documentElement.dataset.xSafariScrollFixVersion
document.documentElement.dataset.xSafariScrollFixState
devicePixelRatio
```

應分別看到類似：

```text
"2.3.7"
"idle"、"restoring" 或 "restored"
2（100%）、2.3（115%）、2.5（125%）
```

回報跳動問題時，請在發生後立即於 Console 執行下列指令，並把複製到的內容附在回報中：

```js
copy(sessionStorage.getItem("x-safari-scroll-fix:v4:debug-log"))
```

## 實作方式

腳本會在離開時間線前保存：

- 目前路由
- `scrollY`
- 錨點推文 ID
- 錨點推文相對於視窗頂端的位置
- `devicePixelRatio`
- 保存時間

返回後，腳本會等待時間線就緒（首頁以 For you／Following 分頁列為準），排除隱藏或推文詳情頁殘留的同 ID 推文，再以錨點校正位置。若 X 尚未掛載該推文，會以退避方式重試保存的 `scrollY` 來喚醒虛擬列表；錨點出現後就不再使用 `scrollY`。對齊後會再監看約 2 秒，攔截 X 延遲完成的版面變動。

使用者主動捲動、觸控或按下捲動按鍵時，任何進行中的自動還原都會立即取消；觸控板的返回手勢則不會取消還原。

## 授權

本專案採用 [MIT License](LICENSE)。
