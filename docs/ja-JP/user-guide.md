# ユーザーガイド

[English](../en-US/user-guide.md) | [繁體中文](../zh-TW/user-guide.md) | 日本語 | [ドキュメント](README.md)

## プロダクトモデル

Navide は、一人のエンジニアが複数の AI Agent を指揮するために設計されています。主な操作は常に File Editing とは限りません。Outcome の設定、Session の協調、Progress の観察、意味ある Exception の処理、検証済み Result の受け入れです。

日々の作業は三つの Loop を通じて進みます。

1. **Genesis** は Pipeline を使い、Idea を最初に動く Prototype へ変えます。
2. **Evolution** は一つ以上の Agent Session を通じて既存 Project を反復的に開発、Test、Fix、Refine します。
3. **Intervention** は Diff、Editor、Terminal、Diagnostics、Git、Review Tool を通じて、エンジニアが Result を確認または直接変更できるようにします。

現在の Pipeline は Genesis Loop を実装しています。Manual Pane と Maintenance Mode は初期 Evolution Workflow を提供し、Editor と Review Surface は Intervention を提供します。

## Runtime の考え方

Navide には三つの Work Level があります。

1. **Workspace** は Project Folder であり、Project State、Run History、Git Operation の境界です。
2. **Pane** は Agent CLI または Plain Shell を実行する Live Terminal Session です。
3. **Pipeline** は設定可能な Stage の順序付き集合です。各 Stage は一つ以上の Parallel Slot を持ち、各 Slot が Agent と Role を選びます。

## Workspace

Welcome Screen は Recent Workspace を一覧表示し、Pinning をサポートし、存在しない Folder を示します。Workspace を開くと UI State と対象 Session が復元されます。Workspace を切り替える、または閉じる前に、中断してはならない Active Work を完了または Abort してください。

Navide は Workspace 内の `.agent-team/` に、ユーザーごとに非公開の Project Intelligence を保存します。この Directory は Git から除外され、共有 Team State として扱ってはなりません。個々のエンジニアの Local Workflow に属する Task Context、Session Metadata、Run History、Handoff、Token Information が含まれる場合があります。

Source Code と明示的に共有された Documentation は、Repository における Team-visible Truth であり続けます。`.agent-team/` の情報を共有する必要がある場合は、Specification、Architecture Decision、Test Report、Issue、Commit、Pull Request など、意図的な Artifact に変換してください。

## Manual Agent Pane

完全な Genesis Pipeline が不要な Exploration、Maintenance、Evolution Task では Manual Spawn を使います。

- Agent と Role を選択します。
- Spawn 前に Launch Command を確認します。
- Agent が不要な場合は Plain Terminal Pane を使います。
- Main Layout を占有せず PTY を維持するには Pane を Minimize します。
- Navide が再利用可能な Session ID を検出した後にのみ Rebuild または Resume します。

A new empty Codex pane waits for your input without sending an artificial session-discovery message. Its session ID may become available only after the first real user or configured task turn; until then, Rebuild remains unavailable. The same applies to a fresh rebuild or restore. If Codex asks to review the Navide session hook, review it in Codex; YOLO mode does not approve hooks. Existing shared session homes may need that trusted hook to associate the new conversation with its pane.

Select multiple pane headers with Cmd/Ctrl-click or Shift-click, then right-click a selected pane to open the batch menu. Its groups contain Interrupt/Rebuild, Minimize/Restore/Reclaim, notification controls, and Remove. **Restore selected** also opens selected panes that have not yet been opened or were reclaimed. Pane and project overflow menus stay within the window; long menus scroll so their final actions remain reachable.

**Reclaim selected (N)** shows how many selected panes are eligible, releases their CLI processes, and keeps click-to-resume placeholders. It skips protected panes, including running panes, the focused pane, panes awaiting an answer or holding unsent text, and panes without a resumable session. The action stays visible but is disabled when none of the selected panes can be reclaimed. **Mute selected notifications** mutes the entire selection, including a mix of muted and unmuted panes; when every selected pane is muted, **Unmute selected notifications** restores notifications for all of them. These batch actions affect only the selected panes.

組み込みで対応する Agent Key は 14 種類のコーディング CLI（Aider、Antigravity CLI、Claude Code、Codex、Copilot CLI、Cursor CLI、Droid、Grok CLI、Kilo Code、Kimi Code、Muse Code、OpenCode、Pi、Qwen Code）です。正確な CLI Behavior と Provider Billing は各 External Tool が引き続き管理します。

### CLI risk observations

An active agent pane can show one yellow or red risk pill. Open its popover to inspect the backend's evidence and observation times; multiple findings share that popover. Disk findings apply to the vendor's active panes, while network findings belong to the observed pane's process tree, including its CLI, MCP servers and tools. Reclaimed placeholders show no risk pill.

