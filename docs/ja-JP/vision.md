# プロダクトビジョン

[English](../en-US/vision.md) | [繁體中文](../zh-TW/vision.md) | 日本語 | [ドキュメント](README.md)

## ビジョン

Navide は Agent 時代の主要なエンジニアリング環境になります。一人のエンジニアが、ソフトウェアライフサイクル全体を通じて AI エンジニアリングチームを指揮、同期、検証できるシステムです。

## ミッション

人間の意図、判断、Ownership、最終責任を保ちながら、一人のエンジニアにソフトウェアチーム全体の実行能力を与えます。

## カテゴリー

Navide は AI-native なソフトウェアエンジニアリング環境、すなわち Agent 時代のエンジニアリングツールです。

このカテゴリーは、AI Editor、Terminal Multiplexer、Chat Session の集合よりも広いものです。Navide は、成果、Agent、Session、協調、非公開の Project Intelligence、人間が判断すべき例外、受け入れ根拠を中心にエンジニアリング作業を組織します。File、Editing、Terminal、Git は、その環境の中で引き続き第一級の道具です。

## 対象ユーザー

Navide はまず、プロダクトと複数の AI Agent の両方を管理する Solo Engineer のために作られています。Independent Developer、Technical Founder、プロダクト領域を End-to-end で担う Engineer が含まれます。

あらゆる知的労働のための汎用 OS を目指すものではありません。対象領域はソフトウェアエンジニアリングです。

## プロダクト仮説

従来の IDE は File と直接的な Code Entry を中心に作業を組織します。AI-native なエンジニアリング環境は、次の要素を中心に作業を組織しなければなりません。

- Goal と Acceptance Criteria
- Agent、Role、Capability、Session
- Task、Dependency、Ownership、Progress
- 共有 Context、Decision、Handoff
- Change、Test、Review、Evidence
- Human Exception と Final Acceptance
- 個々の Session を越えて残る非公開の Project Intelligence

Editor は第一級のエンジニアリングツールであり続けますが、開発の唯一の中心ではなく、より大きなシステム内での Intervention Mode の一つになります。

AI は実行能力を高め、協調が新しいボトルネックになります。Navide は、並行する Agent の作業に Ownership と Context を与え、可視化し、中断、復旧、検証できるようにするために存在します。

## 三つのエンジニアリングループ

### Genesis

アイデアをプロダクトの最初に動く形へ変えます。設定可能な Pipeline が、要件、計画、設計、実装、Review、Test を進みます。成果は検証済みの Prototype と持続可能な Project Context であり、開発の終点ではありません。

### Evolution

既存プロジェクトを継続的に開発します。エンジニアが Feature、Fix、Experiment、Quality Goal を設定し、Navide が一つ以上の Session を Implementation、Testing、Correction、Verification まで協調させます。これが日々のプロダクトの中心です。

### Intervention

判断や精度が必要なとき、エンジニアが成果を確認し直接変更できるようにします。Diff、Editor、Terminal、Diagnostics、Git、Test、Review は失敗時の代替ではなく、人間が制御するための意図的な道具です。

## 運用哲学

Navide は Management by Exception を採用します。

### エンジニアが担うもの

- Product Intent と Priority
- 重要な Constraint と Quality Standard
- 長期的な影響を持つ Architecture または Product Choice
- Credential、Payment、Publication、Deployment、Destructive Action
- 提供された成果の Final Acceptance

### 承認された境界内で Agent が担うもの

- Research と Local Codebase Exploration
- Planning と Task Decomposition
- 可逆的な Workspace Edit
- Routine Command、Test、Diagnostic、Repair
- Progress Update、Structured Handoff、Evidence Collection
- Acceptance Criteria を満たすか Exception に到達するまでの Iteration

### Navide が担うもの

- Agent と Session の Lifecycle
- Task Routing と Parallel Coordination
- Context Synchronization と非公開 Project Memory
- Conflict、Risk、Idle、Failure の Detection
- Visibility、Interruption、Recovery、Auditability
- 適切な Exception を適切な時点でエンジニアへ返すこと

## Project Intelligence Layer

`.agent-team/` は Workspace ごとの Local・Per-user Intelligence Layer です。将来の Model には Project State、Session、Run、Task、Decision、Handoff、Evidence、Coordination Metadata が含まれる可能性があります。

この Layer は次の性質を持ちます。

- 各ユーザーに非公開
- デフォルトでローカル保存
- Git から除外
- Source File およびチーム共有 Project Documentation から分離
- 明示的で制御された Export/Import Flow でのみ Portability を提供
- Retention、Redaction、Deletion Control の対象

暗黙の Cloud Account、隠れた Team Synchronization Mechanism、Agent Context に Credential を置く口実にしてはなりません。

## North-star Experience

エンジニアは次のことができるべきです。

1. Project を開き、非公開の Engineering Context を直ちに復元する。
2. すべての実装手順を手作業で準備する代わりに、次の Outcome を説明する。
3. Navide が適切な Agent と Session を提案または起動するのを確認する。
4. 独立した作業を、見えない重複や Context Loss なしに並行して進める。
5. 意味のある Exception のときだけ注意を向ける。
6. Reasoning Trail、Change、Test、Risk、未解決 Decision を確認する。
7. いつでも Editor、Terminal、Diff、直接指示を通じて介入する。
8. Evidence に裏付けられた成果を受け入れ、次の Evolution Loop へ進む。

## 置き換えることの意味

従来の IDE を置き換えることは、その Interface Feature を一つずつ複製することではありません。別の IDE を主要環境とせずに、ソフトウェアの理解、作成、Navigation、Editing、Execution、Debugging、Testing、Review、Versioning、Delivery という完全な専門 Workflow を完了できることです。

Navide は最終的に完全なエンジニアリング能力を提供しなければなりません。ただし各能力は、Code Entry 時代から無批判に継承するのではなく、Agent Coordination と Human Judgment を中心に再解釈すべきです。

## 成功

Navide が成功した状態は次のとおりです。

- ユーザーが日常の主要エンジニアリング環境として選ぶ。
- Solo Engineer が制御や Context を失わず、複数の生産的な Agent Session を維持できる。
- Quality、Security、Causality を不透明にせず、Project Evolution が速くなる。
- 非公開の Project Intelligence Layer により、新しい各 Session が孤立した会話より効果的になる。
- エンジニアが反復的な実行より、Direction、Architecture、Judgment、Acceptance に注意を使う。
- 完全なプロダクトが、従来の IDE Workflow に戻ることなく Idea から Continuous Delivery へ進める。

## 根拠に対する規律

Navide の野心は現在の実装より大きく保つ必要がありますが、両者を混同してはなりません。

- README の Capability List と User Guide は現在利用できる挙動を説明します。
- Roadmap は方向性と Exit Criteria を説明し、提供を約束しません。
- 創設者が Navide で Navide を開発することは有効な Dogfooding Evidence ですが、Customer Validation ではありません。
- Replacement、Autonomy、Productivity、Safety、Adoption、Performance の主張には、それぞれに適した Product Evidence または Independent Evidence が必要です。
- 既知の Security、Privacy、Distribution、Platform Boundary は公開 Communication で見える状態を保ちます。

Canonical な Communication Hierarchy と Claim Boundary については、[プロダクトポジショニングと公開表現](product-positioning.md)を参照してください。
