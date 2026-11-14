Feature: The agent runs a mid-size task as one inline_task call on a small model (GH-734)

  # Only structure is asserted: card, statuses, steps, files, settings. Never the reply wording.
  # inline_task is a deferred MCP tool: each prompt loads it with ToolSearch first.

  Background:
    Given the viewport is 1440x900
    And the app is open
    And I open the scratch project
    And the scratch project has the inline task fixtures
    And I set inline tasks to on with at most 10 turns in Settings

  Scenario: The agent runs an inline task and gets its result
    Given I start a new Haiku session
    When I send "Load the tool with ToolSearch (query select:mcp__claude-ui__inline_task). Then call inline_task once with the prompt: Use Grep to find the files under src that contain zebraQuota42 and list their paths. Leave tools at the default. Do nothing else."
    And I allow permission requests until the turn has finished
    Then the inline task card is finished
    And the inline task card shows its result
    And I see a reply from Claude
    And I capture "inline task done"

  Scenario: Inline task runs shell and file tools
    Given I start a new Haiku session
    When I send "Load the tool with ToolSearch (query select:mcp__claude-ui__inline_task). Then call inline_task once with tools Bash, Read and Write and the prompt: Run echo gh734 in the shell, then write the output to a new file named inline-out.txt in the project folder. Do nothing else."
    And I allow permission requests until the turn has finished
    Then the inline task card is finished
    And the inline task steps show a "Bash" step
    And the inline task steps show a "Write" step
    And the inline task card lists the changed file "inline-out.txt"
    And the file "inline-out.txt" exists in the project
    And I capture "inline task files"

  @playwright-mcp
  Scenario: Inline task drives Playwright through MCP
    Given the scratch project has the Playwright MCP server
    And I start a new Haiku session
    When I send "Load the tool with ToolSearch (query select:mcp__claude-ui__inline_task). Then call inline_task once with mcp [playwright] and maxTurns 8 and the prompt: Open the local file page.html of the project folder as a file:// URL in the browser, then take a screenshot and tell me the heading text and the screenshot file path. Do nothing else."
    And I allow permission requests until the turn has finished
    Then the inline task card is finished
    And the inline task steps show a "browser" step
    And the inline task card shows its result
    And I capture "inline task playwright"

  Scenario: A permission prompt of an inline task shows in the parent and Deny and Allow are honoured
    Given I start a new Haiku session
    When I send "Load the tool with ToolSearch (query select:mcp__claude-ui__inline_task). Then call inline_task once with tools Bash and the prompt: Run exactly this command and nothing else: echo gh734 > inline-probe.txt. If the inline task fails, do not run the command yourself and do not retry."
    Then I see a permission request
    And the permission request shows "inline-probe.txt"
    And I capture "inline permission"
    When I deny the permission request
    Then the permission request is gone
    And the inline task step "inline-probe.txt" is denied
    When I deny permission requests until the turn has finished
    And the file "inline-probe.txt" does not exist in the project
    And I capture "inline denied"
    When I send "Call inline_task once more with tools Bash and the prompt: Run exactly this command and nothing else: echo gh734 > inline-probe.txt"
    Then I see a permission request
    When I allow the permission request
    Then the permission request is gone
    And the turn has finished
    And the file "inline-probe.txt" exists in the project
    And I capture "inline allowed"

  Scenario: The inline task card is collapsed, expands to its steps and shows model and tokens
    Given I start a new Haiku session
    When I send "Load the tool with ToolSearch (query select:mcp__claude-ui__inline_task). Then call inline_task once with the prompt: Use Grep to find the files under src that contain zebraQuota42, then Read src/quota.ts. Do nothing else."
    And I allow permission requests until the turn has finished
    Then the inline task card is finished
    And the inline task card shows collapsed
    And the inline task card shows a model and a token count in its header
    And I capture "card collapsed 1440"
    When I open the inline task card
    Then the inline task card shows its result
    And the inline task steps are collapsed
    When I open the inline task steps
    Then the inline task steps show the explored group of read and search steps
    And I capture "card expanded 1440"
    When I resize the viewport to 390x844
    Then the inline task meta is its own row under the header
    And the page scrollWidth equals the viewport width
    And I capture "card expanded 390"

  Scenario: Stop ends a long inline task and keeps the partial result
    Given I start a new Haiku session
    When I send "Load the tool with ToolSearch (query select:mcp__claude-ui__inline_task). Then call inline_task once with tools Bash and the prompt: Run this command in the foreground (no run_in_background) and nothing else: for i in $(seq 1 60); do sleep 1; done; echo finished"
    And I allow the permission request
    Then the inline task card is running
    And the inline task card has a Stop button
    And I capture "long task running 1440"
    When I resize the viewport to 390x844
    Then the inline task card has a Stop button
    And the page scrollWidth equals the viewport width
    And I capture "long task running 390"
    When I resize the viewport to 1440x900
    And I stop the inline task
    Then the inline task card is stopped
    And the inline task card says the result is partial
    And the turn has finished
    And I capture "long task stopped 1440"
    When I resize the viewport to 390x844
    Then the page scrollWidth equals the viewport width
    And I capture "long task stopped 390"

  Scenario: With the setting off the session has no inline_task tool
    Given I set inline tasks to off with at most 10 turns in Settings
    And I start a new Haiku session
    When I send "Use ToolSearch with query select:mcp__claude-ui__inline_task. If a tool named inline_task is loaded, call it with the prompt: say hi. If it is not available, reply with exactly: NONE"
    Then the turn has finished
    And no inline task card is shown
    And I capture "setting off"
    When I set inline tasks to on with at most 10 turns in Settings

  Scenario: A turn limit of 1 ends the inline task early with a partial result
    Given I set inline tasks to on with at most 1 turns in Settings
    And I start a new Haiku session
    When I send "Load the tool with ToolSearch (query select:mcp__claude-ui__inline_task). Then call inline_task once with the prompt: Use Grep to find the files under src that contain zebraQuota42, then Read each of them one call at a time. Do not pass maxTurns."
    And I allow permission requests until the turn has finished
    Then the inline task card is finished
    And the inline task card says the result is partial
    And I capture "turn limit"
    When I set inline tasks to on with at most 10 turns in Settings

  # Cost per plan 5.13: warm-up turn (loads the deferred inline_task tool, so neither run pays the ToolSearch call), then the same task as inline_task and as the Agent tool (general-purpose, haiku) in one session.
  # Total = tokens of every parent call after the warm-up (input + cache write + cache read + output) + the inline result's tokens, or the subagent's transcript tokens (they are not in the parent's usage).
  # Read from the Claude Code transcripts of the scratch project. Writes <evidence>/inline-cost.json.
  @cost
  Scenario: Cost of Code location inline versus subagent
    Given I start a new Haiku session
    When I send "Load the tool with ToolSearch (query select:mcp__claude-ui__inline_task), then reply with exactly: OK"
    And the turn has finished
    And I note the session token totals
    And I send "Call inline_task once with the prompt: Find every file under src that uses the symbol zebraQuota42 and list the paths, one per line. Then answer with the list only."
    And I allow permission requests until the turn has finished
    And I record the inline cost of "Code location"
    And I note the session token totals
    And I send "Call the Agent tool once with subagent_type general-purpose, model haiku and the prompt: Find every file under src that uses the symbol zebraQuota42 and list the paths, one per line. Then answer with the list only."
    And I allow permission requests until the turn has finished
    And I record the subagent cost of "Code location"
    Then the inline cost of "Code location" is lower than the subagent cost
    And the parent context grew less with the inline task than with the subagent for "Code location"
    And I capture "cost code location"

  @cost
  Scenario: Cost of Log extraction inline versus subagent
    Given I start a new Haiku session
    When I send "Load the tool with ToolSearch (query select:mcp__claude-ui__inline_task), then reply with exactly: OK"
    And the turn has finished
    And I note the session token totals
    And I send "Call inline_task once with the prompt: In build.log find the single ERROR line and report its exact timestamp and message. Then answer with that only."
    And I allow permission requests until the turn has finished
    And I record the inline cost of "Log extraction"
    And I note the session token totals
    And I send "Call the Agent tool once with subagent_type general-purpose, model haiku and the prompt: In build.log find the single ERROR line and report its exact timestamp and message. Then answer with that only."
    And I allow permission requests until the turn has finished
    And I record the subagent cost of "Log extraction"
    Then the inline cost of "Log extraction" is lower than the subagent cost
    And the parent context grew less with the inline task than with the subagent for "Log extraction"
    And I capture "cost log extraction"

  @cost
  Scenario: Cost of Test run inline versus subagent
    Given I start a new Haiku session
    When I send "Load the tool with ToolSearch (query select:mcp__claude-ui__inline_task), then reply with exactly: OK"
    And the turn has finished
    And I note the session token totals
    And I send "Call inline_task once with tools Bash and the prompt: Run node --test tests/sample.test.mjs in the project folder and report the names of the failing tests. Then answer with the names only."
    And I allow permission requests until the turn has finished
    And I record the inline cost of "Test run"
    And I note the session token totals
    And I send "Call the Agent tool once with subagent_type general-purpose, model haiku and the prompt: Run node --test tests/sample.test.mjs in the project folder and report the names of the failing tests. Then answer with the names only."
    And I allow permission requests until the turn has finished
    And I record the subagent cost of "Test run"
    Then the inline cost of "Test run" is lower than the subagent cost
    And the parent context grew less with the inline task than with the subagent for "Test run"
    And I capture "cost test run"

  # Needs a real OpenCode binary (E2E_OPENCODE_BIN) and the owner's login (E2E_OPENCODE_AUTH): not run without it.
  @model
  Scenario: OpenCode: the agent runs an inline task with Grep
    Given OpenCode has the owner's login
    And OpenCode is set up in a scratch project
    And I choose the engine "OpenCode"
    And I pick the OpenCode model "DeepSeek V4.1 Flash 1017" in the model chooser
    And the OpenCode server of the daemon is running
    When I send "Call the claude-ui inline_task tool once with the prompt: Use Grep to find the files under src that contain zebraQuota42 and list their paths. Do nothing else."
    And I allow permission requests until the turn has finished
    Then the inline task card is finished
    And the inline task card shows its result
    And I capture "opencode inline task"