- **Yellow network:** a sampled numeric IP and port fall outside a complete, current expected-address snapshot. The count is from the last sample, and “observed since” describes sampled observations, not connection duration. Legitimate tools, proxies and different DNS answers can produce a mismatch.
- **Yellow disk:** after a successful baseline, a file first observed following prior absence qualifies within 24 hours if it exceeds 100 MiB and bounded content inspection does not recognize its format. Files already in the baseline are excluded; timestamps and familiar extensions alone do not establish that a file is new or recognized.
- **Red disk:** a previously flagged path was successfully observed present, then absent, then present again with opaque content in the same 100 MiB size class. This does not identify who removed or recreated it, or establish that its contents are the same.

**Ignore** persists for the displayed vendor/IP across all ports, or vendor/canonical file path, including later severity changes. **Allow this IP** adds only the displayed exact IP for that vendor across all ports; it does not allow an inferred hostname or certify the destination. Both decisions apply across that vendor's panes and survive restart. Disk **Reveal in folder** opens the existing native folder action so you can inspect the file.

Observations use existing resource requests: normally every 30 seconds, or every 2 seconds while the resource panel is open. Disk attempts, including failed attempts, are throttled to once per five minutes per active vendor. Work finishes in the backend and appears in a later response; opening Storage is unnecessary. Descendant discovery and polling can delay network evidence, and short-lived connections or file replacement between samples can be missed.

Default network declarations currently cover Claude Code and Codex; other vendors have no expected-address comparison. Captured proxy or provider-endpoint overrides disable that comparison. Network observation covers established TCP on macOS and Linux; Windows network observation and UDP/QUIC are unsupported. Disk roots are declared per vendor, with Aider unsupported; symlinks beneath a resolved data root are skipped. Roots use the captured pane home and declared environment overrides; later changes inside CLI settings, command arguments or shell startup scripts can fall outside that snapshot. Failed or incomplete collection, unavailable declarations and expired DNS must not be read as a clean result. Historical findings can remain visible as stale evidence. **No pill is not an assurance of safety.**

