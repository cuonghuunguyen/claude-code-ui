Feature: The session agent lists, reads and runs commands in the project's open terminals (GH-709)

  # Only structure is asserted: cards, statuses, what the terminal shows. Never the reply wording.
  # The tools are deferred MCP tools: each prompt loads them with ToolSearch first.

  Background:
    Given the viewport is 1440x900
    And the app is open
    And I open the scratch project
    And I set terminal access to on in Settings

  Scenario: Allow types the command into the terminal and the card shows its output
    Given I start a new Haiku session
    When I toggle the terminal from the titlebar
    Then a terminal shows in the bottom panel
    When I send "Load the terminal tools with ToolSearch (query select:mcp__claude-ui__terminal_list,mcp__claude-ui__terminal_run). Call terminal_list, then call terminal_run with terminal Terminal 1 and the command echo gh709-$((6*7)). Do nothing else."
    Then I see a permission request whose title contains "Run in Terminal 1"
    And I capture "run card 1440"
    When I allow the permission request
    Then the permission request is gone
    And the terminal shows "gh709-42" on a line of its own
    And the "terminal_run" tool card is finished with the output
    And the "terminal_run" tool card output shows "gh709-42"
    And the turn has finished
    And I capture "run allowed 1440"
    When I resize the viewport to 390x844
    Then the page has no horizontal scroll
    And I capture "run allowed 390"

  Scenario: Deny types nothing and the turn goes on
    Given I start a new Haiku session
    When I toggle the terminal from the titlebar
    Then a terminal shows in the bottom panel
    When I send "Load the terminal tools with ToolSearch (query select:mcp__claude-ui__terminal_run). Then call terminal_run with terminal Terminal 1 and the command echo gh709-$((6*7)). Do nothing else."
    Then I see a permission request whose title contains "Run in Terminal 1"
    When I deny the permission request
    Then the permission request is gone
    And the "terminal_run" tool call is denied in the terminal
    And the turn has finished
    And the terminal has nothing typed from "gh709"
    And I capture "run denied"

  Scenario: Reading a terminal hides secrets
    Given I start a new Haiku session
    When I toggle the terminal from the titlebar
    Then a terminal shows in the bottom panel
    When I type "export DEMO_TOKEN=abcd1234efgh5678" in the terminal
    And I type "echo $DEMO_TOKEN" in the terminal
    And I send "Load the terminal tools with ToolSearch (query select:mcp__claude-ui__terminal_read). Then call terminal_read with terminal Terminal 1. Do nothing else."
    Then the "terminal_read" tool card is finished with the output
    And the "terminal_read" tool card output shows "[redacted]"
    And the "terminal_read" tool card output does not show "abcd1234efgh5678"
    And the turn has finished
    And I capture "read redacted"

  Scenario: A terminal of another project is not listed
    When I open a session in a second project folder with a finished reply
    And I toggle the terminal from the titlebar
    Then a terminal shows in the bottom panel
    When I open the scratch project
    And I start a new Haiku session in the new session tab
    And I send "Load the terminal tools with ToolSearch (query select:mcp__claude-ui__terminal_list). Then call terminal_list with no arguments. Do nothing else." in the new session tab
    Then the "terminal_list" tool card says no terminal is open in this project
    And the new session has finished its turn
    And I capture "other project not listed"

  Scenario: With the setting off the session has no terminal tools
    Given I start a new Haiku session
    When I set terminal access to off in Settings
    And I toggle the terminal from the titlebar
    Then a terminal shows in the bottom panel
    When I send "Use the terminal_list tool if you have one (try ToolSearch with query select:mcp__claude-ui__terminal_list). If you do not have it, reply with exactly: NONE"
    Then the turn has finished
    And no terminal tool card is shown
    And I capture "setting off"
    When I set terminal access to on in Settings

  # Needs a real OpenCode binary (E2E_OPENCODE_BIN) and the owner's login (E2E_OPENCODE_AUTH): skipped without it.
  @model
  Scenario: OpenCode: the run asks, Allow types the command into the terminal
    Given OpenCode has the owner's login
    And OpenCode is set up in a scratch project
    And I choose the engine "OpenCode"
    And I pick the OpenCode model "DeepSeek V4.1 Flash 1017" in the model chooser
    And the OpenCode server of the daemon is running
    When I toggle the terminal from the titlebar
    Then a terminal shows in the bottom panel
    When I send "Call the claude-ui terminal_run tool with terminal Terminal 1 and the command echo gh709-$((6*7)). Do nothing else."
    Then I see a permission request whose title contains "Run in Terminal 1"
    When I allow the permission request
    Then the terminal shows "gh709-42" on a line of its own
    And the turn has finished
    And I capture "opencode run allowed"
