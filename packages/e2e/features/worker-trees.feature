Feature: Workers start workers of their own, within the tree limits

  Background:
    Given the viewport is 1440x900
    And the app is open
    And the scratch project is a git repository with its own worktree
    And I open the scratch project
    And I enable orchestration in Settings
    And I start a new Haiku session

  Scenario: Settings shows the worker tree limits
    When I open Settings › Orchestration
    Then the Orchestration setting "Maximum tree depth" is 2
    And the Orchestration setting "Maximum workers per coordinator" is 4
    And the Orchestration setting "Maximum workers per tree" is 4
    And the Orchestration setting "Maximum workers in total" is 0
    And I capture "tree limits desktop"
    When I set the Orchestration setting "Maximum tree depth" to 9
    Then the Settings error mentions "Maximum tree depth"
    And I capture "tree depth out of range"
    When the viewport is 390x844
    Then the Orchestration setting "Maximum workers per coordinator" is 4
    And the Orchestration setting "Maximum workers in total" is 0
    And the page has no horizontal scroll
    And I capture "tree limits phone"

  Scenario: A worker starts its own worker after the user's card, and the card names the tree
    When I open Settings › Orchestration
    And I set the Orchestration setting "Maximum workers per tree" to 20
    And I close Settings
    And I send "Load the worker_start tool with ToolSearch (query select:mcp__orchestration__worker_start). Then call worker_start exactly once with name parent, project <project>, and as its prompt exactly the text between BEGIN and END. BEGIN Load the worker_start tool with ToolSearch (query select:mcp__orchestration__worker_start), then call worker_start exactly once with name child, project <project>, and prompt: Reply with exactly: OK. Do nothing else. END. Do nothing else." with the scratch project and worktree names filled in
    Then I see a permission request
    When I allow the permission request
    And I open the worker "parent"
    Then I see a permission request whose title contains "started by worker parent"
    And I capture "card names the tree"
    When I allow the permission request
    Then the sidebar lists the worker "parent › child"
    And I capture "child runs"

  Scenario: The worker's worker lists under the root coordinator
    When I open Settings › Orchestration
    And I set the Orchestration setting "Maximum workers per tree" to 20
    And I close Settings
    And I send "Load the worker_start tool with ToolSearch (query select:mcp__orchestration__worker_start). Then call worker_start exactly once with name parent, project <project>, and as its prompt exactly the text between BEGIN and END. BEGIN Load the worker_start tool with ToolSearch (query select:mcp__orchestration__worker_start), then call worker_start exactly once with name child, project <project>, and prompt: Reply with exactly: OK. Do nothing else. END. Do nothing else." with the scratch project and worktree names filled in
    Then I see a permission request
    When I allow the permission request
    And I open the worker "parent"
    Then I see a permission request whose title contains "started by worker parent"
    When I allow the permission request
    Then the sidebar lists the worker "parent"
    And the sidebar lists the worker "parent › child"
    And I capture "tree in sidebar desktop"
    When the viewport is 390x844
    Then the sidebar lists the worker "parent › child"
    When I show the sidebar
    Then the sidebar lists the worker "parent › child"
    And the page has no horizontal scroll
    And I capture "tree in sidebar phone"

  Scenario: A worker at the depth limit cannot start a worker
    When I open Settings › Orchestration
    And I set the Orchestration setting "Maximum workers per tree" to 20
    And I set the Orchestration setting "Maximum tree depth" to 1
    And I close Settings
    And I send "Load the worker_start tool with ToolSearch (query select:mcp__orchestration__worker_start). Then call worker_start exactly once with name parent, project <project>, and as its prompt exactly the text between BEGIN and END. BEGIN Load the worker_start tool with ToolSearch (query select:mcp__orchestration__worker_start), then call worker_start exactly once with name child, project <project>, and prompt: Reply with exactly: OK. Do nothing else. END. Do nothing else." with the scratch project and worktree names filled in
    Then I see a permission request
    When I allow the permission request
    Then the sidebar lists the worker "parent"
    When I open the worker "parent"
    Then the "worker_start" tool card failed
    And the "worker_start" tool card shows an error that names the depth limit
    And no permission request is shown
    And the sidebar does not list the worker "parent › child"
    And I capture "depth limit"
