Feature: Coordinator starts workers by project or worktree name

  Background:
    Given the viewport is 1440x900
    And the app is open
    And the scratch project is a git repository with its own worktree
    And I open the scratch project
    And I enable orchestration in Settings
    And I start a new Haiku session

  Scenario: worker_targets lists the project and its worktree
    When I send "Load the worker_targets tool with ToolSearch (query select:mcp__orchestration__worker_targets), then call it with no arguments. Do nothing else." with the scratch project and worktree names filled in
    Then the "worker_targets" tool card is shown and finished
    And the "worker_targets" tool card lists the scratch project and its worktree
    And the turn has finished
    And I capture "worker targets listed"

  Scenario: worker_start by project asks with the project name and starts in the main checkout
    When I send "Load the worker_start tool with ToolSearch (query select:mcp__orchestration__worker_start), then call it with exactly {\"name\":\"probe\",\"project\":\"<project>\",\"prompt\":\"Reply with exactly: OK\"}. Do nothing else." with the scratch project and worktree names filled in
    Then I see a permission request
    And the permission request names the scratch project
    And I capture "project card"
    When I allow the permission request
    Then a worker session runs in the main checkout of the scratch project
    And I capture "worker in main checkout"

  Scenario: worker_start by worktree asks with project and worktree names and starts in that worktree
    When I send "Load the worker_start tool with ToolSearch (query select:mcp__orchestration__worker_start), then call it with exactly {\"name\":\"probe\",\"worktree\":\"<worktree>\",\"prompt\":\"Reply with exactly: OK\"}. Do nothing else." with the scratch project and worktree names filled in
    Then I see a permission request
    And the permission request names the scratch worktree and the scratch project
    And I capture "worktree card"
    When I allow the permission request
    Then a worker session runs in the scratch worktree
    And I capture "worker in worktree"

  Scenario: worker_start with an unknown name fails and starts nothing
    When I send "Load the worker_start tool with ToolSearch (query select:mcp__orchestration__worker_start), then call it with exactly {\"name\":\"probe\",\"project\":\"no-such-project-zz\",\"prompt\":\"Reply with exactly: OK\"}. Do nothing else." with the scratch project and worktree names filled in
    Then I see a permission request
    When I allow the permission request
    Then the "worker_start" tool card failed
    And the "worker_start" tool card shows an error that names no such project
    And no worker session exists for the scratch project
    And I capture "unknown name"