These observations help you inspect local activity; they do not prove exfiltration or unlawful intent. Navide does not automatically block a connection, pause a CLI or delete a file. See [Privacy and Data Flows](privacy.md#cli-risk-observation-data) for local reads, retained metadata and DNS requests.

## Pipeline

付属 Pipeline は Requirement、Planning、Design、Implementation、Security Review、Testing を網羅します。Stage、Slot、Role、Kickoff Prompt、Question、Completion Sentinel は Settings で設定できます。

一つの Stage で複数 Slot を並行実行できます。Navide は設定された Completion Signal と Agent State に基づいて進行します。Generated Change と Test Result は必ず確認してください。Automatic Completion は Workflow Progress を示すもので、Correctness を保証しません。

## Manager と Worker の協調

一つの Slot を Global Manager として動かせます。Manager は Stage 間 Context を受け取り、Worker に作業を Delegation し、Worker Question を処理し、Navide の Routing Protocol を通じて Stage Completion を Signal します。

Task が Decomposition または Parallel Ownership の恩恵を受ける場合に Manager を使います。小さな Task では、Single-agent Stage の方が通常は低コストで確認しやすくなります。

## Automation Mode

- **YOLO** は対応 CLI で Approval または Trust Prompt を回避する CLI-specific Flag を渡します。一部 CLI は Confirmation Gate なしですでに Tool を実行する場合があります。
- **Full Auto** は利用可能な Task Context を使い、Analyzer が Agent Question に回答できるようにします。
- **Strict** は選択された Timeout または Progression Boundary で確認を求めます。
- **Continuous** は設定された Automation Behavior に従って Pipeline を進行させます。
- **Local Analyzer** は Local Intent Classification と関連 Automation を有効化します。

保守的な設定から始めてください。YOLO と Full Auto は、追加の User Confirmation なしに Agent が File を変更したり Command を実行したりする可能性があります。

## Management by Exception

Navide の長期的な運用哲学は、可逆的で観察可能な作業を Agent に継続させ、人間の判断に価値があるときだけエンジニアへ注意を戻すことです。現在の Automation Mode は初期 Control であり、完全な Policy Engine ではありません。

次の場合に介入してください。

- Requirement に大きく異なる複数の有効な解釈がある
- Architecture または Product Choice が長期的な影響を持つ
- Session が Ownership、File、Technical Direction をめぐって Conflict している
- Test と明示された Acceptance Criteria が一致しない
- Credential、Payment、Deployment、Publication、Destructive Operation、External System が関係する
- Result に Subjective Product Judgment または Quality Judgment が必要

Routine Exploration、Reversible Edit、Local Test、Diagnostic、Repair は、可視性と中断可能性を保ちながら、最終的には Approval Noise なしで進むべきです。

## History と Token Tracking

History は Pipeline、Stage、Pane、Question、Analyzer、Handoff、Warning Event の Append-only Timeline です。Run History は `.agent-team/runs/` に保存され、Filter または Export できます。

Token Stats は対応 Local CLI Log を Parse し、Usage を Workspace、Pane、Stage、Run に Attribution します。Observability Feature であり、Provider Invoice ではありません。Provider 側の Usage と Billing が正式な情報です。

### Token Monitor

Open **Window → Token Monitor** for a separate window showing local Claude turn history over 14, 30, or 90 days. Reopening the command focuses the existing monitor. The existing **Turn Stats** modal remains available for inspecting one pane. Model filters, per-turn trends, and per-turn averages and medians summarize the selected local records.

Transcript records have **unknown account attribution**: a shared local Claude history cannot establish which signed-in account produced a turn. Other devices, web conversations, and subagent logs are outside this view. Missing history is not zero usage; partial scan coverage and errors are shown. Large histories are bounded, and refresh can reuse a scan for 60 seconds.

Quota history records successful observations for the active Claude account slot through the existing usage polling service. It starts accumulating when those observations are available; it cannot reconstruct earlier quota windows. Disabled polling and an empty history are displayed explicitly. Opening the monitor does not make extra provider requests. Observed tokens and quota percentages do not establish an official token allowance, throttling, effort level, or separate thinking-token usage.

## Git と Review

Marketplace Install が利用可能になるまで、Navide は削除可能な Official Git Factory Package を提供します。Active Package Version は Embedded Left View と Dedicated Git Window の両方を提供します。Extensions で Bundled Git を削除すると再起動後も削除状態が維持され、同じ画面の **Restore** で Factory Copy を復元できます。Verified Marketplace Version が存在する場合はそちらが優先されます。Git View は Repository Discovery、Working Tree Inspection、Staging、Commit、Branch、Remote、Issue、関連 Workflow をサポートし、Multi-repository Workspace では検出された Repository を切り替えられます。Repository Operation は Navide の Host／Backend Boundary 内に留まり、GitHub／GitLab Issue Detection は利用可能な場合に設定済みの `gh` または `glab` CLI を使用します。選択された v2 Package が Load、Mount、または Ready Report に失敗した場合、その Process では Retained Legacy Git Renderer を明示して使用します。Security／Trust／Permission Denial は Fallback を Trigger しません。

特に Automatic または Parallel Run の後は、Commit 前に変更を確認してください。Agent-generated Change が Git Panel に表示されたというだけで、安全になるわけではありません。

## Editor と AI Terminal

Editor は Monaco を使用し、File Editing、Diagnostics、Plan Rendering、Diff、Conflict、AI-assisted Workflow を提供します。右側の AI パネルは実際の Coding Agent CLI Terminal（メインウィンドウと同じ Agent）を組み込み、起動時に Editor の Context を注入します。

これらの Tool は、より広い Engineering Environment における Intervention Surface です。Navide は最終的に、従来の IDE を主要環境として必要としない完全な Professional Workflow を提供することを目指します。

## Navide MCP で Skills を管理する

許可を受けた Agent は **Settings → Skills** と同じライブラリを利用できます。

1. `skills_list` の ID を `skills_inspect` に渡し、指示、ファイル、所有者、出所の記録と現在の `delivery_revision` を確認します。
2. `skills_prepare_install` には `owner/repo`、HTTPS の `github.com/owner/repo` URL、またはローカル skill フォルダの絶対パス（`~` 展開対応）を指定します。GitHub の `ref` と `subdir` は別引数です。`subdir: "."` は repository のルートを選びます。候補が複数なら `selection_required` と `candidates` を返し、インストール用 preview ID は発行しません。パスを選んで再度 prepare してください。Private repository、任意の URL、GitHub tree URL は対象外です。
3. 指示全文、ファイル一覧、スクリプト警告、出所と digest を確認し、preview ID、同じ digest、明示的な targets で `skills_install` を呼びます。共有ルートへの初回書き込みには、別途ユーザーの許可を `consent` で渡します。digest や Agent が設定した boolean は許可の証拠ではありません。同名の管理対象、ユーザー所有、native skill は拒否します。宛先を排他的に作成し、添付ファイルと metadata の後に `SKILL.md` を公開するため、不完全なパッケージが検出されません。ディレクトリ全体の atomic rename ではありません。
4. 配信設定の変更には ID と最新の `delivery_revision` を `skills_set_delivery` に渡します。古い revision は失敗し、別の呼び出し元の判断を上書きしません。このフローは追加専用で、既存インストールの更新や再取得は行いません。

準備した bytes は認証済み呼び出し元に結び付けられ、15 分後または backend 再起動時に失効します。インストール時にローカルの再読込や再ダウンロードは行いません。許可の再試行には有効な preview を再利用でき、再試行用の記録が残っている間だけ、成功後の再送は元の結果を返し、再書き込みしません。有効な準備は最大 8 パッケージで、内容を持たない軽量な完了記録を別に最大 8 件保持します。インストールが成功すると、パッケージ bytes と有効な準備枠を解放します。記録は元の preview の期限で失効し、上限に達するとインストール成功が最も古い記録から破棄します。失効または破棄後の再送は missing/expired を返し、再インストールしません。GitHub archive は圧縮 10 MiB、展開 32 MiB、4,096 entries が上限で、選んだ skill は 64 ファイル、各 256 KiB、合計 512 KiB までです。危険なパス、リンク、特殊ファイル、予約 metadata、不正な manifest は黙って除外せず拒否します。

共有 skill の `targets: null` は全 wired vendor、`targets: []` は Navide の追加配信なしを意味します。Native skill の targets は他の CLI への追加配信を指定し、空配列や `null` はそれを解除します。共有ルートを直接読む CLI は Navide の targets や有効スイッチに関係なく skill を発見できます。これらの設定は隔離境界ではありません。

`materialized_in_current_session: null` と `loaded_in_current_session: null` は現在の session の実配信とロードが未確認であることを示します。互換フィールド `delivered_to_me` も設定情報です。配信変更後は新しい CLI session を開いて確認してください。インストールや設定変更の成功だけでは、実行中の CLI が新しい内容をロードしたとはいえません。

ローカルの出所記録には source、準備時 digest、時刻が含まれ、編集、切り替え、再起動後も inspect で読めます。digest はインストールした snapshot を表し、後のローカル編集を表しません。管理 marker と出所記録は既存の export／Skills sync に含まれず、デバイス間の保持は保証しません。Skills sync が有効なら条件を満たす内容と配信設定は既存フローで同期できますが、サイズ上限を満たすことは同期完了の証拠ではありません。

Skills 画面は backend の変更成功と再接続で更新されます。未保存の内容と元の revision を保持するため、古い保存は引き続き conflict になります。他のツールによる直接のファイル変更は手動更新が必要です。準備とインストールは添付スクリプトや plugin hooks を実行しません。後の利用には CLI 自身のツール権限が適用されます。

## Settings と Portability

Settings は Role、Pipeline、MCP Server、Analyzer Behavior、AI Provider、Appearance、Keyboard Shortcut を扱います。CLI Agents では Install 済みの Coding CLI も管理します。バージョン、Install 方法、重複 Install、その CLI 自身の最後の更新結果を表示し、その CLI 公式の更新コマンドと診断コマンドを Terminal で実行できます。Navide はベンダーのコマンドを提示して実行するだけで、CLI 自体を更新することはありません。Export された Settings は API Key と Token を Redact します。Third-party Server を有効化する前に、MCP Command と Environment Variable を確認してください。

**Accounts** では CLI Account ごとに 1 枚のカードを扱います。CLI 自身のサインインに加えて、カードには **Portable Credential** を保持できます。これは各ベンダーが「どの Machine でも使う」ために公式に用意した値（例：Claude Code の `claude setup-token`）です。一度貼り付けると、その CLI の新しい Pane が環境変数として受け取り、CLI 自身の Login File には触れません。CLI ごとに*使用中*の Credential は 1 つで、カードがどれかを示し、ローカルの Login File が優先されてしまう場合には警告します。削除はこの Device にのみ影響します。

**Sync** セクション（Settings → Sync）は、これらの Credential を他の Device へ運べます。**Credentials** スイッチは既定で無効です。有効にすると Accounts のカードに Credential ごとの Cloud 行が現れ（同期済み、この Device のみ、Cloud にあるがここでは未使用、判断待ち）、別の Machine で貼り付けた Credential をワンクリックでここで使えるようにできます。ここで削除しても Cloud や他の Device からは削除されません。同じセクションは Sync Key の ID を表示し、漏洩が疑われるときに Rotate を提供します。すべての Record が再暗号化され、ペアリング済みの Device は新しい Key を受け取ります。

`.agent-team/` は現在 Portability Mechanism ではありません。将来 Machine 間で移行する場合は Git Synchronization ではなく、Redaction と Retention Control を備えた明示的な Local Export/Import Flow を使用すべきです。
