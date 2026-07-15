# Navide 文件中心

[繁體中文](README.md) | [English](../README.md)

Navide 是 Agent 時代的工程利器：一套讓一個人透過建立、持續演進與精準介入，指揮多個 Coding Agent 的 AI-native 軟體工程環境。

## 從這裡開始

| 對象 | 文件 | 用途 |
|---|---|---|
| 所有人 | [Navide 宣言](manifesto.md) | 理解 Navide 回應的時代變化，以及引導產品發展的信念 |
| 所有人 | [產品願景](vision.md) | 理解目標使用者、運作哲學、產品模型與成功定義 |
| 維護者 | [產品定位與公開主張](product-positioning.md) | 維持產品類別、訊息層次、用詞、證據與公開主張一致 |
| 新使用者 | [開始使用](getting-started.md) | 從原始碼安裝 Navide、完成前置需求與首次啟動 |
| 使用者 | [使用指南](user-guide.md) | 學習 Workspace、Pane、Pipeline、Manager 協調、Git、History 與 Editor 工作流 |
| 使用者 | [疑難排解](troubleshooting.md) | 解決啟動、權限、Agent Session、Analyzer 與 Token Tracking 問題 |
| 所有人 | [隱私與資料流](privacy.md) | 理解哪些資料留在本機、哪些功能可能連線第三方，以及憑證儲存位置 |
| 維護者 | [產品 Roadmap](roadmap.md) | 理解走向完整 AI-native 工程環境的方向性路徑 |

## 尚未中文化的技術文件

下列文件目前以英文版為準：

- [Contributing](../../CONTRIBUTING.md)
- [Architecture](../architecture.md)
- [CLI Extension Guide](../cli-extension-guide.md)
- [Release Guide](../releases.md)
- [Keyboard Shortcuts](../keybindings.md)
- [Editor Design](../editor-design.md)
- [Historical Milestone Record](../spec.md)
- [Security Policy](../../SECURITY.md)
- [Changelog](../../CHANGELOG.md)

## 翻譯原則

- 英文文件是規格與事實的原始基準；功能改變時應先更新英文版，再同步繁體中文版。
- `Navide` 是公開產品名稱；`agent-team` 僅保留在內部套件、目錄或相容性識別名稱中。
- `Agent`、`Session`、`Workspace`、`Pane`、`Pipeline`、`Stage`、`Run` 等介面或架構詞彙保留英文，以便與產品畫面及除錯資訊對照。
- Local-first 表示 Navide 的調度程序與 Workspace 狀態在使用者裝置上執行，不表示所有選用服務都離線。
- `.agent-team/` 中的 Private Project Intelligence 屬於個別使用者、預設保留在本機並排除於 Git；它不是人類團隊的同步層。
- README 與使用指南只描述現有行為；Vision 與 Roadmap 可以描述未來方向，但必須清楚標示。
- Roadmap 描述方向，不是交付承諾；已發布功能以 Changelog 與 GitHub Releases 為準。
